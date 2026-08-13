import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
} from "./postgres-logical-backup-v4-table-data-contract.js";

/**
 * This module is a passive, serialization-safe specification for a future
 * scratch-restore executor. It deliberately has no database, filesystem,
 * process, environment, network, or tool-execution dependency.
 */
export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CAPABILITY = Object.freeze({
  implementationState: "OFFLINE_CONTRACT_ONLY",
  databaseAccessImplemented: false,
  archiveArtifactVerificationImplemented: false,
  sourceAuthorityAcceptanceImplemented: false,
  sourceAuthorityReceiptHashAccepted: false,
  toolExecutableVerificationImplemented: false,
  restoreExecutionImplemented: false,
  crossOidScratchLoadImplemented: false,
  operationalScratchRestoreImplemented: false,
  artifactEmissionAuthorized: false,
  restoreAuthorized: false,
  activationAuthorized: false,
  productionCutoverAuthorized: false,
} as const);

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_CONTRACT_BYTES = 512 * 1024;
export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_JSON_DEPTH = 32;
export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_JSON_NODES = 20_000;

const PINNED_BASE_DDL_SHA256 =
  "5b991b43715b27d4727c0d9988f31bfc43e0d5ce16d1f2e80ede5f3a6b5ded3f";
const PINNED_MIGRATION_CONTRACT_SHA256 =
  "78f49d0af57a19f92154f717c3b5c9c7e3bdc02bbda68809a8f2257bf7ef879d";
const PINNED_KERNEL_MIGRATION_SHA256 =
  "e9f045a77d5643bb0d31f2cb2bc10f55dc812d279d621dc33b6e405317fb5ce0";
const PINNED_KERNEL_CONTRACT_SHA256 =
  "8242a09061b15dee258617672cdfaba6b9f51ada9208088ef170e1ab735f2752";
const PINNED_PORTABLE_BOUNDARY_SHA256 =
  "a0710c86bde835f493d189f2195ebfc07252bc8cf6ffa87d930a8201328f7abd";
const PINNED_TABLE_DATA_SET_SHA256 =
  "505d42cd7ffbe6809aea3e3ed02b33968bf625bde882cdbc0f1a3c69cc94f6d8";
const PINNED_SOURCE_SCHEMA_SHA256 =
  "b5a093844709f725bd71415dadb37062b75e40dbd6475082732fa28b1ef1fcc9";
const PINNED_SOURCE_SCHEMA_FINGERPRINT =
  "6dadd6082a06129dbaf05d73a62a7b2e6c2b590127d1c524c844afe54e1ebdb5";
const BASE_DDL_FILE = "src/db/postgres-schema.sql" as const;
const KERNEL_MIGRATION_FILE =
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OID_PATTERN = /^(?:[1-9][0-9]{0,9})$/;
const COUNT_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/;
const FIXED_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_SIGNED_INT8 = 9_223_372_036_854_775_807n;
const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf] as const);

const BUFFER_OBJECT = Buffer;
const BUFFER_ALLOC = BUFFER_OBJECT.alloc;
const BUFFER_BYTE_LENGTH = BUFFER_OBJECT.byteLength;
const BUFFER_COMPARE = BUFFER_OBJECT.compare;
const BUFFER_FROM = BUFFER_OBJECT.from;
const BUFFER_IS_BUFFER = BUFFER_OBJECT.isBuffer;
const BUFFER_PROTOTYPE = BUFFER_OBJECT.prototype;
const BUFFER_EQUALS = BUFFER_PROTOTYPE.equals;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
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

const ARCHIVED_RELATION_NAMES = Object.freeze(`
pintpath_app.account_deletion_completion_outbox
pintpath_app.account_deletion_notice_recipient_secrets
pintpath_app.account_deletion_notification_events
pintpath_app.account_deletion_requests
pintpath_app.account_discount_passes
pintpath_app.account_preferences
pintpath_app.account_privacy_settings
pintpath_app.account_reward_vouchers
pintpath_app.accounts
pintpath_app.admin_ingestion_queue
pintpath_app.age_verifications
pintpath_app.auth_sessions
pintpath_app.beer_catalog_aliases
pintpath_app.beer_catalog_items
pintpath_app.billing_checkout_reservations
pintpath_app.contribution_ledger
pintpath_app.discount_redemptions
pintpath_app.events
pintpath_app.feedback
pintpath_app.free_pint_reward_codes
pintpath_app.free_pint_reward_redemptions
pintpath_app.leaderboard_prize_awards
pintpath_app.leaderboard_prize_campaigns
pintpath_app.migration_quarantined_records
pintpath_app.mission_progress
pintpath_app.missions
pintpath_app.pint_point_drink_records
pintpath_app.pint_point_ledger
pintpath_app.profiles
pintpath_app.revoked_provider_sessions
pintpath_app.saved_items
pintpath_app.schema_metadata
pintpath_app.security_audit_log
pintpath_app.source_evidence_objects
pintpath_app.stripe_webhook_events
pintpath_app.submission_items
pintpath_app.submission_source_evidence
pintpath_app.submissions
pintpath_app.system_state
pintpath_app.user_activity_events
pintpath_app.venue_analytics_events
pintpath_app.venue_beers
pintpath_app.venue_claim_requests
pintpath_app.venue_happy_hours
pintpath_app.venue_identity_aliases
pintpath_app.venue_interest_requests
pintpath_app.venue_location_cache
pintpath_app.venue_manager_assignments
pintpath_app.venue_monthly_reports
pintpath_app.venue_partner_outreach
pintpath_app.venue_pending_changes
pintpath_app.venue_price_records
pintpath_app.venue_profiles
pintpath_app.venue_requests
pintpath_app.venue_specials
pintpath_app.verifications
pintpath_app.wrong_price_reports
pintpath_ops.migration_chunks
pintpath_ops.migration_runs
`.trim().split("\n"));

const KERNEL_RELATION_NAMES = Object.freeze([
  "pintpath_ops.reviewed_price_promotion_operations",
  "pintpath_ops.reviewed_price_promotion_rows",
] as const);

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ARCHIVED_RELATIONS = ARCHIVED_RELATION_NAMES;
export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS = Object.freeze([
  ...ARCHIVED_RELATION_NAMES,
  ...KERNEL_RELATION_NAMES,
].sort((left, right) => compareText(left, right)));

const SCHEMA_METADATA_SEED = Object.freeze([
  ["import_state", "empty"],
  ["migration_candidate_sha", ""],
  ["migration_contract_sha256", PINNED_MIGRATION_CONTRACT_SHA256],
  ["migration_manifest_sha256", ""],
  ["migration_plan_sha256", ""],
  ["migration_run_sha256", ""],
  ["schema_version", "1"],
  ["source_schema_fingerprint", ""],
  ["source_schema_sha256", PINNED_SOURCE_SCHEMA_SHA256],
  ["source_schema_version", "0"],
  ["source_snapshot_sha256", ""],
  ["target_ddl_sha256", ""],
] as const);

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SCHEMA_METADATA_SEED =
  SCHEMA_METADATA_SEED;

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_CATALOG_COUNTS = Object.freeze({
  privateRelations: 61,
  privateColumns: 771,
  privatePolicies: 240,
  foreignKeys: 79,
  validatedForeignKeys: 79,
  deferrableForeignKeys: 0,
  initiallyDeferredForeignKeys: 0,
  nonSingleColumnForeignKeys: 0,
  riConstraintTriggers: 316,
  enabledRiConstraintTriggers: 316,
  applicationTriggers: 1,
  enabledApplicationTriggers: 1,
  totalPrivateTriggers: 317,
  scopedRoles: 5,
  privateSequences: 0,
  privateRelationPublicationMemberships: 0,
  privateSchemaPublicationMemberships: 0,
  allTablesPublications: 0,
  privateRelationExtensionDependencies: 0,
} as const);

const CONTROL_TABLE_COLUMNS = Object.freeze([
  Object.freeze({
    qualifiedName: "pintpath_app.schema_metadata",
    columns: Object.freeze(["key", "value", "updated_at"]),
  }),
  Object.freeze({
    qualifiedName: "pintpath_ops.migration_chunks",
    columns: Object.freeze([
      "run_id", "table_name", "chunk_ordinal", "row_count",
      "source_transformed_sha256", "target_sha256", "completed_at",
    ]),
  }),
  Object.freeze({
    qualifiedName: "pintpath_ops.migration_runs",
    columns: Object.freeze([
      "run_id", "source_snapshot_sha256", "source_schema_fingerprint",
      "contract_sha256", "manifest_sha256", "target_ddl_sha256",
      "source_schema_version", "candidate_commit_sha", "target_binding_sha256",
      "expected_environment", "approval_reference_sha256", "operator_id_sha256",
      "verifier_id_sha256", "status", "started_at", "completed_at",
      "receipt_sha256", "failure_code",
    ]),
  }),
  Object.freeze({
    qualifiedName: "pintpath_ops.reviewed_price_promotion_operations",
    columns: Object.freeze([
      "operation_id", "operation_kind", "source_apply_operation_id", "candidate_sha",
      "expected_environment", "authority_bundle_sha256", "plan_candidate_sha256",
      "review_packet_candidate_sha256", "target_physical_identity_sha256",
      "source_snapshot_sha256", "request_sha256", "requested_row_count", "committed_at",
      "result_state_sha256", "receipt_sha256",
    ]),
  }),
  Object.freeze({
    qualifiedName: "pintpath_ops.reviewed_price_promotion_rows",
    columns: Object.freeze([
      "operation_id", "row_ordinal", "source_ingestion_id", "venue_id",
      "price_record_id", "venue_beer_id", "normalized_beer_id", "row_request_sha256",
      "before_state_sha256", "after_state_sha256", "row_receipt_sha256",
    ]),
  }),
]);

const AUTHORITATIVE_TABLE_COLUMN_ROWS = `
account_deletion_completion_outbox|23
account_deletion_notice_recipient_secrets|7
account_deletion_notification_events|7
account_deletion_requests|19
account_discount_passes|9
account_preferences|7
account_privacy_settings|9
account_reward_vouchers|16
accounts|34
admin_ingestion_queue|24
age_verifications|11
auth_sessions|9
beer_catalog_aliases|5
beer_catalog_items|10
billing_checkout_reservations|9
contribution_ledger|8
discount_redemptions|16
events|9
feedback|17
free_pint_reward_codes|16
free_pint_reward_redemptions|11
leaderboard_prize_awards|10
leaderboard_prize_campaigns|14
migration_quarantined_records|6
mission_progress|9
missions|13
pint_point_drink_records|21
pint_point_ledger|11
profiles|13
revoked_provider_sessions|4
saved_items|8
security_audit_log|10
source_evidence_objects|11
stripe_webhook_events|11
submission_items|14
submission_source_evidence|4
submissions|29
system_state|4
user_activity_events|7
venue_analytics_events|9
venue_beers|18
venue_claim_requests|17
venue_happy_hours|11
venue_identity_aliases|6
venue_interest_requests|16
venue_location_cache|6
venue_manager_assignments|11
venue_monthly_reports|5
venue_partner_outreach|13
venue_pending_changes|14
venue_price_records|20
venue_profiles|33
venue_requests|19
venue_specials|19
verifications|8
wrong_price_reports|17
`.trim();

