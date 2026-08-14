import { z } from "zod";
import type { QueryResultRow } from "pg";
import { types as utilTypes } from "node:util";

import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../db/postgres-migration-schema.js";
import {
  buildPostgresMigrationReadyMetadata,
  derivePostgresMigrationRunId,
  postgresMigrationReceiptSchema,
  postgresMigrationTargetIdentitySchema,
  sha256PostgresMigrationRunBinding,
  sha256PostgresMigrationReadyMetadata,
  sha256PostgresMigrationTargetIdentity,
  type PostgresMigrationReceipt,
  type PostgresMigrationTargetIdentity,
} from "../db/postgres-migration-receipt.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../db/postgres-migration-schema.js";
import type { SqlDatabase } from "../db/sql-database.js";
import { sha256PostgresDatabaseIdentity } from "./postgres-database-identity.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
  finalizePostgresReviewedPricePromotionReviewPacket,
  postgresReviewedPricePromotionAuthorityBundleSchema,
  type PostgresReviewedPricePromotionAuthorityBundle,
  type PostgresReviewedPricePromotionReviewPacket,
} from "./postgres-reviewed-price-promotion-authority.js";
import {
  REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS,
  REVIEWED_PRICE_SELECTION_POLICY_SHA256,
  selectPublishableMapBaseRows,
} from "./reviewed-price-selection-policy.js";
import {
  REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES,
  REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
  REVIEWED_PRICE_WRONG_PRICE_REASONS,
  REVIEWED_PRICE_WRONG_PRICE_STATUSES,
  reviewedPriceWrongPriceStatusBlocksPromotion,
} from "./reviewed-price-wrong-price-policy.js";
import type { AdminBeerInput } from "../modules/admin/admin.schemas.js";

const ARRAY_CONSTRUCTOR = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const ARRAY_SORT = Array.prototype.sort;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_OBJECT = Buffer;
const JSON_CONSTRUCTOR = JSON;
const JSON_OBJECT = JSON;
const JSON_PARSE = JSON.parse;
const MAP_CONSTRUCTOR = Map;
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const MAP_SET = Map.prototype.set;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_TO_STRING = Number.prototype.toString;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_IS = Object.is;
const OBJECT_PROTOTYPE = Object.prototype;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_CONSTRUCT = Reflect.construct;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_CONSTRUCTOR = RegExp;
const REGEXP_EXEC = RegExp.prototype.exec;
const SET_CONSTRUCTOR = Set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_CONSTRUCTOR = String;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;
const UTIL_IS_PROXY = utilTypes.isProxy;

interface IntrinsicSurface {
  readonly descriptors: readonly PropertyDescriptor[];
  readonly keys: readonly PropertyKey[];
  readonly target: object;
}

function captureIntrinsicSurface(target: object): IntrinsicSurface {
  const keys = REFLECT_OWN_KEYS(target);
  const descriptors = new ARRAY_CONSTRUCTOR<PropertyDescriptor>(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = key === undefined
      ? undefined
      : OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, key);
    if (!descriptor) throw new Error("intrinsic_surface_unavailable");
    defineDenseArrayValue(descriptors, index, OBJECT_FREEZE({ ...descriptor }));
  }
  return OBJECT_FREEZE({
    descriptors: OBJECT_FREEZE(descriptors),
    keys: OBJECT_FREEZE(keys),
    target,
  });
}

const PLAN_INTRINSIC_SURFACES = OBJECT_FREEZE([
  captureIntrinsicSurface(ARRAY_CONSTRUCTOR),
  captureIntrinsicSurface(ARRAY_PROTOTYPE),
  captureIntrinsicSurface(BUFFER_OBJECT),
  captureIntrinsicSurface(BUFFER_OBJECT.prototype),
  captureIntrinsicSurface(JSON_CONSTRUCTOR),
  captureIntrinsicSurface(MAP_CONSTRUCTOR),
  captureIntrinsicSurface(MAP_CONSTRUCTOR.prototype),
  captureIntrinsicSurface(NUMBER_CONSTRUCTOR),
  captureIntrinsicSurface(NUMBER_CONSTRUCTOR.prototype),
  captureIntrinsicSurface(OBJECT_CONSTRUCTOR),
  captureIntrinsicSurface(OBJECT_PROTOTYPE),
  captureIntrinsicSurface(REGEXP_CONSTRUCTOR),
  captureIntrinsicSurface(REGEXP_CONSTRUCTOR.prototype),
  captureIntrinsicSurface(SET_CONSTRUCTOR),
  captureIntrinsicSurface(SET_CONSTRUCTOR.prototype),
  captureIntrinsicSurface(STRING_CONSTRUCTOR),
  captureIntrinsicSurface(STRING_CONSTRUCTOR.prototype),
]);

export const POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND =
  "pintpath-postgres-reviewed-price-promotion-private-input" as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND =
  "pintpath-postgres-reviewed-price-promotion-plan-candidate" as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_VERSION = 1 as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION = 4 as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256 =
  "b5a093844709f725bd71415dadb37062b75e40dbd6475082732fa28b1ef1fcc9" as const;

const APPLICATION_SCHEMA = "pintpath_app";
const OPERATIONS_SCHEMA = "pintpath_ops";
const PLANNER_ROLE = "pintpath_reviewed_price_planner";
const MAX_ITEMS = 50;
const MAX_CATALOG_KEYS = 5_000;
const MAX_SOURCE_JSON_BYTES = 262_144;
const MAX_SOURCE_ROWS_PER_ITEM = 100;
const MAX_WRONG_PRICE_ROWS = 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LOGICAL_BACKUP_SELECT_POLICY_EXPRESSION =
  "(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid\n"
  + "   FROM pg_database database\n"
  + "  WHERE (database.datname = current_database()))))";
const TRUSTED_PUBLIC_CONFIDENCE = Object.freeze([
  "admin_verified",
  "venue_confirmed",
  "photo_verified",
  "community_confirmed",
] as const);
const EXPECTED_METADATA_KEYS = Object.freeze([
  "import_state",
  "live_schema_sha256",
  "migration_candidate_sha",
  "migration_contract_sha256",
  "migration_manifest_sha256",
  "migration_plan_sha256",
  "migration_run_sha256",
  "schema_version",
  "source_schema_fingerprint",
  "source_schema_sha256",
  "source_schema_version",
  "source_snapshot_sha256",
  "target_ddl_sha256",
] as const);

export const POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS = Object.freeze([
  "dedicated_read_only_planner_role_and_complete_acl_rls_visibility",
  "provider_observed_deployment_authority",
  "signed_approval_trust_root",
  "immutable_private_evidence_and_worm_authority",
  "dedicated_apply_quarantine_roles_and_functions",
  "durable_database_ledger_and_crash_safe_receipts",
  "atomic_apply_and_receipt_authorized_quarantine",
] as const);

export const POSTGRES_REVIEWED_PRICE_PROMOTION_READ_ONLY_TRANSACTION =
  "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_SEARCH_PATH =
  "SET LOCAL search_path = pg_catalog" as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_ROW_SECURITY =
  "SET LOCAL row_security = on" as const;

