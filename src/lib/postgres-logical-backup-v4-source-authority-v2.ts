import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
} from "./postgres-logical-backup-v4-table-data-contract.js";

/**
 * Passive V2 source-authority policy and canonical archive record.
 *
 * This module deliberately has no database, filesystem, environment, process,
 * network, migration-source, archive-emitter, or restore dependency. A record
 * produced here contains caller claims plus derivational bindings only. It is
 * never evidence that the claimed PostgreSQL observations happened.
 */
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_PROFILE =
  "selected-data-least-authority-pg17-v2" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_RECEIPT_BYTES =
  128 * 1024;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_LIFETIME_SECONDS = 600;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_STATEMENT_TIMEOUT_MILLISECONDS =
  180_000;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS =
  480_000;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_DUMP_WATCHDOG_MILLISECONDS =
  300_000;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CLEANUP_RESERVE_MILLISECONDS =
  120_000;

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CAPABILITY = Object.freeze({
  implementationState: "PASSIVE_RECORD_FOUNDATION_ONLY",
  databaseAccessImplemented: false,
  roleProvisioningImplemented: false,
  roleCatalogObservationImplemented: false,
  membershipCeremonyImplemented: false,
  effectiveTargetOnlyDatabaseAccessRequired: false,
  effectiveTargetOnlyDatabaseAccessVerified: false,
  completeRoleGraphVerified: false,
  sourceSnapshotExportImplemented: false,
  pgDumpHandoffImplemented: false,
  operationalCompletionRecorderImplemented: false,
  completedEvidenceProjectionParsableAsUnverifiedObservation: true,
  independentLiveRecorderBrandRequired: true,
  independentLiveRecorderBrandSerialized: false,
  callerEvidenceVerifiedByThisModule: false,
  operationalSourceAuthorityImplemented: false,
  sourceAuthorityGranted: false,
  archiveContentAuthorityGranted: false,
  serializedReceiptIsAuthority: false,
  artifactEmissionAuthorized: false,
  activationAuthorized: false,
  productionCutoverAuthorized: false,
} as const);

const PINNED_PORTABLE_READ_BOUNDARY_SHA256 =
  "26b6b1346c15465ce538ac9769d435cd02c50bb138f8c73095ef5ff132506cf8" as const;
const PINNED_ARCHIVED_TABLE_SET_SHA256 =
  "505d42cd7ffbe6809aea3e3ed02b33968bf625bde882cdbc0f1a3c69cc94f6d8" as const;
const PINNED_V2_VALIDATOR_PROFILE = "pintpath-postgres-logical-state-v2-full-validator" as const;
const PINNED_V2_VALIDATOR_SOURCE_SHA256 =
  "84634059f74f30299596838f9d45602d7d0624e17fce3c58edeb9b701359aa99" as const;
const PINNED_STRICT_TOC_PARSER_PROFILE =
  "pintpath-postgres-logical-backup-v4-strict-toc-parser" as const;
const PINNED_STRICT_TOC_PARSER_SOURCE_SHA256 =
  "996bd6190a4680346a65dacfe05a6f97bef90586a9d269d38a9cfb626bf55c5f" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OID_PATTERN = /^(?:[1-9][0-9]{0,9})$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const LOGIN_VERSION_PATTERN = /^(?:[1-9][0-9]{0,19})$/;
const BARE_POSTGRES_17_VERSION_PATTERN =
  /^17(?:\.[0-9]{1,3}){1,3}(?:[-+._a-zA-Z0-9 ()~:]{0,96})?$/;
const TOC_ARCHIVE_CREATED_PATTERN =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] (?:[A-Za-z][A-Za-z0-9+:-]{0,15}|[+-][0-9]{2}(?::?[0-9]{2})?)$/;
const TOC_NUMERIC_TIME_ZONE_PATTERN = / ([+-])([0-9]{2})(?::?([0-9]{2}))?$/;
const MAX_POSTGRES_OID = 4_294_967_295n;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 8_192;
const MAX_JSON_STRING_BYTES = 64 * 1024;
const MAX_ARRAY_LENGTH = 512;
const MAX_OBJECT_KEYS = 512;
const BACKUP_GROUP_PREFIX = "pintpath_logical_backup_d";
const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf] as const);

const BUFFER_OBJECT = Buffer;
const BUFFER_ALLOC = BUFFER_OBJECT.alloc;
const BUFFER_BYTE_LENGTH = BUFFER_OBJECT.byteLength;
const BUFFER_COMPARE = BUFFER_OBJECT.compare;
const BUFFER_FROM = BUFFER_OBJECT.from;
const BUFFER_IS_BUFFER = BUFFER_OBJECT.isBuffer;
const BUFFER_PROTOTYPE = BUFFER_OBJECT.prototype;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const UTIL_IS_PROXY = utilTypes.isProxy;
const UTIL_IS_UINT8_ARRAY = utilTypes.isUint8Array;

export type PostgresLogicalBackupV4SourceAuthorityV2ErrorCode =
  | "static_authority_drift"
  | "receipt_invalid"
  | "receipt_v1_rejected";

export class PostgresLogicalBackupV4SourceAuthorityV2Error extends Error {
  constructor(readonly code: PostgresLogicalBackupV4SourceAuthorityV2ErrorCode) {
    super(code);
    this.name = "PostgresLogicalBackupV4SourceAuthorityV2Error";
  }
}

function fail(code: PostgresLogicalBackupV4SourceAuthorityV2ErrorCode): never {
  throw new PostgresLogicalBackupV4SourceAuthorityV2Error(code);
}

function compareText(left: string, right: string): number {
  const leftBytes = REFLECT_APPLY(BUFFER_FROM, BUFFER_OBJECT, [left, "utf8"]) as Buffer;
  const rightBytes = REFLECT_APPLY(BUFFER_FROM, BUFFER_OBJECT, [right, "utf8"]) as Buffer;
  return REFLECT_APPLY(BUFFER_COMPARE, BUFFER_OBJECT, [leftBytes, rightBytes]) as number;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || UTIL_IS_PROXY(value)) {
    return false;
  }
  try {
    const prototype = OBJECT_GET_PROTOTYPE_OF(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function snapshotBoundedPlainData(value: unknown): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) fail("receipt_invalid");
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      const length = REFLECT_APPLY(
        BUFFER_BYTE_LENGTH,
        BUFFER_OBJECT,
        [candidate, "utf8"],
      ) as number;
      if (length > MAX_JSON_STRING_BYTES) fail("receipt_invalid");
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate) || Object.is(candidate, -0)) {
        fail("receipt_invalid");
      }
      return candidate;
    }
    if (typeof candidate !== "object" || UTIL_IS_PROXY(candidate)) fail("receipt_invalid");
    if (seen.has(candidate)) fail("receipt_invalid");
    seen.add(candidate);
    let prototype: object | null;
    let keys: PropertyKey[];
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = OBJECT_GET_PROTOTYPE_OF(candidate);
      keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [candidate]) as PropertyKey[];
      descriptors = REFLECT_APPLY(
        OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
        Object,
        [candidate],
      ) as PropertyDescriptorMap;
    } catch {
      fail("receipt_invalid");
    }
    if (Array.isArray(candidate)) {
      if (prototype !== Array.prototype
        || keys.length > MAX_ARRAY_LENGTH + 1
        || keys.some((key) => typeof key !== "string"
          || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
        fail("receipt_invalid");
      }
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value)
        || Number(lengthDescriptor.value) < 0
        || Number(lengthDescriptor.value) > MAX_ARRAY_LENGTH
        || keys.length !== Number(lengthDescriptor.value) + 1) fail("receipt_invalid");
      const output: unknown[] = [];
      for (let index = 0; index < Number(lengthDescriptor.value); index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          fail("receipt_invalid");
        }
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    }
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > MAX_OBJECT_KEYS) {
      fail("receipt_invalid");
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") fail("receipt_invalid");
      const keyLength = REFLECT_APPLY(
        BUFFER_BYTE_LENGTH,
        BUFFER_OBJECT,
        [key, "utf8"],
      ) as number;
      const descriptor = descriptors[key];
      if (keyLength > 128 || !descriptor || !("value" in descriptor)
        || descriptor.enumerable !== true) fail("receipt_invalid");
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

function snapshotReceiptBuffer(input: unknown): Buffer {
  try {
    if (!input || typeof input !== "object" || UTIL_IS_PROXY(input)
      || !TYPED_ARRAY_BYTE_LENGTH) fail("receipt_invalid");
    const byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH, input, []) as unknown;
    if (!Number.isSafeInteger(byteLength)
      || Number(byteLength) < 1
      || Number(byteLength) > POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_RECEIPT_BYTES
      || !UTIL_IS_UINT8_ARRAY(input)
      || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [input]) !== BUFFER_PROTOTYPE
      || REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_OBJECT, [input]) !== true) {
      fail("receipt_invalid");
    }
    const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [input]) as PropertyKey[];
    const descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      Object,
      [input],
    ) as PropertyDescriptorMap;
    if (keys.length !== Number(byteLength)) fail("receipt_invalid");
    for (let index = 0; index < Number(byteLength); index += 1) {
      const descriptor = descriptors[String(index)];
      if (keys[index] !== String(index) || !descriptor || !("value" in descriptor)
        || !Number.isInteger(descriptor.value) || descriptor.value < 0
        || descriptor.value > 255 || descriptor.enumerable !== true) fail("receipt_invalid");
    }
    const snapshot = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_OBJECT, [byteLength]) as Buffer;
    REFLECT_APPLY(TYPED_ARRAY_SET, snapshot, [input, 0]);
    return snapshot;
  } catch (error) {
    if (error instanceof PostgresLogicalBackupV4SourceAuthorityV2Error) throw error;
    fail("receipt_invalid");
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail("receipt_invalid");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalize(entry)}`
    )).join(",")}}`;
  }
  fail("receipt_invalid");
}

function canonicalJson(value: unknown): string {
  return `${canonicalize(value)}\n`;
}

function sha256Utf8(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function domainHash(kind: string, value: unknown): string {
  return sha256Utf8(canonicalJson({ kind, version: 2, value }));
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function exactOid(value: unknown): value is string {
  if (typeof value !== "string" || !OID_PATTERN.test(value)) return false;
  try {
    const oid = BigInt(value);
    return oid > 0n && oid <= MAX_POSTGRES_OID;
  } catch {
    return false;
  }
}

function exactDatabaseName(value: unknown): value is string {
  return typeof value === "string"
    && DATABASE_NAME_PATTERN.test(value)
    && (REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_OBJECT, [value, "utf8"]) as number) <= 63;
}

function exactBarePostgres17Version(value: unknown): value is string {
  return typeof value === "string" && BARE_POSTGRES_17_VERSION_PATTERN.test(value);
}

function exactTocArchiveCreatedAt(value: unknown): value is string {
  if (typeof value !== "string" || !TOC_ARCHIVE_CREATED_PATTERN.test(value)) return false;
  const numericZone = TOC_NUMERIC_TIME_ZONE_PATTERN.exec(value);
  if (!numericZone) return true;
  const hours = Number(numericZone[2]);
  const minutes = Number(numericZone[3] ?? "00");
  return hours <= 14 && minutes <= 59 && (hours !== 14 || minutes === 0);
}

function exactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) && instant.toISOString() === value;
}

function splitQualifiedName(value: string): readonly [string, string] {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail("static_authority_drift");
  return [parts[0], parts[1]];
}

function backupGroupName(databaseOid: string): string {
  if (!exactOid(databaseOid)) fail("receipt_invalid");
  return `${BACKUP_GROUP_PREFIX}${databaseOid}`;
}

function ephemeralLoginName(databaseOid: string, versionToken: string): string {
  if (!LOGIN_VERSION_PATTERN.test(versionToken)) fail("receipt_invalid");
  const name = `${backupGroupName(databaseOid)}_v${versionToken}`;
  if ((REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_OBJECT, [name, "utf8"]) as number) > 63) {
    fail("receipt_invalid");
  }
  return name;
}

export interface PostgresLogicalBackupV4SourceRelationDispositionV2 {
  readonly qualifiedRelation: string;
  readonly disposition: "ARCHIVED_TABLE_DATA" | "REQUIRED_EMPTY_NOT_ARCHIVED";
  readonly rowSecurityRequired: true;
  readonly forceRowSecurityRequired: true;
}

const archivedQualifiedRelations = POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.map(
  (descriptor) => `${descriptor.schemaName}.${descriptor.tableName}`,
);
const requiredEmptyQualifiedRelations = Object.freeze([
  "pintpath_ops.reviewed_price_promotion_operations",
  "pintpath_ops.reviewed_price_promotion_rows",
] as const);

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_RELATIONS =
  requiredEmptyQualifiedRelations;

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS =
  deepFreeze([
    ...archivedQualifiedRelations.map((qualifiedRelation) => ({
      qualifiedRelation,
      disposition: "ARCHIVED_TABLE_DATA" as const,
      rowSecurityRequired: true as const,
      forceRowSecurityRequired: true as const,
    })),
    ...requiredEmptyQualifiedRelations.map((qualifiedRelation) => ({
      qualifiedRelation,
      disposition: "REQUIRED_EMPTY_NOT_ARCHIVED" as const,
      rowSecurityRequired: true as const,
      forceRowSecurityRequired: true as const,
    })),
  ].sort((left, right) => compareText(left.qualifiedRelation, right.qualifiedRelation)));

type PolicyCommand = "ALL" | "SELECT" | "INSERT" | "UPDATE";
type PolicyExpressionProfile =
  | "TRUE"
  | "NONE"
  | "CURRENT_USER_EQUALS_DATABASE_OID_SCOPED_BACKUP_GROUP";

