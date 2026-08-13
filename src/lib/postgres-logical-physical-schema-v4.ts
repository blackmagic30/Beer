import crypto from "node:crypto";
import { TextDecoder, types as utilTypes } from "node:util";

import {
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
} from "./postgres-logical-backup-v4-table-data-contract.js";

/**
 * Passive, fail-closed PG17 physical-schema catalog contract.
 *
 * This module has no database, filesystem, process, environment, network, or
 * tool-execution dependency. It can normalize and hash caller-provided catalog
 * observations, but a serialized observation is never live database authority.
 */
export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PROFILE =
  "pintpath-canonical-ddl-plus-inert-kernel-pg17-v4" as const;
export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_KIND =
  "pintpath-postgres-logical-physical-schema" as const;
export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_VERSION = 4 as const;
export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CLASSIFICATION =
  "UNVERIFIED_PASSIVE_PHYSICAL_SCHEMA_OBSERVATION_ONLY" as const;
export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_BASE_DDL_SHA256 =
  "8afc13da7e86d433fe988b6f53f856da609d556fc6de46413daffa5a67c6e03f" as const;
export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_INERT_KERNEL_SHA256 =
  "329308dda329342387db8d6ab0cabab4ba87e16a174eb843aa6b54108a995bb1" as const;
export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_BYTES = 16 * 1024 * 1024;
export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_CAPTURE_MILLISECONDS = 120_000;

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CAPABILITY = Object.freeze({
  implementationState: "PASSIVE_CATALOG_CONTRACT_ONLY",
  catalogCaptureImplemented: false,
  databaseConnectionImplemented: false,
  transactionControlImplemented: false,
  lockAcquisitionImplemented: false,
  snapshotFreshnessVerificationImplemented: false,
  databaseEnvironmentProfilePinned: false,
  databaseEnvironmentProfileVerified: false,
  completePhysicalSchemaDigestVerified: false,
  callerClaimsVerifiedByThisModule: false,
  independentLiveRecorderBrandRequired: true,
  independentLiveRecorderBrandSerialized: false,
  serializedObservationIsAuthority: false,
  artifactEmissionAuthorized: false,
  activationAuthorized: false,
  productionCutoverAuthorized: false,
} as const);

const KERNEL_RELATIONS = Object.freeze([
  "pintpath_ops.reviewed_price_promotion_operations",
  "pintpath_ops.reviewed_price_promotion_rows",
] as const);

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS = Object.freeze([
  ...POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.map(
    ({ schemaName, tableName }) => `${schemaName}.${tableName}`,
  ),
  ...KERNEL_RELATIONS,
].sort(compareText));

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS = Object.freeze({
  databaseOwner: "$database_owner",
  logicalBackup: "$pintpath_logical_backup_current_database",
  applyOwner: "$pintpath_reviewed_price_apply_owner_current_database",
  applyExecute: "$pintpath_reviewed_price_apply_execute_current_database",
  quarantineOwner: "$pintpath_reviewed_price_quarantine_owner_current_database",
  quarantineExecute: "$pintpath_reviewed_price_quarantine_execute_current_database",
} as const);

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_ROUTINES = Object.freeze([
  "pintpath_app.clear_account_references_before_delete()",
  "pintpath_app.datetime(value timestamp with time zone)",
  "pintpath_app.instr(value text, fragment text)",
  "pintpath_app.json_each(document jsonb, sqlite_path text)",
  "pintpath_app.json_extract(value jsonb, sqlite_path text)",
  "pintpath_app.json_valid(value jsonb)",
  "pintpath_app.julianday(value timestamp with time zone, modifier text)",
  "pintpath_app.strftime(format text, value timestamp with time zone, modifier text)",
  "pintpath_ops.apply_reviewed_price_promotion(request jsonb)",
  "pintpath_ops.quarantine_reviewed_price_promotion(request jsonb)",
] as const);

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES = Object.freeze([
  "database",
  "schemas",
  "relations",
  "columns",
  "constraints",
  "indexes",
  "triggers",
  "policies",
  "routines",
  "roles",
  "aclEntries",
  "defaultAcls",
  "dependencies",
  "sharedDependencies",
] as const);