const AUTHORITATIVE_TABLE_COLUMNS = Object.freeze(
  AUTHORITATIVE_TABLE_COLUMN_ROWS.split("\n").map((row) => {
    const [tableName, countText] = row.split("|");
    const columnCount = Number(countText);
    if (!tableName || !FIXED_IDENTIFIER_PATTERN.test(tableName)
      || !Number.isSafeInteger(columnCount) || columnCount < 1) fail("static_authority_drift");
    return Object.freeze({ tableName, columnCount });
  }),
);

export interface PostgresLogicalScratchRestoreV4ForeignKeyDescriptor {
  readonly constraintName: string;
  readonly childRelation: string;
  readonly childColumn: string;
  readonly parentRelation: string;
  readonly parentColumn: string;
  readonly validated: true;
  readonly deferrable: false;
  readonly initiallyDeferred: false;
  readonly keyColumnCount: 1;
  readonly antiJoinSql: string;
}

/*
 * Exact pg_catalog projection obtained on PostgreSQL 17 after applying only
 * PINNED_BASE_DDL_SHA256 and PINNED_KERNEL_MIGRATION_SHA256. The separately
 * pinned, domain-separated set hash below makes any descriptor change an
 * explicit authority change; count alone is never accepted.
 */
const FOREIGN_KEY_ROWS = `
account_deletion_completion_outbox_request_id_fkey|pintpath_app.account_deletion_completion_outbox|request_id|pintpath_app.account_deletion_requests|id
account_deletion_notice_recipient_secrets_request_id_fkey|pintpath_app.account_deletion_notice_recipient_secrets|request_id|pintpath_app.account_deletion_completion_outbox|request_id
account_deletion_notification_events_request_id_fkey|pintpath_app.account_deletion_notification_events|request_id|pintpath_app.account_deletion_completion_outbox|request_id
account_deletion_requests_reviewed_by_fkey|pintpath_app.account_deletion_requests|reviewed_by|pintpath_app.accounts|id
account_deletion_requests_user_id_fkey|pintpath_app.account_deletion_requests|user_id|pintpath_app.accounts|id
account_discount_passes_session_token_hash_fkey|pintpath_app.account_discount_passes|session_token_hash|pintpath_app.auth_sessions|token_hash
account_discount_passes_user_id_fkey|pintpath_app.account_discount_passes|user_id|pintpath_app.accounts|id
account_preferences_user_id_fkey|pintpath_app.account_preferences|user_id|pintpath_app.accounts|id
account_privacy_settings_user_id_fkey|pintpath_app.account_privacy_settings|user_id|pintpath_app.accounts|id
account_reward_vouchers_user_id_fkey|pintpath_app.account_reward_vouchers|user_id|pintpath_app.accounts|id
age_verifications_user_id_fkey|pintpath_app.age_verifications|user_id|pintpath_app.accounts|id
auth_sessions_user_id_fkey|pintpath_app.auth_sessions|user_id|pintpath_app.accounts|id
beer_catalog_aliases_beer_key_fkey|pintpath_app.beer_catalog_aliases|beer_key|pintpath_app.beer_catalog_items|key
contribution_ledger_submission_id_fkey|pintpath_app.contribution_ledger|submission_id|pintpath_app.submissions|id
contribution_ledger_user_id_fkey|pintpath_app.contribution_ledger|user_id|pintpath_app.accounts|id
discount_redemptions_discount_pass_id_fkey|pintpath_app.discount_redemptions|discount_pass_id|pintpath_app.account_discount_passes|id
discount_redemptions_redeemed_by_user_id_fkey|pintpath_app.discount_redemptions|redeemed_by_user_id|pintpath_app.accounts|id
discount_redemptions_user_id_fkey|pintpath_app.discount_redemptions|user_id|pintpath_app.accounts|id
events_user_id_fkey|pintpath_app.events|user_id|pintpath_app.accounts|id
feedback_assigned_to_fkey|pintpath_app.feedback|assigned_to|pintpath_app.accounts|id
feedback_resolved_by_fkey|pintpath_app.feedback|resolved_by|pintpath_app.accounts|id
feedback_user_id_fkey|pintpath_app.feedback|user_id|pintpath_app.accounts|id
free_pint_reward_codes_redeemed_by_user_id_fkey|pintpath_app.free_pint_reward_codes|redeemed_by_user_id|pintpath_app.accounts|id
free_pint_reward_codes_user_id_fkey|pintpath_app.free_pint_reward_codes|user_id|pintpath_app.accounts|id
free_pint_reward_redemptions_redeemed_by_user_id_fkey|pintpath_app.free_pint_reward_redemptions|redeemed_by_user_id|pintpath_app.accounts|id
free_pint_reward_redemptions_reward_code_id_fkey|pintpath_app.free_pint_reward_redemptions|reward_code_id|pintpath_app.free_pint_reward_codes|id
free_pint_reward_redemptions_user_id_fkey|pintpath_app.free_pint_reward_redemptions|user_id|pintpath_app.accounts|id
leaderboard_prize_awards_user_id_fkey|pintpath_app.leaderboard_prize_awards|user_id|pintpath_app.accounts|id
leaderboard_prize_awards_voucher_id_fkey|pintpath_app.leaderboard_prize_awards|voucher_id|pintpath_app.account_reward_vouchers|id
mission_progress_mission_id_fkey|pintpath_app.mission_progress|mission_id|pintpath_app.missions|id
mission_progress_submission_id_fkey|pintpath_app.mission_progress|submission_id|pintpath_app.submissions|id
mission_progress_user_id_fkey|pintpath_app.mission_progress|user_id|pintpath_app.accounts|id
pint_point_drink_records_recorded_by_user_id_fkey|pintpath_app.pint_point_drink_records|recorded_by_user_id|pintpath_app.accounts|id
pint_point_drink_records_reward_code_id_fkey|pintpath_app.pint_point_drink_records|reward_code_id|pintpath_app.free_pint_reward_codes|id
pint_point_drink_records_user_id_fkey|pintpath_app.pint_point_drink_records|user_id|pintpath_app.accounts|id
pint_point_drink_records_voided_by_user_id_fkey|pintpath_app.pint_point_drink_records|voided_by_user_id|pintpath_app.accounts|id
pint_point_ledger_drink_record_id_fkey|pintpath_app.pint_point_ledger|drink_record_id|pintpath_app.pint_point_drink_records|id
pint_point_ledger_reward_code_id_fkey|pintpath_app.pint_point_ledger|reward_code_id|pintpath_app.free_pint_reward_codes|id
pint_point_ledger_user_id_fkey|pintpath_app.pint_point_ledger|user_id|pintpath_app.accounts|id
profiles_id_fkey|pintpath_app.profiles|id|pintpath_app.accounts|id
revoked_provider_sessions_user_id_fkey|pintpath_app.revoked_provider_sessions|user_id|pintpath_app.accounts|id
saved_items_user_id_fkey|pintpath_app.saved_items|user_id|pintpath_app.accounts|id
source_evidence_objects_owner_user_id_fkey|pintpath_app.source_evidence_objects|owner_user_id|pintpath_app.accounts|id
submission_items_submission_id_fkey|pintpath_app.submission_items|submission_id|pintpath_app.submissions|id
submission_source_evidence_evidence_id_fkey|pintpath_app.submission_source_evidence|evidence_id|pintpath_app.source_evidence_objects|id
submission_source_evidence_submission_id_fkey|pintpath_app.submission_source_evidence|submission_id|pintpath_app.submissions|id
submissions_mission_id_fkey|pintpath_app.submissions|mission_id|pintpath_app.missions|id
submissions_reviewed_by_fkey|pintpath_app.submissions|reviewed_by|pintpath_app.accounts|id
submissions_user_id_fkey|pintpath_app.submissions|user_id|pintpath_app.accounts|id
user_activity_events_user_id_fkey|pintpath_app.user_activity_events|user_id|pintpath_app.accounts|id
venue_beers_venue_id_fkey|pintpath_app.venue_beers|venue_id|pintpath_app.venue_profiles|venue_id
venue_claim_requests_reviewed_by_fkey|pintpath_app.venue_claim_requests|reviewed_by|pintpath_app.accounts|id
venue_claim_requests_user_id_fkey|pintpath_app.venue_claim_requests|user_id|pintpath_app.accounts|id
venue_happy_hours_venue_id_fkey|pintpath_app.venue_happy_hours|venue_id|pintpath_app.venue_profiles|venue_id
venue_interest_requests_assigned_to_fkey|pintpath_app.venue_interest_requests|assigned_to|pintpath_app.accounts|id
venue_interest_requests_resolved_by_fkey|pintpath_app.venue_interest_requests|resolved_by|pintpath_app.accounts|id
venue_interest_requests_user_id_fkey|pintpath_app.venue_interest_requests|user_id|pintpath_app.accounts|id
venue_manager_assignments_approved_by_fkey|pintpath_app.venue_manager_assignments|approved_by|pintpath_app.accounts|id
venue_manager_assignments_user_id_fkey|pintpath_app.venue_manager_assignments|user_id|pintpath_app.accounts|id
venue_monthly_reports_venue_id_fkey|pintpath_app.venue_monthly_reports|venue_id|pintpath_app.venue_profiles|venue_id
venue_partner_outreach_updated_by_fkey|pintpath_app.venue_partner_outreach|updated_by|pintpath_app.accounts|id
venue_pending_changes_reviewed_by_fkey|pintpath_app.venue_pending_changes|reviewed_by|pintpath_app.accounts|id
venue_pending_changes_submitted_by_fkey|pintpath_app.venue_pending_changes|submitted_by|pintpath_app.accounts|id
venue_price_records_source_submission_id_fkey|pintpath_app.venue_price_records|source_submission_id|pintpath_app.submissions|id
venue_requests_assigned_to_fkey|pintpath_app.venue_requests|assigned_to|pintpath_app.accounts|id
venue_requests_mission_id_fkey|pintpath_app.venue_requests|mission_id|pintpath_app.missions|id
venue_requests_resolved_by_fkey|pintpath_app.venue_requests|resolved_by|pintpath_app.accounts|id
venue_requests_source_submission_id_fkey|pintpath_app.venue_requests|source_submission_id|pintpath_app.submissions|id
venue_requests_user_id_fkey|pintpath_app.venue_requests|user_id|pintpath_app.accounts|id
venue_specials_venue_id_fkey|pintpath_app.venue_specials|venue_id|pintpath_app.venue_profiles|venue_id
verifications_upload_id_fkey|pintpath_app.verifications|upload_id|pintpath_app.submissions|id
verifications_verifier_user_id_fkey|pintpath_app.verifications|verifier_user_id|pintpath_app.accounts|id
wrong_price_reports_assigned_to_fkey|pintpath_app.wrong_price_reports|assigned_to|pintpath_app.accounts|id
wrong_price_reports_price_record_id_fkey|pintpath_app.wrong_price_reports|price_record_id|pintpath_app.venue_price_records|id
wrong_price_reports_resolved_by_fkey|pintpath_app.wrong_price_reports|resolved_by|pintpath_app.accounts|id
wrong_price_reports_user_id_fkey|pintpath_app.wrong_price_reports|user_id|pintpath_app.accounts|id
migration_chunks_run_id_fkey|pintpath_ops.migration_chunks|run_id|pintpath_ops.migration_runs|run_id
reviewed_price_promotion_operations_source_apply_fkey|pintpath_ops.reviewed_price_promotion_operations|source_apply_operation_id|pintpath_ops.reviewed_price_promotion_operations|operation_id
reviewed_price_promotion_rows_operation_fkey|pintpath_ops.reviewed_price_promotion_rows|operation_id|pintpath_ops.reviewed_price_promotion_operations|operation_id
`.trim();