export interface PostgresLogicalBackupV4SourcePolicyDescriptorV2 {
  readonly qualifiedRelation: string;
  readonly policyName: string;
  readonly classification: "LOGICAL_BACKUP_SELECT" | "REVIEWED_OTHER";
  readonly permissive: true;
  readonly command: PolicyCommand;
  readonly roles: readonly ["PUBLIC"] | readonly ["pintpath_runtime"]
    | readonly ["pintpath_migrator"];
  readonly usingExpressionProfile: PolicyExpressionProfile;
  readonly withCheckExpressionProfile: "TRUE" | "NONE";
}

function policyDescriptor(
  qualifiedRelation: string,
  policyName: string,
  classification: PostgresLogicalBackupV4SourcePolicyDescriptorV2["classification"],
  command: PolicyCommand,
  role: "PUBLIC" | "pintpath_runtime" | "pintpath_migrator",
  usingExpressionProfile: PolicyExpressionProfile,
  withCheckExpressionProfile: "TRUE" | "NONE",
): PostgresLogicalBackupV4SourcePolicyDescriptorV2 {
  return Object.freeze({
    qualifiedRelation,
    policyName,
    classification,
    permissive: true,
    command,
    roles: Object.freeze([role]) as PostgresLogicalBackupV4SourcePolicyDescriptorV2["roles"],
    usingExpressionProfile,
    withCheckExpressionProfile,
  });
}

function reviewedOtherPolicies(qualifiedRelation: string): readonly PostgresLogicalBackupV4SourcePolicyDescriptorV2[] {
  const [schemaName, tableName] = splitQualifiedName(qualifiedRelation);
  if (requiredEmptyQualifiedRelations.includes(
    qualifiedRelation as typeof requiredEmptyQualifiedRelations[number],
  )) {
    return [policyDescriptor(
      qualifiedRelation,
      `${tableName}_migrator_select`,
      "REVIEWED_OTHER",
      "SELECT",
      "pintpath_migrator",
      "TRUE",
      "NONE",
    )];
  }
  if (schemaName === "pintpath_ops") {
    return [
      policyDescriptor(qualifiedRelation, `${tableName}_migrator_select`, "REVIEWED_OTHER", "SELECT", "pintpath_migrator", "TRUE", "NONE"),
      policyDescriptor(qualifiedRelation, `${tableName}_migrator_insert`, "REVIEWED_OTHER", "INSERT", "pintpath_migrator", "NONE", "TRUE"),
      policyDescriptor(qualifiedRelation, `${tableName}_migrator_update`, "REVIEWED_OTHER", "UPDATE", "pintpath_migrator", "TRUE", "TRUE"),
    ];
  }
  if (qualifiedRelation === "pintpath_app.schema_metadata") {
    return [
      policyDescriptor(qualifiedRelation, "schema_metadata_runtime_read", "REVIEWED_OTHER", "SELECT", "pintpath_runtime", "TRUE", "NONE"),
      policyDescriptor(qualifiedRelation, "schema_metadata_migrator_select", "REVIEWED_OTHER", "SELECT", "pintpath_migrator", "TRUE", "NONE"),
      policyDescriptor(qualifiedRelation, "schema_metadata_migrator_update", "REVIEWED_OTHER", "UPDATE", "pintpath_migrator", "TRUE", "TRUE"),
    ];
  }
  return [
    policyDescriptor(qualifiedRelation, `${tableName}_runtime_all`, "REVIEWED_OTHER", "ALL", "pintpath_runtime", "TRUE", "TRUE"),
    policyDescriptor(qualifiedRelation, `${tableName}_migrator_select`, "REVIEWED_OTHER", "SELECT", "pintpath_migrator", "TRUE", "NONE"),
    policyDescriptor(qualifiedRelation, `${tableName}_migrator_insert`, "REVIEWED_OTHER", "INSERT", "pintpath_migrator", "NONE", "TRUE"),
  ];
}

function buildPolicyDescriptors(): readonly PostgresLogicalBackupV4SourcePolicyDescriptorV2[] {
  const descriptors: PostgresLogicalBackupV4SourcePolicyDescriptorV2[] = [];
  for (const relation of POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS) {
    const [, tableName] = splitQualifiedName(relation.qualifiedRelation);
    descriptors.push(policyDescriptor(
      relation.qualifiedRelation,
      `${tableName}_logical_backup_select`,
      "LOGICAL_BACKUP_SELECT",
      "SELECT",
      "PUBLIC",
      "CURRENT_USER_EQUALS_DATABASE_OID_SCOPED_BACKUP_GROUP",
      "NONE",
    ));
    descriptors.push(...reviewedOtherPolicies(relation.qualifiedRelation));
  }
  descriptors.sort((left, right) => compareText(
    `${left.qualifiedRelation}\u0000${left.policyName}`,
    `${right.qualifiedRelation}\u0000${right.policyName}`,
  ));
  return deepFreeze(descriptors);
}

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS =
  buildPolicyDescriptors();

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITION_SET_SHA256 =
  domainHash(
    "pintpath-postgres-logical-backup-v4-source-relation-disposition-set",
    POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS,
  );
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_SET_SHA256 =
  domainHash(
    "pintpath-postgres-logical-backup-v4-required-empty-relation-set",
    POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_RELATIONS,
  );
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SET_SHA256 =
  domainHash(
    "pintpath-postgres-logical-backup-v4-source-policy-set",
    POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS,
  );

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY = deepFreeze({
  kind: "pintpath-postgres-logical-backup-v4-source-authority-policy",
  version: 2,
  profile: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_PROFILE,
  implementationState: "PASSIVE_RECORD_FOUNDATION_ONLY",
  postgresMajor: 17,
  selectedData: {
    archivedRelations: 59,
    requiredEmptyKernelRelations: 2,
    totalSourceRelations: 61,
    archivedTableSetSha256: PINNED_ARCHIVED_TABLE_SET_SHA256,
    relationDispositionSetSha256:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITION_SET_SHA256,
    requiredEmptyRelationSetSha256:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_SET_SHA256,
    portableReadBoundarySha256: PINNED_PORTABLE_READ_BOUNDARY_SHA256,
    exactArchivedRelationSelectAclCountForBackupGroup: 59,
    exactRequiredEmptyKernelRelationSelectAclCountForBackupGroup: 2,
    exactTotalRelationSelectAclCountForBackupGroup: 61,
  },
  rowSecurity: {
    exactRlsEnabledRelationCount: 61,
    exactForceRlsRelationCount: 61,
    exactLogicalBackupSelectPolicyCount: 61,
    exactReviewedOtherPolicyCount: 179,
    exactTotalPolicyCount: 240,
    policySetSha256: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SET_SHA256,
  },
  backupGroupExpectation: {
    oidScopedNameRequired: true,
    login: false,
    inherit: false,
    connectionLimit: -1,
    validUntil: null,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
    directDatabaseAclCount: 0,
    exactSchemaUsageAclCount: 2,
    exactArchivedRelationSelectAclCount: 59,
    exactRequiredEmptyKernelSelectAclCount: 2,
    exactTotalRelationSelectAclCount: 61,
    exactSharedDependencyCount: 63,
    relationWriteAclCount: 0,
    columnAclCount: 0,
    sequenceAclCount: 0,
    routineAclCount: 0,
    ownedObjectCount: 0,
    membershipsGrantedCount: 0,
    membershipsReceivedCount: 0,
    roleSettingCount: 0,
  },
  ephemeralLoginExpectation: {
    oidScopedVersionedNameRequired: true,
    login: true,
    inherit: false,
    connectionLimit: 2,
    validUntilRequired: true,
    validUntilBoundToLifecycleAtCompletion: true,
    maxLifetimeSeconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_LIFETIME_SECONDS,
    scramSha256Required: true,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
    exactDirectTargetDatabaseConnectAclCount: 1,
    exactSharedDependencyCount: 1,
    otherDirectDatabaseAclCount: 0,
    schemaAclCount: 0,
    relationAclCount: 0,
    columnAclCount: 0,
    sequenceAclCount: 0,
    routineAclCount: 0,
    ownedObjectCount: 0,
    roleSettingCount: 0,
    effectiveTargetOnlyDatabaseAccessRequired: false,
    effectiveTargetOnlyDatabaseAccessVerifiedByThisModule: false,
    completeRoleGraphVerifiedByThisModule: false,
  },
  membershipCeremony: {
    expectedSetOnlyMembershipCountSequence: [1, 0, 1, 0],
    inheritOptionTrueCount: 0,
    adminOptionTrueCount: 0,
  },
  operationalCompletionWire: {
    states: ["PENDING_LIVE_RECORDER", "COMPLETED_EVIDENCE_PROJECTION"],
    passiveBuilderEmitsOnlyPending: true,
    completedProjectionRequiresIndependentLiveRecorderBrand: true,
    liveRecorderBrandSerialized: false,
    serializedCompletedProjectionIsAuthority: false,
    sourceAndPgDumpScramAuthenticationEvidenceRequired: true,
    sourceSessionAndPgDumpSessionIdentityEvidenceRequired: true,
    independentFullV2CaptureRequired: true,
    semanticSameSnapshotHandoffRequired: true,
    exactPgDumpAndListRuntimeEvidenceRequired: true,
    stableArchiveCustodyAndTocBindingRequired: true,
    maxLifetimeSeconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_LIFETIME_SECONDS,
    sourceStatementTimeoutMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_STATEMENT_TIMEOUT_MILLISECONDS,
    sourceSessionTimeoutMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS,
    pgDumpWatchdogMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_DUMP_WATCHDOG_MILLISECONDS,
    cleanupReserveMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CLEANUP_RESERVE_MILLISECONDS,
    cleanupMembershipRevokedRequired: true,
    cleanupLoginDisabledThenDroppedRequired: true,
    cleanupBackendsTerminatedAndActiveSessionCountZeroRequired: true,
  },
  authorization: {
    recordClassification: "CANONICAL_SOURCE_ARCHIVE_RECORD_ONLY",
    callerEvidenceVerifiedByThisModule: false,
    serializedReceiptIsAuthority: false,
    operationalSourceAuthorityImplemented: false,
    sourceAuthorityGranted: false,
    archiveContentAuthorityGranted: false,
    artifactEmissionAuthorized: false,
    activationAuthorized: false,
    productionCutoverAuthorized: false,
  },
} as const);

const POLICY_CANONICAL_JSON = canonicalJson(
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY,
);
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SHA256 =
  sha256Utf8(POLICY_CANONICAL_JSON);

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_RELATION_DISPOSITION_SET_SHA256 =
  "29c501ec35ebf94c5338f18f7b453055385dc51f7750052e1c484fdcd57da3a3" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_REQUIRED_EMPTY_SET_SHA256 =
  "e4cddd8b31fa1a4fb19acdbed39abc815ec157de207a06273965279a816b2a09" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SET_SHA256 =
  "5f73c7de727f295540363a0ed262262d1930a77d2d09f225491c29f50c787d91" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SHA256 =
  "3e375a73225da5f8af2e0b1a968b6fd6b3af53e36d0d2ec9612812c4b8de849f" as const;

function assertStaticAuthority(): void {
  const backupPolicies = POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS
    .filter((policy) => policy.classification === "LOGICAL_BACKUP_SELECT");
  const otherPolicies = POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS
    .filter((policy) => policy.classification === "REVIEWED_OTHER");
  if (archivedQualifiedRelations.length !== 59
    || new Set(archivedQualifiedRelations).size !== 59
    || requiredEmptyQualifiedRelations.length !== 2
    || POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS.length !== 61
    || new Set(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS
      .map((relation) => relation.qualifiedRelation)).size !== 61
    || POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS.length !== 240
    || new Set(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS
      .map((policy) => `${policy.qualifiedRelation}\u0000${policy.policyName}`)).size !== 240
    || backupPolicies.length !== 61
    || otherPolicies.length !== 179
    || POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256 !== PINNED_ARCHIVED_TABLE_SET_SHA256
    || POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256
      !== PINNED_ARCHIVED_TABLE_SET_SHA256
    || sha256Utf8(canonicalJson({
      kind: "pintpath-postgres-logical-backup-table-data-set",
      version: 1,
      entries: POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
    })) !== PINNED_ARCHIVED_TABLE_SET_SHA256
    || POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITION_SET_SHA256
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_RELATION_DISPOSITION_SET_SHA256
    || POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_SET_SHA256
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_REQUIRED_EMPTY_SET_SHA256
    || POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SET_SHA256
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SET_SHA256
    || POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SHA256
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SHA256) {
    fail("static_authority_drift");
  }
}

export interface PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim {
  readonly phase: "provisioned" | "detached-for-capture" | "regranted-for-pg-dump"
    | "cleaned-up";
  readonly claimedObservedAt: string;
  readonly claimedEvidenceSha256: string;
}

export interface BuildPostgresLogicalBackupV4SourceAuthorityReceiptV2Input {
  readonly createdAt: string;
  readonly sourceDatabaseOid: string;
  readonly sourceDatabaseName: string;
  readonly ephemeralLoginVersionToken: string;
  readonly backupGroupClaimedRoleOid: string;
  readonly ephemeralLoginClaimedRoleOid: string;
  readonly claimedDatabaseIdentitySha256: string;
  readonly claimedSourceUrlSha256: string;
  readonly claimedBackupGroupCatalogEvidenceSha256: string;
  readonly claimedEphemeralLoginCatalogEvidenceSha256: string;
  readonly membershipClaims: readonly [
    PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
    PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
    PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
    PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
  ];
  readonly claimedSourceStateCaptureSha256: string;
  readonly claimedExportedSnapshotBindingSha256: string;
  readonly claimedPgDumpArgumentsBindingSha256: string;
  readonly claimedPgDumpExecutableSha256: string;
  readonly claimedPgRestoreExecutableSha256: string;
  readonly claimedArchiveSha256: string;
  readonly claimedArchiveListingSha256: string;
  readonly claimedArchiveByteLength: number;
}

