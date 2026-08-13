import crypto from "node:crypto";

export const POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE =
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql" as const;

export const POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256 =
  "e9f045a77d5643bb0d31f2cb2bc10f55dc812d279d621dc33b6e405317fb5ce0" as const;

export const POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_RESTORE_SOURCE_DATABASE_OID_SETTING =
  "pintpath.restore_reviewed_price_kernel_source_database_oid" as const;

const OPERATIONS_COLUMNS = Object.freeze([
  "operation_id:uuid:not-null",
  "operation_kind:text-c:not-null",
  "source_apply_operation_id:uuid:nullable",
  "candidate_sha:text-c:not-null",
  "expected_environment:text-c:not-null",
  "authority_bundle_sha256:text-c:not-null",
  "plan_candidate_sha256:text-c:not-null",
  "review_packet_candidate_sha256:text-c:not-null",
  "target_physical_identity_sha256:text-c:not-null",
  "source_snapshot_sha256:text-c:not-null",
  "request_sha256:text-c:not-null",
  "requested_row_count:integer:not-null",
  "committed_at:timestamptz:not-null",
  "result_state_sha256:text-c:not-null",
  "receipt_sha256:text-c:not-null",
] as const);

const ROWS_COLUMNS = Object.freeze([
  "operation_id:uuid:not-null",
  "row_ordinal:integer:not-null",
  "source_ingestion_id:uuid:not-null",
  "venue_id:uuid:not-null",
  "price_record_id:text-c:not-null",
  "venue_beer_id:text-c:not-null",
  "normalized_beer_id:text-c:not-null",
  "row_request_sha256:text-c:not-null",
  "before_state_sha256:text-c:not-null",
  "after_state_sha256:text-c:not-null",
  "row_receipt_sha256:text-c:not-null",
] as const);

const OPERATIONS_CONSTRAINTS = Object.freeze([
  "reviewed_price_promotion_operations_authority_hash_check",
  "reviewed_price_promotion_operations_candidate_check",
  "reviewed_price_promotion_operations_environment_check",
  "reviewed_price_promotion_operations_kind_check",
  "reviewed_price_promotion_operations_packet_hash_check",
  "reviewed_price_promotion_operations_pkey",
  "reviewed_price_promotion_operations_plan_hash_check",
  "reviewed_price_promotion_operations_receipt_hash_check",
  "reviewed_price_promotion_operations_request_hash_check",
  "reviewed_price_promotion_operations_result_hash_check",
  "reviewed_price_promotion_operations_row_count_check",
  "reviewed_price_promotion_operations_snapshot_hash_check",
  "reviewed_price_promotion_operations_source_apply_fkey",
  "reviewed_price_promotion_operations_source_check",
  "reviewed_price_promotion_operations_target_hash_check",
] as const);

const ROWS_CONSTRAINTS = Object.freeze([
  "reviewed_price_promotion_rows_after_hash_check",
  "reviewed_price_promotion_rows_before_hash_check",
  "reviewed_price_promotion_rows_normalized_id_check",
  "reviewed_price_promotion_rows_operation_fkey",
  "reviewed_price_promotion_rows_ordinal_check",
  "reviewed_price_promotion_rows_pkey",
  "reviewed_price_promotion_rows_price_id_check",
  "reviewed_price_promotion_rows_receipt_hash_check",
  "reviewed_price_promotion_rows_request_hash_check",
  "reviewed_price_promotion_rows_venue_beer_id_check",
] as const);

const OPERATIONS_INDEXES = Object.freeze([
  "reviewed_price_promotion_operations_pkey",
  "reviewed_price_promotion_operations_receipt_uidx",
  "reviewed_price_promotion_operations_source_apply_idx",
] as const);

const ROWS_INDEXES = Object.freeze([
  "reviewed_price_promotion_rows_pkey",
  "reviewed_price_promotion_rows_price_uidx",
  "reviewed_price_promotion_rows_receipt_uidx",
  "reviewed_price_promotion_rows_venue_beer_uidx",
] as const);

const ROLE_PREFIXES = Object.freeze({
  applyOwner: "pintpath_reviewed_price_apply_owner_d",
  applyExecute: "pintpath_reviewed_price_apply_execute_d",
  quarantineOwner: "pintpath_reviewed_price_quarantine_owner_d",
  quarantineExecute: "pintpath_reviewed_price_quarantine_execute_d",
} as const);