export const POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY = `/* pintpath:reviewed-price-plan:identity */
WITH relation_spec(nspname, relname, relkind, planner_policy_name, columns) AS (
  VALUES
    ('${APPLICATION_SCHEMA}', 'schema_metadata', 'r'::"char",
      'schema_metadata_reviewed_price_planner_select', ARRAY['key','value']::text[]),
    ('${OPERATIONS_SCHEMA}', 'migration_runs', 'r'::"char",
      'migration_runs_reviewed_price_planner_select', ARRAY[
        'run_id','source_snapshot_sha256','source_schema_fingerprint','contract_sha256',
        'manifest_sha256','target_ddl_sha256','source_schema_version','candidate_commit_sha',
        'target_binding_sha256','expected_environment','approval_reference_sha256',
        'operator_id_sha256','status','started_at','completed_at','verifier_id_sha256',
        'receipt_sha256','failure_code'
      ]::text[]),
    ('${APPLICATION_SCHEMA}', 'admin_ingestion_queue', 'r'::"char",
      'admin_ingestion_queue_reviewed_price_planner_select', ARRAY[
        'id','venue_id','venue_name','source_type','source_url','image_retention_expires_at',
        'image_redacted_at','image_redaction_reason','note','status','review_claim_token',
        'review_claimed_at','venue_name_guess','captured_notes','overall_confidence',
        'extracted_beers_json','review_beers_json','created_at','updated_at','published_at','rejected_at'
      ]::text[]),
    ('${APPLICATION_SCHEMA}', 'venue_profiles', 'r'::"char",
      'venue_profiles_reviewed_price_planner_select',
      ARRAY['venue_id','name','address','suburb','area','active','updated_at']::text[]),
    ('${APPLICATION_SCHEMA}', 'beer_catalog_aliases', 'r'::"char",
      'beer_catalog_aliases_reviewed_price_planner_select',
      ARRAY['alias_key','alias','beer_key']::text[]),
    ('${APPLICATION_SCHEMA}', 'beer_catalog_items', 'r'::"char",
      'beer_catalog_items_reviewed_price_planner_select',
      ARRAY['key','name','brewery','style','abv','status','source','updated_at']::text[]),
    ('${APPLICATION_SCHEMA}', 'venue_price_records', 'r'::"char",
      'venue_price_records_reviewed_price_planner_select',
      ARRAY['id','venue_id','source_ingestion_id','confidence','source_type','updated_at']::text[]),
    ('${APPLICATION_SCHEMA}', 'venue_beers', 'r'::"char",
      'venue_beers_reviewed_price_planner_select',
      ARRAY['id','venue_id','source_ingestion_id','normalized_beer_id','updated_at']::text[]),
    ('${APPLICATION_SCHEMA}', 'wrong_price_reports', 'r'::"char",
      'wrong_price_reports_reviewed_price_planner_select', ARRAY[
        'id','venue_id','price_record_id','beer_name','reason','notes','source_photo_url',
        'status','assigned_to','resolution_note','resolved_at','resolved_by','created_at','updated_at'
      ]::text[])
),
required_columns AS (
  SELECT spec.nspname, spec.relname, column_name
  FROM relation_spec AS spec
  CROSS JOIN LATERAL pg_catalog.unnest(spec.columns) AS column_name
),
planner AS (
  SELECT role.*
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = '${PLANNER_ROLE}'
),
required_relations AS (
  SELECT
    spec.nspname,
    spec.relname,
    spec.relkind,
    spec.planner_policy_name,
    spec.columns,
    relation.oid,
    relation.relowner,
    relation.relrowsecurity,
    relation.relforcerowsecurity
  FROM relation_spec AS spec
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.nspname = spec.nspname
  JOIN pg_catalog.pg_class AS relation
    ON relation.relnamespace = namespace.oid AND relation.relname = spec.relname
),
resolved_required_columns AS (
  SELECT required.nspname, required.relname, required.column_name, relation.oid, attribute.attnum
  FROM required_columns AS required
  JOIN required_relations AS relation
    ON relation.nspname = required.nspname AND relation.relname = required.relname
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attname = required.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
)
SELECT
  control.system_identifier::text AS "systemIdentifier",
  database.oid::text AS "databaseOid",
  current_database() AS "databaseName",
  session_user::text AS "sessionUser",
  current_user::text AS "currentUser",
  current_setting('server_version_num') AS "serverVersionNum",
  current_setting('transaction_isolation') AS "transactionIsolation",
  current_setting('transaction_read_only')::boolean AS "transactionReadOnly",
  current_schemas(false)::text[] AS "searchPathSchemas",
  true AS "roleAuthorityValid",
  9::integer AS "requiredRelationCount",
  84::integer AS "requiredColumnCount"
FROM pg_catalog.pg_database AS database
CROSS JOIN pg_catalog.pg_control_system() AS control
CROSS JOIN planner
WHERE database.datname = current_database()
  AND session_user::text = '${PLANNER_ROLE}'
  AND current_user::text = '${PLANNER_ROLE}'
  AND planner.rolcanlogin
  AND NOT planner.rolinherit
  AND NOT planner.rolsuper
  AND NOT planner.rolcreatedb
  AND NOT planner.rolcreaterole
  AND NOT planner.rolreplication
  AND NOT planner.rolbypassrls
  AND current_setting('row_security') = 'on'
  AND current_schemas(false)::text[] = ARRAY['pg_catalog']::text[]
  AND has_function_privilege(planner.oid, 'pg_catalog.pg_control_system()', 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = planner.oid OR membership.roleid = planner.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_db_role_setting AS setting WHERE setting.setrole = planner.oid
  )
  AND database.datdba <> planner.oid
  AND has_database_privilege(planner.oid, database.oid, 'CONNECT')
  AND NOT has_database_privilege(planner.oid, database.oid, 'CREATE')
  AND NOT has_database_privilege(planner.oid, database.oid, 'TEMP')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_database AS other_database
    WHERE other_database.oid <> database.oid
      AND other_database.datallowconn
      AND has_database_privilege(planner.oid, other_database.oid, 'CONNECT')
  )
  AND (
    SELECT count(*) FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname IN ('${APPLICATION_SCHEMA}', '${OPERATIONS_SCHEMA}')
      AND has_schema_privilege(planner.oid, namespace.oid, 'USAGE')
      AND NOT has_schema_privilege(planner.oid, namespace.oid, 'CREATE')
      AND namespace.nspowner <> planner.oid
  ) = 2
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND (
        namespace.nspowner = planner.oid
        OR has_schema_privilege(planner.oid, namespace.oid, 'CREATE')
        OR (
          namespace.nspname NOT IN ('${APPLICATION_SCHEMA}', '${OPERATIONS_SCHEMA}')
          AND has_schema_privilege(planner.oid, namespace.oid, 'USAGE')
        )
      )
  )
  AND (SELECT count(*) FROM required_relations) = 9
  AND (SELECT count(*) FROM resolved_required_columns) = 84
  AND NOT EXISTS (
    SELECT 1 FROM required_relations AS relation
    WHERE relation.relkind <> 'r'::"char"
      OR relation.relowner = planner.oid
      OR NOT relation.relrowsecurity
      OR NOT relation.relforcerowsecurity
      OR NOT pg_catalog.row_security_active(relation.oid)
      OR has_table_privilege(planner.oid, relation.oid, 'SELECT')
      OR (
        SELECT count(*)
        FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = relation.oid
          AND (0::oid = ANY(policy.polroles) OR planner.oid = ANY(policy.polroles))
      ) <> 2
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = relation.oid
          AND policy.polname = relation.planner_policy_name
          AND policy.polcmd = 'r'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[planner.oid]::oid[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true'
          AND policy.polwithcheck IS NULL
      )
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = relation.oid
          AND policy.polname = (relation.relname || '_logical_backup_select')::name
          AND policy.polcmd = 'r'
          AND policy.polpermissive
          AND policy.polroles = ARRAY[0]::oid[]
          AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false)
            = $pintpath_policy$${LOGICAL_BACKUP_SELECT_POLICY_EXPRESSION}$pintpath_policy$
          AND policy.polwithcheck IS NULL
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM resolved_required_columns AS required
    WHERE NOT has_column_privilege(
      planner.oid, required.oid, required.attnum, 'SELECT'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND (
        relation.relowner = planner.oid
        OR (
          relation.relkind IN ('r','p','v','m','f')
          AND (
            has_table_privilege(planner.oid, relation.oid, 'SELECT')
            OR has_table_privilege(planner.oid, relation.oid, 'INSERT')
            OR has_table_privilege(planner.oid, relation.oid, 'UPDATE')
            OR has_table_privilege(planner.oid, relation.oid, 'DELETE')
            OR has_table_privilege(planner.oid, relation.oid, 'TRUNCATE')
            OR has_table_privilege(planner.oid, relation.oid, 'REFERENCES')
            OR has_table_privilege(planner.oid, relation.oid, 'TRIGGER')
            OR has_table_privilege(planner.oid, relation.oid, 'MAINTAIN')
            OR has_any_column_privilege(planner.oid, relation.oid, 'INSERT')
            OR has_any_column_privilege(planner.oid, relation.oid, 'UPDATE')
            OR has_any_column_privilege(planner.oid, relation.oid, 'REFERENCES')
          )
        )
        OR (
          relation.relkind = 'S'
          AND (
            has_sequence_privilege(planner.oid, relation.oid, 'SELECT')
            OR has_sequence_privilege(planner.oid, relation.oid, 'USAGE')
            OR has_sequence_privilege(planner.oid, relation.oid, 'UPDATE')
          )
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND has_column_privilege(planner.oid, relation.oid, attribute.attnum, 'SELECT')
      AND NOT EXISTS (
        SELECT 1 FROM resolved_required_columns AS required
        WHERE required.oid = relation.oid AND required.attnum = attribute.attnum
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
      AND (
        routine.proowner = planner.oid
        OR has_function_privilege(planner.oid, routine.oid, 'EXECUTE')
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type AS type_object
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_object.typnamespace
    WHERE type_object.typowner = planner.oid
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname <> 'pg_catalog'
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND namespace.nspname NOT LIKE 'pg_toast_temp_%'
  )`;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const candidateSchema = z.string().regex(CANDIDATE_PATTERN);
const sourceIdSchema = z.string().regex(UUID_PATTERN);
const canonicalUtcSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
).refine((value) => new Date(value).toISOString() === value);
const canonicalSuburbSchema = z.string().min(1).max(120).refine(
  (value) => value === normalizeHumanText(value),
  "marketedSuburb must already be canonical",
);

const privateInputItemSchema = z.object({
  evidenceContentSha256: sha256Schema,
  evidenceReferenceSha256: sha256Schema,
  sourceIngestionId: sourceIdSchema,
  venueIdSha256: sha256Schema,
}).strict();

export const postgresReviewedPricePromotionPrivateInputSchema = z.object({
  itemCount: z.number().int().min(1).max(MAX_ITEMS),
  items: z.array(privateInputItemSchema).min(1).max(MAX_ITEMS),
  kind: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND),
  marketedSuburb: canonicalSuburbSchema,
  version: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_VERSION),
}).strict().superRefine((value, context) => {
  if (value.itemCount !== value.items.length) {
    context.addIssue({ code: "custom", message: "itemCount mismatch" });
  }
  const ids = denseArrayMap(value.items, (item) => item.sourceIngestionId);
  if (
    uniqueStringCount(ids) !== ids.length
    || denseArraySome(ids, (id, index) => index > 0 && ids[index - 1]! >= id)
  ) {
    context.addIssue({ code: "custom", message: "items must have unique bytewise-sorted IDs" });
  }
  const venueHashes = denseArrayMap(value.items, (item) => item.venueIdSha256);
  if (uniqueStringCount(venueHashes) !== venueHashes.length) {
    context.addIssue({ code: "custom", message: "one ingestion per venue is required" });
  }
});

export type PostgresReviewedPricePromotionPrivateInput = z.infer<
  typeof postgresReviewedPricePromotionPrivateInputSchema
>;

const deploymentSchema = z.object({
  attestationFileSha256: sha256Schema,
  attestationPolicySha256: sha256Schema,
  deploymentIdSha256: sha256Schema,
  environmentIdSha256: sha256Schema,
  imageDigestSha256: sha256Schema,
  projectIdSha256: sha256Schema,
  serviceIdSha256: sha256Schema,
}).strict();

const expectedMigrationSchema = z.object({
  receiptFileSha256: sha256Schema,
}).strict();

const sourceItemPlanSchema = z.object({
  catalogRowsSha256: sha256Schema,
  queueSnapshotSha256: sha256Schema,
  selectedRowCount: z.number().int().positive(),
  selectedRowsSha256: sha256Schema,
  sourceIngestionId: sourceIdSchema,
  venueIdSha256: sha256Schema,
  venueProfileSha256: sha256Schema,
}).strict();

const activationBlockersSchema = z.tuple([
  z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[0]),
  z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[1]),
  z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[2]),
  z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[3]),
  z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[4]),
  z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[5]),
  z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[6]),
]);