interface ExpectedRoleSafetyFlagsV2 {
  readonly inherit: false;
  readonly superuser: false;
  readonly createDatabase: false;
  readonly createRole: false;
  readonly replication: false;
  readonly bypassRls: false;
}

interface MembershipTransitionRecordV2 {
  readonly phase: PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim["phase"];
  readonly claimedObservedAt: string;
  readonly expectedBackupGroupChildMembershipCount: 0 | 1;
  readonly expectedLoginParentMembershipCount: 0 | 1;
  readonly expectedExactSetOnlyMembershipCount: 0 | 1;
  readonly expectedInheritOptionTrueCount: 0;
  readonly expectedAdminOptionTrueCount: 0;
  readonly claimedEvidenceSha256: string;
  readonly transitionBindingSha256: string;
}

export interface PostgresLogicalBackupV4SourceAuthorityPendingCompletionV2 {
  readonly state: "PENDING_LIVE_RECORDER";
  readonly completed: false;
  readonly pendingReason: "PASSIVE_BUILDER_CANNOT_VERIFY_LIVE_EVIDENCE";
  readonly independentLiveRecorderBrandRequired: true;
  readonly independentLiveRecorderBrandSerialized: false;
  readonly completionObservationVerifiedByThisModule: false;
  readonly completionBindingSha256: string;
}

export interface PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2 {
  readonly state: "COMPLETED_EVIDENCE_PROJECTION";
  readonly completed: true;
  readonly independentLiveRecorderBrandRequired: true;
  readonly independentLiveRecorderBrandSerialized: false;
  readonly serializedCompletionObservationOnly: true;
  readonly completionObservationVerifiedByThisModule: false;
  readonly passivePolicyRecordSha256: string;
  readonly authorityEvidence: {
    readonly backupGroupCatalogProjectionVerified: true;
    readonly ephemeralLoginCatalogProjectionVerified: true;
    readonly membershipCeremonyVerified: true;
    readonly authorityProjectionSha256: string;
    readonly membershipCeremonyBindingSha256: string;
    readonly backupGroupCatalogEvidenceSha256: string;
    readonly ephemeralLoginCatalogEvidenceSha256: string;
    readonly ephemeralLoginValidUntil: string;
    readonly authorityEvidenceBindingSha256: string;
  };
  readonly lifecycle: {
    readonly startedAt: string;
    readonly expiresAt: string;
    readonly maxLifetimeSeconds: 600;
    readonly serverClockObservedAt: string;
    readonly serverClockEvidenceSha256: string;
    readonly loginValidUntil: string;
    readonly loginProvisionedAt: string;
    readonly sourceAuthenticatedAt: string;
    readonly membershipDetachedAt: string;
    readonly sourceTransactionBeganAt: string;
    readonly v2CaptureCompletedAt: string;
    readonly snapshotExportedAt: string;
    readonly membershipRegrantedAt: string;
    readonly pgDumpStartedAt: string;
    readonly pgDumpAuthenticatedAt: string;
    readonly pgDumpSnapshotImportedAt: string;
    readonly pgDumpCompletedAt: string;
    readonly archiveListedAt: string;
    readonly sourceTransactionEndedAt: string;
    readonly cleanupStartedAt: string;
    readonly loginDisabledAt: string;
    readonly loginDroppedAt: string;
    readonly cleanupCompletedAt: string;
    readonly pgDumpWatchdogMilliseconds: 300000;
    readonly cleanupReserveMilliseconds: 120000;
    readonly absoluteDeadline: string;
    readonly lifecycleEvidenceSha256: string;
  };
  readonly sessions: {
    readonly sourceSessionIdentitySha256: string;
    readonly independentAdminSessionIdentitySha256: string;
    readonly pgDumpSessionIdentitySha256: string;
    readonly sourceSessionIdentityVerified: true;
    readonly independentAdminSessionIdentityVerified: true;
    readonly pgDumpSessionIdentityVerified: true;
    readonly sourceScramAuthenticationVerified: true;
    readonly pgDumpScramAuthenticationVerified: true;
    readonly sourceAuthenticationEvidenceSha256: string;
    readonly pgDumpAuthenticationEvidenceSha256: string;
    readonly sourceAuthenticatedAt: string;
    readonly pgDumpAuthenticatedAt: string;
    readonly sourceDatabaseVersion: string;
    readonly sourceCurrentUserRoleName: string;
    readonly sourceSessionUserRoleName: string;
    readonly pgDumpCurrentUserRoleName: string;
    readonly pgDumpSessionUserRoleName: string;
    readonly sourceTransactionIsolation: "repeatable read";
    readonly sourceTransactionReadOnly: true;
    readonly sourceStatementTimeoutMilliseconds: 180000;
    readonly sourceIdleInTransactionSessionTimeoutMilliseconds: 480000;
    readonly sourceIdleSessionTimeoutMilliseconds: 480000;
    readonly sourceTransactionTimeoutMilliseconds: 480000;
    readonly sessionEvidenceBindingSha256: string;
  };
  readonly v2Capture: {
    readonly sourceDatabaseOid: string;
    readonly captureSha256: string;
    readonly portableReadBoundarySha256: typeof PINNED_PORTABLE_READ_BOUNDARY_SHA256;
    /**
     * OID/owner-sensitive selected-data and read-safety evidence only. This is
     * deliberately not a complete physical-schema or canonical target digest.
     */
    readonly sourcePhysicalReadBoundarySha256: string;
    readonly sourcePhysicalReadBoundaryClassification:
      "OID_OWNER_SENSITIVE_SELECTED_DATA_READ_SAFETY_EVIDENCE_ONLY";
    readonly overallStateSha256: string;
    readonly independentFullV2ValidationPerformed: true;
    readonly v2ValidatorProfile: typeof PINNED_V2_VALIDATOR_PROFILE;
    readonly v2ValidatorVersion: 2;
    readonly v2ValidatorSourceSha256: typeof PINNED_V2_VALIDATOR_SOURCE_SHA256;
    readonly independentLiveV2ValidatorBrandRequired: true;
    readonly sameSourceSessionVerified: true;
    readonly sourceSessionIdentitySha256: string;
    readonly capturedAt: string;
    readonly captureSequence: 1;
    readonly captureBindingSha256: string;
  };
  readonly snapshotHandoff: {
    readonly snapshotIdentifierSha256: string;
    readonly rawSnapshotIdentifierPersisted: false;
    readonly exportedAt: string;
    readonly exportSequence: 2;
    readonly pgDumpImportedAt: string;
    readonly sourceSessionIdentitySha256: string;
    readonly pgDumpSessionIdentitySha256: string;
    readonly roleArgumentSha256: string;
    readonly exportedSnapshotBindingSha256: string;
    readonly pgDumpSnapshotSemanticBindingSha256: string;
    readonly semanticHandoffBindingSha256: string;
    readonly sameSnapshotSemanticBindingVerified: true;
  };
  readonly tools: {
    readonly pgDumpExecutableSha256: string;
    readonly pgDumpExecutableProvenanceVerified: true;
    readonly pgDumpExecutableProvenanceEvidenceSha256: string;
    readonly pgDumpNativeRuntimeClosureVerified: true;
    readonly pgDumpNativeRuntimeClosureEvidenceSha256: string;
    readonly pgDumpVersion: string;
    readonly pgDumpVersionEvidenceSha256: string;
    readonly pgDumpRuntimeEvidenceSha256: string;
    readonly pgDumpExactArgumentsSha256: string;
    readonly pgDumpArgumentsBindingSha256: string;
    readonly pgDumpExitCode: 0;
    readonly pgDumpStdoutByteLength: 0;
    readonly pgDumpStderrByteLength: 0;
    readonly pgDumpRequireAuth: "scram-sha-256";
    readonly pgDumpDatabaseArgumentKind: "CANONICAL_DATABASE_IDENTIFIER";
    readonly pgRestoreExecutableSha256: string;
    readonly pgRestoreExecutableProvenanceVerified: true;
    readonly pgRestoreExecutableProvenanceEvidenceSha256: string;
    readonly pgRestoreNativeRuntimeClosureVerified: true;
    readonly pgRestoreNativeRuntimeClosureEvidenceSha256: string;
    readonly pgRestoreVersion: string;
    readonly pgRestoreVersionEvidenceSha256: string;
    readonly listRuntimeEvidenceSha256: string;
    readonly listExactArgumentsSha256: string;
    readonly listArgumentsBindingSha256: string;
    readonly listExitCode: 0;
    readonly listStderrByteLength: 0;
    readonly rawListingBytesPreserved: true;
    readonly toolRuntimeBindingSha256: string;
  };
  readonly archiveCustody: {
    readonly archiveSha256: string;
    readonly archiveByteLength: number;
    readonly archiveIdentityBeforeSha256: string;
    readonly archiveIdentityBeforeDigestSha256: string;
    readonly archiveIdentityAfterDigestSha256: string;
    readonly archiveIdentityBeforeListingSha256: string;
    readonly archiveIdentityAfterListingSha256: string;
    readonly archiveIdentityAfterSha256: string;
    readonly stableArchiveIdentitySha256: string;
    readonly archiveIdentityStable: true;
    readonly dumpAndListUsedSameRetainedArchiveDescriptor: true;
    readonly listingSha256: string;
    readonly listingByteLength: number;
    readonly archiveCreatedAt: string;
    readonly databaseName: string;
    readonly dumpedFromDatabaseVersion: string;
    readonly dumpedByPgDumpVersion: string;
    readonly tocEntryCount: 63;
    readonly tocTableDataEntryCount: 59;
    readonly tocTableDataSetSha256: typeof PINNED_ARCHIVED_TABLE_SET_SHA256;
    readonly tocEvidenceSha256: string;
    readonly tocBindingSha256: string;
    readonly strictTocParserValidationPerformed: true;
    readonly strictTocParserProfile: typeof PINNED_STRICT_TOC_PARSER_PROFILE;
    readonly strictTocParserVersion: 1;
    readonly strictTocParserSourceSha256: typeof PINNED_STRICT_TOC_PARSER_SOURCE_SHA256;
    readonly independentStrictTocParserBrandRequired: true;
    readonly rawListingHashMatchesTocEvidence: true;
    readonly archiveCustodyBindingSha256: string;
  };
  readonly cleanup: {
    readonly membershipRevoked: true;
    readonly exactSetOnlyMembershipCount: 0;
    readonly loginDisabledNoLogin: true;
    readonly loginDropped: true;
    readonly backendTerminationAttempted: true;
    readonly terminatedBackendCount: number;
    readonly activeSessionCount: 0;
    readonly cleanupEvidenceSha256: string;
    readonly cleanupComplete: true;
  };
  readonly completionBindingSha256: string;
}

export type PostgresLogicalBackupV4SourceAuthorityOperationalCompletionV2 =
  | PostgresLogicalBackupV4SourceAuthorityPendingCompletionV2
  | PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2;