export type PostgresLogicalPhysicalSchemaV4Category =
  typeof POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES[number];

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_COUNTS = Object.freeze({
  database: 1,
  schemas: 2,
  relations: 61,
  columns: 771,
  constraints: 243,
  indexes: 270,
  triggers: 317,
  policies: 240,
  routines: 10,
  roles: 5,
  aclEntries: 932,
  defaultAcls: 0,
  dependencies: 1_909,
  sharedDependencies: 377,
} satisfies Readonly<Record<PostgresLogicalPhysicalSchemaV4Category, number>>);

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS = Object.freeze({
  database: Object.freeze([
    "databaseName", "owner", "aclIsNull",
  ]),
  schemas: Object.freeze([
    "schemaName", "owner", "aclIsNull",
  ]),
  relations: Object.freeze([
    "schemaName", "relationName", "owner", "kind", "persistence", "rowSecurity",
    "forceRowSecurity", "isPartition", "accessMethod", "tablespace", "replicaIdentity",
    "options", "partitionBound", "checkCount", "hasRules", "hasTriggers", "hasSubclass",
    "hasToastRelation", "aclIsNull",
  ]),
  columns: Object.freeze([
    "relation", "ordinal", "columnName", "formattedType", "typeSchema", "typeName",
    "typeKind", "typeCategory", "dimensions", "notNull", "hasDefault", "defaultExpression",
    "generated", "identity", "collation", "storage", "compression", "statisticsTarget",
    "options", "foreignOptions", "inheritanceCount", "isLocal", "hasMissingValue",
    "missingValue", "aclIsNull",
  ]),
  constraints: Object.freeze([
    "relation", "constraintName", "constraintType", "definition", "validated", "deferrable",
    "initiallyDeferred", "noInherit", "parentConstraint", "inheritanceCount", "isLocal",
    "columns", "referencedRelation", "referencedColumns", "indexName", "foreignUpdateAction",
    "foreignDeleteAction", "foreignMatchType", "period",
  ]),
  indexes: Object.freeze([
    "relation", "indexName", "owner", "accessMethod", "persistence", "tablespace", "options",
    "unique", "nullsNotDistinct", "primary", "exclusion", "immediate", "clustered", "valid",
    "checkXmin", "ready", "live", "replicaIdentity", "keyAttributeCount", "attributeCount",
    "keyColumns", "collations", "operatorClasses", "optionsBits", "predicate", "expressions",
    "definition", "isPartition", "parentIndex",
  ]),
  triggers: Object.freeze([
    "relation", "triggerName", "function", "functionOwner", "internal", "enabled", "typeBits",
    "constraintName", "constraintRelation", "deferrable", "initiallyDeferred", "columnNumbers",
    "argumentsHex", "whenExpression", "oldTransitionTable", "newTransitionTable", "parentTrigger",
  ]),
  policies: Object.freeze([
    "relation", "policyName", "permissive", "command", "roles", "usingExpression",
    "withCheckExpression",
  ]),
  routines: Object.freeze([
    "schemaName", "routineName", "identityArguments", "owner", "language", "kind", "resultType",
    "argumentTypes", "allArgumentTypes", "argumentModes", "argumentNames", "inputArgumentCount",
    "argumentDefaultCount", "argumentDefaults", "variadicType", "transformTypes", "securityDefiner",
    "leakproof", "strict", "returnsSet", "volatility", "parallel", "cost", "rows", "supportFunction",
    "config", "source", "binary", "sqlBody", "aclIsNull",
  ]),
  roles: Object.freeze([
    "role", "login", "superuser", "inherit", "createRole", "createDatabase", "passwordIsNull",
    "replication", "bypassRls", "connectionLimit", "validUntil", "membershipsGranted",
    "membershipsReceived", "settings",
  ]),
  aclEntries: Object.freeze([
    "objectKind", "objectIdentity", "grantor", "grantee", "privilege", "grantable",
  ]),
  defaultAcls: Object.freeze([
    "role", "schemaName", "objectType", "grantor", "grantee", "privilege", "grantable",
  ]),
  dependencies: Object.freeze([
    "dependentType", "dependentNames", "dependentArguments", "referencedType", "referencedNames",
    "referencedArguments", "dependencyType",
  ]),
  sharedDependencies: Object.freeze([
    "databaseScoped", "dependentType", "dependentNames", "dependentArguments", "referencedType",
    "referencedNames", "referencedArguments", "dependencyType",
  ]),
} satisfies Readonly<Record<PostgresLogicalPhysicalSchemaV4Category, readonly string[]>>);

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_FORBIDDEN_COUNT_KEYS = Object.freeze([
  "unexpectedPrivateSchemas",
  "unexpectedPrivateRelations",
  "otherPrivateRelationKinds",
  "partitionedRelations",
  "partitions",
  "inheritanceEdges",
  "sequences",
  "views",
  "materializedViews",
  "foreignTables",
  "standaloneTypes",
  "rewriteRules",
  "publications",
  "publicationRelations",
  "publicationSchemas",
  "privateExtensionDependencies",
  "unexpectedExtensions",
  "privateTypeAcls",
  "privateComments",
  "privateSecurityLabels",
  "eventTriggers",
  "foreignDataWrappers",
  "foreignServers",
  "userMappings",
  "privateForeignObjects",
  "statisticsObjects",
  "unexpectedDefaultAcls",
  "unexpectedPrivateObjects",
  "unexpectedPrivateDependencies",
  "unexpectedSharedDependencies",
] as const);

export type PostgresLogicalPhysicalSchemaV4ForbiddenCounts = Readonly<
  Record<typeof POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_FORBIDDEN_COUNT_KEYS[number], 0>
>;

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_SESSION_CONTRACT = Object.freeze({
  postgresMajorVersion: 17,
  transactionIsolation: "repeatable read",
  transactionReadOnly: true,
  trustedSearchPath: "pg_catalog, pg_temp",
  effectiveFirstSchema: "pg_catalog",
  sameSessionRequired: true,
  privateRelationLockMode: "ACCESS SHARE",
  expectedLockedPrivateRelationCount: 61,
  catalogSnapshotFreshnessRequired: true,
  maximumCaptureMilliseconds: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_CAPTURE_MILLISECONDS,
  serializedSessionFieldsAreUnverifiedCallerClaims: true,
} as const);

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_DATABASE_ENVIRONMENT_POLICY = Object.freeze({
  fields: Object.freeze([
    "encoding", "localeProvider", "collate", "ctype", "icuLocale", "icuRules",
    "collationVersion", "allowConnections", "isTemplate", "connectionLimit", "tablespace",
  ] as const),
  expectedSha256: null,
  reviewedTargetPinRequired: true,
  verified: false,
} as const);