const planWithoutHashSchema = z.object({
  activationBlockers: activationBlockersSchema,
  authority: z.object({
    authorityBundleSha256: sha256Schema,
    authorityMode: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE),
    evidenceReferencesSha256: sha256Schema,
    expiresAt: canonicalUtcSchema,
    generatedAt: canonicalUtcSchema,
    mutationAuthorized: z.literal(false),
    providerAuthorityObserved: z.literal(false),
    recoveryReferencesSha256: sha256Schema,
    reviewBindingsSha256: sha256Schema,
    supabaseProjectIdentitySha256: sha256Schema,
    targetProfileSha256: sha256Schema,
  }).strict(),
  candidateSha: candidateSchema,
  expectedEnvironment: z.enum(["permanent-staging", "production"]),
  expectedDeployment: deploymentSchema,
  kind: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND),
  migration: z.object({
    approvalReferenceSha256: sha256Schema,
    completedAt: z.string().datetime({ offset: true }),
    contractSha256: sha256Schema,
    manifestSha256: sha256Schema,
    operatorIdSha256: sha256Schema,
    planSha256: sha256Schema,
    receiptFileSha256: sha256Schema,
    receiptSha256: sha256Schema,
    runId: sha256Schema,
    runSnapshotSha256: sha256Schema,
    schemaMetadataSha256: sha256Schema,
    sourceSchemaFingerprint: sha256Schema,
    sourceSchemaSha256: sha256Schema,
    sourceSchemaVersion: z.number().int().positive(),
    sourceSnapshotSha256: sha256Schema,
    startedAt: z.string().datetime({ offset: true }),
    targetBindingSha256: sha256Schema,
    targetDdlSha256: sha256Schema,
    verifierIdSha256: sha256Schema,
  }).strict(),
  mutationEnabled: z.literal(false),
  privateInput: z.object({
    evidenceSetSha256: sha256Schema,
    itemCount: z.number().int().min(1).max(MAX_ITEMS),
    manifestSha256: sha256Schema,
    marketedSuburb: canonicalSuburbSchema,
  }).strict(),
  reviewPacket: z.object({
    itemCount: z.number().int().min(1).max(MAX_ITEMS),
    reviewPacketCandidateSha256: sha256Schema,
    rowCount: z.number().int().min(1).max(MAX_ITEMS * MAX_SOURCE_ROWS_PER_ITEM),
  }).strict(),
  sourceSnapshot: z.object({
    combinedSha256: sha256Schema,
    items: z.array(sourceItemPlanSchema).min(1).max(MAX_ITEMS),
    selectionPolicySha256: sha256Schema,
    publicConflicts: z.object({
      priceRecordCount: z.number().int().nonnegative(),
      rowsSha256: sha256Schema,
      venueBeerCount: z.number().int().nonnegative(),
    }).strict(),
    wrongPriceReports: z.object({
      blockingCount: z.number().int().nonnegative(),
      blockingStatuses: z.tuple([
        z.literal(REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES[0]),
        z.literal(REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES[1]),
      ]),
      openOrInProgressCount: z.number().int().nonnegative(),
      policySha256: sha256Schema,
      rejectedCount: z.number().int().nonnegative(),
      resolvedCount: z.number().int().nonnegative(),
      rowsSha256: sha256Schema,
      totalCount: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  target: z.object({
    catalogIdentity: z.object({
      currentUserSha256: sha256Schema,
      databaseNameSha256: sha256Schema,
      databaseOidSha256: sha256Schema,
      roleSafetySha256: sha256Schema,
      serverVersionNum: z.string().regex(/^17\d{4}$/),
      sessionUserSha256: sha256Schema,
      systemIdentifierSha256: sha256Schema,
    }).strict(),
    physicalIdentitySha256: sha256Schema,
    plannerLoginIdentitySha256: sha256Schema,
  }).strict(),
  version: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION),
}).strict();

export const postgresReviewedPricePromotionPlanCandidateSchema = planWithoutHashSchema.extend({
  planCandidateSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { planCandidateSha256, ...withoutHash } = value;
  if (sha256PostgresReviewedPricePromotionValue(withoutHash) !== planCandidateSha256) {
    context.addIssue({ code: "custom", message: "plan candidate hash mismatch" });
  }
});

export type PostgresReviewedPricePromotionPlanCandidate = z.infer<
  typeof postgresReviewedPricePromotionPlanCandidateSchema
>;

export interface PostgresReviewedPricePromotionPlanArtifacts {
  readonly plan: PostgresReviewedPricePromotionPlanCandidate;
  readonly reviewPacket: PostgresReviewedPricePromotionReviewPacket;
}

export type PostgresReviewedPricePromotionPlanErrorCode =
  | "argument_invalid"
  | "authority_mismatch"
  | "catalog_mismatch"
  | "environment_mismatch"
  | "identity_mismatch"
  | "inspection_invalid"
  | "migration_mismatch"
  | "not_postgres"
  | "private_input_mismatch"
  | "public_conflict"
  | "role_unsafe"
  | "source_mismatch"
  | "wrong_price_open";

export class PostgresReviewedPricePromotionPlanError extends Error {
  constructor(readonly code: PostgresReviewedPricePromotionPlanErrorCode) {
    super(code);
    this.name = "PostgresReviewedPricePromotionPlanError";
  }
}

export interface BuildPostgresReviewedPricePromotionPlanInput {
  readonly authorityBundle: unknown;
  readonly candidateSha: string;
  readonly database: SqlDatabase;
  readonly expectedDeployment: z.input<typeof deploymentSchema>;
  readonly expectedEnvironment: "permanent-staging" | "production";
  readonly expectedMigration: z.input<typeof expectedMigrationSchema>;
  readonly expectedAuthorityBundleSha256: string;
  readonly migrationTargetIdentity: z.input<typeof postgresMigrationTargetIdentitySchema>;
  readonly migrationReceipt: unknown;
  readonly expectedPrivateInputSha256: string;
  readonly expectedPhysicalDatabaseIdentitySha256: string;
  readonly privateInput: unknown;
}

interface IdentityRow extends QueryResultRow {
  readonly currentUser: string;
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly requiredColumnCount: number;
  readonly requiredRelationCount: number;
  readonly roleAuthorityValid: boolean;
  readonly searchPathSchemas: string[];
  readonly serverVersionNum: string;
  readonly sessionUser: string;
  readonly systemIdentifier: string;
  readonly transactionIsolation: string;
  readonly transactionReadOnly: boolean;
}

const IDENTITY_ROW_KEYS = Object.freeze([
  "currentUser",
  "databaseName",
  "databaseOid",
  "requiredColumnCount",
  "requiredRelationCount",
  "roleAuthorityValid",
  "searchPathSchemas",
  "serverVersionNum",
  "sessionUser",
  "systemIdentifier",
  "transactionIsolation",
  "transactionReadOnly",
] as const);
const identityRowSchema = z.object({
  currentUser: z.literal(PLANNER_ROLE),
  databaseName: z.string().min(1).max(128),
  databaseOid: z.string().regex(/^\d+$/),
  requiredColumnCount: z.literal(84),
  requiredRelationCount: z.literal(9),
  roleAuthorityValid: z.literal(true),
  searchPathSchemas: z.tuple([z.literal("pg_catalog")]),
  serverVersionNum: z.string().regex(/^17\d{4}$/),
  sessionUser: z.literal(PLANNER_ROLE),
  systemIdentifier: z.string().regex(/^\d+$/),
  transactionIsolation: z.literal("repeatable read"),
  transactionReadOnly: z.literal(true),
}).strict();

interface MetadataRow extends QueryResultRow {
  readonly key: string;
  readonly value: string;
}

interface MigrationRunRow extends QueryResultRow {
  readonly approvalReferenceSha256: string;
  readonly candidateSha: string;
  readonly completedAt: string | null;
  readonly contractSha256: string;
  readonly expectedEnvironment: string;
  readonly failureCode: string | null;
  readonly manifestSha256: string;
  readonly operatorIdSha256: string;
  readonly receiptSha256: string | null;
  readonly runId: string;
  readonly sourceSchemaFingerprint: string;
  readonly sourceSchemaVersion: number;
  readonly sourceSnapshotSha256: string;
  readonly startedAt: string;
  readonly status: string;
  readonly targetBindingSha256: string;
  readonly targetDdlSha256: string;
  readonly verifierIdSha256: string | null;
}

interface QueueRow extends QueryResultRow {
  readonly capturedNotes: string | null;
  readonly createdAt: string;
  readonly extractedBeersJson: string;
  readonly id: string;
  readonly imageRedactedAt: string | null;
  readonly imageRedactionReason: string | null;
  readonly imageRetentionExpiresAt: string | null;
  readonly note: string | null;
  readonly overallConfidence: number | string | null;
  readonly publishedAt: string | null;
  readonly rejectedAt: string | null;
  readonly reviewBeersJson: string | null;
  readonly reviewClaimToken: string | null;
  readonly reviewClaimedAt: string | null;
  readonly sourceType: string;
  readonly sourceUrl: string | null;
  readonly status: string;
  readonly updatedAt: string;
  readonly venueId: string;
  readonly venueName: string;
  readonly venueNameGuess: string | null;
}

interface VenueProfileRow extends QueryResultRow {
  readonly active: boolean;
  readonly address: string | null;
  readonly area: string | null;
  readonly name: string;
  readonly suburb: string | null;
  readonly updatedAt: string;
  readonly venueId: string;
}

interface CatalogRow extends QueryResultRow {
  readonly abv: number | string | null;
  readonly alias: string;
  readonly aliasKey: string;
  readonly brewery: string | null;
  readonly itemKey: string;
  readonly itemName: string;
  readonly source: string;
  readonly status: string;
  readonly style: string | null;
  readonly updatedAt: string;
}

interface PresenceRow extends QueryResultRow {
  readonly present: boolean;
}

interface WrongPriceRow extends QueryResultRow {
  readonly assignedTo: string | null;
  readonly beerName: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly notes: string | null;
  readonly priceRecordId: string | null;
  readonly reason: string;
  readonly resolutionNote: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly sourcePhotoUrl: string | null;
  readonly status: typeof REVIEWED_PRICE_WRONG_PRICE_STATUSES[number];
  readonly updatedAt: string;
  readonly venueId: string;
}

const nullableText = (maximum: number) => z.string().min(1).max(maximum).nullable();
const METADATA_ROW_KEYS = Object.freeze(["key", "value"] as const);
const metadataRowSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.string().max(4_096),
}).strict();
const MIGRATION_RUN_KEYS = Object.freeze([
  "approvalReferenceSha256",
  "candidateSha",
  "completedAt",
  "contractSha256",
  "expectedEnvironment",
  "failureCode",
  "manifestSha256",
  "operatorIdSha256",
  "receiptSha256",
  "runId",
  "sourceSchemaFingerprint",
  "sourceSchemaVersion",
  "sourceSnapshotSha256",
  "startedAt",
  "status",
  "targetBindingSha256",
  "targetDdlSha256",
  "verifierIdSha256",
] as const);
const migrationRunRowSchema = z.object({
  approvalReferenceSha256: sha256Schema,
  candidateSha: candidateSchema,
  completedAt: canonicalUtcSchema.nullable(),
  contractSha256: sha256Schema,
  expectedEnvironment: z.enum(["permanent-staging", "production"]),
  failureCode: z.string().min(1).max(160).nullable(),
  manifestSha256: sha256Schema,
  operatorIdSha256: sha256Schema,
  receiptSha256: sha256Schema.nullable(),
  runId: sha256Schema,
  sourceSchemaFingerprint: sha256Schema,
  sourceSchemaVersion: z.number().int().positive(),
  sourceSnapshotSha256: sha256Schema,
  startedAt: canonicalUtcSchema,
  status: z.enum(["planned", "importing", "verifying", "ready", "failed"]),
  targetBindingSha256: sha256Schema,
  targetDdlSha256: sha256Schema,
  verifierIdSha256: sha256Schema.nullable(),
}).strict();
const QUEUE_ROW_KEYS = Object.freeze([
  "capturedNotes",
  "createdAt",
  "extractedBeersJson",
  "id",
  "imageRedactedAt",
  "imageRedactionReason",
  "imageRetentionExpiresAt",
  "note",
  "overallConfidence",
  "publishedAt",
  "rejectedAt",
  "reviewBeersJson",
  "reviewClaimToken",
  "reviewClaimedAt",
  "sourceType",
  "sourceUrl",
  "status",
  "updatedAt",
  "venueId",
  "venueName",
  "venueNameGuess",
] as const);
const boundedNumericInspectionSchema = (maximum: number) => z.union([
  z.number().finite().min(0).max(maximum),
  z.string()
    .min(1)
    .max(32)
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .refine((value) => {
      const numeric = REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [value]) as number;
      return NUMBER_IS_FINITE(numeric) && numeric >= 0 && numeric <= maximum;
    }),
  z.null(),
]);
const confidenceInspectionSchema = boundedNumericInspectionSchema(1);
const catalogAbvInspectionSchema = boundedNumericInspectionSchema(25);
const queueRowSchema = z.object({
  capturedNotes: nullableText(4_000),
  createdAt: canonicalUtcSchema,
  extractedBeersJson: z.string().max(MAX_SOURCE_JSON_BYTES),
  id: sourceIdSchema,
  imageRedactedAt: canonicalUtcSchema.nullable(),
  imageRedactionReason: nullableText(1_000),
  imageRetentionExpiresAt: canonicalUtcSchema.nullable(),
  note: nullableText(4_000),
  overallConfidence: confidenceInspectionSchema,
  publishedAt: canonicalUtcSchema.nullable(),
  rejectedAt: canonicalUtcSchema.nullable(),
  reviewBeersJson: z.string().max(MAX_SOURCE_JSON_BYTES).nullable(),
  reviewClaimToken: nullableText(1_024),
  reviewClaimedAt: canonicalUtcSchema.nullable(),
  sourceType: z.enum(["menu_photo_upload", "source_image_url", "source_reference"]),
  sourceUrl: nullableText(4_096),
  status: z.enum(["pending_review", "publishing", "rejecting", "published", "rejected", "failed"]),
  updatedAt: canonicalUtcSchema,
  venueId: sourceIdSchema,
  venueName: z.string().min(1).max(180),
  venueNameGuess: nullableText(180),
}).strict();
const VENUE_PROFILE_ROW_KEYS = Object.freeze([
  "active",
  "address",
  "area",
  "name",
  "suburb",
  "updatedAt",
  "venueId",
] as const);
const venueProfileRowSchema = z.object({
  active: z.boolean(),
  address: nullableText(500),
  area: nullableText(180),
  name: z.string().min(1).max(180),
  suburb: nullableText(180),
  updatedAt: canonicalUtcSchema,
  venueId: sourceIdSchema,
}).strict();
const CATALOG_ROW_KEYS = Object.freeze([
  "abv",
  "alias",
  "aliasKey",
  "brewery",
  "itemKey",
  "itemName",
  "source",
  "status",
  "style",
  "updatedAt",
] as const);
const catalogRowSchema = z.object({
  abv: catalogAbvInspectionSchema,
  alias: z.string().min(1).max(180),
  aliasKey: z.string().min(1).max(180),
  brewery: nullableText(180),
  itemKey: z.string().min(1).max(180),
  itemName: z.string().min(1).max(180),
  source: z.string().min(1).max(180),
  status: z.string().min(1).max(80),
  style: nullableText(180),
  updatedAt: canonicalUtcSchema,
}).strict();
const wrongPriceRowSchema = z.object({
  assignedTo: nullableText(180),
  beerName: nullableText(2_000),
  createdAt: canonicalUtcSchema,
  id: z.string().min(1).max(180),
  notes: nullableText(2_000),
  priceRecordId: nullableText(180),
  reason: z.enum(REVIEWED_PRICE_WRONG_PRICE_REASONS),
  resolutionNote: nullableText(2_000),
  resolvedAt: canonicalUtcSchema.nullable(),
  resolvedBy: nullableText(180),
  sourcePhotoUrl: nullableText(4_096),
  status: z.enum(REVIEWED_PRICE_WRONG_PRICE_STATUSES),
  updatedAt: canonicalUtcSchema,
  venueId: sourceIdSchema,
}).strict().superRefine((value, context) => {
  const terminal = value.status === "resolved" || value.status === "rejected";
  if (
    terminal
      ? value.resolvedAt === null
      : value.resolvedAt !== null || value.resolvedBy !== null
  ) {
    context.addIssue({ code: "custom", message: "wrong-price terminal authority mismatch" });
  }
  if (
    value.updatedAt < value.createdAt
    || value.resolvedAt !== null && (value.resolvedAt < value.createdAt || value.resolvedAt > value.updatedAt)
  ) {
    context.addIssue({ code: "custom", message: "wrong-price timestamp order mismatch" });
  }
});