export interface PostgresLogicalBackupV4SourceAuthorityReceiptV2 {
  readonly kind: "pintpath-postgres-logical-backup-source-authority";
  readonly version: 2;
  readonly classification: "CANONICAL_SOURCE_ARCHIVE_RECORD_ONLY";
  readonly profile: typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_PROFILE;
  readonly policySha256: string;
  readonly createdAt: string;
  readonly source: {
    readonly databaseOid: string;
    readonly databaseName: string;
    readonly claimedDatabaseIdentitySha256: string;
    readonly claimedSourceUrlSha256: string;
    readonly portableReadBoundarySha256: typeof PINNED_PORTABLE_READ_BOUNDARY_SHA256;
  };
  readonly selectedData: {
    readonly archivedRelationCount: 59;
    readonly requiredEmptyKernelRelationCount: 2;
    readonly totalSourceRelationCount: 61;
    readonly archivedTableSetSha256: typeof PINNED_ARCHIVED_TABLE_SET_SHA256;
    readonly relationDispositionSetSha256: string;
    readonly requiredEmptyRelationSetSha256: string;
    readonly policySetSha256: string;
    readonly rlsEnabledRelationCount: 61;
    readonly forceRlsRelationCount: 61;
    readonly logicalBackupSelectPolicyCount: 61;
    readonly reviewedOtherPolicyCount: 179;
    readonly totalPolicyCount: 240;
  };
  readonly authorityProjection: {
    readonly classification: "DECLARATIVE_EXPECTATION_WITH_CALLER_CLAIMED_EVIDENCE_ONLY";
    readonly backupGroup: ExpectedRoleSafetyFlagsV2 & {
      readonly roleName: string;
      readonly claimedRoleOid: string;
      readonly login: false;
      readonly connectionLimit: -1;
      readonly validUntil: null;
      readonly expectedDirectDatabaseAclCount: 0;
      readonly expectedSchemaUsageAclCount: 2;
      readonly expectedArchivedRelationSelectAclCount: 59;
      readonly expectedRequiredEmptyKernelSelectAclCount: 2;
      readonly expectedTotalRelationSelectAclCount: 61;
      readonly expectedSharedDependencyCount: 63;
      readonly expectedRelationWriteAclCount: 0;
      readonly expectedColumnAclCount: 0;
      readonly expectedSequenceAclCount: 0;
      readonly expectedRoutineAclCount: 0;
      readonly expectedOwnedObjectCount: 0;
      readonly expectedMembershipsGrantedCount: 0;
      readonly expectedMembershipsReceivedCount: 0;
      readonly expectedRoleSettingCount: 0;
      readonly claimedCatalogEvidenceSha256: string;
    };
    readonly ephemeralLogin: ExpectedRoleSafetyFlagsV2 & {
      readonly roleName: string;
      readonly claimedRoleOid: string;
      readonly versionToken: string;
      readonly login: true;
      readonly connectionLimit: 2;
      readonly validUntilRequired: true;
      readonly validUntilBoundToLifecycleAtCompletion: true;
      readonly passwordVerifierFormatRequired: "scram-sha-256";
      readonly expectedDirectTargetDatabaseConnectAclCount: 1;
      readonly expectedSharedDependencyCount: 1;
      readonly expectedOtherDirectDatabaseAclCount: 0;
      readonly expectedSchemaAclCount: 0;
      readonly expectedRelationAclCount: 0;
      readonly expectedColumnAclCount: 0;
      readonly expectedSequenceAclCount: 0;
      readonly expectedRoutineAclCount: 0;
      readonly expectedOwnedObjectCount: 0;
      readonly expectedRoleSettingCount: 0;
      readonly effectiveTargetOnlyDatabaseAccessRequired: false;
      readonly effectiveTargetOnlyDatabaseAccessVerified: false;
      readonly completeRoleGraphVerified: false;
      readonly claimedCatalogEvidenceSha256: string;
    };
    readonly projectionVerifiedByThisModule: false;
    readonly authorityProjectionSha256: string;
  };
  readonly membershipCeremony: {
    readonly expectedSetOnlyMembershipCountSequence: readonly [1, 0, 1, 0];
    readonly transitions: readonly [
      MembershipTransitionRecordV2,
      MembershipTransitionRecordV2,
      MembershipTransitionRecordV2,
      MembershipTransitionRecordV2,
    ];
    readonly ceremonyVerifiedByThisModule: false;
    readonly ceremonyBindingSha256: string;
  };
  readonly archiveClaims: {
    readonly claimedSourceStateCaptureSha256: string;
    readonly claimedExportedSnapshotBindingSha256: string;
    readonly claimedPgDumpArgumentsBindingSha256: string;
    readonly claimedPgDumpExecutableSha256: string;
    readonly claimedPgRestoreExecutableSha256: string;
    readonly claimedArchiveSha256: string;
    readonly claimedArchiveListingSha256: string;
    readonly claimedArchiveByteLength: number;
  };
  readonly operationalCompletion:
    PostgresLogicalBackupV4SourceAuthorityOperationalCompletionV2;
  readonly evidenceSemantics: {
    readonly allCallerEvidenceHashesAreUnverifiedClaims: true;
    readonly callerEvidenceVerifiedByThisModule: false;
    readonly serializedReceiptIsAuthority: false;
    readonly operationalSourceAuthorityImplemented: false;
    readonly sourceAuthorityGranted: false;
    readonly archiveContentAuthorityGranted: false;
    readonly artifactEmissionAuthorized: false;
    readonly activationAuthorized: false;
    readonly productionCutoverAuthorized: false;
  };
  readonly receiptBindingSha256: string;
}

function roleProjectionBinding(
  projection: Omit<PostgresLogicalBackupV4SourceAuthorityReceiptV2["authorityProjection"],
    "authorityProjectionSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-source-authority-projection",
    projection,
  );
}

function transitionBinding(
  transition: Omit<MembershipTransitionRecordV2, "transitionBindingSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-membership-transition",
    transition,
  );
}

function ceremonyBinding(
  transitions: readonly MembershipTransitionRecordV2[],
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-membership-ceremony",
    { expectedSetOnlyMembershipCountSequence: [1, 0, 1, 0], transitions },
  );
}

function operationalCompletionBinding(
  completion: Omit<PostgresLogicalBackupV4SourceAuthorityOperationalCompletionV2,
    "completionBindingSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-operational-completion-evidence-projection",
    completion,
  );
}

function authorityEvidenceBinding(
  evidence: Omit<PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["authorityEvidence"],
    "authorityEvidenceBindingSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-completed-authority-evidence",
    evidence,
  );
}

function sourceSessionEvidenceBinding(
  sessions: Omit<PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["sessions"],
    "sessionEvidenceBindingSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-completed-session-evidence",
    sessions,
  );
}

function sourceCaptureBinding(
  capture: Omit<PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["v2Capture"],
    "captureBindingSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-completed-v2-capture",
    capture,
  );
}

function snapshotBindings(input: {
  readonly sourceDatabaseOid: string;
  readonly databaseIdentitySha256: string;
  readonly sourceUrlSha256: string;
  readonly effectiveRoleName: string;
  readonly snapshotIdentifierSha256: string;
}): {
  readonly roleArgumentSha256: string;
  readonly exportedSnapshotBindingSha256: string;
  readonly pgDumpSnapshotSemanticBindingSha256: string;
  readonly semanticHandoffBindingSha256: string;
} {
  const roleArgumentSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-pg-dump-role-argument",
    { argument: `--role=${input.effectiveRoleName}` },
  );
  const exportedSnapshotBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-exported-snapshot-binding",
    { ...input, transactionIsolation: "repeatable read", transactionReadOnly: true },
  );
  const pgDumpSnapshotSemanticBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-pg-dump-snapshot-semantic-binding",
    { snapshotIdentifierSha256: input.snapshotIdentifierSha256 },
  );
  const semanticHandoffBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-snapshot-handoff-semantic-binding",
    {
      ...input,
      exportedSnapshotBindingSha256,
      pgDumpSnapshotSemanticBindingSha256,
    },
  );
  return {
    roleArgumentSha256,
    exportedSnapshotBindingSha256,
    pgDumpSnapshotSemanticBindingSha256,
    semanticHandoffBindingSha256,
  };
}

function pgDumpArgumentsBinding(input: {
  readonly pgDumpExactArgumentsSha256: string;
  readonly roleArgumentSha256: string;
  readonly pgDumpSnapshotSemanticBindingSha256: string;
  readonly semanticHandoffBindingSha256: string;
}): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-pg-dump-arguments-binding",
    input,
  );
}

function listArgumentsBinding(input: {
  readonly listExactArgumentsSha256: string;
  readonly pgRestoreExecutableSha256: string;
}): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-list-arguments-binding",
    { ...input, operation: "list-v4", stdoutMode: "raw" },
  );
}

function toolRuntimeBinding(
  tools: Omit<PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["tools"],
    "toolRuntimeBindingSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-tool-runtime-evidence",
    tools,
  );
}

function stableArchiveIdentityBinding(input: {
  readonly archiveIdentityBeforeSha256: string;
  readonly archiveIdentityBeforeDigestSha256: string;
  readonly archiveIdentityAfterDigestSha256: string;
  readonly archiveIdentityBeforeListingSha256: string;
  readonly archiveIdentityAfterListingSha256: string;
  readonly archiveIdentityAfterSha256: string;
  readonly archiveByteLength: number;
  readonly dumpAndListUsedSameRetainedArchiveDescriptor: true;
}): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-stable-archive-identity",
    input,
  );
}

interface StrictTocEvidenceProjectionV2 {
  readonly listingSha256: string;
  readonly listingByteLength: number;
  readonly archiveCreatedAt: string;
  readonly databaseName: string;
  readonly dumpedFromDatabaseVersion: string;
  readonly dumpedByPgDumpVersion: string;
  readonly tocEntryCount: 63;
  readonly tocTableDataEntryCount: 59;
  readonly tocTableDataSetSha256: typeof PINNED_ARCHIVED_TABLE_SET_SHA256;
}

function tocEvidenceBinding(input: StrictTocEvidenceProjectionV2): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-strict-toc-semantic-evidence",
    input,
  );
}

function tocBinding(input: StrictTocEvidenceProjectionV2 & {
  readonly tocEvidenceSha256: string;
}): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-toc-evidence-binding",
    input,
  );
}

function archiveCustodyBinding(
  custody: Omit<PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["archiveCustody"],
    "archiveCustodyBindingSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-archive-custody-and-toc",
    custody,
  );
}

function receiptBinding(
  receipt: Omit<PostgresLogicalBackupV4SourceAuthorityReceiptV2, "receiptBindingSha256">,
): string {
  return domainHash(
    "pintpath-postgres-logical-backup-v4-source-archive-record",
    receipt,
  );
}

function expectedRoleSafety(value: Record<string, unknown>, login: boolean): boolean {
  return value.login === login
    && value.inherit === false
    && value.superuser === false
    && value.createDatabase === false
    && value.createRole === false
    && value.replication === false
    && value.bypassRls === false;
}