export interface PostgresLogicalPhysicalSchemaV4TaggedValue {
  readonly tag:
    | "databaseName"
    | "databaseOid"
    | "role"
    | "roleInterpolatedText"
    | "pgCatalogRoutineOwner"
    | "systemGeneratedForeignKeyTrigger"
    | "systemGeneratedToastRelation";
  readonly value: string;
}

export type PostgresLogicalPhysicalSchemaV4Json =
  | null | boolean | number | string
  | PostgresLogicalPhysicalSchemaV4TaggedValue
  | readonly PostgresLogicalPhysicalSchemaV4Json[]
  | { readonly [key: string]: PostgresLogicalPhysicalSchemaV4Json };

export interface PostgresLogicalPhysicalSchemaV4CatalogEntry {
  readonly identity: string | PostgresLogicalPhysicalSchemaV4TaggedValue;
  readonly fields: Readonly<Record<string, PostgresLogicalPhysicalSchemaV4Json>>;
}

export type PostgresLogicalPhysicalSchemaV4CatalogGraph = Readonly<{
  [Category in PostgresLogicalPhysicalSchemaV4Category]:
    readonly PostgresLogicalPhysicalSchemaV4CatalogEntry[];
}>;

export interface PostgresLogicalPhysicalSchemaV4RoleMapping {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly databaseOwner: string;
  readonly logicalBackup: string;
  readonly applyOwner: string;
  readonly applyExecute: string;
  readonly quarantineOwner: string;
  readonly quarantineExecute: string;
}

export interface PostgresLogicalPhysicalSchemaV4SessionObservation {
  readonly serverVersionNum: number;
  readonly claimedTransactionIsolation: "repeatable read";
  readonly claimedTransactionReadOnly: true;
  /** All fields in this projection are unverified caller claims. */
  readonly claimedTrustedSearchPath: "pg_catalog, pg_temp";
  readonly claimedEffectiveFirstSchema: "pg_catalog";
  readonly claimedSameSession: true;
  readonly claimedBackendPid: string;
  readonly claimedSnapshotIdentifierSha256: string;
  readonly claimedPrivateRelationLockMode: "ACCESS SHARE";
  readonly claimedLockedPrivateRelations: readonly string[];
  readonly claimedCatalogSnapshotFreshnessValidated: true;
  readonly claimedTransactionStartedAt: string;
  readonly claimedCatalogCapturedAt: string;
  readonly claimedTransactionEndedAt: string;
}

export interface PostgresLogicalPhysicalSchemaV4DatabaseEnvironment {
  readonly encoding: string;
  readonly localeProvider: string;
  readonly collate: string;
  readonly ctype: string;
  readonly icuLocale: string | null;
  readonly icuRules: string | null;
  readonly collationVersion: string | null;
  readonly allowConnections: boolean;
  readonly isTemplate: boolean;
  readonly connectionLimit: number;
  readonly tablespace: string;
}

export interface PostgresLogicalPhysicalSchemaV4Capture {
  readonly roleMapping: PostgresLogicalPhysicalSchemaV4RoleMapping;
  readonly session: PostgresLogicalPhysicalSchemaV4SessionObservation;
  readonly databaseEnvironment: PostgresLogicalPhysicalSchemaV4DatabaseEnvironment;
  readonly graph: PostgresLogicalPhysicalSchemaV4CatalogGraph;
  readonly forbiddenCounts: PostgresLogicalPhysicalSchemaV4ForbiddenCounts;
}

interface CategoryDigest {
  readonly count: number;
  readonly rawSha256: string;
  readonly portableSha256: string;
}

export interface PostgresLogicalPhysicalSchemaV4Derived {
  readonly categories: Readonly<Record<PostgresLogicalPhysicalSchemaV4Category, CategoryDigest>>;
  readonly databaseEnvironmentSha256: string;
  readonly portableSchemaSha256: string;
  readonly rawPhysicalSha256: string;
}

export interface PostgresLogicalPhysicalSchemaV4Record {
  readonly kind: typeof POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_KIND;
  readonly version: typeof POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_VERSION;
  readonly profile: typeof POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PROFILE;
  readonly classification: typeof POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CLASSIFICATION;
  readonly policySha256: string;
  readonly capture: PostgresLogicalPhysicalSchemaV4Capture;
  readonly derived: PostgresLogicalPhysicalSchemaV4Derived;
  readonly databaseEnvironmentProfileVerified: false;
  readonly completePhysicalSchemaDigestVerified: false;
  readonly serializedObservationIsAuthority: false;
  readonly artifactEmissionAuthorized: false;
  readonly activationAuthorized: false;
  readonly productionCutoverAuthorized: false;
  readonly receiptSha256: string;
}

export type PostgresLogicalPhysicalSchemaV4ErrorCode =
  | "catalog_invalid"
  | "catalog_mismatch"
  | "record_invalid"
  | "static_contract_drift";