interface SourceBeer {
  readonly availabilityStatus: "on_tap" | "package_only" | "unavailable" | "unknown";
  readonly availableOnTap: boolean | null;
  readonly availablePackageOnly: boolean;
  readonly confidence: number;
  readonly name: string;
  readonly needsReview: boolean;
  readonly notes: string | null;
  readonly priceNumeric: number | null;
  readonly priceText: string | null;
  readonly servingSize: "pint";
  readonly unavailableReason:
    | "bottles_only"
    | "cans_only"
    | "cans_or_bottles"
    | "no_pints"
    | "not_on_tap"
    | "not_stocked"
    | "unknown"
    | null;
}

const sourceBeerSchema: z.ZodType<SourceBeer> = z.object({
  availabilityStatus: z.enum(["on_tap", "package_only", "unavailable", "unknown"]),
  availableOnTap: z.boolean().nullable(),
  availablePackageOnly: z.boolean(),
  confidence: z.number().finite(),
  name: z.string(),
  needsReview: z.boolean(),
  notes: z.string().nullable(),
  priceNumeric: z.number().finite().nullable(),
  priceText: z.string().nullable(),
  servingSize: z.literal("pint"),
  unavailableReason: z.enum([
    "bottles_only",
    "cans_only",
    "cans_or_bottles",
    "no_pints",
    "not_on_tap",
    "not_stocked",
    "unknown",
  ]).nullable(),
}).strict();

function fail(code: PostgresReviewedPricePromotionPlanErrorCode): never {
  throw new PostgresReviewedPricePromotionPlanError(code);
}

function sameIntrinsicDescriptor(
  actual: PropertyDescriptor,
  expected: PropertyDescriptor,
): boolean {
  return actual.configurable === expected.configurable
    && actual.enumerable === expected.enumerable
    && actual.get === expected.get
    && actual.set === expected.set
    && OBJECT_IS(actual.value, expected.value)
    && actual.writable === expected.writable;
}

function assertPlanIntrinsicSurfacesExact(): void {
  for (let surfaceIndex = 0; surfaceIndex < PLAN_INTRINSIC_SURFACES.length; surfaceIndex += 1) {
    const surface = PLAN_INTRINSIC_SURFACES[surfaceIndex];
    if (!surface) fail("inspection_invalid");
    const actualKeys = REFLECT_OWN_KEYS(surface.target);
    if (actualKeys.length !== surface.keys.length) fail("inspection_invalid");
    for (let keyIndex = 0; keyIndex < surface.keys.length; keyIndex += 1) {
      const key = surface.keys[keyIndex];
      if (key === undefined || actualKeys[keyIndex] !== key) fail("inspection_invalid");
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(surface.target, key);
      const expected = surface.descriptors[keyIndex];
      if (!descriptor || !expected || !sameIntrinsicDescriptor(descriptor, expected)) {
        fail("inspection_invalid");
      }
    }
  }
}

function parseOrFail<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  try {
    assertPlanIntrinsicSurfacesExact();
    const parsed = schema.safeParse(value);
    if (!parsed.success) fail("argument_invalid");
    return parsed.data;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("argument_invalid");
  }
}

function normalizeHumanText(value: string): string {
  const trimmed = REFLECT_APPLY(STRING_TRIM, value, []) as string;
  let output = "";
  let whitespacePending = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, trimmed, [index]) as number;
    const whitespace = code === 0x09
      || code === 0x0a
      || code === 0x0b
      || code === 0x0c
      || code === 0x0d
      || code === 0x20
      || code === 0xa0
      || code === 0x1680
      || code >= 0x2000 && code <= 0x200a
      || code === 0x2028
      || code === 0x2029
      || code === 0x202f
      || code === 0x205f
      || code === 0x3000
      || code === 0xfeff;
    if (whitespace) {
      whitespacePending = output.length > 0;
      continue;
    }
    if (whitespacePending) output += " ";
    output += trimmed[index];
    whitespacePending = false;
  }
  return output;
}

function lowercase(value: string): string {
  return REFLECT_APPLY(STRING_TO_LOWER_CASE, value, []) as string;
}

function bytewiseCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function regexpMatches(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function exactStringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  try {
    if (
      typeof value !== "object"
      || value === null
      || UTIL_IS_PROXY(value)
      || !ARRAY_IS_ARRAY(value)
      || OBJECT_GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE
    ) return false;
    const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, "length");
    if (
      !lengthDescriptor
      || !OBJECT_HAS_OWN(lengthDescriptor, "value")
      || lengthDescriptor.value !== expected.length
      || REFLECT_OWN_KEYS(value).length !== expected.length + 1
    ) return false;
    for (let index = 0; index < expected.length; index += 1) {
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, `${index}`);
      if (
        !descriptor
        || !OBJECT_HAS_OWN(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.value !== expected[index]
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function defineDenseArrayValue(
  target: unknown[],
  index: number,
  value: unknown,
): void {
  OBJECT_DEFINE_PROPERTY(target, `${index}`, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function denseArrayMap<Input, Output>(
  values: readonly Input[],
  transform: (value: Input, index: number) => Output,
): Output[] {
  const output = new ARRAY_CONSTRUCTOR<Output>(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) fail("inspection_invalid");
    defineDenseArrayValue(output, index, transform(value, index));
  }
  return output;
}

function denseArraySome<Input>(
  values: readonly Input[],
  predicate: (value: Input, index: number) => boolean,
): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) fail("inspection_invalid");
    if (predicate(value, index)) return true;
  }
  return false;
}

function denseArrayCount<Input>(
  values: readonly Input[],
  predicate: (value: Input, index: number) => boolean,
): number {
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) fail("inspection_invalid");
    if (predicate(value, index)) count += 1;
  }
  return count;
}

function denseStringSort(values: readonly string[]): string[] {
  const output = denseArrayMap(values, (value) => value);
  REFLECT_APPLY(ARRAY_SORT, output, [bytewiseCompare]);
  return output;
}

function uniqueStringCount(values: readonly string[]): number {
  if (typeof SET_SIZE !== "function") fail("inspection_invalid");
  const seen = REFLECT_CONSTRUCT(SET_CONSTRUCTOR, []) as Set<string>;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string") fail("inspection_invalid");
    REFLECT_APPLY(SET_ADD, seen, [value]);
  }
  const size = REFLECT_APPLY(SET_SIZE, seen, []);
  if (!NUMBER_IS_SAFE_INTEGER(size) || size < 0) fail("inspection_invalid");
  return size;
}

function mapGet<Key, Value>(map: Map<Key, Value>, key: Key): Value | undefined {
  return REFLECT_APPLY(MAP_GET, map, [key]) as Value | undefined;
}

function mapHas<Key, Value>(map: Map<Key, Value>, key: Key): boolean {
  return REFLECT_APPLY(MAP_HAS, map, [key]) === true;
}

function mapSet<Key, Value>(map: Map<Key, Value>, key: Key, value: Value): void {
  REFLECT_APPLY(MAP_SET, map, [key, value]);
}

function setHas<Value>(set: Set<Value>, value: Value): boolean {
  return REFLECT_APPLY(SET_HAS, set, [value]) === true;
}

export function canonicalPostgresReviewedPricePromotionJson(value: unknown): Buffer {
  return serializeCanonicalPostgresMigrationJson(value);
}

export function sha256PostgresReviewedPricePromotionValue(value: unknown): string {
  return sha256PostgresMigrationBytes(canonicalPostgresReviewedPricePromotionJson(value));
}

export function sha256PostgresReviewedPricePromotionIdentity(
  label: "venue-id" | "evidence-reference",
  value: string,
): string {
  return sha256PostgresMigrationBytes(`pintpath-reviewed-price-${label}-v1\0${value}`);
}

function nullableDigest(label: string, value: string | null): string | null {
  return value === null
    ? null
    : sha256PostgresMigrationBytes(`pintpath-reviewed-price-${label}-v1\0${value}`);
}

function exactNumeric(value: number | string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "number" && typeof value !== "string") fail("inspection_invalid");
  const numeric = REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [value]) as number;
  if (!NUMBER_IS_FINITE(numeric)) fail("inspection_invalid");
  return typeof value === "number"
    ? REFLECT_APPLY(NUMBER_TO_STRING, value, []) as string
    : value;
}

function parseJsonArray(value: string | null): unknown[] | null {
  if (value === null) return null;
  try {
    assertPlanIntrinsicSurfacesExact();
    if (
      REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_OBJECT, [value, "utf8"])
        > MAX_SOURCE_JSON_BYTES
    ) fail("source_mismatch");
    const parsed: unknown = REFLECT_APPLY(JSON_PARSE, JSON_OBJECT, [value]);
    return Array.isArray(parsed) && parsed.length <= MAX_SOURCE_ROWS_PER_ITEM
      ? parsed
      : fail("source_mismatch");
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("source_mismatch");
  }
}

function canonicalPrivateInput(value: unknown): PostgresReviewedPricePromotionPrivateInput {
  try {
    assertPlanIntrinsicSurfacesExact();
    const parsed = postgresReviewedPricePromotionPrivateInputSchema.safeParse(value);
    if (!parsed.success) fail("private_input_mismatch");
    return parsed.data;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("private_input_mismatch");
  }
}

function canonicalAuthorityBundle(
  value: unknown,
): PostgresReviewedPricePromotionAuthorityBundle {
  try {
    assertPlanIntrinsicSurfacesExact();
    const parsed = postgresReviewedPricePromotionAuthorityBundleSchema.safeParse(value);
    if (!parsed.success) fail("authority_mismatch");
    return parsed.data;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("authority_mismatch");
  }
}

function canonicalMigrationReceipt(value: unknown): PostgresMigrationReceipt {
  try {
    assertPlanIntrinsicSurfacesExact();
    const parsed = postgresMigrationReceiptSchema.safeParse(value);
    if (!parsed.success) fail("migration_mismatch");
    return parsed.data;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("migration_mismatch");
  }
}

function normalizeBeerKey(value: string): string {
  const normalized = lowercase(REFLECT_APPLY(STRING_TRIM, value, []) as string);
  let output = "";
  let separatorPending = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, normalized, [index]) as number;
    const allowed = code >= 0x61 && code <= 0x7a || code >= 0x30 && code <= 0x39;
    if (!allowed) {
      separatorPending = output.length > 0;
      continue;
    }
    if (separatorPending) output += "_";
    output += normalized[index];
    separatorPending = false;
  }
  return output;
}

function recordIdSegment(value: string): string {
  const normalized = lowercase(REFLECT_APPLY(STRING_TRIM, value, []) as string);
  let output = "";
  let separatorPending = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, normalized, [index]) as number;
    const allowed = code >= 0x61 && code <= 0x7a || code >= 0x30 && code <= 0x39;
    if (!allowed) {
      separatorPending = output.length > 0;
      continue;
    }
    if (separatorPending) output += "-";
    output += normalized[index];
    separatorPending = false;
  }
  return output || "beer";
}