function validateOperationalCompletion(
  value: unknown,
  receipt: Record<string, unknown> & {
    source: Record<string, unknown>;
    authorityProjection: Record<string, unknown>;
    membershipCeremony: Record<string, unknown>;
    archiveClaims: Record<string, unknown>;
  },
): asserts value is PostgresLogicalBackupV4SourceAuthorityOperationalCompletionV2 {
  if (!isPlainObject(value) || !safeHash(value.completionBindingSha256)) {
    fail("receipt_invalid");
  }
  const { completionBindingSha256: _binding, ...withoutBinding } = value;
  if (value.completionBindingSha256 !== operationalCompletionBinding(
    withoutBinding as Omit<
      PostgresLogicalBackupV4SourceAuthorityOperationalCompletionV2,
      "completionBindingSha256"
    >,
  )) fail("receipt_invalid");
  if (value.state === "PENDING_LIVE_RECORDER") {
    if (!exactKeys(value, [
      "state", "completed", "pendingReason", "independentLiveRecorderBrandRequired",
      "independentLiveRecorderBrandSerialized", "completionObservationVerifiedByThisModule",
      "completionBindingSha256",
    ])
      || value.completed !== false
      || value.pendingReason !== "PASSIVE_BUILDER_CANNOT_VERIFY_LIVE_EVIDENCE"
      || value.independentLiveRecorderBrandRequired !== true
      || value.independentLiveRecorderBrandSerialized !== false
      || value.completionObservationVerifiedByThisModule !== false) fail("receipt_invalid");
    return;
  }
  if (!exactKeys(value, [
    "state", "completed", "independentLiveRecorderBrandRequired",
    "independentLiveRecorderBrandSerialized", "serializedCompletionObservationOnly",
    "completionObservationVerifiedByThisModule", "passivePolicyRecordSha256",
    "authorityEvidence", "lifecycle",
    "sessions", "v2Capture", "snapshotHandoff", "tools", "archiveCustody", "cleanup",
    "completionBindingSha256",
  ])
    || value.state !== "COMPLETED_EVIDENCE_PROJECTION"
    || value.completed !== true
    || value.independentLiveRecorderBrandRequired !== true
    || value.independentLiveRecorderBrandSerialized !== false
    || value.serializedCompletionObservationOnly !== true
    || value.completionObservationVerifiedByThisModule !== false
    || value.passivePolicyRecordSha256
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SHA256) {
    fail("receipt_invalid");
  }

  const authorityEvidence = value.authorityEvidence;
  const authorityProjection = receipt.authorityProjection;
  const authorityBackupGroup = authorityProjection.backupGroup as Record<string, unknown>;
  const authorityLogin = authorityProjection.ephemeralLogin as Record<string, unknown>;
  if (!isPlainObject(authorityEvidence) || !exactKeys(authorityEvidence, [
    "backupGroupCatalogProjectionVerified", "ephemeralLoginCatalogProjectionVerified",
    "membershipCeremonyVerified",
    "authorityProjectionSha256", "membershipCeremonyBindingSha256",
    "backupGroupCatalogEvidenceSha256", "ephemeralLoginCatalogEvidenceSha256",
    "ephemeralLoginValidUntil", "authorityEvidenceBindingSha256",
  ])
    || authorityEvidence.backupGroupCatalogProjectionVerified !== true
    || authorityEvidence.ephemeralLoginCatalogProjectionVerified !== true
    || authorityEvidence.membershipCeremonyVerified !== true
    || authorityEvidence.authorityProjectionSha256
      !== authorityProjection.authorityProjectionSha256
    || authorityEvidence.membershipCeremonyBindingSha256
      !== receipt.membershipCeremony.ceremonyBindingSha256
    || authorityEvidence.backupGroupCatalogEvidenceSha256
      !== authorityBackupGroup.claimedCatalogEvidenceSha256
    || authorityEvidence.ephemeralLoginCatalogEvidenceSha256
      !== authorityLogin.claimedCatalogEvidenceSha256
    || !exactIsoInstant(authorityEvidence.ephemeralLoginValidUntil)
    || !safeHash(authorityEvidence.authorityEvidenceBindingSha256)) fail("receipt_invalid");
  const { authorityEvidenceBindingSha256: _authorityEvidenceBinding,
    ...authorityEvidenceWithoutBinding } = authorityEvidence;
  if (authorityEvidence.authorityEvidenceBindingSha256 !== authorityEvidenceBinding(
    authorityEvidenceWithoutBinding as Omit<
      PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["authorityEvidence"],
      "authorityEvidenceBindingSha256"
    >,
  )) fail("receipt_invalid");

  const lifecycle = value.lifecycle;
  const lifecycleKeys = [
    "startedAt", "expiresAt", "maxLifetimeSeconds", "serverClockObservedAt",
    "serverClockEvidenceSha256", "loginValidUntil", "loginProvisionedAt",
    "sourceAuthenticatedAt", "membershipDetachedAt", "sourceTransactionBeganAt",
    "v2CaptureCompletedAt", "snapshotExportedAt", "membershipRegrantedAt",
    "pgDumpStartedAt", "pgDumpAuthenticatedAt", "pgDumpSnapshotImportedAt",
    "pgDumpCompletedAt", "archiveListedAt",
    "sourceTransactionEndedAt", "cleanupStartedAt", "loginDisabledAt", "loginDroppedAt",
    "cleanupCompletedAt", "pgDumpWatchdogMilliseconds", "cleanupReserveMilliseconds",
    "absoluteDeadline", "lifecycleEvidenceSha256",
  ] as const;
  if (!isPlainObject(lifecycle) || !exactKeys(lifecycle, lifecycleKeys)
    || !lifecycleKeys.filter((key) => key.endsWith("At") || key === "expiresAt")
      .every((key) => exactIsoInstant(lifecycle[key]))
    || lifecycle.maxLifetimeSeconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_LIFETIME_SECONDS
    || lifecycle.loginValidUntil !== lifecycle.expiresAt
    || authorityEvidence.ephemeralLoginValidUntil !== lifecycle.expiresAt
    || lifecycle.pgDumpWatchdogMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_DUMP_WATCHDOG_MILLISECONDS
    || lifecycle.cleanupReserveMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CLEANUP_RESERVE_MILLISECONDS
    || !safeHash(lifecycle.serverClockEvidenceSha256)
    || !safeHash(lifecycle.lifecycleEvidenceSha256)) fail("receipt_invalid");
  const orderedLifecycleKeys = [
    "startedAt", "serverClockObservedAt", "loginProvisionedAt", "sourceAuthenticatedAt",
    "membershipDetachedAt", "sourceTransactionBeganAt", "v2CaptureCompletedAt",
    "snapshotExportedAt", "membershipRegrantedAt", "pgDumpStartedAt",
    "pgDumpAuthenticatedAt", "pgDumpSnapshotImportedAt", "pgDumpCompletedAt",
    "archiveListedAt", "sourceTransactionEndedAt",
    "cleanupStartedAt", "loginDisabledAt", "loginDroppedAt", "cleanupCompletedAt",
  ] as const;
  const orderedTimes = orderedLifecycleKeys.map((key) => lifecycle[key] as string);
  const startedMilliseconds = Date.parse(lifecycle.startedAt as string);
  const expiresMilliseconds = Date.parse(lifecycle.expiresAt as string);
  const latestWatchdogDeadline = expiresMilliseconds
    - POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CLEANUP_RESERVE_MILLISECONDS;
  const expectedDeadline = new Date(Math.min(
    Date.parse(lifecycle.membershipRegrantedAt as string)
      + POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_DUMP_WATCHDOG_MILLISECONDS,
    latestWatchdogDeadline,
  )).toISOString();
  if (orderedTimes.some((instant, index) => index > 0
      && Date.parse(instant) < Date.parse(orderedTimes[index - 1]!))
    || expiresMilliseconds <= startedMilliseconds
    || expiresMilliseconds - startedMilliseconds
      > POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_LIFETIME_SECONDS * 1000
    || Date.parse(lifecycle.membershipRegrantedAt as string) >= latestWatchdogDeadline
    || lifecycle.absoluteDeadline !== expectedDeadline
    || Date.parse(lifecycle.pgDumpCompletedAt as string) > Date.parse(expectedDeadline)
    || Date.parse(lifecycle.archiveListedAt as string) > Date.parse(expectedDeadline)
    || Date.parse(lifecycle.sourceTransactionEndedAt as string) > Date.parse(expectedDeadline)
    || Date.parse(lifecycle.cleanupCompletedAt as string) > expiresMilliseconds
    || receipt.createdAt !== lifecycle.cleanupCompletedAt) {
    fail("receipt_invalid");
  }
  const ceremonyTransitions = receipt.membershipCeremony.transitions;
  if (!Array.isArray(ceremonyTransitions)
    || ceremonyTransitions.length !== 4
    || !isPlainObject(ceremonyTransitions[0])
    || ceremonyTransitions[0].claimedObservedAt !== lifecycle.loginProvisionedAt
    || !isPlainObject(ceremonyTransitions[1])
    || ceremonyTransitions[1].claimedObservedAt !== lifecycle.membershipDetachedAt
    || !isPlainObject(ceremonyTransitions[2])
    || ceremonyTransitions[2].claimedObservedAt !== lifecycle.membershipRegrantedAt
    || !isPlainObject(ceremonyTransitions[3])
    || ceremonyTransitions[3].claimedObservedAt !== lifecycle.cleanupCompletedAt) {
    fail("receipt_invalid");
  }

  const authority = receipt.authorityProjection;
  const backupGroup = authority.backupGroup as Record<string, unknown>;
  const login = authority.ephemeralLogin as Record<string, unknown>;
  const sessions = value.sessions;
  if (!isPlainObject(sessions) || !exactKeys(sessions, [
    "sourceSessionIdentitySha256", "independentAdminSessionIdentitySha256",
    "pgDumpSessionIdentitySha256", "sourceSessionIdentityVerified",
    "independentAdminSessionIdentityVerified", "pgDumpSessionIdentityVerified",
    "sourceScramAuthenticationVerified", "pgDumpScramAuthenticationVerified",
    "sourceAuthenticationEvidenceSha256", "pgDumpAuthenticationEvidenceSha256",
    "sourceAuthenticatedAt", "pgDumpAuthenticatedAt", "sourceDatabaseVersion",
    "sourceCurrentUserRoleName", "sourceSessionUserRoleName", "pgDumpCurrentUserRoleName",
    "pgDumpSessionUserRoleName", "sourceTransactionIsolation", "sourceTransactionReadOnly",
    "sourceStatementTimeoutMilliseconds", "sourceIdleInTransactionSessionTimeoutMilliseconds",
    "sourceIdleSessionTimeoutMilliseconds", "sourceTransactionTimeoutMilliseconds",
    "sessionEvidenceBindingSha256",
  ])
    || !safeHash(sessions.sourceSessionIdentitySha256)
    || !safeHash(sessions.independentAdminSessionIdentitySha256)
    || !safeHash(sessions.pgDumpSessionIdentitySha256)
    || new Set([
      sessions.sourceSessionIdentitySha256,
      sessions.independentAdminSessionIdentitySha256,
      sessions.pgDumpSessionIdentitySha256,
    ]).size !== 3
    || sessions.sourceSessionIdentityVerified !== true
    || sessions.independentAdminSessionIdentityVerified !== true
    || sessions.pgDumpSessionIdentityVerified !== true
    || sessions.sourceScramAuthenticationVerified !== true
    || sessions.pgDumpScramAuthenticationVerified !== true
    || !safeHash(sessions.sourceAuthenticationEvidenceSha256)
    || !safeHash(sessions.pgDumpAuthenticationEvidenceSha256)
    || sessions.sourceAuthenticatedAt !== lifecycle.sourceAuthenticatedAt
    || sessions.pgDumpAuthenticatedAt !== lifecycle.pgDumpAuthenticatedAt
    || !exactBarePostgres17Version(sessions.sourceDatabaseVersion)
    || sessions.sourceCurrentUserRoleName !== backupGroup.roleName
    || sessions.pgDumpCurrentUserRoleName !== backupGroup.roleName
    || sessions.sourceSessionUserRoleName !== login.roleName
    || sessions.pgDumpSessionUserRoleName !== login.roleName
    || sessions.sourceTransactionIsolation !== "repeatable read"
    || sessions.sourceTransactionReadOnly !== true
    || sessions.sourceStatementTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_STATEMENT_TIMEOUT_MILLISECONDS
    || sessions.sourceIdleInTransactionSessionTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS
    || sessions.sourceIdleSessionTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS
    || sessions.sourceTransactionTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS
    || !safeHash(sessions.sessionEvidenceBindingSha256)) fail("receipt_invalid");
  const { sessionEvidenceBindingSha256: _sessionBinding, ...sessionsWithoutBinding } = sessions;
  if (sessions.sessionEvidenceBindingSha256 !== sourceSessionEvidenceBinding(
    sessionsWithoutBinding as Omit<
      PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["sessions"],
      "sessionEvidenceBindingSha256"
    >,
  )) fail("receipt_invalid");

  const capture = value.v2Capture;
  if (!isPlainObject(capture) || !exactKeys(capture, [
    "sourceDatabaseOid", "captureSha256", "portableReadBoundarySha256",
    "sourcePhysicalReadBoundarySha256", "sourcePhysicalReadBoundaryClassification",
    "overallStateSha256", "independentFullV2ValidationPerformed",
    "v2ValidatorProfile", "v2ValidatorVersion", "v2ValidatorSourceSha256",
    "independentLiveV2ValidatorBrandRequired",
    "sameSourceSessionVerified", "sourceSessionIdentitySha256", "capturedAt",
    "captureSequence", "captureBindingSha256",
  ])
    || capture.sourceDatabaseOid !== receipt.source.databaseOid
    || !safeHash(capture.captureSha256)
    || capture.portableReadBoundarySha256 !== PINNED_PORTABLE_READ_BOUNDARY_SHA256
    || !safeHash(capture.sourcePhysicalReadBoundarySha256)
    || capture.sourcePhysicalReadBoundaryClassification
      !== "OID_OWNER_SENSITIVE_SELECTED_DATA_READ_SAFETY_EVIDENCE_ONLY"
    || !safeHash(capture.overallStateSha256)
    || capture.independentFullV2ValidationPerformed !== true
    || capture.v2ValidatorProfile !== PINNED_V2_VALIDATOR_PROFILE
    || capture.v2ValidatorVersion !== 2
    || capture.v2ValidatorSourceSha256 !== PINNED_V2_VALIDATOR_SOURCE_SHA256
    || capture.independentLiveV2ValidatorBrandRequired !== true
    || capture.sameSourceSessionVerified !== true
    || capture.sourceSessionIdentitySha256 !== sessions.sourceSessionIdentitySha256
    || capture.capturedAt !== lifecycle.v2CaptureCompletedAt
    || capture.captureSequence !== 1
    || !safeHash(capture.captureBindingSha256)) fail("receipt_invalid");
  const { captureBindingSha256: _captureBinding, ...captureWithoutBinding } = capture;
  if (capture.captureBindingSha256 !== sourceCaptureBinding(
    captureWithoutBinding as Omit<
      PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["v2Capture"],
      "captureBindingSha256"
    >,
  ) || capture.captureSha256 !== receipt.archiveClaims.claimedSourceStateCaptureSha256) {
    fail("receipt_invalid");
  }

  const handoff = value.snapshotHandoff;
  if (!isPlainObject(handoff) || !exactKeys(handoff, [
    "snapshotIdentifierSha256", "rawSnapshotIdentifierPersisted", "exportedAt",
    "exportSequence", "pgDumpImportedAt", "sourceSessionIdentitySha256",
    "pgDumpSessionIdentitySha256", "roleArgumentSha256", "exportedSnapshotBindingSha256",
    "pgDumpSnapshotSemanticBindingSha256", "semanticHandoffBindingSha256",
    "sameSnapshotSemanticBindingVerified",
  ])
    || !safeHash(handoff.snapshotIdentifierSha256)
    || handoff.rawSnapshotIdentifierPersisted !== false
    || handoff.exportedAt !== lifecycle.snapshotExportedAt
    || handoff.exportSequence !== 2
    || handoff.pgDumpImportedAt !== lifecycle.pgDumpSnapshotImportedAt
    || handoff.sourceSessionIdentitySha256 !== sessions.sourceSessionIdentitySha256
    || handoff.pgDumpSessionIdentitySha256 !== sessions.pgDumpSessionIdentitySha256
    || handoff.sameSnapshotSemanticBindingVerified !== true) fail("receipt_invalid");
  const derivedSnapshot = snapshotBindings({
    sourceDatabaseOid: receipt.source.databaseOid as string,
    databaseIdentitySha256: receipt.source.claimedDatabaseIdentitySha256 as string,
    sourceUrlSha256: receipt.source.claimedSourceUrlSha256 as string,
    effectiveRoleName: backupGroup.roleName as string,
    snapshotIdentifierSha256: handoff.snapshotIdentifierSha256,
  });
  if (handoff.roleArgumentSha256 !== derivedSnapshot.roleArgumentSha256
    || handoff.exportedSnapshotBindingSha256
      !== derivedSnapshot.exportedSnapshotBindingSha256
    || handoff.pgDumpSnapshotSemanticBindingSha256
      !== derivedSnapshot.pgDumpSnapshotSemanticBindingSha256
    || handoff.semanticHandoffBindingSha256
      !== derivedSnapshot.semanticHandoffBindingSha256
    || handoff.exportedSnapshotBindingSha256
      !== receipt.archiveClaims.claimedExportedSnapshotBindingSha256) fail("receipt_invalid");

  const tools = value.tools;
  if (!isPlainObject(tools) || !exactKeys(tools, [
    "pgDumpExecutableSha256", "pgDumpVersion", "pgDumpVersionEvidenceSha256",
    "pgDumpExecutableProvenanceVerified", "pgDumpExecutableProvenanceEvidenceSha256",
    "pgDumpNativeRuntimeClosureVerified", "pgDumpNativeRuntimeClosureEvidenceSha256",
    "pgDumpRuntimeEvidenceSha256", "pgDumpExactArgumentsSha256",
    "pgDumpArgumentsBindingSha256", "pgDumpExitCode", "pgDumpStdoutByteLength",
    "pgDumpStderrByteLength",
    "pgDumpRequireAuth", "pgDumpDatabaseArgumentKind", "pgRestoreExecutableSha256",
    "pgRestoreExecutableProvenanceVerified", "pgRestoreExecutableProvenanceEvidenceSha256",
    "pgRestoreNativeRuntimeClosureVerified", "pgRestoreNativeRuntimeClosureEvidenceSha256",
    "pgRestoreVersion", "pgRestoreVersionEvidenceSha256", "listRuntimeEvidenceSha256",
    "listExactArgumentsSha256", "listArgumentsBindingSha256",
    "listExitCode", "listStderrByteLength", "rawListingBytesPreserved",
    "toolRuntimeBindingSha256",
  ])
    || !Object.entries(tools).filter(([key]) => key.endsWith("Sha256"))
      .every(([, entry]) => safeHash(entry))
    || tools.pgDumpExecutableSha256 !== receipt.archiveClaims.claimedPgDumpExecutableSha256
    || tools.pgRestoreExecutableSha256 !== receipt.archiveClaims.claimedPgRestoreExecutableSha256
    || tools.pgDumpExecutableProvenanceVerified !== true
    || !safeHash(tools.pgDumpExecutableProvenanceEvidenceSha256)
    || tools.pgDumpNativeRuntimeClosureVerified !== true
    || !safeHash(tools.pgDumpNativeRuntimeClosureEvidenceSha256)
    || tools.pgRestoreExecutableProvenanceVerified !== true
    || !safeHash(tools.pgRestoreExecutableProvenanceEvidenceSha256)
    || tools.pgRestoreNativeRuntimeClosureVerified !== true
    || !safeHash(tools.pgRestoreNativeRuntimeClosureEvidenceSha256)
    || !exactBarePostgres17Version(tools.pgDumpVersion)
    || !exactBarePostgres17Version(tools.pgRestoreVersion)
    || tools.pgDumpExitCode !== 0 || tools.pgDumpStdoutByteLength !== 0
    || tools.pgDumpStderrByteLength !== 0
    || tools.pgDumpRequireAuth !== "scram-sha-256"
    || tools.pgDumpDatabaseArgumentKind !== "CANONICAL_DATABASE_IDENTIFIER"
    || tools.listExitCode !== 0 || tools.listStderrByteLength !== 0
    || tools.rawListingBytesPreserved !== true
    || tools.listArgumentsBindingSha256 !== listArgumentsBinding({
      listExactArgumentsSha256: tools.listExactArgumentsSha256 as string,
      pgRestoreExecutableSha256: tools.pgRestoreExecutableSha256 as string,
    })
    || tools.pgDumpArgumentsBindingSha256 !== pgDumpArgumentsBinding({
      pgDumpExactArgumentsSha256: tools.pgDumpExactArgumentsSha256 as string,
      roleArgumentSha256: handoff.roleArgumentSha256,
      pgDumpSnapshotSemanticBindingSha256: handoff.pgDumpSnapshotSemanticBindingSha256,
      semanticHandoffBindingSha256: handoff.semanticHandoffBindingSha256,
    })
    || tools.pgDumpArgumentsBindingSha256
      !== receipt.archiveClaims.claimedPgDumpArgumentsBindingSha256) fail("receipt_invalid");
  const { toolRuntimeBindingSha256: _toolBinding, ...toolsWithoutBinding } = tools;
  if (tools.toolRuntimeBindingSha256 !== toolRuntimeBinding(
    toolsWithoutBinding as Omit<
      PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["tools"],
      "toolRuntimeBindingSha256"
    >,
  )) fail("receipt_invalid");

  const custody = value.archiveCustody;
  if (!isPlainObject(custody) || !exactKeys(custody, [
    "archiveSha256", "archiveByteLength", "archiveIdentityBeforeSha256",
    "archiveIdentityBeforeDigestSha256", "archiveIdentityAfterDigestSha256",
    "archiveIdentityBeforeListingSha256", "archiveIdentityAfterListingSha256",
    "archiveIdentityAfterSha256", "stableArchiveIdentitySha256", "archiveIdentityStable",
    "dumpAndListUsedSameRetainedArchiveDescriptor",
    "listingSha256", "listingByteLength", "archiveCreatedAt", "databaseName",
    "dumpedFromDatabaseVersion", "dumpedByPgDumpVersion",
    "tocEntryCount", "tocTableDataEntryCount",
    "tocTableDataSetSha256", "tocEvidenceSha256", "rawListingHashMatchesTocEvidence",
    "tocBindingSha256", "strictTocParserValidationPerformed", "strictTocParserProfile",
    "strictTocParserVersion", "strictTocParserSourceSha256",
    "independentStrictTocParserBrandRequired",
    "archiveCustodyBindingSha256",
  ])
    || custody.archiveSha256 !== receipt.archiveClaims.claimedArchiveSha256
    || custody.archiveByteLength !== receipt.archiveClaims.claimedArchiveByteLength
    || !Number.isSafeInteger(custody.archiveByteLength) || Number(custody.archiveByteLength) < 1
    || !safeHash(custody.archiveIdentityBeforeSha256)
    || custody.archiveIdentityBeforeDigestSha256 !== custody.archiveIdentityBeforeSha256
    || custody.archiveIdentityAfterDigestSha256 !== custody.archiveIdentityBeforeSha256
    || custody.archiveIdentityBeforeListingSha256 !== custody.archiveIdentityBeforeSha256
    || custody.archiveIdentityAfterListingSha256 !== custody.archiveIdentityBeforeSha256
    || custody.archiveIdentityAfterSha256 !== custody.archiveIdentityBeforeSha256
    || custody.archiveIdentityStable !== true
    || custody.dumpAndListUsedSameRetainedArchiveDescriptor !== true
    || custody.stableArchiveIdentitySha256 !== stableArchiveIdentityBinding({
      archiveIdentityBeforeSha256: custody.archiveIdentityBeforeSha256,
      archiveIdentityBeforeDigestSha256: custody.archiveIdentityBeforeDigestSha256,
      archiveIdentityAfterDigestSha256: custody.archiveIdentityAfterDigestSha256,
      archiveIdentityBeforeListingSha256: custody.archiveIdentityBeforeListingSha256,
      archiveIdentityAfterListingSha256: custody.archiveIdentityAfterListingSha256,
      archiveIdentityAfterSha256: custody.archiveIdentityAfterSha256,
      archiveByteLength: custody.archiveByteLength as number,
      dumpAndListUsedSameRetainedArchiveDescriptor: true,
    })
    || custody.listingSha256 !== receipt.archiveClaims.claimedArchiveListingSha256
    || !Number.isSafeInteger(custody.listingByteLength)
    || Number(custody.listingByteLength) < 1
    || Number(custody.listingByteLength) > 65_536
    || !exactTocArchiveCreatedAt(custody.archiveCreatedAt)
    || custody.databaseName !== receipt.source.databaseName
    || custody.dumpedFromDatabaseVersion !== sessions.sourceDatabaseVersion
    || custody.dumpedByPgDumpVersion !== tools.pgDumpVersion
    || !exactBarePostgres17Version(custody.dumpedFromDatabaseVersion)
    || !exactBarePostgres17Version(custody.dumpedByPgDumpVersion)
    || custody.tocEntryCount !== 63
    || custody.tocTableDataEntryCount !== 59
    || custody.tocTableDataSetSha256 !== PINNED_ARCHIVED_TABLE_SET_SHA256
    || custody.tocEvidenceSha256 !== tocEvidenceBinding({
      listingSha256: custody.listingSha256 as string,
      listingByteLength: custody.listingByteLength as number,
      archiveCreatedAt: custody.archiveCreatedAt as string,
      databaseName: custody.databaseName as string,
      dumpedFromDatabaseVersion: custody.dumpedFromDatabaseVersion as string,
      dumpedByPgDumpVersion: custody.dumpedByPgDumpVersion as string,
      tocEntryCount: 63,
      tocTableDataEntryCount: 59,
      tocTableDataSetSha256: PINNED_ARCHIVED_TABLE_SET_SHA256,
    })
    || custody.strictTocParserValidationPerformed !== true
    || custody.strictTocParserProfile !== PINNED_STRICT_TOC_PARSER_PROFILE
    || custody.strictTocParserVersion !== 1
    || custody.strictTocParserSourceSha256 !== PINNED_STRICT_TOC_PARSER_SOURCE_SHA256
    || custody.independentStrictTocParserBrandRequired !== true
    || custody.tocBindingSha256 !== tocBinding({
      listingSha256: custody.listingSha256 as string,
      listingByteLength: custody.listingByteLength as number,
      archiveCreatedAt: custody.archiveCreatedAt as string,
      databaseName: custody.databaseName as string,
      dumpedFromDatabaseVersion: custody.dumpedFromDatabaseVersion as string,
      dumpedByPgDumpVersion: custody.dumpedByPgDumpVersion as string,
      tocEntryCount: 63,
      tocTableDataEntryCount: 59,
      tocTableDataSetSha256: PINNED_ARCHIVED_TABLE_SET_SHA256,
      tocEvidenceSha256: custody.tocEvidenceSha256 as string,
    })
    || custody.rawListingHashMatchesTocEvidence !== true
    || !safeHash(custody.archiveCustodyBindingSha256)) fail("receipt_invalid");
  const { archiveCustodyBindingSha256: _custodyBinding, ...custodyWithoutBinding } = custody;
  if (custody.archiveCustodyBindingSha256 !== archiveCustodyBinding(
    custodyWithoutBinding as Omit<
      PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2["archiveCustody"],
      "archiveCustodyBindingSha256"
    >,
  )) fail("receipt_invalid");

  const cleanup = value.cleanup;
  if (!isPlainObject(cleanup) || !exactKeys(cleanup, [
    "membershipRevoked", "exactSetOnlyMembershipCount", "loginDisabledNoLogin",
    "loginDropped", "backendTerminationAttempted", "terminatedBackendCount",
    "activeSessionCount", "cleanupEvidenceSha256", "cleanupComplete",
  ])
    || cleanup.membershipRevoked !== true
    || cleanup.exactSetOnlyMembershipCount !== 0
    || cleanup.loginDisabledNoLogin !== true
    || cleanup.loginDropped !== true
    || cleanup.backendTerminationAttempted !== true
    || !Number.isSafeInteger(cleanup.terminatedBackendCount)
    || Number(cleanup.terminatedBackendCount) < 0
    || cleanup.activeSessionCount !== 0
    || !safeHash(cleanup.cleanupEvidenceSha256)
    || cleanup.cleanupComplete !== true) fail("receipt_invalid");
}