export class PostgresLogicalPhysicalSchemaV4Error extends Error {
  constructor(readonly code: PostgresLogicalPhysicalSchemaV4ErrorCode) {
    super(code);
    this.name = "PostgresLogicalPhysicalSchemaV4Error";
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OID_PATTERN = /^(?:[1-9][0-9]{0,9})$/;
const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const BACKEND_PID_PATTERN = /^(?:[1-9][0-9]{0,9})$/;
const MAX_POSTGRES_OID = 4_294_967_295n;
const MAX_DEPTH = 32;
const MAX_NODES = 300_000;
const MAX_STRING_BYTES = 4 * 1024 * 1024;
const MAX_ARRAY_LENGTH = 4_096;
const MAX_OBJECT_KEYS = 128;
const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf] as const);
const BUFFER_OBJECT = Buffer;
const BUFFER_FROM = BUFFER_OBJECT.from;
const BUFFER_COMPARE = BUFFER_OBJECT.compare;
const BUFFER_BYTE_LENGTH = BUFFER_OBJECT.byteLength;
const BUFFER_IS_BUFFER = BUFFER_OBJECT.isBuffer;
const BUFFER_PROTOTYPE = BUFFER_OBJECT.prototype;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const UTIL_IS_PROXY = utilTypes.isProxy;
const UTIL_IS_UINT8_ARRAY = utilTypes.isUint8Array;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const REFLECT_APPLY = Reflect.apply;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function fail(code: PostgresLogicalPhysicalSchemaV4ErrorCode): never {
  throw new PostgresLogicalPhysicalSchemaV4Error(code);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
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

function snapshotBoundedPlainData(value: unknown): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) fail("record_invalid");
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      if (BUFFER_BYTE_LENGTH(candidate, "utf8") > MAX_STRING_BYTES) fail("record_invalid");
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate) || Object.is(candidate, -0)) fail("record_invalid");
      return candidate;
    }
    if (typeof candidate !== "object" || UTIL_IS_PROXY(candidate) || seen.has(candidate)) {
      fail("record_invalid");
    }
    seen.add(candidate);
    let prototype: object | null;
    let keys: PropertyKey[];
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = OBJECT_GET_PROTOTYPE_OF(candidate);
      keys = REFLECT_OWN_KEYS(candidate);
      descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(candidate);
    } catch {
      fail("record_invalid");
    }
    if (Array.isArray(candidate)) {
      if (prototype !== Array.prototype || keys.length > MAX_ARRAY_LENGTH + 1
        || keys.some((key) => typeof key !== "string"
          || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) fail("record_invalid");
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH
        || keys.length !== length + 1) fail("record_invalid");
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          fail("record_invalid");
        }
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    }
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > MAX_OBJECT_KEYS) {
      fail("record_invalid");
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string" || BUFFER_BYTE_LENGTH(key, "utf8") > MAX_STRING_BYTES) {
        fail("record_invalid");
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        fail("record_invalid");
      }
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) fail("record_invalid");
  return `{${Object.keys(value).sort(compareText).map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(",")}}`;
}

function sha256Domain(domain: string, value: unknown): string {
  return crypto.createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function staticPolicyValue(): object {
  return {
    profile: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PROFILE,
    version: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_VERSION,
    classification: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CLASSIFICATION,
    expectedCounts: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_COUNTS,
    expectedSchemas: ["pintpath_app", "pintpath_ops"],
    expectedRelations: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS,
    expectedRoutines: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_ROUTINES,
    expectedRoleSymbols: Object.values(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS),
    baseDdlSha256: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_BASE_DDL_SHA256,
    inertKernelSha256: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_INERT_KERNEL_SHA256,
    categoryFields: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS,
    forbiddenCountKeys: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_FORBIDDEN_COUNT_KEYS,
    sessionContract: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_SESSION_CONTRACT,
    databaseEnvironmentPolicy: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_DATABASE_ENVIRONMENT_POLICY,
    capability: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CAPABILITY,
    expectedCategorySha256: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_CATEGORY_SHA256,
    portableSchemaSha256: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PORTABLE_SCHEMA_SHA256,
  };
}

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_POLICY_SHA256 =
  "78aa7299ebeabf98075c0e075171f0193116333c7cd05eae00fb55b1e010197e" as const;

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_CATEGORY_SHA256 = Object.freeze({
  database: "adbacf15a9f25c46d49ae9c10fcf073388211dd5ba92f2b4d59447d8ed30d677",
  schemas: "5ed5521a115e0fe158df8613e05451484ce8c8b3b4dd138c65cef1958ad5cada",
  relations: "4b743c4da7836321769f5df93452feb9772fc9d5b694b20778f19d3f87a29558",
  columns: "af17a43dc89cb77df32d11bae9ef7823e242f13da13089b901bbfd10b3510427",
  constraints: "be25b5fe0c9a9db029dabfebfcadfbc99776da7cd394cf7a3e303a107ad52cf1",
  indexes: "031ddcae53bf142ad77b1c108aa4e7376385553c540d0c5aedf5548d8a586007",
  triggers: "a0efdaf692dc0e1dc68ce886216e4e325bae27b12ff677740218eb715fe2125d",
  policies: "7a116bba3b97e56a28d6abd21e8ef6ab24620c2d33465da59f875cc8b10bf160",
  routines: "2c98140120c7288a7796abdbb39d00d956349e2af59a8c4d8f8155f8e86afcdb",
  roles: "c66910184733a287b30abbb12c56fb59733e68856dd9e9d0be18a47bd164e089",
  aclEntries: "33d120479b479f7ce303b887f58e4791e59100e5693579a87d9cf6419b95941a",
  defaultAcls: "9288051af2942af4443fbf11f35e7b03ed2442016f8b51c800a245764f1aec4e",
  dependencies: "e339265e7334cf4804d374a872a6273c97c6bc5993b4b60481f4f76c87b83e2e",
  sharedDependencies: "235fe24fe1d58bfa4de35384cbe896b944386ced969b41b849fcfb84c665d38d",
} satisfies Readonly<Record<PostgresLogicalPhysicalSchemaV4Category, string>>);

export const POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PORTABLE_SCHEMA_SHA256 =
  "c4661ad44e3d21f670e3bdf490638476d433923022991dc9ce3c357f58fd693e" as const;

function validateRoleMapping(value: unknown): asserts value is PostgresLogicalPhysicalSchemaV4RoleMapping {
  const keys = [
    "databaseName", "databaseOid", "databaseOwner", "logicalBackup", "applyOwner", "applyExecute",
    "quarantineOwner", "quarantineExecute",
  ] as const;
  if (!isPlainObject(value) || !exactKeys(value, keys)) fail("catalog_invalid");
  for (const key of keys) if (typeof value[key] !== "string" || value[key].length === 0) fail("catalog_invalid");
  const mapping = value as unknown as PostgresLogicalPhysicalSchemaV4RoleMapping;
  if (!OID_PATTERN.test(mapping.databaseOid)
    || BigInt(mapping.databaseOid) > MAX_POSTGRES_OID
    || !ROLE_PATTERN.test(mapping.databaseOwner)
    || mapping.databaseName.length > 63
    || !ROLE_PATTERN.test(mapping.databaseName)) fail("catalog_invalid");
  const expected = {
    logicalBackup: `pintpath_logical_backup_d${mapping.databaseOid}`,
    applyOwner: `pintpath_reviewed_price_apply_owner_d${mapping.databaseOid}`,
    applyExecute: `pintpath_reviewed_price_apply_execute_d${mapping.databaseOid}`,
    quarantineOwner: `pintpath_reviewed_price_quarantine_owner_d${mapping.databaseOid}`,
    quarantineExecute: `pintpath_reviewed_price_quarantine_execute_d${mapping.databaseOid}`,
  } as const;
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (mapping[key] !== expected[key]) fail("catalog_invalid");
  }
  const roles = [mapping.databaseOwner, mapping.logicalBackup, mapping.applyOwner, mapping.applyExecute,
    mapping.quarantineOwner, mapping.quarantineExecute];
  if (new Set(roles).size !== roles.length) fail("catalog_invalid");
}