const APPLY_FUNCTION = Object.freeze({
  schema: "pintpath_ops",
  name: "apply_reviewed_price_promotion",
  identityArguments: "pg_catalog.jsonb",
  argumentName: "request",
  resultType: "pg_catalog.jsonb",
  language: "plpgsql",
  securityDefiner: true,
  volatility: "volatile",
  parallel: "unsafe",
  strict: false,
  setReturning: false,
  leakproof: false,
  searchPath: "pg_catalog",
  ownerRolePrefix: ROLE_PREFIXES.applyOwner,
  executeRolePrefix: ROLE_PREFIXES.applyExecute,
} as const);

const QUARANTINE_FUNCTION = Object.freeze({
  schema: "pintpath_ops",
  name: "quarantine_reviewed_price_promotion",
  identityArguments: "pg_catalog.jsonb",
  argumentName: "request",
  resultType: "pg_catalog.jsonb",
  language: "plpgsql",
  securityDefiner: true,
  volatility: "volatile",
  parallel: "unsafe",
  strict: false,
  setReturning: false,
  leakproof: false,
  searchPath: "pg_catalog",
  ownerRolePrefix: ROLE_PREFIXES.quarantineOwner,
  executeRolePrefix: ROLE_PREFIXES.quarantineExecute,
} as const);

/**
 * Declarative catalog contract only. The checked-in migration is the sole
 * executable SQL authority; this module must never synthesize migration SQL.
 */
export const POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT = Object.freeze({
  kind: "pintpath-postgres-reviewed-price-promotion-kernel-contract",
  version: 1,
  state: "inert-hard-disabled",
  migrationFile: POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE,
  migrationSha256: POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256,
  inventory: Object.freeze({
    legacyRelations: 59,
    successorRelations: 61,
    forceRlsRelations: 61,
    sequences: 0,
    basePolicies: 179,
    backupPolicies: 61,
    totalPolicies: 240,
    backupRoleDependencies: 63,
    kernelTables: 2,
    kernelFunctions: 2,
    kernelRoles: 4,
  }),
  tables: Object.freeze({
    operations: Object.freeze({
      qualifiedName: "pintpath_ops.reviewed_price_promotion_operations",
      columns: OPERATIONS_COLUMNS,
      constraints: OPERATIONS_CONSTRAINTS,
      indexes: OPERATIONS_INDEXES,
      primaryKey: Object.freeze(["operation_id"] as const),
      migratorPrivileges: Object.freeze(["SELECT"] as const),
      runtimePrivileges: Object.freeze([] as const),
      forceRowLevelSecurity: true,
      persistence: "permanent-heap",
      requiredRowCount: 0,
    }),
    rows: Object.freeze({
      qualifiedName: "pintpath_ops.reviewed_price_promotion_rows",
      columns: ROWS_COLUMNS,
      constraints: ROWS_CONSTRAINTS,
      indexes: ROWS_INDEXES,
      primaryKey: Object.freeze(["operation_id", "row_ordinal"] as const),
      migratorPrivileges: Object.freeze(["SELECT"] as const),
      runtimePrivileges: Object.freeze([] as const),
      forceRowLevelSecurity: true,
      persistence: "permanent-heap",
      requiredRowCount: 0,
    }),
  }),
  roles: ROLE_PREFIXES,
  functions: Object.freeze({
    apply: APPLY_FUNCTION,
    quarantine: QUARANTINE_FUNCTION,
  }),
  failureContract: Object.freeze({
    ownerGuardSqlState: "42501",
    ownerGuardMessage: "reviewed_price_promotion_kernel_owner_unsafe",
    disabledSqlState: "55000",
    disabledMessage: "reviewed_price_promotion_kernel_disabled",
  }),
  restoreTransition: Object.freeze({
    sourceDatabaseOidSetting:
      POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_RESTORE_SOURCE_DATABASE_OID_SETTING,
    explicitSourceDatabaseOidRequiredForCrossDatabaseGuardRewrite: true,
    exactSourceGuardRequiredBeforeRewrite: true,
    targetDatabaseOidGuardRequiredAfterRewrite: true,
    transactionallyVerifiedBeforeCommit: true,
  }),
  activation: Object.freeze({
    mutationEnabled: false,
    callerMembershipCreated: false,
    requestInspected: false,
    relationReadByFunctions: false,
    relationWrittenByFunctions: false,
  }),
} as const);

export function sha256PostgresReviewedPricePromotionKernelMigration(
  bytes: string | Buffer,
): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