function validateReceipt(value: unknown): asserts value is PostgresLogicalBackupV4SourceAuthorityReceiptV2 {
  if (isPlainObject(value)
    && value.kind === "pintpath-postgres-logical-backup-source-authority"
    && value.version === 1) fail("receipt_v1_rejected");
  if (!isPlainObject(value) || !exactKeys(value, [
    "kind", "version", "classification", "profile", "policySha256", "createdAt",
    "source", "selectedData", "authorityProjection",
    "membershipCeremony", "archiveClaims", "operationalCompletion", "evidenceSemantics",
    "receiptBindingSha256",
  ])
    || value.kind !== "pintpath-postgres-logical-backup-source-authority"
    || value.version !== 2
    || value.classification !== "CANONICAL_SOURCE_ARCHIVE_RECORD_ONLY"
    || value.profile !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_PROFILE
    || value.policySha256 !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SHA256
    || !exactIsoInstant(value.createdAt)
    || !safeHash(value.receiptBindingSha256)) fail("receipt_invalid");

  if (!isPlainObject(value.source) || !exactKeys(value.source, [
    "databaseOid", "databaseName", "claimedDatabaseIdentitySha256", "claimedSourceUrlSha256",
    "portableReadBoundarySha256",
  ])
    || !exactOid(value.source.databaseOid)
    || !exactDatabaseName(value.source.databaseName)
    || !safeHash(value.source.claimedDatabaseIdentitySha256)
    || !safeHash(value.source.claimedSourceUrlSha256)
    || value.source.portableReadBoundarySha256 !== PINNED_PORTABLE_READ_BOUNDARY_SHA256) {
    fail("receipt_invalid");
  }

  if (!isPlainObject(value.selectedData) || !exactKeys(value.selectedData, [
    "archivedRelationCount", "requiredEmptyKernelRelationCount", "totalSourceRelationCount",
    "archivedTableSetSha256", "relationDispositionSetSha256", "requiredEmptyRelationSetSha256",
    "policySetSha256", "rlsEnabledRelationCount", "forceRlsRelationCount",
    "logicalBackupSelectPolicyCount", "reviewedOtherPolicyCount", "totalPolicyCount",
  ])
    || value.selectedData.archivedRelationCount !== 59
    || value.selectedData.requiredEmptyKernelRelationCount !== 2
    || value.selectedData.totalSourceRelationCount !== 61
    || value.selectedData.archivedTableSetSha256 !== PINNED_ARCHIVED_TABLE_SET_SHA256
    || value.selectedData.relationDispositionSetSha256
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITION_SET_SHA256
    || value.selectedData.requiredEmptyRelationSetSha256
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_SET_SHA256
    || value.selectedData.policySetSha256
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SET_SHA256
    || value.selectedData.rlsEnabledRelationCount !== 61
    || value.selectedData.forceRlsRelationCount !== 61
    || value.selectedData.logicalBackupSelectPolicyCount !== 61
    || value.selectedData.reviewedOtherPolicyCount !== 179
    || value.selectedData.totalPolicyCount !== 240) fail("receipt_invalid");

  const authority = value.authorityProjection;
  if (!isPlainObject(authority) || !exactKeys(authority, [
    "classification", "backupGroup", "ephemeralLogin", "projectionVerifiedByThisModule",
    "authorityProjectionSha256",
  ])
    || authority.classification
      !== "DECLARATIVE_EXPECTATION_WITH_CALLER_CLAIMED_EVIDENCE_ONLY"
    || authority.projectionVerifiedByThisModule !== false
    || !safeHash(authority.authorityProjectionSha256)
    || !isPlainObject(authority.backupGroup)
    || !exactKeys(authority.backupGroup, [
      "roleName", "claimedRoleOid", "login", "inherit", "superuser", "createDatabase",
      "createRole", "replication", "bypassRls", "connectionLimit", "validUntil",
      "expectedDirectDatabaseAclCount",
      "expectedSchemaUsageAclCount", "expectedArchivedRelationSelectAclCount",
      "expectedRequiredEmptyKernelSelectAclCount", "expectedTotalRelationSelectAclCount",
      "expectedSharedDependencyCount", "expectedRelationWriteAclCount",
      "expectedColumnAclCount", "expectedSequenceAclCount", "expectedRoutineAclCount",
      "expectedOwnedObjectCount", "expectedMembershipsGrantedCount",
      "expectedMembershipsReceivedCount", "expectedRoleSettingCount", "claimedCatalogEvidenceSha256",
    ])
    || !expectedRoleSafety(authority.backupGroup, false)
    || authority.backupGroup.roleName !== backupGroupName(value.source.databaseOid)
    || !exactOid(authority.backupGroup.claimedRoleOid)
    || authority.backupGroup.connectionLimit !== -1
    || authority.backupGroup.validUntil !== null
    || authority.backupGroup.expectedDirectDatabaseAclCount !== 0
    || authority.backupGroup.expectedSchemaUsageAclCount !== 2
    || authority.backupGroup.expectedArchivedRelationSelectAclCount !== 59
    || authority.backupGroup.expectedRequiredEmptyKernelSelectAclCount !== 2
    || authority.backupGroup.expectedTotalRelationSelectAclCount !== 61
    || authority.backupGroup.expectedSharedDependencyCount !== 63
    || authority.backupGroup.expectedRelationWriteAclCount !== 0
    || authority.backupGroup.expectedColumnAclCount !== 0
    || authority.backupGroup.expectedSequenceAclCount !== 0
    || authority.backupGroup.expectedRoutineAclCount !== 0
    || authority.backupGroup.expectedOwnedObjectCount !== 0
    || authority.backupGroup.expectedMembershipsGrantedCount !== 0
    || authority.backupGroup.expectedMembershipsReceivedCount !== 0
    || authority.backupGroup.expectedRoleSettingCount !== 0
    || !safeHash(authority.backupGroup.claimedCatalogEvidenceSha256)
    || !isPlainObject(authority.ephemeralLogin)
    || !exactKeys(authority.ephemeralLogin, [
      "roleName", "claimedRoleOid", "versionToken", "login", "inherit", "connectionLimit",
      "validUntilRequired", "validUntilBoundToLifecycleAtCompletion",
      "passwordVerifierFormatRequired", "superuser", "createDatabase", "createRole",
      "replication", "bypassRls", "expectedDirectTargetDatabaseConnectAclCount",
      "expectedSharedDependencyCount",
      "expectedOtherDirectDatabaseAclCount", "expectedSchemaAclCount", "expectedRelationAclCount",
      "expectedColumnAclCount", "expectedSequenceAclCount", "expectedRoutineAclCount",
      "expectedOwnedObjectCount", "expectedRoleSettingCount",
      "effectiveTargetOnlyDatabaseAccessRequired", "effectiveTargetOnlyDatabaseAccessVerified",
      "completeRoleGraphVerified", "claimedCatalogEvidenceSha256",
    ])
    || !expectedRoleSafety(authority.ephemeralLogin, true)
    || typeof authority.ephemeralLogin.versionToken !== "string"
    || authority.ephemeralLogin.roleName !== ephemeralLoginName(
      value.source.databaseOid,
      authority.ephemeralLogin.versionToken,
    )
    || !exactOid(authority.ephemeralLogin.claimedRoleOid)
    || authority.ephemeralLogin.claimedRoleOid === authority.backupGroup.claimedRoleOid
    || authority.ephemeralLogin.connectionLimit !== 2
    || authority.ephemeralLogin.validUntilRequired !== true
    || authority.ephemeralLogin.validUntilBoundToLifecycleAtCompletion !== true
    || authority.ephemeralLogin.passwordVerifierFormatRequired !== "scram-sha-256"
    || authority.ephemeralLogin.expectedDirectTargetDatabaseConnectAclCount !== 1
    || authority.ephemeralLogin.expectedSharedDependencyCount !== 1
    || authority.ephemeralLogin.expectedOtherDirectDatabaseAclCount !== 0
    || authority.ephemeralLogin.expectedSchemaAclCount !== 0
    || authority.ephemeralLogin.expectedRelationAclCount !== 0
    || authority.ephemeralLogin.expectedColumnAclCount !== 0
    || authority.ephemeralLogin.expectedSequenceAclCount !== 0
    || authority.ephemeralLogin.expectedRoutineAclCount !== 0
    || authority.ephemeralLogin.expectedOwnedObjectCount !== 0
    || authority.ephemeralLogin.expectedRoleSettingCount !== 0
    || authority.ephemeralLogin.effectiveTargetOnlyDatabaseAccessRequired !== false
    || authority.ephemeralLogin.effectiveTargetOnlyDatabaseAccessVerified !== false
    || authority.ephemeralLogin.completeRoleGraphVerified !== false
    || !safeHash(authority.ephemeralLogin.claimedCatalogEvidenceSha256)) {
    fail("receipt_invalid");
  }
  const { authorityProjectionSha256: _authorityHash, ...authorityWithoutHash } = authority;
  if (authority.authorityProjectionSha256 !== roleProjectionBinding(
    authorityWithoutHash as Omit<
      PostgresLogicalBackupV4SourceAuthorityReceiptV2["authorityProjection"],
      "authorityProjectionSha256"
    >,
  )) fail("receipt_invalid");

  const ceremony = value.membershipCeremony;
  if (!isPlainObject(ceremony) || !exactKeys(ceremony, [
    "expectedSetOnlyMembershipCountSequence", "transitions",
    "ceremonyVerifiedByThisModule", "ceremonyBindingSha256",
  ])
    || !Array.isArray(ceremony.expectedSetOnlyMembershipCountSequence)
    || ceremony.expectedSetOnlyMembershipCountSequence.length !== 4
    || ceremony.expectedSetOnlyMembershipCountSequence.some(
      (count, index) => count !== ([1, 0, 1, 0] as const)[index],
    )
    || !Array.isArray(ceremony.transitions)
    || ceremony.transitions.length !== 4
    || ceremony.ceremonyVerifiedByThisModule !== false
    || !safeHash(ceremony.ceremonyBindingSha256)) fail("receipt_invalid");
  const phases = [
    "provisioned", "detached-for-capture", "regranted-for-pg-dump", "cleaned-up",
  ] as const;
  const transitionTimes: string[] = [];
  for (let index = 0; index < ceremony.transitions.length; index += 1) {
    const transition = ceremony.transitions[index];
    const expectedCount = ([1, 0, 1, 0] as const)[index]!;
    if (!isPlainObject(transition) || !exactKeys(transition, [
      "phase", "claimedObservedAt", "expectedBackupGroupChildMembershipCount",
      "expectedLoginParentMembershipCount", "expectedExactSetOnlyMembershipCount",
      "expectedInheritOptionTrueCount", "expectedAdminOptionTrueCount",
      "claimedEvidenceSha256", "transitionBindingSha256",
    ])
      || transition.phase !== phases[index]
      || !exactIsoInstant(transition.claimedObservedAt)
      || transition.expectedBackupGroupChildMembershipCount !== expectedCount
      || transition.expectedLoginParentMembershipCount !== expectedCount
      || transition.expectedExactSetOnlyMembershipCount !== expectedCount
      || transition.expectedInheritOptionTrueCount !== 0
      || transition.expectedAdminOptionTrueCount !== 0
      || !safeHash(transition.claimedEvidenceSha256)
      || !safeHash(transition.transitionBindingSha256)) fail("receipt_invalid");
    const { transitionBindingSha256: _transitionHash, ...transitionWithoutHash } = transition;
    if (transition.transitionBindingSha256 !== transitionBinding(
      transitionWithoutHash as Omit<MembershipTransitionRecordV2, "transitionBindingSha256">,
    )) fail("receipt_invalid");
    transitionTimes.push(transition.claimedObservedAt);
  }
  if (transitionTimes.some((instant, index) => index > 0
      && Date.parse(instant) < Date.parse(transitionTimes[index - 1]!))
    || value.createdAt !== transitionTimes[3]
    || ceremony.ceremonyBindingSha256 !== ceremonyBinding(
      ceremony.transitions as unknown as readonly MembershipTransitionRecordV2[],
    )) fail("receipt_invalid");

  if (!isPlainObject(value.archiveClaims) || !exactKeys(value.archiveClaims, [
    "claimedSourceStateCaptureSha256", "claimedExportedSnapshotBindingSha256",
    "claimedPgDumpArgumentsBindingSha256", "claimedPgDumpExecutableSha256",
    "claimedPgRestoreExecutableSha256", "claimedArchiveSha256",
    "claimedArchiveListingSha256", "claimedArchiveByteLength",
  ])
    || !Object.entries(value.archiveClaims).every(([key, claim]) => (
      key === "claimedArchiveByteLength"
        ? Number.isSafeInteger(claim) && Number(claim) > 0
        : key.startsWith("claimed") && key.endsWith("Sha256") && safeHash(claim)
    ))) fail("receipt_invalid");

  validateOperationalCompletion(value.operationalCompletion, value as Record<string, unknown> & {
    source: Record<string, unknown>;
    authorityProjection: Record<string, unknown>;
    membershipCeremony: Record<string, unknown>;
    archiveClaims: Record<string, unknown>;
  });

  if (!isPlainObject(value.evidenceSemantics) || !exactKeys(value.evidenceSemantics, [
    "allCallerEvidenceHashesAreUnverifiedClaims", "callerEvidenceVerifiedByThisModule",
    "serializedReceiptIsAuthority", "operationalSourceAuthorityImplemented",
    "sourceAuthorityGranted", "archiveContentAuthorityGranted", "artifactEmissionAuthorized",
    "activationAuthorized", "productionCutoverAuthorized",
  ])
    || value.evidenceSemantics.allCallerEvidenceHashesAreUnverifiedClaims !== true
    || value.evidenceSemantics.callerEvidenceVerifiedByThisModule !== false
    || value.evidenceSemantics.serializedReceiptIsAuthority !== false
    || value.evidenceSemantics.operationalSourceAuthorityImplemented !== false
    || value.evidenceSemantics.sourceAuthorityGranted !== false
    || value.evidenceSemantics.archiveContentAuthorityGranted !== false
    || value.evidenceSemantics.artifactEmissionAuthorized !== false
    || value.evidenceSemantics.activationAuthorized !== false
    || value.evidenceSemantics.productionCutoverAuthorized !== false) fail("receipt_invalid");

  const { receiptBindingSha256: _receiptHash, ...withoutReceiptHash } = value;
  if (value.receiptBindingSha256 !== receiptBinding(
    withoutReceiptHash as Omit<
      PostgresLogicalBackupV4SourceAuthorityReceiptV2,
      "receiptBindingSha256"
    >,
  )) fail("receipt_invalid");
}