export type PostgresLogicalScratchRestoreV4ErrorCode =
  | "static_authority_drift"
  | "contract_invalid"
  | "artifact_evidence_invalid"
  | "source_authority_evidence_only"
  | "source_authority_unsupported"
  | "catalog_evidence_invalid"
  | "pre_load_evidence_invalid"
  | "state_capture_invalid"
  | "target_comparison_invalid"
  | "post_load_evidence_invalid"
  | "disposal_evidence_invalid"
  | "operational_completion_unimplemented";

export class PostgresLogicalScratchRestoreV4Error extends Error {
  constructor(readonly code: PostgresLogicalScratchRestoreV4ErrorCode) {
    super(code);
    this.name = "PostgresLogicalScratchRestoreV4Error";
  }
}

function fail(code: PostgresLogicalScratchRestoreV4ErrorCode): never {
  throw new PostgresLogicalScratchRestoreV4Error(code);
}

function compareText(left: string, right: string): number {
  const leftBytes = REFLECT_APPLY(BUFFER_FROM, BUFFER_OBJECT, [left, "utf8"]) as Buffer;
  const rightBytes = REFLECT_APPLY(BUFFER_FROM, BUFFER_OBJECT, [right, "utf8"]) as Buffer;
  return REFLECT_APPLY(BUFFER_COMPARE, BUFFER_OBJECT, [leftBytes, rightBytes]) as number;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    return false;
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function snapshotBoundedPlainData(
  value: unknown,
  code: PostgresLogicalScratchRestoreV4ErrorCode,
): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_JSON_NODES
      || depth > POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_JSON_DEPTH) fail(code);
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      if ((REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_OBJECT, [candidate, "utf8"]) as number)
        > 64 * 1024) fail(code);
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate) || candidate < 0 || Object.is(candidate, -0)) fail(code);
      return candidate;
    }
    if (typeof candidate !== "object" || utilTypes.isProxy(candidate)) fail(code);
    if (seen.has(candidate)) fail(code);
    seen.add(candidate);
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
      if (prototype !== Array.prototype || keys.length > 513
        || keys.some((key) => typeof key !== "string"
          || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) fail(code);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0 || lengthDescriptor.value > 512
        || keys.length !== Number(lengthDescriptor.value) + 1) fail(code);
      const output: unknown[] = [];
      for (let index = 0; index < Number(lengthDescriptor.value); index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    if (keys.length > 512) fail(code);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string"
        || (REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_OBJECT, [key, "utf8"]) as number) > 128) {
        fail(code);
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

function snapshotBoundedPlainBuffer(input: unknown): Buffer {
  try {
    if (typeof input !== "object" || input === null || UTIL_IS_PROXY(input)
      || !TYPED_ARRAY_BYTE_LENGTH) fail("contract_invalid");
    const byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH, input, []) as unknown;
    if (!Number.isSafeInteger(byteLength) || Number(byteLength) < 1
      || Number(byteLength) > POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_CONTRACT_BYTES
      || !UTIL_IS_UINT8_ARRAY(input)
      || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [input]) !== BUFFER_PROTOTYPE
      || REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_OBJECT, [input]) !== true) {
      fail("contract_invalid");
    }
    const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [input]) as PropertyKey[];
    const descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      Object,
      [input],
    ) as PropertyDescriptorMap;
    if (keys.length !== Number(byteLength)) fail("contract_invalid");
    for (let index = 0; index < Number(byteLength); index += 1) {
      const descriptor = descriptors[String(index)];
      if (keys[index] !== String(index) || !descriptor || !("value" in descriptor)
        || !Number.isInteger(descriptor.value) || descriptor.value < 0
        || descriptor.value > 255 || descriptor.enumerable !== true) fail("contract_invalid");
    }
    const snapshot = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_OBJECT, [byteLength]) as Buffer;
    REFLECT_APPLY(TYPED_ARRAY_SET, snapshot, [input, 0]);
    return snapshot;
  } catch (error) {
    if (error instanceof PostgresLogicalScratchRestoreV4Error) throw error;
    fail("contract_invalid");
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      fail("contract_invalid");
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
  fail("contract_invalid");
}

function sha256Canonical(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function exactOid(value: unknown): value is string {
  if (typeof value !== "string" || !OID_PATTERN.test(value)) return false;
  const oid = BigInt(value);
  return oid > 0n && oid <= 4_294_967_295n;
}

function exactCount(value: unknown, code: PostgresLogicalScratchRestoreV4ErrorCode): bigint {
  if (typeof value !== "string" || !COUNT_PATTERN.test(value)) fail(code);
  const count = BigInt(value);
  if (count > MAX_SIGNED_INT8) fail(code);
  return count;
}

function exactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) && instant.toISOString() === value;
}

function splitQualifiedName(value: string): readonly [string, string] {
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]
    || !FIXED_IDENTIFIER_PATTERN.test(parts[0])
    || !FIXED_IDENTIFIER_PATTERN.test(parts[1])) fail("static_authority_drift");
  return [parts[0], parts[1]];
}

function quoteIdentifier(value: string): string {
  if (!FIXED_IDENTIFIER_PATTERN.test(value)) fail("static_authority_drift");
  return `"${value}"`;
}