function roleToSymbol(mapping: PostgresLogicalPhysicalSchemaV4RoleMapping): ReadonlyMap<string, string> {
  return new Map([
    [mapping.databaseOwner, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS.databaseOwner],
    [mapping.logicalBackup, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS.logicalBackup],
    [mapping.applyOwner, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS.applyOwner],
    [mapping.applyExecute, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS.applyExecute],
    [mapping.quarantineOwner, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS.quarantineOwner],
    [mapping.quarantineExecute, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS.quarantineExecute],
  ]);
}

function normalizeTaggedValue(
  value: unknown,
  mapping: PostgresLogicalPhysicalSchemaV4RoleMapping,
): PostgresLogicalPhysicalSchemaV4Json {
  const symbols = roleToSymbol(mapping);
  const visit = (candidate: unknown): PostgresLogicalPhysicalSchemaV4Json => {
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number") {
      return candidate;
    }
    if (typeof candidate === "string") {
      if (candidate === mapping.databaseOid || candidate === mapping.databaseName
        || symbols.has(candidate)
        || [...symbols.keys()].some((role) => candidate.includes(role))) fail("catalog_invalid");
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(visit);
    if (!isPlainObject(candidate)) fail("catalog_invalid");
    if (exactKeys(candidate, ["tag", "value"])) {
      if (typeof candidate.tag !== "string" || typeof candidate.value !== "string") {
        fail("catalog_invalid");
      }
      if (candidate.tag === "databaseName") {
        if (candidate.value !== mapping.databaseName) fail("catalog_invalid");
        return "$database";
      }
      if (candidate.tag === "databaseOid") {
        if (candidate.value !== mapping.databaseOid) fail("catalog_invalid");
        return "$database_oid";
      }
      if (candidate.tag === "role") {
        const symbol = symbols.get(candidate.value);
        if (!symbol) fail("catalog_invalid");
        return symbol;
      }
      if (candidate.tag === "roleInterpolatedText") {
        let normalized = candidate.value;
        let replacements = 0;
        for (const [role, symbol] of [...symbols.entries()].sort(
          ([left], [right]) => right.length - left.length || compareText(left, right),
        )) {
          const pieces = normalized.split(role);
          if (pieces.length > 1) {
            replacements += pieces.length - 1;
            normalized = pieces.join(symbol);
          }
        }
        if (replacements === 0) fail("catalog_invalid");
        return normalized;
      }
      if (candidate.tag === "pgCatalogRoutineOwner") {
        if (!ROLE_PATTERN.test(candidate.value)) fail("catalog_invalid");
        return "$pg_catalog_function_owner";
      }
      if (candidate.tag === "systemGeneratedForeignKeyTrigger") {
        if (!/^RI_ConstraintTrigger_[ac]_[1-9][0-9]*$/.test(candidate.value)) {
          fail("catalog_invalid");
        }
        return "$system_generated_foreign_key_trigger";
      }
      if (candidate.tag === "systemGeneratedToastRelation") {
        if (!/^pg_toast_[1-9][0-9]{0,9}$/.test(candidate.value)) fail("catalog_invalid");
        return "$system_generated_toast_relation";
      }
      fail("catalog_invalid");
    }
    const output: Record<string, PostgresLogicalPhysicalSchemaV4Json> = Object.create(null) as Record<
      string, PostgresLogicalPhysicalSchemaV4Json
    >;
    for (const key of Object.keys(candidate)) output[key] = visit(candidate[key]);
    return output;
  };
  return visit(value);
}