function buildTransition(
  claim: PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
  expectedCount: 0 | 1,
): MembershipTransitionRecordV2 {
  const withoutBinding = {
    phase: claim.phase,
    claimedObservedAt: claim.claimedObservedAt,
    expectedBackupGroupChildMembershipCount: expectedCount,
    expectedLoginParentMembershipCount: expectedCount,
    expectedExactSetOnlyMembershipCount: expectedCount,
    expectedInheritOptionTrueCount: 0 as const,
    expectedAdminOptionTrueCount: 0 as const,
    claimedEvidenceSha256: claim.claimedEvidenceSha256,
  };
  return deepFreeze({
    ...withoutBinding,
    transitionBindingSha256: transitionBinding(withoutBinding),
  });
}

function buildPendingOperationalCompletion():
PostgresLogicalBackupV4SourceAuthorityPendingCompletionV2 {
  const withoutBinding = {
    state: "PENDING_LIVE_RECORDER" as const,
    completed: false as const,
    pendingReason: "PASSIVE_BUILDER_CANNOT_VERIFY_LIVE_EVIDENCE" as const,
    independentLiveRecorderBrandRequired: true as const,
    independentLiveRecorderBrandSerialized: false as const,
    completionObservationVerifiedByThisModule: false as const,
  };
  return deepFreeze({
    ...withoutBinding,
    completionBindingSha256: operationalCompletionBinding(withoutBinding),
  });
}