function selectedSourceBeers(row: QueueRow): AdminBeerInput[] {
  assertPlanIntrinsicSurfacesExact();
  const overallConfidence = REFLECT_APPLY(
    NUMBER_CONSTRUCTOR,
    undefined,
    [row.overallConfidence],
  ) as number;
  if (
    row.status !== "pending_review"
    || row.reviewClaimToken !== null
    || row.reviewClaimedAt !== null
    || row.publishedAt !== null
    || row.rejectedAt !== null
    || !NUMBER_IS_FINITE(overallConfidence)
    || overallConfidence < REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS.minOverallConfidence
  ) fail("source_mismatch");

  const extracted = parseJsonArray(row.extractedBeersJson);
  if (!extracted) fail("source_mismatch");
  const parsed = z.array(sourceBeerSchema).max(MAX_SOURCE_ROWS_PER_ITEM).safeParse(extracted);
  if (!parsed.success) fail("source_mismatch");
  try {
    const selection = selectPublishableMapBaseRows({
      capturedNotes: row.capturedNotes,
      extractedBeers: parsed.data,
      note: row.note,
      overallConfidence,
      sourceType: row.sourceType as "source_reference",
      sourceUrl: row.sourceUrl,
    }, REVIEWED_PRICE_SELECTION_DEFAULT_OPTIONS);
    assertPlanIntrinsicSurfacesExact();
    if (selection.reasons.length !== 0 || selection.beers.length === 0) fail("source_mismatch");
    return selection.beers;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("source_mismatch");
  }
}

function queueSnapshot(row: QueueRow, selected: readonly AdminBeerInput[]): Record<string, unknown> {
  return {
    capturedNotesSha256: nullableDigest("captured-notes", row.capturedNotes),
    createdAt: row.createdAt,
    extractedBeersSha256: sha256PostgresReviewedPricePromotionValue(parseJsonArray(row.extractedBeersJson)),
    imageRedactedAt: row.imageRedactedAt,
    imageRedactionReasonSha256: nullableDigest("image-redaction-reason", row.imageRedactionReason),
    imageRetentionExpiresAt: row.imageRetentionExpiresAt,
    noteSha256: nullableDigest("queue-note", row.note),
    overallConfidence: exactNumeric(row.overallConfidence),
    publishedAt: row.publishedAt,
    rejectedAt: row.rejectedAt,
    reviewBeersSha256: row.reviewBeersJson === null
      ? null
      : sha256PostgresReviewedPricePromotionValue(parseJsonArray(row.reviewBeersJson)),
    reviewClaimPresent: row.reviewClaimToken !== null || row.reviewClaimedAt !== null,
    selectedRowsSha256: sha256PostgresReviewedPricePromotionValue(selected),
    sourceIngestionId: row.id,
    sourceType: row.sourceType,
    sourceUrlSha256: nullableDigest("source-url", row.sourceUrl),
    status: row.status,
    updatedAt: row.updatedAt,
    venueIdSha256: sha256PostgresReviewedPricePromotionIdentity("venue-id", row.venueId),
    venueNameGuessSha256: nullableDigest("venue-name-guess", row.venueNameGuess),
    venueNameSha256: nullableDigest("venue-name", row.venueName),
  };
}

function plannerLoginIdentityDigest(row: IdentityRow): string {
  return sha256PostgresReviewedPricePromotionValue({
    currentUser: row.currentUser,
    databaseName: row.databaseName,
    databaseOid: row.databaseOid,
    serverVersionNum: row.serverVersionNum,
    sessionUser: row.sessionUser,
    systemIdentifier: row.systemIdentifier,
  });
}

function physicalDatabaseIdentityDigest(
  value: Parameters<typeof sha256PostgresDatabaseIdentity>[0],
  errorCode: "argument_invalid" | "identity_mismatch",
): string {
  try {
    return sha256PostgresDatabaseIdentity(value);
  } catch {
    return fail(errorCode);
  }
}

function assertSafeIdentity(row: IdentityRow | undefined): asserts row is IdentityRow {
  assertPlanIntrinsicSurfacesExact();
  if (
    !row
    || !regexpMatches(/^\d+$/, row.systemIdentifier)
    || !regexpMatches(/^\d+$/, row.databaseOid)
    || !regexpMatches(/^17\d{4}$/, row.serverVersionNum)
    || row.sessionUser !== PLANNER_ROLE
    || row.currentUser !== PLANNER_ROLE
    || row.transactionIsolation !== "repeatable read"
    || row.transactionReadOnly !== true
    || !exactStringArrayEquals(row.searchPathSchemas, ["pg_catalog"])
    || row.roleAuthorityValid !== true
    || row.requiredRelationCount !== 9
    || row.requiredColumnCount !== 84
  ) fail("role_unsafe");
}

function exactMetadata(rows: readonly MetadataRow[]): Readonly<Record<string, string>> {
  assertPlanIntrinsicSurfacesExact();
  if (rows.length !== EXPECTED_METADATA_KEYS.length) fail("migration_mismatch");
  const output = OBJECT_CREATE(null) as Record<string, string>;
  for (let index = 0; index < EXPECTED_METADATA_KEYS.length; index += 1) {
    const row = rows[index];
    const expectedKey = EXPECTED_METADATA_KEYS[index];
    if (
      !row
      || typeof row.key !== "string"
      || typeof row.value !== "string"
      || row.key !== expectedKey
      || expectedKey === undefined
    ) fail("migration_mismatch");
    OBJECT_DEFINE_PROPERTY(output, expectedKey, {
      configurable: false,
      enumerable: true,
      value: row.value,
      writable: false,
    });
  }
  return output;
}

function expectedMigrationRunBinding(
  receipt: PostgresMigrationReceipt,
  sourceSchemaVersion: number,
): { readonly runBindingSha256: string; readonly runIdSha256: string } {
  const runBindingSha256 = sha256PostgresMigrationRunBinding({
    approvalReferenceSha256: receipt.approvalReferenceSha256,
    candidateSha: receipt.candidateSha,
    contractSha256: receipt.contractSha256,
    expectedEnvironment: receipt.expectedEnvironment,
    manifestSha256: receipt.manifestSha256,
    operatorIdSha256: receipt.operatorIdSha256,
    planSha256: receipt.planSha256,
    sourceSchemaFingerprint: receipt.sourceSchemaFingerprint,
    sourceSchemaVersion,
    sourceSnapshotSha256: receipt.sourceSnapshotSha256,
    targetDdlSha256: receipt.targetDdlSha256,
    targetIdentitySha256: receipt.targetIdentitySha256,
    liveSchemaSha256: receipt.liveSchemaSha256,
    transportAuthoritySha256: receipt.transportAuthoritySha256,
    targetUrlSha256: receipt.targetUrlSha256,
    verifierIdSha256: receipt.verifierIdSha256,
    verifierAuthoritySha256: receipt.verifierAuthoritySha256,
    verifierAuthorityPolicySha256: receipt.verifierAuthorityPolicySha256,
    verifierPublicKeySha256: receipt.verifierPublicKeySha256,
  });
  return {
    runBindingSha256,
    runIdSha256: derivePostgresMigrationRunId(runBindingSha256),
  };
}

function validateMigration(
  row: MigrationRunRow | undefined,
  metadata: Readonly<Record<string, string>>,
  receipt: PostgresMigrationReceipt,
  migrationTargetIdentity: PostgresMigrationTargetIdentity,
  liveIdentity: IdentityRow,
  environment: "permanent-staging" | "production",
  candidateSha: string,
): asserts row is MigrationRunRow {
  if (row && row.expectedEnvironment !== environment) fail("environment_mismatch");
  if (
    !row
    || !NUMBER_IS_SAFE_INTEGER(row.sourceSchemaVersion)
    || row.sourceSchemaVersion !== POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion
  ) fail("migration_mismatch");
  let runAuthority: ReturnType<typeof expectedMigrationRunBinding>;
  try {
    runAuthority = expectedMigrationRunBinding(receipt, row.sourceSchemaVersion);
  } catch {
    fail("migration_mismatch");
  }
  let readyMetadataSha256: string;
  try {
    readyMetadataSha256 = sha256PostgresMigrationReadyMetadata(
      buildPostgresMigrationReadyMetadata({
        import_state: metadata.import_state as "ready",
        migration_candidate_sha: metadata.migration_candidate_sha!,
        migration_contract_sha256: metadata.migration_contract_sha256!,
        migration_manifest_sha256: metadata.migration_manifest_sha256!,
        migration_plan_sha256: metadata.migration_plan_sha256!,
        migration_run_sha256: metadata.migration_run_sha256!,
        source_schema_fingerprint: metadata.source_schema_fingerprint!,
        source_schema_version: metadata.source_schema_version!,
        source_snapshot_sha256: metadata.source_snapshot_sha256!,
        target_ddl_sha256: metadata.target_ddl_sha256!,
        live_schema_sha256: metadata.live_schema_sha256!,
      }),
    );
  } catch {
    fail("migration_mismatch");
  }
  if (
    row.status !== "ready"
    || receipt.runBindingSha256 !== runAuthority.runBindingSha256
    || receipt.runIdSha256 !== runAuthority.runIdSha256
    || row.runId !== runAuthority.runIdSha256
    || row.receiptSha256 !== receipt.receiptSha256
    || row.targetBindingSha256 !== runAuthority.runBindingSha256
    || row.candidateSha !== candidateSha
    || row.sourceSnapshotSha256 !== receipt.sourceSnapshotSha256
    || row.sourceSchemaFingerprint !== receipt.sourceSchemaFingerprint
    || row.contractSha256 !== receipt.contractSha256
    || row.manifestSha256 !== receipt.manifestSha256
    || row.targetDdlSha256 !== receipt.targetDdlSha256
    || row.approvalReferenceSha256 !== receipt.approvalReferenceSha256
    || row.operatorIdSha256 !== receipt.operatorIdSha256
    || row.verifierIdSha256 !== receipt.verifierIdSha256
    || row.failureCode !== null
    || row.verifierIdSha256 === null
    || row.completedAt === null
    || row.completedAt < row.startedAt
    || !regexpMatches(SHA256_PATTERN, row.approvalReferenceSha256)
    || !regexpMatches(SHA256_PATTERN, row.operatorIdSha256)
    || !regexpMatches(SHA256_PATTERN, row.verifierIdSha256)
    || receipt.expectedEnvironment !== environment
    || receipt.candidateSha !== candidateSha
    || receipt.targetIdentitySha256 !== sha256PostgresMigrationTargetIdentity(migrationTargetIdentity)
    || !regexpMatches(/^17\d{4}$/, migrationTargetIdentity.serverVersionNum)
    || migrationTargetIdentity.systemIdentifier !== liveIdentity.systemIdentifier
    || migrationTargetIdentity.databaseOid !== liveIdentity.databaseOid
    || migrationTargetIdentity.databaseName !== liveIdentity.databaseName
    || receipt.planSha256 !== metadata.migration_plan_sha256
    || receipt.contractSha256 !== sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)
    || receipt.sourceSchemaFingerprint !== POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint
    || receipt.tableCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    || receipt.columnCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns
    || receipt.foreignKeyCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys
    || receipt.schemaMetadataSha256 !== readyMetadataSha256
    || metadata.import_state !== "ready"
    || metadata.schema_version !== "1"
    || metadata.migration_candidate_sha !== candidateSha
    || metadata.migration_contract_sha256 !== row.contractSha256
    || metadata.migration_manifest_sha256 !== row.manifestSha256
    || metadata.migration_plan_sha256 !== receipt.planSha256
    || metadata.migration_run_sha256 !== row.runId
    || metadata.source_schema_fingerprint !== row.sourceSchemaFingerprint
    || metadata.source_schema_version !== String(row.sourceSchemaVersion)
    || metadata.source_snapshot_sha256 !== row.sourceSnapshotSha256
    || metadata.target_ddl_sha256 !== row.targetDdlSha256
    || metadata.live_schema_sha256 !== receipt.liveSchemaSha256
    || metadata.source_schema_sha256 !== POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256
    || !regexpMatches(/^\d+$/, metadata.source_schema_version ?? "")
  ) fail("migration_mismatch");
}