function validateSession(value: unknown): asserts value is PostgresLogicalPhysicalSchemaV4SessionObservation {
  const keys = [
    "serverVersionNum", "claimedTransactionIsolation", "claimedTransactionReadOnly",
    "claimedTrustedSearchPath", "claimedEffectiveFirstSchema", "claimedSameSession", "claimedBackendPid",
    "claimedSnapshotIdentifierSha256", "claimedPrivateRelationLockMode",
    "claimedLockedPrivateRelations", "claimedCatalogSnapshotFreshnessValidated",
    "claimedTransactionStartedAt", "claimedCatalogCapturedAt", "claimedTransactionEndedAt",
  ] as const;
  if (!isPlainObject(value) || !exactKeys(value, keys)
    || typeof value.serverVersionNum !== "number"
    || value.serverVersionNum < 170_000 || value.serverVersionNum >= 180_000
    || value.claimedTransactionIsolation !== "repeatable read"
    || value.claimedTransactionReadOnly !== true
    || value.claimedTrustedSearchPath !== "pg_catalog, pg_temp"
    || value.claimedEffectiveFirstSchema !== "pg_catalog"
    || value.claimedSameSession !== true
    || typeof value.claimedBackendPid !== "string"
    || !BACKEND_PID_PATTERN.test(value.claimedBackendPid)
    || typeof value.claimedSnapshotIdentifierSha256 !== "string"
    || !SHA256_PATTERN.test(value.claimedSnapshotIdentifierSha256)
    || value.claimedPrivateRelationLockMode !== "ACCESS SHARE"
    || value.claimedCatalogSnapshotFreshnessValidated !== true
    || !Array.isArray(value.claimedLockedPrivateRelations)) fail("catalog_invalid");
  const locks = value.claimedLockedPrivateRelations;
  if (locks.length !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS.length
    || locks.some((entry) => typeof entry !== "string")
    || [...locks].sort(compareText).some(
      (entry, index) => entry !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS[index],
    )) fail("catalog_invalid");
  if (typeof value.claimedTransactionStartedAt !== "string"
    || typeof value.claimedCatalogCapturedAt !== "string"
    || typeof value.claimedTransactionEndedAt !== "string") fail("catalog_invalid");
  const dates: readonly [string, string, string] = [value.claimedTransactionStartedAt,
    value.claimedCatalogCapturedAt, value.claimedTransactionEndedAt];
  const milliseconds = dates.map((entry) => Date.parse(entry));
  const [started, captured, ended] = milliseconds;
  if (started === undefined || captured === undefined || ended === undefined) fail("catalog_invalid");
  if (milliseconds.some((entry, index) => !Number.isFinite(entry)
      || new Date(entry).toISOString() !== dates[index])
    || started > captured || captured > ended
    || ended - started
      > POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_CAPTURE_MILLISECONDS) fail("catalog_invalid");
}

function validateEnvironment(
  value: unknown,
): asserts value is PostgresLogicalPhysicalSchemaV4DatabaseEnvironment {
  const expected = POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_DATABASE_ENVIRONMENT_POLICY.fields;
  if (!isPlainObject(value) || !exactKeys(value, expected)) fail("catalog_invalid");
  for (const key of ["encoding", "localeProvider", "collate", "ctype", "tablespace"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) fail("catalog_invalid");
  }
  for (const key of ["icuLocale", "icuRules", "collationVersion"] as const) {
    if (value[key] !== null && typeof value[key] !== "string") fail("catalog_invalid");
  }
  if (typeof value.allowConnections !== "boolean" || typeof value.isTemplate !== "boolean"
    || !Number.isSafeInteger(value.connectionLimit)) fail("catalog_invalid");
}

function validateForbiddenCounts(
  value: unknown,
): asserts value is PostgresLogicalPhysicalSchemaV4ForbiddenCounts {
  if (!isPlainObject(value)
    || !exactKeys(value, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_FORBIDDEN_COUNT_KEYS)
    || POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_FORBIDDEN_COUNT_KEYS.some(
      (key) => value[key] !== 0,
    )) fail("catalog_mismatch");
}