export function buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(
  input: unknown,
): PostgresLogicalBackupV4SourceAuthorityReceiptV2 {
  assertStaticAuthority();
  const snapshot = snapshotBoundedPlainData(input);
  if (isPlainObject(snapshot)
    && snapshot.kind === "pintpath-postgres-logical-backup-source-authority"
    && snapshot.version === 1) fail("receipt_v1_rejected");
  if (!isPlainObject(snapshot) || !exactKeys(snapshot, [
    "createdAt", "sourceDatabaseOid", "sourceDatabaseName", "ephemeralLoginVersionToken",
    "backupGroupClaimedRoleOid", "ephemeralLoginClaimedRoleOid",
    "claimedDatabaseIdentitySha256", "claimedSourceUrlSha256",
    "claimedBackupGroupCatalogEvidenceSha256", "claimedEphemeralLoginCatalogEvidenceSha256",
    "membershipClaims",
    "claimedSourceStateCaptureSha256", "claimedExportedSnapshotBindingSha256",
    "claimedPgDumpArgumentsBindingSha256", "claimedPgDumpExecutableSha256",
    "claimedPgRestoreExecutableSha256", "claimedArchiveSha256",
    "claimedArchiveListingSha256", "claimedArchiveByteLength",
  ])
    || !exactIsoInstant(snapshot.createdAt)
    || !exactOid(snapshot.sourceDatabaseOid)
    || !exactDatabaseName(snapshot.sourceDatabaseName)
    || typeof snapshot.ephemeralLoginVersionToken !== "string"
    || !LOGIN_VERSION_PATTERN.test(snapshot.ephemeralLoginVersionToken)
    || !exactOid(snapshot.backupGroupClaimedRoleOid)
    || !exactOid(snapshot.ephemeralLoginClaimedRoleOid)
    || snapshot.backupGroupClaimedRoleOid === snapshot.ephemeralLoginClaimedRoleOid
    || !Array.isArray(snapshot.membershipClaims)
    || snapshot.membershipClaims.length !== 4
    || !Number.isSafeInteger(snapshot.claimedArchiveByteLength)
    || Number(snapshot.claimedArchiveByteLength) < 1) fail("receipt_invalid");
  const hashKeys = Object.keys(snapshot).filter((key) => key.startsWith("claimed")
    && key.endsWith("Sha256"));
  if (hashKeys.length !== 11 || !hashKeys.every((key) => safeHash(snapshot[key]))) {
    fail("receipt_invalid");
  }
  const phases = [
    "provisioned", "detached-for-capture", "regranted-for-pg-dump", "cleaned-up",
  ] as const;
  for (let index = 0; index < snapshot.membershipClaims.length; index += 1) {
    const claim = snapshot.membershipClaims[index];
    if (!isPlainObject(claim) || !exactKeys(claim, [
      "phase", "claimedObservedAt", "claimedEvidenceSha256",
    ])
      || claim.phase !== phases[index]
      || !exactIsoInstant(claim.claimedObservedAt)
      || !safeHash(claim.claimedEvidenceSha256)) fail("receipt_invalid");
  }
  const typedClaims = snapshot.membershipClaims as unknown as readonly [
    PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
    PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
    PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
    PostgresLogicalBackupV4SourceAuthorityV2MembershipClaim,
  ];
  const transitions = deepFreeze([
    buildTransition(typedClaims[0], 1),
    buildTransition(typedClaims[1], 0),
    buildTransition(typedClaims[2], 1),
    buildTransition(typedClaims[3], 0),
  ] as const);
  const groupName = backupGroupName(snapshot.sourceDatabaseOid);
  const loginName = ephemeralLoginName(
    snapshot.sourceDatabaseOid,
    snapshot.ephemeralLoginVersionToken,
  );
  const authorityWithoutHash = deepFreeze({
    classification: "DECLARATIVE_EXPECTATION_WITH_CALLER_CLAIMED_EVIDENCE_ONLY" as const,
    backupGroup: {
      roleName: groupName,
      claimedRoleOid: snapshot.backupGroupClaimedRoleOid,
      login: false as const,
      inherit: false as const,
      connectionLimit: -1 as const,
      validUntil: null,
      superuser: false as const,
      createDatabase: false as const,
      createRole: false as const,
      replication: false as const,
      bypassRls: false as const,
      expectedDirectDatabaseAclCount: 0 as const,
      expectedSchemaUsageAclCount: 2 as const,
      expectedArchivedRelationSelectAclCount: 59 as const,
      expectedRequiredEmptyKernelSelectAclCount: 2 as const,
      expectedTotalRelationSelectAclCount: 61 as const,
      expectedSharedDependencyCount: 63 as const,
      expectedRelationWriteAclCount: 0 as const,
      expectedColumnAclCount: 0 as const,
      expectedSequenceAclCount: 0 as const,
      expectedRoutineAclCount: 0 as const,
      expectedOwnedObjectCount: 0 as const,
      expectedMembershipsGrantedCount: 0 as const,
      expectedMembershipsReceivedCount: 0 as const,
      expectedRoleSettingCount: 0 as const,
      claimedCatalogEvidenceSha256: snapshot.claimedBackupGroupCatalogEvidenceSha256,
    },
    ephemeralLogin: {
      roleName: loginName,
      claimedRoleOid: snapshot.ephemeralLoginClaimedRoleOid,
      versionToken: snapshot.ephemeralLoginVersionToken,
      login: true as const,
      inherit: false as const,
      connectionLimit: 2 as const,
      validUntilRequired: true as const,
      validUntilBoundToLifecycleAtCompletion: true as const,
      passwordVerifierFormatRequired: "scram-sha-256" as const,
      superuser: false as const,
      createDatabase: false as const,
      createRole: false as const,
      replication: false as const,
      bypassRls: false as const,
      expectedDirectTargetDatabaseConnectAclCount: 1 as const,
      expectedSharedDependencyCount: 1 as const,
      expectedOtherDirectDatabaseAclCount: 0 as const,
      expectedSchemaAclCount: 0 as const,
      expectedRelationAclCount: 0 as const,
      expectedColumnAclCount: 0 as const,
      expectedSequenceAclCount: 0 as const,
      expectedRoutineAclCount: 0 as const,
      expectedOwnedObjectCount: 0 as const,
      expectedRoleSettingCount: 0 as const,
      effectiveTargetOnlyDatabaseAccessRequired: false as const,
      effectiveTargetOnlyDatabaseAccessVerified: false as const,
      completeRoleGraphVerified: false as const,
      claimedCatalogEvidenceSha256: snapshot.claimedEphemeralLoginCatalogEvidenceSha256,
    },
    projectionVerifiedByThisModule: false as const,
  });
  const base = {
    kind: "pintpath-postgres-logical-backup-source-authority" as const,
    version: 2 as const,
    classification: "CANONICAL_SOURCE_ARCHIVE_RECORD_ONLY" as const,
    profile: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_PROFILE,
    policySha256: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SHA256,
    createdAt: snapshot.createdAt,
    source: {
      databaseOid: snapshot.sourceDatabaseOid,
      databaseName: snapshot.sourceDatabaseName,
      claimedDatabaseIdentitySha256: snapshot.claimedDatabaseIdentitySha256,
      claimedSourceUrlSha256: snapshot.claimedSourceUrlSha256,
      portableReadBoundarySha256: PINNED_PORTABLE_READ_BOUNDARY_SHA256,
    },
    selectedData: {
      archivedRelationCount: 59 as const,
      requiredEmptyKernelRelationCount: 2 as const,
      totalSourceRelationCount: 61 as const,
      archivedTableSetSha256: PINNED_ARCHIVED_TABLE_SET_SHA256,
      relationDispositionSetSha256:
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITION_SET_SHA256,
      requiredEmptyRelationSetSha256:
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_SET_SHA256,
      policySetSha256: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SET_SHA256,
      rlsEnabledRelationCount: 61 as const,
      forceRlsRelationCount: 61 as const,
      logicalBackupSelectPolicyCount: 61 as const,
      reviewedOtherPolicyCount: 179 as const,
      totalPolicyCount: 240 as const,
    },
    authorityProjection: {
      ...authorityWithoutHash,
      authorityProjectionSha256: roleProjectionBinding(authorityWithoutHash as unknown as Omit<
        PostgresLogicalBackupV4SourceAuthorityReceiptV2["authorityProjection"],
        "authorityProjectionSha256"
      >),
    },
    membershipCeremony: {
      expectedSetOnlyMembershipCountSequence: [1, 0, 1, 0] as const,
      transitions,
      ceremonyVerifiedByThisModule: false as const,
      ceremonyBindingSha256: ceremonyBinding(transitions),
    },
    archiveClaims: {
      claimedSourceStateCaptureSha256: snapshot.claimedSourceStateCaptureSha256,
      claimedExportedSnapshotBindingSha256: snapshot.claimedExportedSnapshotBindingSha256,
      claimedPgDumpArgumentsBindingSha256: snapshot.claimedPgDumpArgumentsBindingSha256,
      claimedPgDumpExecutableSha256: snapshot.claimedPgDumpExecutableSha256,
      claimedPgRestoreExecutableSha256: snapshot.claimedPgRestoreExecutableSha256,
      claimedArchiveSha256: snapshot.claimedArchiveSha256,
      claimedArchiveListingSha256: snapshot.claimedArchiveListingSha256,
      claimedArchiveByteLength: snapshot.claimedArchiveByteLength,
    },
    operationalCompletion: buildPendingOperationalCompletion(),
    evidenceSemantics: {
      allCallerEvidenceHashesAreUnverifiedClaims: true as const,
      callerEvidenceVerifiedByThisModule: false as const,
      serializedReceiptIsAuthority: false as const,
      operationalSourceAuthorityImplemented: false as const,
      sourceAuthorityGranted: false as const,
      archiveContentAuthorityGranted: false as const,
      artifactEmissionAuthorized: false as const,
      activationAuthorized: false as const,
      productionCutoverAuthorized: false as const,
    },
  };
  const receipt = deepFreeze({
    ...base,
    receiptBindingSha256: receiptBinding(base as unknown as Omit<
      PostgresLogicalBackupV4SourceAuthorityReceiptV2,
      "receiptBindingSha256"
    >),
  }) as PostgresLogicalBackupV4SourceAuthorityReceiptV2;
  validateReceipt(receipt);
  return receipt;
}

export function canonicalPostgresLogicalBackupV4SourceAuthorityPolicyV2Json(): string {
  assertStaticAuthority();
  return POLICY_CANONICAL_JSON;
}

export function canonicalPostgresLogicalBackupV4SourceAuthorityReceiptV2(
  receipt: unknown,
): Buffer {
  assertStaticAuthority();
  const snapshot = snapshotBoundedPlainData(receipt);
  validateReceipt(snapshot);
  return REFLECT_APPLY(
    BUFFER_FROM,
    BUFFER_OBJECT,
    [canonicalJson(snapshot), "utf8"],
  ) as Buffer;
}

export function postgresLogicalBackupV4SourceAuthorityReceiptV2Sha256(
  receipt: unknown,
): string {
  const bytes = canonicalPostgresLogicalBackupV4SourceAuthorityReceiptV2(receipt);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(
  input: unknown,
): PostgresLogicalBackupV4SourceAuthorityReceiptV2 {
  assertStaticAuthority();
  const bytes = snapshotReceiptBuffer(input);
  if (bytes.length >= UTF8_BOM.length
    && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1]
    && bytes[2] === UTF8_BOM[2]) fail("receipt_invalid");
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const roundTrip = REFLECT_APPLY(BUFFER_FROM, BUFFER_OBJECT, [text, "utf8"]) as Buffer;
    if (roundTrip.length !== bytes.length
      || !roundTrip.every((byte, index) => byte === bytes[index])) fail("receipt_invalid");
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof PostgresLogicalBackupV4SourceAuthorityV2Error) throw error;
    fail("receipt_invalid");
  }
  const snapshot = snapshotBoundedPlainData(parsed);
  validateReceipt(snapshot);
  if (canonicalJson(snapshot) !== text) fail("receipt_invalid");
  return deepFreeze(snapshot as PostgresLogicalBackupV4SourceAuthorityReceiptV2);
}

export interface PostgresLogicalBackupV4SourceAuthorityCompletionObservationV2 {
  readonly classification: "UNVERIFIED_SERIALIZED_COMPLETION_OBSERVATION";
  readonly receipt: PostgresLogicalBackupV4SourceAuthorityReceiptV2 & {
    readonly operationalCompletion:
      PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2;
  };
  readonly completedEvidenceShapeValid: true;
  readonly selfDerivedBindingsRecomputed: true;
  readonly independentLiveRecorderBrandPresent: false;
  readonly serializedObservationIsAuthority: false;
  readonly sourceAuthorityGranted: false;
  readonly archiveContentAuthorityGranted: false;
  readonly artifactEmissionAuthorized: false;
  readonly activationAuthorized: false;
  readonly productionCutoverAuthorized: false;
}

/**
 * Strictly validates the durable completed-evidence shape and every local
 * derivation. It cannot recover the future recorder's in-memory capability or
 * verify that any database/process observation happened, so its result is
 * explicitly non-authoritative.
 */
export function parsePostgresLogicalBackupV4SourceAuthorityCompletionObservationV2(
  input: unknown,
): PostgresLogicalBackupV4SourceAuthorityCompletionObservationV2 {
  const receipt = parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(input);
  if (receipt.operationalCompletion.state !== "COMPLETED_EVIDENCE_PROJECTION"
    || receipt.operationalCompletion.completed !== true) fail("receipt_invalid");
  return deepFreeze({
    classification: "UNVERIFIED_SERIALIZED_COMPLETION_OBSERVATION" as const,
    receipt: receipt as PostgresLogicalBackupV4SourceAuthorityReceiptV2 & {
      readonly operationalCompletion:
        PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2;
    },
    completedEvidenceShapeValid: true as const,
    selfDerivedBindingsRecomputed: true as const,
    independentLiveRecorderBrandPresent: false as const,
    serializedObservationIsAuthority: false as const,
    sourceAuthorityGranted: false as const,
    archiveContentAuthorityGranted: false as const,
    artifactEmissionAuthorized: false as const,
    activationAuthorized: false as const,
    productionCutoverAuthorized: false as const,
  });
}

assertStaticAuthority();