function sanitizedConflictRow(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output = OBJECT_CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < WRONG_PRICE_ROW_KEYS.length; index += 1) {
    const key = WRONG_PRICE_ROW_KEYS[index];
    if (key === undefined) fail("inspection_invalid");
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(row, key);
    if (!descriptor || !OBJECT_HAS_OWN(descriptor, "value")) fail("inspection_invalid");
    const value = descriptor.value;
    let sanitized: unknown;
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      sanitized = value;
    } else if (typeof value === "string") {
      sanitized = nullableDigest(`conflict-${key}`, value);
    } else {
      sanitized = sha256PostgresReviewedPricePromotionValue(value);
    }
    OBJECT_DEFINE_PROPERTY(output, key, {
      configurable: false,
      enumerable: true,
      value: sanitized,
      writable: false,
    });
  }
  return output;
}

const WRONG_PRICE_ROW_KEYS = Object.freeze([
  "assignedTo",
  "beerName",
  "createdAt",
  "id",
  "notes",
  "priceRecordId",
  "reason",
  "resolutionNote",
  "resolvedAt",
  "resolvedBy",
  "sourcePhotoUrl",
  "status",
  "updatedAt",
  "venueId",
] as const);

function exactOwnDataSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  assertPlanIntrinsicSurfacesExact();
  if (
    value === null
    || typeof value !== "object"
    || UTIL_IS_PROXY(value)
  ) fail("inspection_invalid");
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) fail("inspection_invalid");
  const actualKeys = REFLECT_OWN_KEYS(value);
  if (actualKeys.length !== expectedKeys.length) fail("inspection_invalid");
  const snapshot: Record<string, unknown> = OBJECT_CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    if (typeof key !== "string") fail("inspection_invalid");
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
    if (
      !descriptor
      || !OBJECT_HAS_OWN(descriptor, "value")
      || descriptor.enumerable !== true
    ) fail("inspection_invalid");
    OBJECT_DEFINE_PROPERTY(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return snapshot;
}

function exactArrayItems(value: unknown, maximum: number): unknown[] {
  assertPlanIntrinsicSurfacesExact();
  if (
    typeof value !== "object"
    || value === null
    || UTIL_IS_PROXY(value)
    || !ARRAY_IS_ARRAY(value)
    || OBJECT_GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE
  ) {
    fail("inspection_invalid");
  }
  const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, "length");
  if (
    !lengthDescriptor
    || !OBJECT_HAS_OWN(lengthDescriptor, "value")
    || typeof lengthDescriptor.value !== "number"
    || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximum
    || REFLECT_OWN_KEYS(value).length !== lengthDescriptor.value + 1
  ) fail("inspection_invalid");
  const output = new ARRAY_CONSTRUCTOR<unknown>(lengthDescriptor.value);
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, `${index}`);
    if (!descriptor || !OBJECT_HAS_OWN(descriptor, "value") || !descriptor.enumerable) {
      return fail("inspection_invalid");
    }
    defineDenseArrayValue(output, index, descriptor.value);
  }
  return output;
}

function exactRowArray<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
  expectedKeys: readonly string[],
  maximum: number,
  code: PostgresReviewedPricePromotionPlanErrorCode,
): Output[] {
  try {
    const rows = exactArrayItems(value, maximum);
    const output = new ARRAY_CONSTRUCTOR<Output>(rows.length);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const parsed = schema.safeParse(exactOwnDataSnapshot(row, expectedKeys));
      if (!parsed.success) fail(code);
      defineDenseArrayValue(output, index, parsed.data);
    }
    return output;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) {
      if (error.code === "inspection_invalid" && code !== "inspection_invalid") fail(code);
      throw error;
    }
    return fail(code);
  }
}

function exactWrongPriceRows(
  value: unknown,
  venueIds: readonly string[],
): WrongPriceRow[] {
  try {
    const rows = exactArrayItems(value, MAX_WRONG_PRICE_ROWS);
    const allowedVenues = REFLECT_CONSTRUCT(SET_CONSTRUCTOR, []) as Set<string>;
    for (let index = 0; index < venueIds.length; index += 1) {
      const venueId = venueIds[index];
      if (typeof venueId !== "string") fail("inspection_invalid");
      REFLECT_APPLY(SET_ADD, allowedVenues, [venueId]);
    }
    const output = new ARRAY_CONSTRUCTOR<WrongPriceRow>(rows.length);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const parsed = wrongPriceRowSchema.safeParse(
        exactOwnDataSnapshot(row, WRONG_PRICE_ROW_KEYS),
      );
      if (!parsed.success || !setHas(allowedVenues, parsed.data.venueId)) {
        fail("inspection_invalid");
      }
      defineDenseArrayValue(output, index, parsed.data);
    }
    return output;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("inspection_invalid");
  }
}

function exactPresenceRow(value: unknown): PresenceRow {
  try {
    const snapshot = exactOwnDataSnapshot(value, ["present"]);
    if (typeof snapshot.present !== "boolean") fail("inspection_invalid");
    return { present: snapshot.present };
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("inspection_invalid");
  }
}

function exactIdentityRow(value: unknown): IdentityRow {
  try {
    const parsed = identityRowSchema.safeParse(exactOwnDataSnapshot(value, IDENTITY_ROW_KEYS));
    if (!parsed.success) fail("role_unsafe");
    return parsed.data;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("role_unsafe");
  }
}