function normalizedCategories(
  graphValue: unknown,
  mapping: PostgresLogicalPhysicalSchemaV4RoleMapping,
): {
  readonly raw: Record<PostgresLogicalPhysicalSchemaV4Category, readonly unknown[]>;
  readonly portable: Record<PostgresLogicalPhysicalSchemaV4Category, readonly unknown[]>;
} {
  if (!isPlainObject(graphValue)
    || !exactKeys(graphValue, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES)) {
    fail("catalog_invalid");
  }
  const raw = Object.create(null) as Record<PostgresLogicalPhysicalSchemaV4Category, unknown[]>;
  const portable = Object.create(null) as Record<PostgresLogicalPhysicalSchemaV4Category, unknown[]>;
  for (const category of POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES) {
    const entries = graphValue[category];
    if (!Array.isArray(entries)
      || entries.length !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_COUNTS[category]) {
      fail("catalog_mismatch");
    }
    const rawEntries: unknown[] = [];
    const portableEntries: unknown[] = [];
    for (const entry of entries) {
      if (!isPlainObject(entry) || !exactKeys(entry, ["identity", "fields"])
        || !(typeof entry.identity === "string" || isPlainObject(entry.identity))
        || !isPlainObject(entry.fields)
        || !exactKeys(entry.fields, POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS[category])) {
        fail("catalog_invalid");
      }
      const normalizedIdentity = normalizeTaggedValue(entry.identity, mapping);
      if (typeof normalizedIdentity !== "string") fail("catalog_invalid");
      const normalizedFields = normalizeTaggedValue(entry.fields, mapping);
      rawEntries.push(entry);
      portableEntries.push({ identity: normalizedIdentity, fields: normalizedFields });
    }
    rawEntries.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
    portableEntries.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
    const identities = portableEntries.map((entry) => (entry as { identity: string }).identity);
    if (new Set(identities).size !== identities.length) fail("catalog_invalid");
    raw[category] = rawEntries;
    portable[category] = portableEntries;
  }
  const identities = (category: PostgresLogicalPhysicalSchemaV4Category): string[] =>
    portable[category].map((entry) => (entry as { identity: string }).identity).sort(compareText);
  if (canonicalJson(identities("database")) !== canonicalJson(["$database"])
    || canonicalJson(identities("schemas")) !== canonicalJson(["pintpath_app", "pintpath_ops"])
    || canonicalJson(identities("relations"))
      !== canonicalJson(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS)
    || canonicalJson(identities("routines"))
      !== canonicalJson([...POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_ROUTINES].sort(compareText))
    || canonicalJson(identities("roles"))
      !== canonicalJson(Object.values(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS)
        .filter((value) => value !== "$database_owner").sort(compareText))) fail("catalog_mismatch");
  return { raw, portable };
}

function validateCapture(value: unknown): asserts value is PostgresLogicalPhysicalSchemaV4Capture {
  if (!isPlainObject(value)
    || !exactKeys(value, ["roleMapping", "session", "databaseEnvironment", "graph", "forbiddenCounts"])) {
    fail("catalog_invalid");
  }
  validateRoleMapping(value.roleMapping);
  validateSession(value.session);
  validateEnvironment(value.databaseEnvironment);
  validateForbiddenCounts(value.forbiddenCounts);
}

export function derivePostgresLogicalPhysicalSchemaV4(
  input: PostgresLogicalPhysicalSchemaV4Capture,
): PostgresLogicalPhysicalSchemaV4Derived {
  if (sha256PostgresLogicalPhysicalSchemaV4Policy()
    !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_POLICY_SHA256) fail("static_contract_drift");
  const capture = snapshotBoundedPlainData(input);
  validateCapture(capture);
  const categories = normalizedCategories(capture.graph, capture.roleMapping);
  const digests = Object.create(null) as Record<PostgresLogicalPhysicalSchemaV4Category, CategoryDigest>;
  for (const category of POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES) {
    digests[category] = {
      count: categories.raw[category].length,
      rawSha256: sha256Domain(`pintpath:physical-schema:v4:raw:${category}`, categories.raw[category]),
      portableSha256: sha256Domain(
        `pintpath:physical-schema:v4:portable:${category}`,
        categories.portable[category],
      ),
    };
  }
  const databaseEnvironmentSha256 = sha256Domain(
    "pintpath:physical-schema:v4:database-environment",
    capture.databaseEnvironment,
  );
  const portableSchemaSha256 = sha256Domain(
    "pintpath:physical-schema:v4:portable-schema",
    {
      profile: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PROFILE,
      categoryHashes: Object.fromEntries(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES.map(
        (category) => [category, digests[category].portableSha256],
      )),
      forbiddenCounts: capture.forbiddenCounts,
    },
  );
  const rawPhysicalSha256 = sha256Domain(
    "pintpath:physical-schema:v4:raw-physical",
    {
      profile: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PROFILE,
      categoryHashes: Object.fromEntries(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES.map(
        (category) => [category, digests[category].rawSha256],
      )),
      roleMapping: capture.roleMapping,
      databaseEnvironmentSha256,
      forbiddenCounts: capture.forbiddenCounts,
    },
  );
  return deepFreeze({
    categories: digests,
    databaseEnvironmentSha256,
    portableSchemaSha256,
    rawPhysicalSha256,
  });
}

function validatePinnedDerived(derived: PostgresLogicalPhysicalSchemaV4Derived): void {
  for (const category of POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES) {
    if (derived.categories[category].portableSha256
      !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_CATEGORY_SHA256[category]) {
      fail("catalog_mismatch");
    }
  }
  if (derived.portableSchemaSha256
    !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PORTABLE_SCHEMA_SHA256) fail("catalog_mismatch");
}