function quoteQualifiedName(value: string): string {
  const [schemaName, relationName] = splitQualifiedName(value);
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(relationName)}`;
}

function buildForeignKeyDescriptors(): readonly PostgresLogicalScratchRestoreV4ForeignKeyDescriptor[] {
  const descriptors = FOREIGN_KEY_ROWS.split("\n").map((row) => {
    const fields = row.split("|");
    if (fields.length !== 5) fail("static_authority_drift");
    const [constraintName, childRelation, childColumn, parentRelation, parentColumn] = fields;
    if (!constraintName || !childRelation || !childColumn || !parentRelation || !parentColumn
      || !FIXED_IDENTIFIER_PATTERN.test(constraintName)
      || !FIXED_IDENTIFIER_PATTERN.test(childColumn)
      || !FIXED_IDENTIFIER_PATTERN.test(parentColumn)) fail("static_authority_drift");
    splitQualifiedName(childRelation);
    splitQualifiedName(parentRelation);
    const antiJoinSql = `/* pintpath:scratch-restore-v4:foreign-key:${constraintName} */\n`
      + `SELECT pg_catalog.count(*)::pg_catalog.text AS "violationRowCount"\n`
      + `FROM ONLY ${quoteQualifiedName(childRelation)} AS child\n`
      + `WHERE child.${quoteIdentifier(childColumn)} IS NOT NULL\n`
      + `  AND NOT EXISTS (\n`
      + `    SELECT 1 FROM ONLY ${quoteQualifiedName(parentRelation)} AS parent\n`
      + `    WHERE parent.${quoteIdentifier(parentColumn)} = child.${quoteIdentifier(childColumn)}\n`
      + "  )";
    return Object.freeze({
      constraintName,
      childRelation,
      childColumn,
      parentRelation,
      parentColumn,
      validated: true as const,
      deferrable: false as const,
      initiallyDeferred: false as const,
      keyColumnCount: 1 as const,
      antiJoinSql,
    });
  });
  if (descriptors.length !== 79
    || new Set(descriptors.map((descriptor) => descriptor.constraintName)).size !== 79) {
    fail("static_authority_drift");
  }
  return Object.freeze(descriptors);
}

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS =
  buildForeignKeyDescriptors();

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEY_SET_SHA256 =
  sha256Canonical({
    kind: "pintpath-postgres-logical-scratch-restore-v4-foreign-key-set",
    version: 1,
    baseDdlSha256: PINNED_BASE_DDL_SHA256,
    kernelMigrationSha256: PINNED_KERNEL_MIGRATION_SHA256,
    entries: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS.map((entry) => ({
      constraintName: entry.constraintName,
      childRelation: entry.childRelation,
      childColumn: entry.childColumn,
      parentRelation: entry.parentRelation,
      parentColumn: entry.parentColumn,
      validated: entry.validated,
      deferrable: entry.deferrable,
      initiallyDeferred: entry.initiallyDeferred,
      keyColumnCount: entry.keyColumnCount,
    })),
  });
export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_FOREIGN_KEY_SET_SHA256 =
  "20f1b960b5cbd667add7602363ceed6b89177a771d24418fc6ed60b768608349" as const;

const APPLICATION_TRIGGER_DISABLED_CONSTRAINTS = Object.freeze([
  Object.freeze({
    constraintName: "pint_point_drink_records_voided_by_user_id_fkey",
    parentRelation: "pintpath_app.accounts",
    childRelation: "pintpath_app.pint_point_drink_records",
    childColumn: "voided_by_user_id",
    triggerFunction: "pg_catalog.RI_FKey_setnull_del",
  }),
  Object.freeze({
    constraintName: "venue_claim_requests_reviewed_by_fkey",
    parentRelation: "pintpath_app.accounts",
    childRelation: "pintpath_app.venue_claim_requests",
    childColumn: "reviewed_by",
    triggerFunction: "pg_catalog.RI_FKey_setnull_del",
  }),
] as const);

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_APPLICATION_TRIGGER_PROOF = Object.freeze({
  profile: "rollback-only-account-reference-trigger-proof-v1",
  applicationTrigger: Object.freeze({
    relation: "pintpath_app.accounts",
    triggerName: "clear_added_account_references_before_delete",
    function: "pintpath_app.clear_account_references_before_delete",
    timing: "BEFORE DELETE",
    enabledThroughoutProof: true,
  }),
  parentSideRiSetNullTriggersDisabled: APPLICATION_TRIGGER_DISABLED_CONSTRAINTS,
  exactDisabledTriggerCount: 2,
  allOtherRiTriggersMustRemainEnabled: true,
  fixtures: Object.freeze({
    accountRows: 2,
    childRows: 2,
    reviewerAccountRowsDeleted: 1,
    requiredSurvivingChildRows: 2,
    requiredNullReferenceRows: 2,
  }),
  proofTransactionMustRollback: true,
  fixtureResidueRowsAfterRollback: 0,
  schemaAndTriggerStateMustMatchBeforeProof: true,
} as const);

function buildSqlContract() {
  const relationLockSql = `/* pintpath:scratch-restore-v4:pre-load-locks */\nLOCK TABLE ${
    POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS.map(
      (name) => `ONLY ${quoteQualifiedName(name)}`,
    ).join(", ")
  } IN ACCESS EXCLUSIVE MODE`;
  const relationRowsSql = [
    "/* pintpath:scratch-restore-v4:relation-row-counts */",
    "SELECT relation_rows.\"qualifiedName\", relation_rows.\"rowCount\"",
    "FROM (",
    ...POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS.map((name, index) => (
      `${index === 0 ? "" : "UNION ALL\n"}SELECT '${name}'::pg_catalog.text AS "qualifiedName", `
      + `pg_catalog.count(*)::pg_catalog.text AS "rowCount" FROM ONLY ${quoteQualifiedName(name)}`
    )),
    ") AS relation_rows",
    "ORDER BY relation_rows.\"qualifiedName\" COLLATE pg_catalog.\"C\"",
  ].join("\n");
  const seedKeysSql = SCHEMA_METADATA_SEED.map(([key]) => `'${key}'`).join(", ");
  const seedRowsSql = `/* pintpath:scratch-restore-v4:seed-read */\n`
    + "SELECT key, value, updated_at AS \"updatedAt\"\n"
    + "FROM ONLY \"pintpath_app\".\"schema_metadata\"\n"
    + "ORDER BY key COLLATE pg_catalog.\"C\"";
  const seedDeleteSql = `/* pintpath:scratch-restore-v4:seed-delete */\n`
    + "DELETE FROM ONLY \"pintpath_app\".\"schema_metadata\"\n"
    + `WHERE key = ANY (ARRAY[${seedKeysSql}]::pg_catalog.text[])\n`
    + "RETURNING key, value, updated_at AS \"updatedAt\"";
  const triggerSelectorSql = `/* pintpath:scratch-restore-v4:application-trigger-mask-selector */\n`
    + "SELECT trigger_object.tgname AS \"triggerName\", constraint_object.conname AS \"constraintName\",\n"
    + "       function_namespace.nspname AS \"functionSchema\", trigger_function.proname AS \"functionName\"\n"
    + "FROM pg_catalog.pg_trigger AS trigger_object\n"
    + "JOIN pg_catalog.pg_constraint AS constraint_object ON constraint_object.oid = trigger_object.tgconstraint\n"
    + "JOIN pg_catalog.pg_class AS parent_relation ON parent_relation.oid = trigger_object.tgrelid\n"
    + "JOIN pg_catalog.pg_namespace AS parent_namespace ON parent_namespace.oid = parent_relation.relnamespace\n"
    + "JOIN pg_catalog.pg_proc AS trigger_function ON trigger_function.oid = trigger_object.tgfoid\n"
    + "JOIN pg_catalog.pg_namespace AS function_namespace ON function_namespace.oid = trigger_function.pronamespace\n"
    + "WHERE parent_namespace.nspname = 'pintpath_app' AND parent_relation.relname = 'accounts'\n"
    + "  AND trigger_object.tgisinternal AND trigger_object.tgenabled = 'O'\n"
    + "  AND function_namespace.nspname = 'pg_catalog' AND trigger_function.proname = 'RI_FKey_setnull_del'\n"
    + "  AND constraint_object.conname = ANY (ARRAY[\n"
    + "    'pint_point_drink_records_voided_by_user_id_fkey',\n"
    + "    'venue_claim_requests_reviewed_by_fkey'\n"
    + "  ]::pg_catalog.text[])\n"
    + "ORDER BY constraint_object.conname COLLATE pg_catalog.\"C\"";
  return deepFreeze({
    trustedSearchPathSql:
      "SET LOCAL search_path = pg_catalog, pg_temp",
    trustedSearchPathPreflightSql:
      "/* pintpath:scratch-restore-v4:trusted-search-path */\n"
      + "SELECT (pg_catalog.current_schemas(true))[1]::pg_catalog.text AS \"firstSchema\"",
    relationLockSql,
    seedRowsSql,
    seedDeleteSql,
    relationRowsSql,
    foreignKeyCatalogSql: `/* pintpath:scratch-restore-v4:foreign-key-catalog */\n`
      + "SELECT constraint_object.conname AS \"constraintName\", constraint_object.convalidated AS \"validated\",\n"
      + "       constraint_object.condeferrable AS \"deferrable\", constraint_object.condeferred AS \"initiallyDeferred\",\n"
      + "       pg_catalog.cardinality(constraint_object.conkey) AS \"keyColumnCount\"\n"
      + "FROM pg_catalog.pg_constraint AS constraint_object\n"
      + "JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = constraint_object.connamespace\n"
      + "WHERE namespace.nspname = ANY (ARRAY['pintpath_app', 'pintpath_ops'])\n"
      + "  AND constraint_object.contype = 'f'\n"
      + "ORDER BY constraint_object.conname COLLATE pg_catalog.\"C\"",
    foreignKeyAntiJoinSql: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS.map(
      (descriptor) => descriptor.antiJoinSql,
    ),
    triggerSelectorSql,
    catalogCountsSql: `/* pintpath:scratch-restore-v4:catalog-counts */
WITH database_identity AS (
  SELECT database.oid
  FROM pg_catalog.pg_database AS database
  WHERE database.datname = pg_catalog.current_database()
), private_relations AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ANY (ARRAY['pintpath_app', 'pintpath_ops'])
    AND relation.relkind IN ('r', 'p')
), private_sequences AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = ANY (ARRAY['pintpath_app', 'pintpath_ops'])
    AND relation.relkind = 'S'
), scoped_roles AS (
  SELECT roles.oid
  FROM database_identity AS database
  JOIN pg_catalog.pg_roles AS roles ON roles.rolname = ANY (ARRAY[
    'pintpath_logical_backup_d' || database.oid::pg_catalog.text,
    'pintpath_reviewed_price_apply_owner_d' || database.oid::pg_catalog.text,
    'pintpath_reviewed_price_apply_execute_d' || database.oid::pg_catalog.text,
    'pintpath_reviewed_price_quarantine_owner_d' || database.oid::pg_catalog.text,
    'pintpath_reviewed_price_quarantine_execute_d' || database.oid::pg_catalog.text
  ])
)
SELECT
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM private_relations)
    AS "privateRelations",
  (SELECT pg_catalog.count(*)::pg_catalog.int4
   FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid IN (SELECT oid FROM private_relations)
     AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS "privateColumns",
  (SELECT pg_catalog.count(*)::pg_catalog.int4
   FROM pg_catalog.pg_policy AS policy
   WHERE policy.polrelid IN (SELECT oid FROM private_relations)) AS "privatePolicies",
  (SELECT pg_catalog.count(*)::pg_catalog.int4
   FROM pg_catalog.pg_constraint AS constraint_object
   WHERE constraint_object.conrelid IN (SELECT oid FROM private_relations)
     AND constraint_object.contype = 'f') AS "foreignKeys",
  (SELECT pg_catalog.count(*) FILTER (WHERE constraint_object.convalidated)::pg_catalog.int4
   FROM pg_catalog.pg_constraint AS constraint_object
   WHERE constraint_object.conrelid IN (SELECT oid FROM private_relations)
     AND constraint_object.contype = 'f') AS "validatedForeignKeys",
  (SELECT pg_catalog.count(*) FILTER (WHERE constraint_object.condeferrable)::pg_catalog.int4
   FROM pg_catalog.pg_constraint AS constraint_object
   WHERE constraint_object.conrelid IN (SELECT oid FROM private_relations)
     AND constraint_object.contype = 'f') AS "deferrableForeignKeys",
  (SELECT pg_catalog.count(*) FILTER (WHERE constraint_object.condeferred)::pg_catalog.int4
   FROM pg_catalog.pg_constraint AS constraint_object
   WHERE constraint_object.conrelid IN (SELECT oid FROM private_relations)
     AND constraint_object.contype = 'f') AS "initiallyDeferredForeignKeys",
  (SELECT pg_catalog.count(*) FILTER (
     WHERE pg_catalog.cardinality(constraint_object.conkey) <> 1
        OR pg_catalog.cardinality(constraint_object.confkey) <> 1
   )::pg_catalog.int4
   FROM pg_catalog.pg_constraint AS constraint_object
   WHERE constraint_object.conrelid IN (SELECT oid FROM private_relations)
     AND constraint_object.contype = 'f') AS "nonSingleColumnForeignKeys",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_trigger AS trigger_object
   WHERE trigger_object.tgrelid IN (SELECT oid FROM private_relations)
     AND trigger_object.tgisinternal AND trigger_object.tgconstraint <> 0::pg_catalog.oid)
    AS "riConstraintTriggers",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_trigger AS trigger_object
   WHERE trigger_object.tgrelid IN (SELECT oid FROM private_relations)
     AND trigger_object.tgisinternal AND trigger_object.tgconstraint <> 0::pg_catalog.oid
     AND trigger_object.tgenabled = 'O') AS "enabledRiConstraintTriggers",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_trigger AS trigger_object
   WHERE trigger_object.tgrelid IN (SELECT oid FROM private_relations)
     AND NOT trigger_object.tgisinternal) AS "applicationTriggers",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_trigger AS trigger_object
   WHERE trigger_object.tgrelid IN (SELECT oid FROM private_relations)
     AND NOT trigger_object.tgisinternal AND trigger_object.tgenabled = 'O')
    AS "enabledApplicationTriggers",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_trigger AS trigger_object
   WHERE trigger_object.tgrelid IN (SELECT oid FROM private_relations)) AS "totalPrivateTriggers",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM scoped_roles) AS "scopedRoles",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM private_sequences) AS "privateSequences",
  (SELECT pg_catalog.count(*)::pg_catalog.int4
   FROM pg_catalog.pg_publication_rel AS publication_relation
   WHERE publication_relation.prrelid IN (SELECT oid FROM private_relations))
    AS "privateRelationPublicationMemberships",
  (SELECT pg_catalog.count(*)::pg_catalog.int4
   FROM pg_catalog.pg_publication_namespace AS publication_namespace
   JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = publication_namespace.pnnspid
   WHERE namespace.nspname = ANY (ARRAY['pintpath_app', 'pintpath_ops']))
    AS "privateSchemaPublicationMemberships",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_publication AS publication
   WHERE publication.puballtables) AS "allTablesPublications",
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_depend AS dependency
   WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
     AND dependency.objid IN (SELECT oid FROM private_relations)
     AND dependency.deptype = 'e') AS "privateRelationExtensionDependencies"`,
  });
}

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL = buildSqlContract();

function assertStaticAuthority(): void {
  const importedRelationNames = POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.map(
    (descriptor) => `${descriptor.schemaName}.${descriptor.tableName}`,
  );
  if (
    POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256 !== PINNED_TABLE_DATA_SET_SHA256
    || POSTGRES_LOGICAL_BACKUP_V4_EXPECTED_TABLE_SET_SHA256 !== PINNED_TABLE_DATA_SET_SHA256
    || canonicalJson(importedRelationNames) !== canonicalJson(ARCHIVED_RELATION_NAMES)
    || AUTHORITATIVE_TABLE_COLUMNS.length !== 56
    || AUTHORITATIVE_TABLE_COLUMNS.reduce((sum, table) => sum + table.columnCount, 0) !== 717
    || POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEY_SET_SHA256
      !== POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_FOREIGN_KEY_SET_SHA256
    || POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS.length !== 61
    || new Set(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS).size !== 61
  ) fail("static_authority_drift");
}

function buildContractValue() {
  assertStaticAuthority();
  return deepFreeze({
    kind: "pintpath-postgres-logical-scratch-restore-v4-contract",
    version: 1,
    implementationState: "OFFLINE_CONTRACT_ONLY",
    capability: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CAPABILITY,
    staticAuthority: {
      manifestSchemaVersion: 4,
      postgresMajor: 17,
      baseDdlFile: BASE_DDL_FILE,
      baseDdlSha256: PINNED_BASE_DDL_SHA256,
      migrationContractSha256: PINNED_MIGRATION_CONTRACT_SHA256,
      sourceSchemaSha256: PINNED_SOURCE_SCHEMA_SHA256,
      sourceSchemaFingerprint: PINNED_SOURCE_SCHEMA_FINGERPRINT,
      kernelMigrationFile: KERNEL_MIGRATION_FILE,
      kernelMigrationSha256: PINNED_KERNEL_MIGRATION_SHA256,
      kernelContractSha256: PINNED_KERNEL_CONTRACT_SHA256,
      portableReadBoundarySha256: PINNED_PORTABLE_BOUNDARY_SHA256,
      tableDataSetSha256: PINNED_TABLE_DATA_SET_SHA256,
    },
    artifactEvidence: {
      canonicalManifestRequired: true,
      exactManifestBindingRequired: true,
      exactArchiveByteCountAndSha256Required: true,
      exactRawListingSha256Required: true,
      exactTableDataTocRequired: true,
      exactSourceDatabaseNameBindingRequired: true,
      independentlyAuthenticatedPgDumpExecutableRequired: true,
      independentlyAuthenticatedPgRestoreExecutableRequired: true,
      archiveBytesVerifiedByThisModule: false,
      sourceDatabaseNameBindingVerifiedByThisModule: false,
      toolExecutablesVerifiedByThisModule: false,
      currentSourceAuthorityReceiptVersion: 1,
      currentSourceAuthorityReceiptAccepted: false,
      currentSourceAuthorityReceiptSha256IsAuthority: false,
      acceptedOperationalSourceAuthorityReceiptVersions: [] as number[],
      futureReviewedOperationalReceiptVersionRequired: true,
    },
    targetAuthority: {
      disposableDatabaseRequired: true,
      currentUserSuperuserRequired: true,
      dedicatedExclusiveConnectionRequired: true,
      trustedSearchPathMustBeSetBeforeEveryFixedSqlSequence: true,
      trustedSearchPathSqlMustBeExactlyPgCatalogThenPgTemp: true,
      effectiveFirstSchemaMustBePgCatalog: true,
      trustedSearchPathVerifiedByThisModule: false,
      sourceAndTargetDatabaseOidsMustDiffer: true,
      sourceAndTargetPhysicalBoundarySha256MustDiffer: true,
      portableBoundarySha256MustEqualPinnedAuthority: true,
      schemaDefinitionAppliedFromPinnedBytesOnly: true,
      archiveLoadAuthorityImplemented: false,
    },
    catalog: {
      expectedCounts: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_CATALOG_COUNTS,
      archivedRelations: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ARCHIVED_RELATIONS,
      authoritativeTableColumns: AUTHORITATIVE_TABLE_COLUMNS,
      kernelRelations: KERNEL_RELATION_NAMES,
      allRelations: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS,
      scopedRolePrefixes: [
        "pintpath_logical_backup_d",
        "pintpath_reviewed_price_apply_owner_d",
        "pintpath_reviewed_price_apply_execute_d",
        "pintpath_reviewed_price_quarantine_owner_d",
        "pintpath_reviewed_price_quarantine_execute_d",
      ],
      foreignKeys: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS,
      foreignKeySetSha256:
        POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_FOREIGN_KEY_SET_SHA256,
    },
    preLoad: {
      lockAll61RelationsOnlyInAccessExclusiveMode: true,
      schemaMetadataSeed: SCHEMA_METADATA_SEED,
      requiredSeedRowCount: 12,
      eachSeedUpdatedAtMustBeNonNullCanonicalUtcInstant: true,
      exactSeedRowsMustBeDeletedAndReturned: true,
      requiredDeletedSeedRowCount: 12,
      all61RelationsMustBeEmptyAfterSeedRemoval: true,
      archivedRelationCount: 59,
      kernelRelationCount: 2,
      requiredTotalRowCountAfterSeedRemoval: "0",
      emptyStateRequiresIndependentFutureDatabaseObservation: true,
    },
    restore: {
      exactArchiveRelationCount: 59,
      kernelRelationsExcludedFromArchive: true,
      disableTriggersRequiresVerifiedTargetSuperuser: true,
      singleTransactionRequired: true,
      exitOnErrorRequired: true,
      archiveExecutionImplemented: false,
    },
    postLoad: {
      physicalReadBoundaryMustEqualPreLoadBoundary: true,
      physicalReadBoundaryEqualityIsCallerReportedOnly: true,
      physicalReadBoundaryIndependentlyVerifiedByThisModule: false,
      completePhysicalSchemaCatalogDigestRequired: true,
      completePhysicalSchemaCatalogDigestVerifiedByThisModule: false,
      all316RiConstraintTriggersMustBeEnabled: true,
      applicationTriggerMustBeEnabled: true,
      totalEnabledPrivateTriggers: 317,
      exactSourceRelationRowCountsRequired: true,
      exactArchiveRowTotalRequired: true,
      kernelRelationRowCountsMustRemainZero: true,
      all79DescriptorDerivedForeignKeyAntiJoinsMustReturnZero: true,
      applicationTriggerProof: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_APPLICATION_TRIGGER_PROOF,
    },
    finalV2Comparison: {
      freshTargetOidScopedBackupRoleRequired: true,
      sourceAndTargetDatabaseOidsMustDiffer: true,
      sourceAndTargetPhysicalBoundarySha256MustDiffer: true,
      bothPortableBoundarySha256MustEqualPinnedAuthority: true,
      exactCanonicalV2InventoryMatchRequired: true,
      exactOverallStateSha256MatchRequired: true,
      opaqueDigestsAreNotStandaloneAuthority: true,
      offlineProjectionPerformsIndependentFullV2Validation: false,
    },
    cleanup: {
      allConnectionsClosedBeforeDisposal: true,
      archiveDescriptorsClosedBeforeDisposal: true,
      toolProcessReapedBeforeDisposal: true,
      disposableDatabaseDropped: true,
      fiveTargetOidScopedRolesDropped: true,
      temporaryArtifactsDisposed: true,
      requiredResidualDatabaseCount: 0,
      requiredResidualScopedRoleCount: 0,
      requiredResidualSessionCount: 0,
      requiredResidualArtifactCount: 0,
      disposalMustCompleteBeforeAnySuccessReceipt: true,
      successReceiptImplemented: false,
    },
    sql: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL,
    blockers: [
      "operational-archive-byte-custody-and-verification-unimplemented",
      "operational-source-authority-receipt-unimplemented",
      "operational-tool-executable-verification-unimplemented",
      "complete-physical-schema-catalog-digest-verification-unimplemented",
      "cross-oid-scratch-database-load-and-disposal-unimplemented",
      "success-receipt-unimplemented",
    ],
  } as const);
}

export type PostgresLogicalScratchRestoreV4Contract = ReturnType<typeof buildContractValue>;

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT = buildContractValue();

function canonicalJson(value: unknown): string {
  return `${canonicalize(value)}\n`;
}

export const POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT_SHA256 =
  sha256Canonical(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT);

export function buildPostgresLogicalScratchRestoreV4Contract():
PostgresLogicalScratchRestoreV4Contract {
  return buildContractValue();
}

export function canonicalPostgresLogicalScratchRestoreV4Contract(): Buffer {
  const bytes = REFLECT_APPLY(
    BUFFER_FROM,
    BUFFER_OBJECT,
    [canonicalJson(buildContractValue()), "utf8"],
  ) as Buffer;
  if (bytes.length > POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_CONTRACT_BYTES) {
    fail("static_authority_drift");
  }
  return bytes;
}

export function parsePostgresLogicalScratchRestoreV4Contract(
  input: unknown,
): PostgresLogicalScratchRestoreV4Contract {
  const bytes = snapshotBoundedPlainBuffer(input);
  if (bytes.length >= UTF8_BOM.length
    && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    fail("contract_invalid");
  }
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const roundTrip = REFLECT_APPLY(BUFFER_FROM, BUFFER_OBJECT, [text, "utf8"]) as Buffer;
    if (REFLECT_APPLY(BUFFER_EQUALS, roundTrip, [bytes]) !== true) fail("contract_invalid");
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof PostgresLogicalScratchRestoreV4Error) throw error;
    fail("contract_invalid");
  }
  const snapshot = snapshotBoundedPlainData(parsed, "contract_invalid");
  if ((REFLECT_APPLY(
    BUFFER_BYTE_LENGTH,
    BUFFER_OBJECT,
    [canonicalJson(snapshot), "utf8"],
  ) as number)
      > POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_CONTRACT_BYTES
    || canonicalJson(snapshot) !== text
    || canonicalJson(snapshot) !== canonicalJson(buildContractValue())) fail("contract_invalid");
  return buildContractValue();
}

export interface PostgresLogicalScratchRestoreV4OfflineArtifactProjection {
  readonly profile: "offline-structural-artifact-projection-v1";
  readonly manifestSha256: string;
  readonly manifestBindingSha256: string;
  readonly archive: {
    readonly claimedBytes: number;
    readonly claimedSha256: string;
    readonly exactBytesVerified: false;
    readonly listingSha256: string;
    readonly listingProjectionShapeAccepted: true;
    readonly listingBytesVerified: false;
    readonly tableDataSetSha256: typeof PINNED_TABLE_DATA_SET_SHA256;
    readonly tableDataEntries: 59;
  };
  readonly source: {
    readonly sourceDatabaseOid: string;
    readonly databaseName: string;
    readonly databaseNameIdentityVerified: false;
    readonly sourceAuthorityReceiptSha256Claim: string;
    readonly sourceAuthorityReceiptVerified: false;
    readonly sourceAuthorityReceiptAccepted: false;
  };
  readonly tools: {
    readonly pgDumpVersionClaim: string;
    readonly pgDumpExecutableSha256Claim: string;
    readonly pgRestoreVersionClaim: string;
    readonly pgRestoreExecutableSha256Claim: string;
    readonly executableBytesVerified: false;
  };
  readonly operationallyUsable: false;
}

/**
 * Validates a bounded plain-data projection from independently authenticated
 * V4 manifest and TOC parsers. This function does not parse files or listings;
 * all bytes, source identity/authority, and executable values remain claims.
 */
export function projectPostgresLogicalScratchRestoreV4OfflineArtifact(
  input: unknown,
): PostgresLogicalScratchRestoreV4OfflineArtifactProjection {
  try {
    const snapshot = snapshotBoundedPlainData(input, "artifact_evidence_invalid");
    assertStaticAuthority();
    if (!isPlainObject(snapshot) || !exactKeys(snapshot, [
      "manifestSha256", "manifestBindingSha256", "archiveClaimedBytes",
      "archiveClaimedSha256", "listingSha256", "tableDataSetSha256", "tableDataEntries",
      "sourceDatabaseOid", "databaseName", "sourceAuthorityReceiptSha256Claim",
      "pgDumpVersionClaim", "pgDumpExecutableSha256Claim", "pgRestoreVersionClaim",
      "pgRestoreExecutableSha256Claim", "baseDdlSha256", "migrationContractSha256",
      "kernelMigrationSha256", "kernelContractSha256", "portableReadBoundarySha256",
    ]) || !safeHash(snapshot.manifestSha256) || !safeHash(snapshot.manifestBindingSha256)
      || !Number.isSafeInteger(snapshot.archiveClaimedBytes)
      || Number(snapshot.archiveClaimedBytes) < 1
      || !safeHash(snapshot.archiveClaimedSha256) || !safeHash(snapshot.listingSha256)
      || snapshot.tableDataSetSha256 !== PINNED_TABLE_DATA_SET_SHA256
      || snapshot.tableDataEntries !== 59 || !exactOid(snapshot.sourceDatabaseOid)
      || typeof snapshot.databaseName !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(snapshot.databaseName)
      || !safeHash(snapshot.sourceAuthorityReceiptSha256Claim)
      || typeof snapshot.pgDumpVersionClaim !== "string"
      || !/^17(?:\.[0-9]+){1,3}(?:[-+._a-zA-Z0-9 ()~:]{0,96})$/.test(
        snapshot.pgDumpVersionClaim,
      ) || typeof snapshot.pgRestoreVersionClaim !== "string"
      || !/^17(?:\.[0-9]+){1,3}(?:[-+._a-zA-Z0-9 ()~:]{0,96})$/.test(
        snapshot.pgRestoreVersionClaim,
      ) || !safeHash(snapshot.pgDumpExecutableSha256Claim)
      || !safeHash(snapshot.pgRestoreExecutableSha256Claim)
      || snapshot.baseDdlSha256 !== PINNED_BASE_DDL_SHA256
      || snapshot.migrationContractSha256 !== PINNED_MIGRATION_CONTRACT_SHA256
      || snapshot.kernelMigrationSha256 !== PINNED_KERNEL_MIGRATION_SHA256
      || snapshot.kernelContractSha256 !== PINNED_KERNEL_CONTRACT_SHA256
      || snapshot.portableReadBoundarySha256 !== PINNED_PORTABLE_BOUNDARY_SHA256) {
      fail("artifact_evidence_invalid");
    }
    return deepFreeze({
      profile: "offline-structural-artifact-projection-v1" as const,
      manifestSha256: snapshot.manifestSha256,
      manifestBindingSha256: snapshot.manifestBindingSha256,
      archive: {
        claimedBytes: Number(snapshot.archiveClaimedBytes),
        claimedSha256: snapshot.archiveClaimedSha256,
        exactBytesVerified: false as const,
        listingSha256: snapshot.listingSha256,
        listingProjectionShapeAccepted: true as const,
        listingBytesVerified: false as const,
        tableDataSetSha256: PINNED_TABLE_DATA_SET_SHA256,
        tableDataEntries: 59 as const,
      },
      source: {
        sourceDatabaseOid: snapshot.sourceDatabaseOid,
        databaseName: snapshot.databaseName,
        databaseNameIdentityVerified: false as const,
        sourceAuthorityReceiptSha256Claim: snapshot.sourceAuthorityReceiptSha256Claim,
        sourceAuthorityReceiptVerified: false as const,
        sourceAuthorityReceiptAccepted: false as const,
      },
      tools: {
        pgDumpVersionClaim: snapshot.pgDumpVersionClaim,
        pgDumpExecutableSha256Claim: snapshot.pgDumpExecutableSha256Claim,
        pgRestoreVersionClaim: snapshot.pgRestoreVersionClaim,
        pgRestoreExecutableSha256Claim: snapshot.pgRestoreExecutableSha256Claim,
        executableBytesVerified: false as const,
      },
      operationallyUsable: false as const,
    });
  } catch (error) {
    if (error instanceof PostgresLogicalScratchRestoreV4Error) throw error;
    fail("artifact_evidence_invalid");
  }
}

/** Every current V1 source-authority receipt is evidence-only and is rejected. */
export function rejectPostgresLogicalScratchRestoreV4CurrentSourceAuthority(
  value: unknown,
): never {
  let snapshot: unknown;
  try {
    snapshot = snapshotBoundedPlainData(value, "source_authority_unsupported");
    if ((REFLECT_APPLY(
      BUFFER_BYTE_LENGTH,
      BUFFER_OBJECT,
      [canonicalJson(snapshot), "utf8"],
    ) as number)
      > POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_EVIDENCE_BYTES) {
      fail("source_authority_unsupported");
    }
  } catch (error) {
    if (error instanceof PostgresLogicalScratchRestoreV4Error) throw error;
    fail("source_authority_unsupported");
  }
  if (isPlainObject(snapshot)
    && snapshot.kind === "pintpath-postgres-logical-backup-source-authority"
    && snapshot.version === 1
    && snapshot.evidenceOnly === true
    && snapshot.operationalSourceAuthorityImplemented === false
    && snapshot.effectiveTargetOnlyDatabaseAccessVerified === false
    && snapshot.completeRoleGraphVerified === false
    && snapshot.emitterMustRejectUntilOperationalSourceAuthorityImplemented === true
    && snapshot.activationAuthorized === false
    && snapshot.artifactEmissionAuthorized === false
    && snapshot.productionCutoverAuthorized === false) {
    fail("source_authority_evidence_only");
  }
  fail("source_authority_unsupported");
}

export interface PostgresLogicalScratchRestoreV4CatalogCounts {
  readonly privateRelations: number;
  readonly privateColumns: number;
  readonly privatePolicies: number;
  readonly foreignKeys: number;
  readonly validatedForeignKeys: number;
  readonly deferrableForeignKeys: number;
  readonly initiallyDeferredForeignKeys: number;
  readonly nonSingleColumnForeignKeys: number;
  readonly riConstraintTriggers: number;
  readonly enabledRiConstraintTriggers: number;
  readonly applicationTriggers: number;
  readonly enabledApplicationTriggers: number;
  readonly totalPrivateTriggers: number;
  readonly scopedRoles: number;
  readonly privateSequences: number;
  readonly privateRelationPublicationMemberships: number;
  readonly privateSchemaPublicationMemberships: number;
  readonly allTablesPublications: number;
  readonly privateRelationExtensionDependencies: number;
}

export function validatePostgresLogicalScratchRestoreV4CatalogCounts(
  value: unknown,
): PostgresLogicalScratchRestoreV4CatalogCounts {
  const snapshot = snapshotBoundedPlainData(value, "catalog_evidence_invalid");
  const expected = POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_CATALOG_COUNTS;
  if (!isPlainObject(snapshot) || !exactKeys(snapshot, Object.keys(expected))) {
    fail("catalog_evidence_invalid");
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (snapshot[key] !== expectedValue) fail("catalog_evidence_invalid");
  }
  return deepFreeze({ ...snapshot } as unknown as PostgresLogicalScratchRestoreV4CatalogCounts);
}

export interface PostgresLogicalScratchRestoreV4SeedRow {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string;
}

export interface PostgresLogicalScratchRestoreV4RelationRowCount {
  readonly qualifiedName: string;
  readonly rowCount: string;
}

function validateSeedRows(
  value: unknown,
  code: "pre_load_evidence_invalid",
): readonly PostgresLogicalScratchRestoreV4SeedRow[] {
  if (!Array.isArray(value) || value.length !== SCHEMA_METADATA_SEED.length) fail(code);
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    const expected = SCHEMA_METADATA_SEED[index];
    if (!isPlainObject(row) || !expected || !exactKeys(row, ["key", "value", "updatedAt"])
      || row.key !== expected[0] || row.value !== expected[1]
      || !exactIsoInstant(row.updatedAt)) fail(code);
  }
  return value as unknown as readonly PostgresLogicalScratchRestoreV4SeedRow[];
}

function validateRelationRows(
  value: unknown,
  expectedCounts: ReadonlyMap<string, string>,
  code: "pre_load_evidence_invalid" | "post_load_evidence_invalid",
): readonly PostgresLogicalScratchRestoreV4RelationRowCount[] {
  if (!Array.isArray(value)
    || value.length !== POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS.length) fail(code);
  let total = 0n;
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    const expectedName = POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS[index];
    if (!isPlainObject(row) || !exactKeys(row, ["qualifiedName", "rowCount"])
      || row.qualifiedName !== expectedName || !expectedName
      || row.rowCount !== expectedCounts.get(expectedName)) fail(code);
    total += exactCount(row.rowCount, code);
  }
  if (total > MAX_SIGNED_INT8) fail(code);
  return value as unknown as readonly PostgresLogicalScratchRestoreV4RelationRowCount[];
}

export interface PostgresLogicalScratchRestoreV4PreLoadObservation {
  readonly targetDatabaseOid: string;
  readonly targetPhysicalReadBoundarySha256: string;
  readonly portableReadBoundarySha256: typeof PINNED_PORTABLE_BOUNDARY_SHA256;
  readonly currentUserSuperuser: true;
  readonly disposableTargetIdentityVerified: true;
  readonly catalog: PostgresLogicalScratchRestoreV4CatalogCounts;
  readonly seedRowsBeforeRemoval: readonly PostgresLogicalScratchRestoreV4SeedRow[];
  readonly seedRowsDeleted: readonly PostgresLogicalScratchRestoreV4SeedRow[];
  readonly relationRowsAfterSeedRemoval:
    readonly PostgresLogicalScratchRestoreV4RelationRowCount[];
}

export interface PostgresLogicalScratchRestoreV4PreLoadProjection {
  readonly profile: "offline-pre-load-empty-state-projection-v1";
  readonly targetDatabaseOid: string;
  readonly targetPhysicalReadBoundarySha256: string;
  readonly portableReadBoundarySha256: typeof PINNED_PORTABLE_BOUNDARY_SHA256;
  readonly seedRowCountBeforeRemoval: 12;
  readonly deletedSeedRowCount: 12;
  readonly emptyRelationCount: 61;
  readonly emptyArchivedRelationCount: 59;
  readonly emptyKernelRelationCount: 2;
  readonly totalRowsAfterSeedRemoval: "0";
  readonly projectionSha256: string;
  readonly operationallyAccepted: false;
}

export function validatePostgresLogicalScratchRestoreV4PreLoadObservation(
  value: unknown,
): PostgresLogicalScratchRestoreV4PreLoadProjection {
  const snapshot = snapshotBoundedPlainData(value, "pre_load_evidence_invalid");
  if (!isPlainObject(snapshot) || !exactKeys(snapshot, [
    "targetDatabaseOid", "targetPhysicalReadBoundarySha256", "portableReadBoundarySha256",
    "currentUserSuperuser", "disposableTargetIdentityVerified", "catalog",
    "seedRowsBeforeRemoval", "seedRowsDeleted", "relationRowsAfterSeedRemoval",
  ]) || !exactOid(snapshot.targetDatabaseOid)
    || !safeHash(snapshot.targetPhysicalReadBoundarySha256)
    || snapshot.portableReadBoundarySha256 !== PINNED_PORTABLE_BOUNDARY_SHA256
    || snapshot.currentUserSuperuser !== true
    || snapshot.disposableTargetIdentityVerified !== true) fail("pre_load_evidence_invalid");
  validatePostgresLogicalScratchRestoreV4CatalogCounts(snapshot.catalog);
  const before = validateSeedRows(snapshot.seedRowsBeforeRemoval, "pre_load_evidence_invalid");
  const deleted = validateSeedRows(snapshot.seedRowsDeleted, "pre_load_evidence_invalid");
  if (canonicalJson(before) !== canonicalJson(deleted)) fail("pre_load_evidence_invalid");
  const emptyCounts = new Map(
    POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS.map((name) => [name, "0"]),
  );
  validateRelationRows(
    snapshot.relationRowsAfterSeedRemoval,
    emptyCounts,
    "pre_load_evidence_invalid",
  );
  const withoutSha = {
    profile: "offline-pre-load-empty-state-projection-v1" as const,
    targetDatabaseOid: snapshot.targetDatabaseOid,
    targetPhysicalReadBoundarySha256: snapshot.targetPhysicalReadBoundarySha256,
    portableReadBoundarySha256: PINNED_PORTABLE_BOUNDARY_SHA256 as typeof PINNED_PORTABLE_BOUNDARY_SHA256,
    seedRowCountBeforeRemoval: 12 as const,
    deletedSeedRowCount: 12 as const,
    emptyRelationCount: 61 as const,
    emptyArchivedRelationCount: 59 as const,
    emptyKernelRelationCount: 2 as const,
    totalRowsAfterSeedRemoval: "0" as const,
    operationallyAccepted: false as const,
  };
  return deepFreeze({
    ...withoutSha,
    projectionSha256: sha256Canonical({
      kind: "pintpath-postgres-logical-scratch-restore-v4-pre-load-projection",
      version: 1,
      projection: withoutSha,
    }),
  });
}

const TABLE_RECEIPT_KEYS = Object.freeze([
  "tableName", "columnCount", "rowCount", "transformedSha256",
  "firstPrimaryKeySha256", "lastPrimaryKeySha256",
] as const);

const V2_INVENTORY_KEYS = Object.freeze([
  "authoritativeTableCount", "authoritativeColumnCount", "authoritativeRowCount",
  "nonEmptyAuthoritativeTableCount", "zeroRowAuthoritativeTableCount",
  "migrationContractSha256", "sourceSchemaFingerprint", "sourceSchemaSha256",
  "sourceSnapshotSha256", "targetDdlSha256", "schemaMetadataSha256",
  "tableSetSha256", "transformedDataSha256", "keyRangesSha256", "stateTotalsSha256",
  "kernelContractSha256", "kernelMigrationSha256", "sourceReadBoundarySha256",
  "controlTableCount", "controlRowCount", "controlTableSetSha256", "controlDataSha256",
  "controlKeyRangesSha256", "overallStateSha256", "tables", "controlTables",
] as const);

function validateTableReceiptShape(
  value: unknown,
  code: "state_capture_invalid" | "post_load_evidence_invalid",
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value) || !exactKeys(value, TABLE_RECEIPT_KEYS)
    || typeof value.tableName !== "string"
    || !Number.isSafeInteger(value.columnCount) || Number(value.columnCount) < 1
    || !safeHash(value.transformedSha256)
    || !(value.firstPrimaryKeySha256 === null || safeHash(value.firstPrimaryKeySha256))
    || !(value.lastPrimaryKeySha256 === null || safeHash(value.lastPrimaryKeySha256))) fail(code);
  const count = exactCount(value.rowCount, code);
  if ((count === 0n) !== (value.firstPrimaryKeySha256 === null)
    || (count === 0n) !== (value.lastPrimaryKeySha256 === null)
    || (count === 1n && value.firstPrimaryKeySha256 !== value.lastPrimaryKeySha256)
    || (count > 1n && value.firstPrimaryKeySha256 === value.lastPrimaryKeySha256)) fail(code);
}

function validateV2CaptureShape(
  value: unknown,
): asserts value is {
  readonly inventory: Record<string, unknown>;
  readonly sourceDatabaseOid: string;
  readonly sourcePhysicalReadBoundarySha256: string;
} {
  if (!isPlainObject(value) || !exactKeys(value, [
    "inventory", "sourceDatabaseOid", "sourcePhysicalReadBoundarySha256",
  ]) || !exactOid(value.sourceDatabaseOid)
    || !safeHash(value.sourcePhysicalReadBoundarySha256)
    || !isPlainObject(value.inventory) || !exactKeys(value.inventory, V2_INVENTORY_KEYS)) {
    fail("state_capture_invalid");
  }
  const inventory = value.inventory;
  if (inventory.authoritativeTableCount !== 56 || inventory.authoritativeColumnCount !== 717
    || !Number.isSafeInteger(inventory.nonEmptyAuthoritativeTableCount)
    || !Number.isSafeInteger(inventory.zeroRowAuthoritativeTableCount)
    || Number(inventory.nonEmptyAuthoritativeTableCount)
      + Number(inventory.zeroRowAuthoritativeTableCount) !== 56
    || inventory.migrationContractSha256 !== PINNED_MIGRATION_CONTRACT_SHA256
    || inventory.sourceSchemaFingerprint !== PINNED_SOURCE_SCHEMA_FINGERPRINT
    || inventory.sourceSchemaSha256 !== PINNED_SOURCE_SCHEMA_SHA256
    || inventory.targetDdlSha256 !== PINNED_BASE_DDL_SHA256
    || inventory.kernelContractSha256 !== PINNED_KERNEL_CONTRACT_SHA256
    || inventory.kernelMigrationSha256 !== PINNED_KERNEL_MIGRATION_SHA256
    || inventory.sourceReadBoundarySha256 !== PINNED_PORTABLE_BOUNDARY_SHA256
    || inventory.controlTableCount !== 5
    || !Array.isArray(inventory.tables) || inventory.tables.length !== 56
    || !Array.isArray(inventory.controlTables) || inventory.controlTables.length !== 5) {
    fail("state_capture_invalid");
  }
  for (const hashKey of [
    "sourceSnapshotSha256", "schemaMetadataSha256", "tableSetSha256",
    "transformedDataSha256", "keyRangesSha256", "stateTotalsSha256",
    "controlTableSetSha256", "controlDataSha256", "controlKeyRangesSha256",
    "overallStateSha256",
  ]) if (!safeHash(inventory[hashKey])) fail("state_capture_invalid");
  let authoritativeRows = 0n;
  for (let index = 0; index < inventory.tables.length; index += 1) {
    const receipt = inventory.tables[index];
    const expectedTable = AUTHORITATIVE_TABLE_COLUMNS[index];
    validateTableReceiptShape(receipt, "state_capture_invalid");
    if (!expectedTable || receipt.tableName !== expectedTable.tableName
      || receipt.columnCount !== expectedTable.columnCount) fail("state_capture_invalid");
    authoritativeRows += exactCount(receipt.rowCount, "state_capture_invalid");
  }
  if (authoritativeRows !== exactCount(inventory.authoritativeRowCount, "state_capture_invalid")) {
    fail("state_capture_invalid");
  }
  let controlRows = 0n;
  for (let index = 0; index < inventory.controlTables.length; index += 1) {
    const receipt = inventory.controlTables[index];
    validateTableReceiptShape(receipt, "state_capture_invalid");
    if (receipt.tableName !== CONTROL_TABLE_COLUMNS[index]?.qualifiedName
      || receipt.columnCount !== CONTROL_TABLE_COLUMNS[index]?.columns.length) {
      fail("state_capture_invalid");
    }
    controlRows += exactCount(receipt.rowCount, "state_capture_invalid");
  }
  if (controlRows !== exactCount(inventory.controlRowCount, "state_capture_invalid")
    || inventory.controlTables[0]?.rowCount !== "12"
    || inventory.controlTables[3]?.rowCount !== "0"
    || inventory.controlTables[4]?.rowCount !== "0") fail("state_capture_invalid");
  const { overallStateSha256: _ignored, ...withoutOverall } = inventory;
  if (inventory.overallStateSha256 !== sha256Canonical({
    kind: "pintpath-postgres-logical-state-inventory",
    version: 2,
    ...withoutOverall,
  })) fail("state_capture_invalid");
}

interface ValidatedV2Capture {
  readonly inventory: Record<string, unknown> & {
    readonly tables: readonly Record<string, unknown>[];
    readonly controlTables: readonly Record<string, unknown>[];
    readonly overallStateSha256: string;
  };
  readonly sourceDatabaseOid: string;
  readonly sourcePhysicalReadBoundarySha256: string;
}

export interface PostgresLogicalScratchRestoreV4V2ShapeComparisonProjection {
  readonly profile: "offline-cross-oid-v2-shape-comparison-projection-v1";
  readonly sourceDatabaseOid: string;
  readonly targetDatabaseOid: string;
  readonly sourcePhysicalReadBoundarySha256: string;
  readonly targetPhysicalReadBoundarySha256: string;
  readonly portableReadBoundarySha256: typeof PINNED_PORTABLE_BOUNDARY_SHA256;
  readonly exactInventoryMatch: true;
  readonly exactOverallStateSha256Match: true;
  readonly shapeAndOverallSelfConsistencyAccepted: true;
  readonly opaqueAggregateDigestsIndependentlyVerified: false;
  readonly independentFullV2ValidationPerformed: false;
  readonly comparisonSha256: string;
  readonly operationallyAccepted: false;
}

/**
 * Compares bounded V2-shaped plain data and recomputes only the inventory's
 * overall wrapper digest. Per-table and aggregate digests remain opaque. A
 * future executor must independently run the complete V2 validator/capture;
 * this projection can never substitute for that database-backed validation.
 */
export function projectPostgresLogicalScratchRestoreV4V2ShapeComparison(
  sourceInput: unknown,
  targetInput: unknown,
): PostgresLogicalScratchRestoreV4V2ShapeComparisonProjection {
  const source = snapshotBoundedPlainData(sourceInput, "state_capture_invalid");
  const target = snapshotBoundedPlainData(targetInput, "state_capture_invalid");
  validateV2CaptureShape(source);
  validateV2CaptureShape(target);
  if (source.sourceDatabaseOid === target.sourceDatabaseOid
    || source.sourcePhysicalReadBoundarySha256 === target.sourcePhysicalReadBoundarySha256
    || canonicalJson(source.inventory) !== canonicalJson(target.inventory)
    || source.inventory.overallStateSha256 !== target.inventory.overallStateSha256) {
    fail("target_comparison_invalid");
  }
  const withoutSha = {
    profile: "offline-cross-oid-v2-shape-comparison-projection-v1" as const,
    sourceDatabaseOid: source.sourceDatabaseOid,
    targetDatabaseOid: target.sourceDatabaseOid,
    sourcePhysicalReadBoundarySha256: source.sourcePhysicalReadBoundarySha256,
    targetPhysicalReadBoundarySha256: target.sourcePhysicalReadBoundarySha256,
    portableReadBoundarySha256: PINNED_PORTABLE_BOUNDARY_SHA256 as typeof PINNED_PORTABLE_BOUNDARY_SHA256,
    exactInventoryMatch: true as const,
    exactOverallStateSha256Match: true as const,
    shapeAndOverallSelfConsistencyAccepted: true as const,
    opaqueAggregateDigestsIndependentlyVerified: false as const,
    independentFullV2ValidationPerformed: false as const,
    operationallyAccepted: false as const,
  };
  return deepFreeze({ ...withoutSha, comparisonSha256: sha256Canonical({
    kind: "pintpath-postgres-logical-scratch-restore-v4-final-v2-comparison",
    version: 1,
    comparison: withoutSha,
  }) });
}

export interface PostgresLogicalScratchRestoreV4PostLoadObservation {
  readonly targetDatabaseOid: string;
  readonly preLoadPhysicalReadBoundarySha256: string;
  readonly postLoadPhysicalReadBoundarySha256: string;
  readonly portableReadBoundarySha256: typeof PINNED_PORTABLE_BOUNDARY_SHA256;
  readonly catalog: PostgresLogicalScratchRestoreV4CatalogCounts;
  readonly relationRows: readonly PostgresLogicalScratchRestoreV4RelationRowCount[];
  readonly expectedArchiveRowCount: string;
  readonly foreignKeyViolationRows: readonly {
    readonly constraintName: string;
    readonly violationRowCount: string;
  }[];
  readonly applicationTriggerProof: {
    readonly disabledParentRiConstraintNames: readonly [
      "pint_point_drink_records_voided_by_user_id_fkey",
      "venue_claim_requests_reviewed_by_fkey",
    ];
    readonly applicationTriggerName: "clear_added_account_references_before_delete";
    readonly applicationTriggerFunction: "pintpath_app.clear_account_references_before_delete";
    readonly exactDisabledParentRiTriggerCount: 2;
    readonly applicationTriggerEnabled: true;
    readonly fixtureAccountRowsInserted: 2;
    readonly fixtureChildRowsInserted: 2;
    readonly reviewerAccountRowsDeleted: 1;
    readonly survivingChildRows: 2;
    readonly nullReferenceRows: 2;
    readonly transactionRolledBack: true;
    readonly fixtureResidueRows: 0;
    readonly postRollbackEnabledPrivateTriggerCount: 317;
    readonly postRollbackSchemaUnchanged: true;
  };
}

export interface PostgresLogicalScratchRestoreV4PostLoadProjection {
  readonly profile: "offline-post-load-integrity-projection-v1";
  readonly targetDatabaseOid: string;
  readonly reportedPhysicalReadBoundaryHashesEqual: true;
  readonly physicalReadBoundaryIndependentlyVerified: false;
  readonly completePhysicalSchemaCatalogDigestVerified: false;
  readonly archiveRowCount: string;
  readonly kernelRowCount: "0";
  readonly foreignKeyViolationRowCount: "0";
  readonly applicationTriggerProofRolledBack: true;
  readonly sourceCaptureIndependentFullV2ValidationPerformed: false;
  readonly projectionSha256: string;
  readonly operationallyAccepted: false;
}

export function validatePostgresLogicalScratchRestoreV4PostLoadObservation(
  value: unknown,
  sourceCaptureInput: unknown,
): PostgresLogicalScratchRestoreV4PostLoadProjection {
  const snapshot = snapshotBoundedPlainData(value, "post_load_evidence_invalid");
  const sourceCapture = snapshotBoundedPlainData(sourceCaptureInput, "state_capture_invalid");
  validateV2CaptureShape(sourceCapture);
  if (!isPlainObject(snapshot) || !exactKeys(snapshot, [
    "targetDatabaseOid", "preLoadPhysicalReadBoundarySha256",
    "postLoadPhysicalReadBoundarySha256", "portableReadBoundarySha256", "catalog",
    "relationRows", "expectedArchiveRowCount", "foreignKeyViolationRows",
    "applicationTriggerProof",
  ]) || !exactOid(snapshot.targetDatabaseOid)
    || !safeHash(snapshot.preLoadPhysicalReadBoundarySha256)
    || snapshot.postLoadPhysicalReadBoundarySha256
      !== snapshot.preLoadPhysicalReadBoundarySha256
    || snapshot.portableReadBoundarySha256 !== PINNED_PORTABLE_BOUNDARY_SHA256
    || snapshot.targetDatabaseOid === sourceCapture.sourceDatabaseOid) {
    fail("post_load_evidence_invalid");
  }
  validatePostgresLogicalScratchRestoreV4CatalogCounts(snapshot.catalog);
  const expectedCounts = new Map<string, string>();
  const validatedSource = sourceCapture as ValidatedV2Capture;
  for (const receipt of validatedSource.inventory.tables) {
    expectedCounts.set(`pintpath_app.${receipt.tableName}`, String(receipt.rowCount));
  }
  for (const receipt of validatedSource.inventory.controlTables.slice(0, 3)) {
    expectedCounts.set(String(receipt.tableName), String(receipt.rowCount));
  }
  for (const relation of KERNEL_RELATION_NAMES) expectedCounts.set(relation, "0");
  validateRelationRows(snapshot.relationRows, expectedCounts, "post_load_evidence_invalid");
  const expectedArchiveRowCount = [...expectedCounts.entries()]
    .filter(([name]) => !KERNEL_RELATION_NAMES.includes(name as typeof KERNEL_RELATION_NAMES[number]))
    .reduce((sum, [, rowCount]) => sum + exactCount(rowCount, "post_load_evidence_invalid"), 0n);
  if (snapshot.expectedArchiveRowCount !== expectedArchiveRowCount.toString()
    || !Array.isArray(snapshot.foreignKeyViolationRows)
    || snapshot.foreignKeyViolationRows.length !== 79) fail("post_load_evidence_invalid");
  for (let index = 0; index < snapshot.foreignKeyViolationRows.length; index += 1) {
    const row = snapshot.foreignKeyViolationRows[index];
    if (!isPlainObject(row) || !exactKeys(row, ["constraintName", "violationRowCount"])
      || row.constraintName !== POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS[index]
        ?.constraintName
      || row.violationRowCount !== "0") fail("post_load_evidence_invalid");
  }
  const proof = snapshot.applicationTriggerProof;
  if (!isPlainObject(proof) || !exactKeys(proof, [
    "disabledParentRiConstraintNames", "applicationTriggerName", "applicationTriggerFunction",
    "exactDisabledParentRiTriggerCount", "applicationTriggerEnabled", "fixtureAccountRowsInserted",
    "fixtureChildRowsInserted", "reviewerAccountRowsDeleted", "survivingChildRows",
    "nullReferenceRows", "transactionRolledBack", "fixtureResidueRows",
    "postRollbackEnabledPrivateTriggerCount", "postRollbackSchemaUnchanged",
  ]) || !Array.isArray(proof.disabledParentRiConstraintNames)
    || canonicalJson(proof.disabledParentRiConstraintNames) !== canonicalJson([
      "pint_point_drink_records_voided_by_user_id_fkey",
      "venue_claim_requests_reviewed_by_fkey",
    ])
    || proof.applicationTriggerName !== "clear_added_account_references_before_delete"
    || proof.applicationTriggerFunction
      !== "pintpath_app.clear_account_references_before_delete"
    || proof.exactDisabledParentRiTriggerCount !== 2
    || proof.applicationTriggerEnabled !== true || proof.survivingChildRows !== 2
    || proof.fixtureAccountRowsInserted !== 2 || proof.fixtureChildRowsInserted !== 2
    || proof.reviewerAccountRowsDeleted !== 1
    || proof.nullReferenceRows !== 2 || proof.transactionRolledBack !== true
    || proof.fixtureResidueRows !== 0 || proof.postRollbackEnabledPrivateTriggerCount !== 317
    || proof.postRollbackSchemaUnchanged !== true) fail("post_load_evidence_invalid");
  const withoutSha = {
    profile: "offline-post-load-integrity-projection-v1" as const,
    targetDatabaseOid: snapshot.targetDatabaseOid,
    reportedPhysicalReadBoundaryHashesEqual: true as const,
    physicalReadBoundaryIndependentlyVerified: false as const,
    completePhysicalSchemaCatalogDigestVerified: false as const,
    archiveRowCount: expectedArchiveRowCount.toString(),
    kernelRowCount: "0" as const,
    foreignKeyViolationRowCount: "0" as const,
    applicationTriggerProofRolledBack: true as const,
    sourceCaptureIndependentFullV2ValidationPerformed: false as const,
    operationallyAccepted: false as const,
  };
  return deepFreeze({ ...withoutSha, projectionSha256: sha256Canonical({
    kind: "pintpath-postgres-logical-scratch-restore-v4-post-load-projection",
    version: 1,
    projection: withoutSha,
  }) });
}

export interface PostgresLogicalScratchRestoreV4DisposalObservation {
  readonly allConnectionsClosed: true;
  readonly archiveDescriptorsClosed: true;
  readonly toolProcessReaped: true;
  readonly disposableDatabaseDropped: true;
  readonly fiveTargetOidScopedRolesDropped: true;
  readonly temporaryArtifactsDisposed: true;
  readonly residualDatabaseCount: 0;
  readonly residualScopedRoleCount: 0;
  readonly residualSessionCount: 0;
  readonly residualArtifactCount: 0;
}

export function validatePostgresLogicalScratchRestoreV4DisposalObservation(
  value: unknown,
): Readonly<PostgresLogicalScratchRestoreV4DisposalObservation & {
  readonly disposalSha256: string;
  readonly permitsSuccessReceipt: false;
}> {
  const snapshot = snapshotBoundedPlainData(value, "disposal_evidence_invalid");
  const expected = {
    allConnectionsClosed: true,
    archiveDescriptorsClosed: true,
    toolProcessReaped: true,
    disposableDatabaseDropped: true,
    fiveTargetOidScopedRolesDropped: true,
    temporaryArtifactsDisposed: true,
    residualDatabaseCount: 0,
    residualScopedRoleCount: 0,
    residualSessionCount: 0,
    residualArtifactCount: 0,
  } as const;
  if (!isPlainObject(snapshot) || !exactKeys(snapshot, Object.keys(expected))) {
    fail("disposal_evidence_invalid");
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (snapshot[key] !== expectedValue) fail("disposal_evidence_invalid");
  }
  return deepFreeze({
    ...expected,
    disposalSha256: sha256Canonical({
      kind: "pintpath-postgres-logical-scratch-restore-v4-disposal-observation",
      version: 1,
      observation: expected,
    }),
    permitsSuccessReceipt: false as const,
  });
}

/** No input can produce success until a separately reviewed executor exists. */
export function completePostgresLogicalScratchRestoreV4(): never {
  fail("operational_completion_unimplemented");
}