export async function buildPostgresReviewedPricePromotionPlanArtifacts(
  input: BuildPostgresReviewedPricePromotionPlanInput,
): Promise<PostgresReviewedPricePromotionPlanArtifacts> {
  assertPlanIntrinsicSurfacesExact();
  let database: SqlDatabase;
  try {
    database = input.database;
    if (database.dialect !== "postgres") fail("not_postgres");
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("argument_invalid");
  }

  const argumentSchema = z.object({
    candidateSha: candidateSchema,
    expectedAuthorityBundleSha256: sha256Schema,
    expectedEnvironment: z.enum(["permanent-staging", "production"]),
    expectedDeployment: deploymentSchema,
    expectedMigration: expectedMigrationSchema,
    migrationTargetIdentity: postgresMigrationTargetIdentitySchema,
    expectedPhysicalDatabaseIdentitySha256: sha256Schema,
    expectedPrivateInputSha256: sha256Schema,
  }).strict();
  let argumentsValue: z.infer<typeof argumentSchema>;
  let authorityBundle: PostgresReviewedPricePromotionAuthorityBundle;
  let historicalPhysicalIdentitySha256: string;
  let migrationReceipt: PostgresMigrationReceipt;
  let privateInput: PostgresReviewedPricePromotionPrivateInput;
  try {
    argumentsValue = parseOrFail(argumentSchema, {
      candidateSha: input.candidateSha,
      expectedAuthorityBundleSha256: input.expectedAuthorityBundleSha256,
      expectedEnvironment: input.expectedEnvironment,
      expectedDeployment: input.expectedDeployment,
      expectedMigration: input.expectedMigration,
      migrationTargetIdentity: input.migrationTargetIdentity,
      expectedPhysicalDatabaseIdentitySha256:
        input.expectedPhysicalDatabaseIdentitySha256,
      expectedPrivateInputSha256: input.expectedPrivateInputSha256,
    });
    historicalPhysicalIdentitySha256 = physicalDatabaseIdentityDigest(
      argumentsValue.migrationTargetIdentity,
      "argument_invalid",
    );
    migrationReceipt = canonicalMigrationReceipt(input.migrationReceipt);
    if (
      sha256PostgresReviewedPricePromotionValue(migrationReceipt)
      !== argumentsValue.expectedMigration.receiptFileSha256
    ) fail("migration_mismatch");
    privateInput = canonicalPrivateInput(input.privateInput);
    if (
      sha256PostgresReviewedPricePromotionValue(privateInput)
      !== argumentsValue.expectedPrivateInputSha256
    ) fail("private_input_mismatch");
    authorityBundle = canonicalAuthorityBundle(input.authorityBundle);
    if (
      sha256PostgresReviewedPricePromotionValue(authorityBundle)
        !== argumentsValue.expectedAuthorityBundleSha256
      || authorityBundle.candidateSha !== argumentsValue.candidateSha
      || authorityBundle.expectedEnvironment !== argumentsValue.expectedEnvironment
      || authorityBundle.privateInputManifestSha256
        !== argumentsValue.expectedPrivateInputSha256
      || authorityBundle.targetProfile.deploymentAttestationFileSha256
        !== argumentsValue.expectedDeployment.attestationFileSha256
      || authorityBundle.targetProfile.physicalDatabaseIdentitySha256
        !== argumentsValue.expectedPhysicalDatabaseIdentitySha256
      || authorityBundle.targetProfile.railwayEnvironmentIdSha256
        !== argumentsValue.expectedDeployment.environmentIdSha256
      || authorityBundle.targetProfile.railwayProjectIdSha256
        !== argumentsValue.expectedDeployment.projectIdSha256
      || authorityBundle.targetProfile.railwayServiceIdSha256
        !== argumentsValue.expectedDeployment.serviceIdSha256
    ) fail("authority_mismatch");
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("argument_invalid");
  }

  let inspect: () => Promise<PostgresReviewedPricePromotionPlanArtifacts>;
  try {
    inspect = database.transaction(async () => {
    assertPlanIntrinsicSurfacesExact();
    await database.exec(POSTGRES_REVIEWED_PRICE_PROMOTION_READ_ONLY_TRANSACTION);
    await database.exec(POSTGRES_REVIEWED_PRICE_PROMOTION_SEARCH_PATH);
    await database.exec(POSTGRES_REVIEWED_PRICE_PROMOTION_ROW_SECURITY);

    const identity = exactIdentityRow(await database
      .prepare(POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY)
      .get<IdentityRow>());
    assertSafeIdentity(identity);
    const physicalIdentitySha256 = physicalDatabaseIdentityDigest(
      identity,
      "identity_mismatch",
    );
    if (
      physicalIdentitySha256
        !== argumentsValue.expectedPhysicalDatabaseIdentitySha256
      || historicalPhysicalIdentitySha256
        !== argumentsValue.expectedPhysicalDatabaseIdentitySha256
    ) {
      fail("identity_mismatch");
    }
    const plannerLoginIdentitySha256 = plannerLoginIdentityDigest(identity);

    const metadataRows = exactRowArray(
      metadataRowSchema,
      await database.prepare(`/* pintpath:reviewed-price-plan:metadata */
      SELECT key, value
      FROM ${APPLICATION_SCHEMA}.schema_metadata
      ORDER BY key COLLATE "C"
      LIMIT ${EXPECTED_METADATA_KEYS.length + 1}`).all<MetadataRow>(),
      METADATA_ROW_KEYS,
      EXPECTED_METADATA_KEYS.length + 1,
      "migration_mismatch",
    );
    const metadata = exactMetadata(metadataRows);

    const migrationRows = exactRowArray(
      migrationRunRowSchema,
      await database.prepare(`/* pintpath:reviewed-price-plan:migration-run */
      SELECT
        run_id AS "runId",
        source_snapshot_sha256 AS "sourceSnapshotSha256",
        source_schema_fingerprint AS "sourceSchemaFingerprint",
        contract_sha256 AS "contractSha256",
        manifest_sha256 AS "manifestSha256",
        target_ddl_sha256 AS "targetDdlSha256",
        source_schema_version AS "sourceSchemaVersion",
        candidate_commit_sha AS "candidateSha",
        target_binding_sha256 AS "targetBindingSha256",
        expected_environment AS "expectedEnvironment",
        approval_reference_sha256 AS "approvalReferenceSha256",
        operator_id_sha256 AS "operatorIdSha256",
        status,
        started_at AS "startedAt",
        completed_at AS "completedAt",
        verifier_id_sha256 AS "verifierIdSha256",
        receipt_sha256 AS "receiptSha256",
        failure_code AS "failureCode"
      FROM ${OPERATIONS_SCHEMA}.migration_runs
      ORDER BY run_id COLLATE "C"
      LIMIT 2`).all<MigrationRunRow>(),
      MIGRATION_RUN_KEYS,
      2,
      "migration_mismatch",
    );
    if (migrationRows.length !== 1) fail("migration_mismatch");
    const migration = migrationRows[0];
    validateMigration(
      migration,
      metadata,
      migrationReceipt,
      argumentsValue.migrationTargetIdentity,
      identity,
      argumentsValue.expectedEnvironment,
      argumentsValue.candidateSha,
    );

    const ids = denseArrayMap(
      privateInput.items,
      (item) => item.sourceIngestionId,
    );
    const queueRows = exactRowArray(
      queueRowSchema,
      await database.prepare(`/* pintpath:reviewed-price-plan:queue */
      SELECT
        id,
        venue_id AS "venueId",
        venue_name AS "venueName",
        source_type AS "sourceType",
        source_url AS "sourceUrl",
        image_retention_expires_at AS "imageRetentionExpiresAt",
        image_redacted_at AS "imageRedactedAt",
        image_redaction_reason AS "imageRedactionReason",
        note,
        status,
        review_claim_token AS "reviewClaimToken",
        review_claimed_at AS "reviewClaimedAt",
        venue_name_guess AS "venueNameGuess",
        captured_notes AS "capturedNotes",
        overall_confidence AS "overallConfidence",
        extracted_beers_json AS "extractedBeersJson",
        review_beers_json AS "reviewBeersJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        published_at AS "publishedAt",
        rejected_at AS "rejectedAt"
      FROM ${APPLICATION_SCHEMA}.admin_ingestion_queue
      WHERE id = ANY (?::text[])
      ORDER BY id COLLATE "C"
      LIMIT ${MAX_ITEMS + 1}`).all<QueueRow>(ids),
      QUEUE_ROW_KEYS,
      MAX_ITEMS + 1,
      "source_mismatch",
    );
    if (
      queueRows.length !== ids.length
      || denseArraySome(queueRows, (row, index) => row.id !== ids[index])
    ) {
      fail("source_mismatch");
    }

    const selectedById = REFLECT_CONSTRUCT(MAP_CONSTRUCTOR, []) as Map<
      string,
      AdminBeerInput[]
    >;
    for (let index = 0; index < queueRows.length; index += 1) {
      const row = queueRows[index];
      if (!row) fail("source_mismatch");
      mapSet(selectedById, row.id, selectedSourceBeers(row));
    }
    assertPlanIntrinsicSurfacesExact();
    const privateById = REFLECT_CONSTRUCT(MAP_CONSTRUCTOR, []) as Map<
      string,
      PostgresReviewedPricePromotionPrivateInput["items"][number]
    >;
    for (let index = 0; index < privateInput.items.length; index += 1) {
      const item = privateInput.items[index];
      if (!item) fail("private_input_mismatch");
      mapSet(privateById, item.sourceIngestionId, item);
    }
    for (let index = 0; index < queueRows.length; index += 1) {
      const row = queueRows[index];
      if (!row) fail("source_mismatch");
      const authority = mapGet(privateById, row.id);
      if (
        !authority
        || authority.venueIdSha256
          !== sha256PostgresReviewedPricePromotionIdentity("venue-id", row.venueId)
        || authority.evidenceReferenceSha256
          !== sha256PostgresReviewedPricePromotionIdentity(
            "evidence-reference",
            `source-ingestion:${row.id}`,
          )
      ) fail("private_input_mismatch");
    }

    const venueIds = denseStringSort(denseArrayMap(queueRows, (row) => row.venueId));
    if (uniqueStringCount(venueIds) !== venueIds.length) fail("private_input_mismatch");
    const profiles = exactRowArray(
      venueProfileRowSchema,
      await database.prepare(`/* pintpath:reviewed-price-plan:profiles */
      SELECT
        venue_id AS "venueId",
        name,
        address,
        suburb,
        area,
        active,
        updated_at AS "updatedAt"
      FROM ${APPLICATION_SCHEMA}.venue_profiles
      WHERE venue_id = ANY (?::text[])
      ORDER BY venue_id COLLATE "C"
      LIMIT ${MAX_ITEMS + 1}`).all<VenueProfileRow>(venueIds),
      VENUE_PROFILE_ROW_KEYS,
      MAX_ITEMS + 1,
      "source_mismatch",
    );
    if (profiles.length !== venueIds.length) fail("source_mismatch");
    const profileByVenue = REFLECT_CONSTRUCT(MAP_CONSTRUCTOR, []) as Map<
      string,
      VenueProfileRow
    >;
    for (let index = 0; index < profiles.length; index += 1) {
      const profile = profiles[index];
      if (!profile) fail("source_mismatch");
      mapSet(profileByVenue, profile.venueId, profile);
    }
    for (let index = 0; index < queueRows.length; index += 1) {
      const queue = queueRows[index];
      if (!queue) fail("source_mismatch");
      const profile = mapGet(profileByVenue, queue.venueId);
      if (
        !profile
        || profile.active !== true
        || profile.suburb === null
        || lowercase(normalizeHumanText(profile.suburb))
          !== lowercase(privateInput.marketedSuburb)
        || normalizeHumanText(profile.name) !== normalizeHumanText(queue.venueName)
      ) fail("source_mismatch");
    }

    const catalogKeySet = REFLECT_CONSTRUCT(SET_CONSTRUCTOR, []) as Set<string>;
    const unsortedCatalogKeys = new ARRAY_CONSTRUCTOR<string>();
    let catalogKeyCount = 0;
    for (let queueIndex = 0; queueIndex < queueRows.length; queueIndex += 1) {
      const queue = queueRows[queueIndex];
      if (!queue) fail("catalog_mismatch");
      const beers = mapGet(selectedById, queue.id);
      if (!beers) fail("catalog_mismatch");
      for (let beerIndex = 0; beerIndex < beers.length; beerIndex += 1) {
        const beer = beers[beerIndex];
        if (!beer) fail("catalog_mismatch");
        const key = normalizeBeerKey(beer.name);
        if (!setHas(catalogKeySet, key)) {
          REFLECT_APPLY(SET_ADD, catalogKeySet, [key]);
          defineDenseArrayValue(unsortedCatalogKeys, catalogKeyCount, key);
          catalogKeyCount += 1;
        }
      }
    }
    const catalogKeys = denseStringSort(unsortedCatalogKeys);
    if (catalogKeys.length === 0 || catalogKeys.length > MAX_CATALOG_KEYS) fail("catalog_mismatch");
    const catalogRows = exactRowArray(
      catalogRowSchema,
      await database.prepare(`/* pintpath:reviewed-price-plan:catalog */
      SELECT
        alias.alias_key AS "aliasKey",
        alias.alias,
        item.key AS "itemKey",
        item.name AS "itemName",
        item.brewery,
        item.style,
        item.abv,
        item.status,
        item.source,
        item.updated_at AS "updatedAt"
      FROM ${APPLICATION_SCHEMA}.beer_catalog_aliases AS alias
      JOIN ${APPLICATION_SCHEMA}.beer_catalog_items AS item ON item.key = alias.beer_key
      WHERE alias.alias_key = ANY (?::text[])
      ORDER BY alias.alias_key COLLATE "C", item.key COLLATE "C"
      LIMIT ${MAX_CATALOG_KEYS + 1}`).all<CatalogRow>(catalogKeys),
      CATALOG_ROW_KEYS,
      MAX_CATALOG_KEYS + 1,
      "catalog_mismatch",
    );
    if (catalogRows.length > catalogKeys.length) fail("catalog_mismatch");
    const catalogByAlias = REFLECT_CONSTRUCT(MAP_CONSTRUCTOR, []) as Map<string, CatalogRow>;
    for (let index = 0; index < catalogRows.length; index += 1) {
      const row = catalogRows[index];
      if (!row) fail("catalog_mismatch");
      if (
        mapHas(catalogByAlias, row.aliasKey)
        || row.status !== "active"
        || row.aliasKey !== normalizeBeerKey(row.alias)
      ) fail("catalog_mismatch");
      mapSet(catalogByAlias, row.aliasKey, row);
    }
    if (denseArraySome(catalogKeys, (key) => !mapHas(catalogByAlias, key))) {
      fail("catalog_mismatch");
    }

    const priceConflict = exactPresenceRow(await database.prepare(`/* pintpath:reviewed-price-plan:price-conflicts */
      SELECT EXISTS (
        SELECT 1
        FROM ${APPLICATION_SCHEMA}.venue_price_records
        WHERE source_ingestion_id = ANY (?::text[])
           OR (venue_id = ANY (?::text[]) AND confidence = ANY (?::text[]))
      ) AS "present"`).get<PresenceRow>(
        ids,
        venueIds,
        TRUSTED_PUBLIC_CONFIDENCE,
      ));
    const venueBeerConflict = exactPresenceRow(await database.prepare(`/* pintpath:reviewed-price-plan:venue-beer-conflicts */
      SELECT EXISTS (
        SELECT 1 FROM ${APPLICATION_SCHEMA}.venue_beers
        WHERE venue_id = ANY (?::text[])
      ) AS "present"`).get<PresenceRow>(venueIds));
    if (priceConflict.present || venueBeerConflict.present) fail("public_conflict");

    const rawWrongPrices = await database.prepare(`/* pintpath:reviewed-price-plan:wrong-prices */
      SELECT
        id,
        venue_id AS "venueId",
        price_record_id AS "priceRecordId",
        beer_name AS "beerName",
        reason,
        notes,
        source_photo_url AS "sourcePhotoUrl",
        status,
        assigned_to AS "assignedTo",
        resolution_note AS "resolutionNote",
        resolved_at AS "resolvedAt",
        resolved_by AS "resolvedBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM ${APPLICATION_SCHEMA}.wrong_price_reports
      WHERE venue_id = ANY (?::text[])
      ORDER BY venue_id COLLATE "C", created_at, id COLLATE "C"
      LIMIT ${MAX_WRONG_PRICE_ROWS + 1}`).all<WrongPriceRow>(venueIds);
    const wrongPrices = exactWrongPriceRows(rawWrongPrices, venueIds);
    const openWrongPriceCount = denseArrayCount(
      wrongPrices,
      (row) => reviewedPriceWrongPriceStatusBlocksPromotion(row.status),
    );
    if (openWrongPriceCount > 0) fail("wrong_price_open");
    const resolvedCount = denseArrayCount(wrongPrices, (row) => row.status === "resolved");
    const rejectedCount = denseArrayCount(wrongPrices, (row) => row.status === "rejected");
    const wrongPriceSanitized = denseArrayMap(wrongPrices, sanitizedConflictRow);

    const sourceItems = denseArrayMap(queueRows, (queue) => {
      const selected = mapGet(selectedById, queue.id);
      const profile = mapGet(profileByVenue, queue.venueId);
      if (!selected || !profile) fail("source_mismatch");
      const catalog = denseArrayMap(selected, (beer) => {
        const row = mapGet(catalogByAlias, normalizeBeerKey(beer.name));
        if (!row) fail("catalog_mismatch");
        return {
          abv: exactNumeric(row.abv),
          aliasKeySha256: nullableDigest("catalog-alias-key", row.aliasKey),
          aliasSha256: nullableDigest("catalog-alias", row.alias),
          brewerySha256: nullableDigest("catalog-brewery", row.brewery),
          itemKeySha256: nullableDigest("catalog-item-key", row.itemKey),
          itemNameSha256: nullableDigest("catalog-item-name", row.itemName),
          source: row.source,
          status: row.status,
          styleSha256: nullableDigest("catalog-style", row.style),
          updatedAt: row.updatedAt,
        };
      });
      const queueAuthority = queueSnapshot(queue, selected);
      return {
        catalogRowsSha256: sha256PostgresReviewedPricePromotionValue(catalog),
        queueSnapshotSha256: sha256PostgresReviewedPricePromotionValue(queueAuthority),
        selectedRowCount: selected.length,
        selectedRowsSha256: sha256PostgresReviewedPricePromotionValue(selected),
        sourceIngestionId: queue.id,
        venueIdSha256: sha256PostgresReviewedPricePromotionIdentity("venue-id", queue.venueId),
        venueProfileSha256: sha256PostgresReviewedPricePromotionValue({
          active: profile.active,
          addressSha256: nullableDigest("profile-address", profile.address),
          areaSha256: nullableDigest("profile-area", profile.area),
          nameSha256: nullableDigest("profile-name", profile.name),
          suburbSha256: nullableDigest("profile-suburb", profile.suburb),
          updatedAt: profile.updatedAt,
          venueIdSha256: sha256PostgresReviewedPricePromotionIdentity("venue-id", profile.venueId),
        }),
      };
    });
    const publicConflicts = {
      priceRecordCount: 0,
      rowsSha256: sha256PostgresReviewedPricePromotionValue([]),
      venueBeerCount: 0,
    };
    const wrongPriceReports = {
      blockingCount: openWrongPriceCount,
      blockingStatuses: denseArrayMap(
        REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES,
        (status) => status,
      ) as [
        typeof REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES[0],
        typeof REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES[1],
      ],
      openOrInProgressCount: openWrongPriceCount,
      policySha256: REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
      rejectedCount,
      resolvedCount,
      rowsSha256: sha256PostgresReviewedPricePromotionValue(wrongPriceSanitized),
      totalCount: wrongPrices.length,
    };
    const sourceSnapshotWithoutCombined = {
      items: sourceItems,
      publicConflicts,
      selectionPolicySha256: REVIEWED_PRICE_SELECTION_POLICY_SHA256,
      wrongPriceReports,
    };
    const sourceSnapshotCombinedSha256 =
      sha256PostgresReviewedPricePromotionValue(sourceSnapshotWithoutCombined);

    const venueBeerIds = REFLECT_CONSTRUCT(SET_CONSTRUCTOR, []) as Set<string>;
    let reviewRowCount = 0;
    const reviewItems = denseArrayMap(queueRows, (queue) => {
      const selected = mapGet(selectedById, queue.id);
      const profile = mapGet(profileByVenue, queue.venueId);
      const privateItem = mapGet(privateById, queue.id);
      if (!selected || !profile || !privateItem || profile.suburb === null) {
        fail("source_mismatch");
      }
      const evidenceReference = `source-ingestion:${queue.id}`;
      const rows = denseArrayMap(selected, (beer, ordinal) => {
        const catalog = mapGet(catalogByAlias, normalizeBeerKey(beer.name));
        if (
          !catalog
          || beer.priceNumeric === null
          || !NUMBER_IS_FINITE(beer.priceNumeric)
        ) fail("catalog_mismatch");
        const venueBeerId = `admin-reviewed:${queue.venueId}`
          + `:${recordIdSegment(catalog.itemKey)}:${beer.servingSize}`;
        if (setHas(venueBeerIds, venueBeerId)) fail("catalog_mismatch");
        REFLECT_APPLY(SET_ADD, venueBeerIds, [venueBeerId]);
        reviewRowCount += 1;
        return {
          ordinal,
          priceRecord: {
            beerName: catalog.itemName,
            confidence: "admin_verified" as const,
            happyHourDetails: null,
            id: `source-ingestion:${queue.id}:${ordinal}`,
            isHappyHourPrice: false as const,
            isOnTap: "yes" as const,
            normalizedBeerId: catalog.itemKey,
            price: beer.priceNumeric,
            servingSize: "pint" as const,
            sourceEvidenceReference: evidenceReference,
            sourceIngestionId: queue.id,
            sourceSubmissionId: null,
            sourceType: "source_ingestion" as const,
            suburb: profile.suburb,
            venueId: queue.venueId,
            venueName: profile.name,
          },
          venueBeer: {
            abv: exactNumeric(catalog.abv),
            beerName: catalog.itemName,
            brewery: catalog.brewery,
            currency: "AUD" as const,
            id: venueBeerId,
            inStock: true as const,
            normalizedBeerId: catalog.itemKey,
            notes: "Published from admin source review." as const,
            onTap: true as const,
            price: beer.priceNumeric,
            serveSize: "pint" as const,
            sourceIngestionId: queue.id,
            style: catalog.style,
            venueId: queue.venueId,
          },
        };
      });
      return {
        evidenceContentSha256: privateItem.evidenceContentSha256,
        evidenceReference,
        evidenceReferenceSha256: privateItem.evidenceReferenceSha256,
        rows,
        sourceIngestionId: queue.id,
        venue: {
          address: profile.address,
          area: profile.area,
          id: profile.venueId,
          name: profile.name,
          suburb: profile.suburb,
        },
      };
    });
    const targetProfileSha256 = sha256PostgresReviewedPricePromotionValue(
      authorityBundle.targetProfile,
    );
    const reviewPacket = finalizePostgresReviewedPricePromotionReviewPacket({
      authorityBundleSha256: argumentsValue.expectedAuthorityBundleSha256,
      candidateSha: argumentsValue.candidateSha,
      expectedEnvironment: argumentsValue.expectedEnvironment,
      expiresAt: authorityBundle.expiresAt,
      generatedAt: authorityBundle.generatedAt,
      itemCount: privateInput.itemCount,
      items: reviewItems,
      kind: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
      marketedSuburb: privateInput.marketedSuburb,
      mutationEnabled: false,
      privateInputManifestSha256: argumentsValue.expectedPrivateInputSha256,
      rowCount: reviewRowCount,
      sourceSnapshotSha256: sourceSnapshotCombinedSha256,
      targetPhysicalIdentitySha256: physicalIdentitySha256,
      targetProfileSha256,
      temporalPolicy: "single-apply-transaction-timestamp",
      version: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
      wrongPricePolicySha256: REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
    });

    const roleSafety = {
      authorityQuerySha256: sha256PostgresMigrationBytes(
        POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY,
      ),
      requiredColumnCount: identity.requiredColumnCount,
      requiredRelationCount: identity.requiredRelationCount,
      roleAuthorityValid: identity.roleAuthorityValid,
      searchPathSchemas: identity.searchPathSchemas,
      transactionIsolation: identity.transactionIsolation,
      transactionReadOnly: identity.transactionReadOnly,
    };
    const evidenceSet = denseArrayMap(privateInput.items, (item) => ({
      evidenceContentSha256: item.evidenceContentSha256,
      evidenceReferenceSha256: item.evidenceReferenceSha256,
      sourceIngestionId: item.sourceIngestionId,
      venueIdSha256: item.venueIdSha256,
    }));
    const withoutHash = {
      activationBlockers: denseArrayMap(
        POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
        (blocker) => blocker,
      ) as [
        typeof POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[0],
        typeof POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[1],
        typeof POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[2],
        typeof POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[3],
        typeof POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[4],
        typeof POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[5],
        typeof POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS[6],
      ],
      authority: {
        authorityBundleSha256: argumentsValue.expectedAuthorityBundleSha256,
        authorityMode: authorityBundle.authorityMode,
        evidenceReferencesSha256: sha256PostgresReviewedPricePromotionValue(
          authorityBundle.evidenceReferences,
        ),
        expiresAt: authorityBundle.expiresAt,
        generatedAt: authorityBundle.generatedAt,
        mutationAuthorized: false as const,
        providerAuthorityObserved: false as const,
        recoveryReferencesSha256: sha256PostgresReviewedPricePromotionValue(
          authorityBundle.recoveryReferences,
        ),
        reviewBindingsSha256: sha256PostgresReviewedPricePromotionValue(
          authorityBundle.reviewBindings,
        ),
        supabaseProjectIdentitySha256:
          authorityBundle.targetProfile.supabaseProjectIdentitySha256,
        targetProfileSha256,
      },
      candidateSha: argumentsValue.candidateSha,
      expectedEnvironment: argumentsValue.expectedEnvironment,
      expectedDeployment: argumentsValue.expectedDeployment,
      kind: POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
      migration: {
        approvalReferenceSha256: migration.approvalReferenceSha256,
        completedAt: migration.completedAt,
        contractSha256: migration.contractSha256,
        manifestSha256: migration.manifestSha256,
        operatorIdSha256: migration.operatorIdSha256,
        planSha256: migrationReceipt.planSha256,
        receiptFileSha256: argumentsValue.expectedMigration.receiptFileSha256,
        receiptSha256: migration.receiptSha256,
        runId: migration.runId,
        runSnapshotSha256: sha256PostgresReviewedPricePromotionValue(migration),
        schemaMetadataSha256: migrationReceipt.schemaMetadataSha256,
        sourceSchemaFingerprint: migration.sourceSchemaFingerprint,
        sourceSchemaSha256: metadata.source_schema_sha256!,
        sourceSchemaVersion: migration.sourceSchemaVersion,
        sourceSnapshotSha256: migration.sourceSnapshotSha256,
        startedAt: migration.startedAt,
        targetBindingSha256: migration.targetBindingSha256,
        targetDdlSha256: migration.targetDdlSha256,
        verifierIdSha256: migration.verifierIdSha256,
      },
      mutationEnabled: false as const,
      privateInput: {
        evidenceSetSha256: sha256PostgresReviewedPricePromotionValue(evidenceSet),
        itemCount: privateInput.itemCount,
        manifestSha256: argumentsValue.expectedPrivateInputSha256,
        marketedSuburb: privateInput.marketedSuburb,
      },
      reviewPacket: {
        itemCount: reviewPacket.itemCount,
        reviewPacketCandidateSha256: reviewPacket.reviewPacketCandidateSha256,
        rowCount: reviewPacket.rowCount,
      },
      sourceSnapshot: {
        ...sourceSnapshotWithoutCombined,
        combinedSha256: sourceSnapshotCombinedSha256,
      },
      target: {
        catalogIdentity: {
          currentUserSha256: nullableDigest("postgres-current-user", identity.currentUser)!,
          databaseNameSha256: nullableDigest("postgres-database-name", identity.databaseName)!,
          databaseOidSha256: nullableDigest("postgres-database-oid", identity.databaseOid)!,
          roleSafetySha256: sha256PostgresReviewedPricePromotionValue(roleSafety),
          serverVersionNum: identity.serverVersionNum,
          sessionUserSha256: nullableDigest("postgres-session-user", identity.sessionUser)!,
          systemIdentifierSha256: nullableDigest(
            "postgres-system-identifier",
            identity.systemIdentifier,
          )!,
        },
        physicalIdentitySha256,
        plannerLoginIdentitySha256,
      },
      version: POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION,
    };
    const strictWithoutHash = parseOrFail(planWithoutHashSchema, withoutHash);
    const candidate = postgresReviewedPricePromotionPlanCandidateSchema.parse({
      ...strictWithoutHash,
      planCandidateSha256: sha256PostgresReviewedPricePromotionValue(strictWithoutHash),
    });
    assertPlanIntrinsicSurfacesExact();
    return OBJECT_FREEZE({ plan: candidate, reviewPacket });
    });
    assertPlanIntrinsicSurfacesExact();
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("inspection_invalid");
  }

  try {
    const artifacts = await inspect();
    assertPlanIntrinsicSurfacesExact();
    return artifacts;
  } catch (error) {
    if (error instanceof PostgresReviewedPricePromotionPlanError) throw error;
    return fail("inspection_invalid");
  }
}

export async function buildPostgresReviewedPricePromotionPlanCandidate(
  input: BuildPostgresReviewedPricePromotionPlanInput,
): Promise<PostgresReviewedPricePromotionPlanCandidate> {
  return (await buildPostgresReviewedPricePromotionPlanArtifacts(input)).plan;
}