function recordPayload(
  capture: PostgresLogicalPhysicalSchemaV4Capture,
  derived: PostgresLogicalPhysicalSchemaV4Derived,
): Omit<PostgresLogicalPhysicalSchemaV4Record, "receiptSha256"> {
  return {
    kind: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_KIND,
    version: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_VERSION,
    profile: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PROFILE,
    classification: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CLASSIFICATION,
    policySha256: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_POLICY_SHA256,
    capture,
    derived,
    databaseEnvironmentProfileVerified: false,
    completePhysicalSchemaDigestVerified: false,
    serializedObservationIsAuthority: false,
    artifactEmissionAuthorized: false,
    activationAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

export function buildPostgresLogicalPhysicalSchemaV4Record(
  input: PostgresLogicalPhysicalSchemaV4Capture,
): PostgresLogicalPhysicalSchemaV4Record {
  const capture = snapshotBoundedPlainData(input) as PostgresLogicalPhysicalSchemaV4Capture;
  const derived = derivePostgresLogicalPhysicalSchemaV4(capture);
  validatePinnedDerived(derived);
  const payload = recordPayload(capture, derived);
  return deepFreeze({
    ...payload,
    receiptSha256: sha256Domain("pintpath:physical-schema:v4:record", payload),
  });
}

function exactDerived(
  value: unknown,
  expected: PostgresLogicalPhysicalSchemaV4Derived,
): boolean {
  return canonicalJson(value) === canonicalJson(expected);
}

export function canonicalizePostgresLogicalPhysicalSchemaV4Record(
  record: PostgresLogicalPhysicalSchemaV4Record,
): string {
  const parsed = parsePostgresLogicalPhysicalSchemaV4Record(record);
  return canonicalJson(parsed);
}

function parseBytes(value: Buffer | Uint8Array): unknown {
  let prototype: object | null;
  let byteLength: number;
  try {
    if (UTIL_IS_PROXY(value)) fail("record_invalid");
    prototype = OBJECT_GET_PROTOTYPE_OF(value);
    if (!(BUFFER_IS_BUFFER(value) ? prototype === BUFFER_PROTOTYPE
      : UTIL_IS_UINT8_ARRAY(value) && prototype === Uint8Array.prototype)) fail("record_invalid");
    if (!TYPED_ARRAY_BYTE_LENGTH) fail("record_invalid");
    byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH, value, []) as number;
  } catch {
    fail("record_invalid");
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0
    || byteLength > POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_BYTES) fail("record_invalid");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(byteLength);
    REFLECT_APPLY(TYPED_ARRAY_SET, bytes, [value]);
  } catch {
    fail("record_invalid");
  }
  if (bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    fail("record_invalid");
  }
  let text: string;
  try {
    text = DECODER.decode(bytes);
  } catch {
    fail("record_invalid");
  }
  if (text.includes("\r") || text.includes("\n")) fail("record_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("record_invalid");
  }
  const snapshot = snapshotBoundedPlainData(parsed);
  if (canonicalJson(snapshot) !== text) fail("record_invalid");
  return snapshot;
}

export function parsePostgresLogicalPhysicalSchemaV4Record(
  input: unknown,
): PostgresLogicalPhysicalSchemaV4Record {
  const value = BUFFER_IS_BUFFER(input) || UTIL_IS_UINT8_ARRAY(input)
    ? parseBytes(input as Buffer | Uint8Array)
    : snapshotBoundedPlainData(input);
  const keys = [
    "kind", "version", "profile", "classification", "policySha256", "capture", "derived",
    "databaseEnvironmentProfileVerified", "completePhysicalSchemaDigestVerified",
    "serializedObservationIsAuthority", "artifactEmissionAuthorized", "activationAuthorized",
    "productionCutoverAuthorized", "receiptSha256",
  ];
  if (!isPlainObject(value) || !exactKeys(value, keys)
    || value.kind !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_KIND
    || value.version !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_VERSION
    || value.profile !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PROFILE
    || value.classification !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CLASSIFICATION
    || value.policySha256 !== POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_POLICY_SHA256
    || !SHA256_PATTERN.test(value.policySha256)
    || value.databaseEnvironmentProfileVerified !== false
    || value.completePhysicalSchemaDigestVerified !== false
    || value.serializedObservationIsAuthority !== false
    || value.artifactEmissionAuthorized !== false
    || value.activationAuthorized !== false
    || value.productionCutoverAuthorized !== false
    || typeof value.receiptSha256 !== "string" || !SHA256_PATTERN.test(value.receiptSha256)) {
    fail("record_invalid");
  }
  validateCapture(value.capture);
  const derived = derivePostgresLogicalPhysicalSchemaV4(
    value.capture as unknown as PostgresLogicalPhysicalSchemaV4Capture,
  );
  validatePinnedDerived(derived);
  if (!exactDerived(value.derived, derived)) fail("record_invalid");
  const payload = recordPayload(value.capture as unknown as PostgresLogicalPhysicalSchemaV4Capture, derived);
  if (value.receiptSha256 !== sha256Domain("pintpath:physical-schema:v4:record", payload)) {
    fail("record_invalid");
  }
  return deepFreeze({ ...payload, receiptSha256: value.receiptSha256 });
}

export function sha256PostgresLogicalPhysicalSchemaV4Policy(): string {
  return sha256Domain("pintpath:physical-schema:v4:policy", staticPolicyValue());
}

export const postgresLogicalPhysicalSchemaV4Internals = Object.freeze({
  canonicalJson,
  sha256Domain,
  staticPolicyValue,
  normalizeTaggedValue,
  parseBytes,
} as const);
