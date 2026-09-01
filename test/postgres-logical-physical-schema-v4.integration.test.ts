import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildPostgresLogicalPhysicalSchemaV4Record,
  canonicalizePostgresLogicalPhysicalSchemaV4Record,
  derivePostgresLogicalPhysicalSchemaV4,
  parsePostgresLogicalPhysicalSchemaV4Record,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_COUNTS,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_BYTES,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PORTABLE_SCHEMA_SHA256,
  postgresLogicalPhysicalSchemaV4Internals,
  type PostgresLogicalPhysicalSchemaV4Capture,
  type PostgresLogicalPhysicalSchemaV4CatalogEntry,
  type PostgresLogicalPhysicalSchemaV4CatalogGraph,
  type PostgresLogicalPhysicalSchemaV4Category,
  type PostgresLogicalPhysicalSchemaV4Json,
  type PostgresLogicalPhysicalSchemaV4RoleMapping,
  type PostgresLogicalPhysicalSchemaV4TaggedValue,
} from "../src/lib/postgres-logical-physical-schema-v4.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";
const suffix = `${process.pid}_${crypto.randomBytes(5).toString("hex")}`;
const firstDatabase = `pintpath_physical_v4_first_${suffix}`;
const secondDatabase = `pintpath_physical_v4_second_${suffix}`;
const secondOwner = `pintpath_physical_v4_owner_${suffix}`;
const verifierAuthorityRole = "pintpath_migration_verifier_authority";
const schemaSql = fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8");
const kernelSql = fs.readFileSync(path.resolve(
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
), "utf8");
const redundantPublicAccountIndexMigrationSql = fs.readFileSync(path.resolve(
  "supabase/migrations/20260901122942_remove_redundant_accounts_public_account_index.sql",
), "utf8");

if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredRequired === "true" && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
}

interface CatalogRow extends QueryResultRow {
  readonly identity: string;
  readonly fields: Record<string, PostgresLogicalPhysicalSchemaV4Json>;
}

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be a disposable loopback PostgreSQL URL.`);
  }
  if (!(["postgres:", "postgresql:"].includes(url.protocol))
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username || !url.password || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash || /[\r\n\0]/.test(value)) {
    throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`);
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe_test_identifier");
  return `"${value}"`;
}

function withDatabase(url: URL, database: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result.toString();
}

function scopedRoleNames(databaseOid: string): readonly string[] {
  if (!/^[1-9][0-9]{0,9}$/.test(databaseOid)) throw new Error("unsafe_test_database_oid");
  return [
    `pintpath_logical_backup_d${databaseOid}`,
    `pintpath_reviewed_price_apply_owner_d${databaseOid}`,
    `pintpath_reviewed_price_apply_execute_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`,
  ];
}

function roleTag(value: string, mapping: PostgresLogicalPhysicalSchemaV4RoleMapping): string | PostgresLogicalPhysicalSchemaV4TaggedValue {
  return Object.values(mapping).includes(value)
    && value !== mapping.databaseName && value !== mapping.databaseOid
    ? { tag: "role", value }
    : value;
}

function transformRoleArray(
  value: PostgresLogicalPhysicalSchemaV4Json,
  mapping: PostgresLogicalPhysicalSchemaV4RoleMapping,
): PostgresLogicalPhysicalSchemaV4Json {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => typeof entry === "string" ? roleTag(entry, mapping) : entry);
}

function transformRows(
  category: PostgresLogicalPhysicalSchemaV4Category,
  rows: readonly CatalogRow[],
  mapping: PostgresLogicalPhysicalSchemaV4RoleMapping,
): PostgresLogicalPhysicalSchemaV4CatalogEntry[] {
  const transformed = rows.map((row) => {
    const fields = { ...row.fields };
    let identity: string | PostgresLogicalPhysicalSchemaV4TaggedValue = row.identity;
    for (const key of ["owner", "functionOwner", "role", "grantor", "grantee"] as const) {
      if (typeof fields[key] === "string") fields[key] = roleTag(fields[key], mapping);
    }
    for (const key of ["roles", "membershipsGranted", "membershipsReceived"] as const) {
      if (fields[key]) fields[key] = transformRoleArray(fields[key], mapping);
    }
    if (category === "database") fields.databaseName = { tag: "databaseName", value: mapping.databaseName };
    if (category === "aclEntries" && fields.objectKind === "database"
      && fields.objectIdentity === mapping.databaseName) {
      fields.objectIdentity = { tag: "databaseName", value: mapping.databaseName };
    }
    if (category === "routines" && typeof fields.source === "string"
      && [mapping.applyOwner, mapping.quarantineOwner].some((role) => (fields.source as string).includes(role))) {
      fields.source = { tag: "roleInterpolatedText", value: fields.source };
    }
    if (category === "triggers" && fields.internal === true) {
      const functionOwner = fields.functionOwner;
      const rawFunctionOwner = typeof functionOwner === "string" ? functionOwner
        : functionOwner && typeof functionOwner === "object" && !Array.isArray(functionOwner)
          && typeof functionOwner.value === "string" ? functionOwner.value : "";
      fields.functionOwner = {
        tag: "pgCatalogRoutineOwner",
        value: rawFunctionOwner,
      };
      identity = `${String(fields.relation)}.${String(fields.constraintName)}:${String(fields.function)}:${String(fields.typeBits)}`;
      fields.triggerName = {
        tag: "systemGeneratedForeignKeyTrigger",
        value: String(fields.triggerName),
      };
    }
    if (category === "dependencies") {
      for (const side of ["dependent", "referenced"] as const) {
        const type = fields[`${side}Type`];
        const names = fields[`${side}Names`];
        if (type === "toast table" && Array.isArray(names) && names.length === 2) {
          fields[`${side}Names`] = [names[0]!, {
            tag: "systemGeneratedToastRelation",
            value: String(names[1]),
          }];
        }
        if (type === "trigger" && Array.isArray(names) && names.length === 3
          && typeof names[2] === "string" && /^RI_ConstraintTrigger_[ac]_[1-9][0-9]*$/.test(names[2])) {
          fields[`${side}Names`] = [names[0]!, names[1]!, {
            tag: "systemGeneratedForeignKeyTrigger",
            value: names[2],
          }];
        }
      }
    }
    for (const side of ["dependent", "referenced"] as const) {
      if (fields[`${side}Type`] === "role" && Array.isArray(fields[`${side}Names`])) {
        fields[`${side}Names`] = transformRoleArray(fields[`${side}Names`], mapping);
      }
    }
    if (category === "database") identity = { tag: "databaseName", value: mapping.databaseName };
    if (category === "roles") identity = { tag: "role", value: row.identity };
    return { identity, fields };
  });
  if (!["aclEntries", "dependencies", "sharedDependencies"].includes(category)) return transformed;
  const canonical = postgresLogicalPhysicalSchemaV4Internals.canonicalJson;
  return transformed
    .map((entry) => ({
      entry,
      portableKey: canonical(postgresLogicalPhysicalSchemaV4Internals.normalizeTaggedValue(
        entry.fields,
        mapping,
      )),
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.portableKey), Buffer.from(right.portableKey)))
    .map(({ entry }, index) => ({
      ...entry,
      identity: `${category}:${String(index).padStart(4, "0")}`,
    }));
}

const CATEGORY_SQL: Readonly<Record<PostgresLogicalPhysicalSchemaV4Category, string>> = {
  database: `SELECT pg_catalog.current_database() AS identity,
    pg_catalog.jsonb_build_object(
      'databaseName', pg_catalog.current_database(), 'owner', owner.rolname,
      'aclIsNull', database.datacl IS NULL
    ) AS fields
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
    WHERE database.datname = pg_catalog.current_database()`,
  schemas: `SELECT namespace.nspname AS identity,
    pg_catalog.jsonb_build_object(
      'schemaName', namespace.nspname, 'owner', owner.rolname,
      'aclIsNull', namespace.nspacl IS NULL
    ) AS fields
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = namespace.nspowner
    WHERE namespace.nspname = ANY(ARRAY['pintpath_app','pintpath_ops'])
    ORDER BY namespace.nspname COLLATE pg_catalog."C"`,
  relations: `SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname) AS identity,
    pg_catalog.jsonb_build_object(
      'schemaName', namespace.nspname, 'relationName', relation.relname, 'owner', owner.rolname,
      'kind', relation.relkind, 'persistence', relation.relpersistence,
      'rowSecurity', relation.relrowsecurity, 'forceRowSecurity', relation.relforcerowsecurity,
      'isPartition', relation.relispartition, 'accessMethod', access_method.amname,
      'tablespace', CASE WHEN relation.reltablespace = 0 THEN '$database_default' ELSE tablespace.spcname END,
      'replicaIdentity', relation.relreplident, 'options', pg_catalog.to_jsonb(relation.reloptions),
      'partitionBound', pg_catalog.pg_get_expr(relation.relpartbound, relation.oid, false),
      'checkCount', relation.relchecks, 'hasRules', relation.relhasrules,
      'hasTriggers', relation.relhastriggers, 'hasSubclass', relation.relhassubclass,
      'hasToastRelation', relation.reltoastrelid <> 0, 'aclIsNull', relation.relacl IS NULL
    ) AS fields
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = relation.relowner
    JOIN pg_catalog.pg_am AS access_method ON access_method.oid = relation.relam
    LEFT JOIN pg_catalog.pg_tablespace AS tablespace ON tablespace.oid = relation.reltablespace
    WHERE namespace.nspname = ANY(ARRAY['pintpath_app','pintpath_ops']) AND relation.relkind = 'r'
    ORDER BY namespace.nspname COLLATE pg_catalog."C", relation.relname COLLATE pg_catalog."C"`,
  columns: `SELECT pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname) AS identity,
    pg_catalog.jsonb_build_object(
      'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
      'ordinal', attribute.attnum, 'columnName', attribute.attname,
      'formattedType', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
      'typeSchema', type_namespace.nspname, 'typeName', type_object.typname,
      'typeKind', type_object.typtype, 'typeCategory', type_object.typcategory,
      'dimensions', attribute.attndims, 'notNull', attribute.attnotnull,
      'hasDefault', attribute.atthasdef,
      'defaultExpression', pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false),
      'generated', attribute.attgenerated, 'identity', attribute.attidentity,
      'collation', CASE WHEN attribute.attcollation = 0 THEN NULL
        ELSE pg_catalog.format('%I.%I', collation_namespace.nspname, collation_object.collname) END,
      'storage', attribute.attstorage, 'compression', attribute.attcompression,
      'statisticsTarget', attribute.attstattarget, 'options', pg_catalog.to_jsonb(attribute.attoptions),
      'foreignOptions', pg_catalog.to_jsonb(attribute.attfdwoptions),
      'inheritanceCount', attribute.attinhcount, 'isLocal', attribute.attislocal,
      'hasMissingValue', attribute.atthasmissing, 'missingValue', attribute.attmissingval::pg_catalog.text,
      'aclIsNull', attribute.attacl IS NULL
    ) AS fields
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_type AS type_object ON type_object.oid = attribute.atttypid
    JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = type_object.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
    LEFT JOIN pg_catalog.pg_collation AS collation_object ON collation_object.oid = attribute.attcollation
    LEFT JOIN pg_catalog.pg_namespace AS collation_namespace ON collation_namespace.oid = collation_object.collnamespace
    WHERE namespace.nspname = ANY(ARRAY['pintpath_app','pintpath_ops']) AND relation.relkind = 'r'
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
    ORDER BY namespace.nspname COLLATE pg_catalog."C", relation.relname COLLATE pg_catalog."C", attribute.attnum`,
  constraints: `SELECT pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, constraint_object.conname) AS identity,
    pg_catalog.jsonb_build_object(
      'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
      'constraintName', constraint_object.conname, 'constraintType', constraint_object.contype,
      'definition', pg_catalog.pg_get_constraintdef(constraint_object.oid, false),
      'validated', constraint_object.convalidated, 'deferrable', constraint_object.condeferrable,
      'initiallyDeferred', constraint_object.condeferred, 'noInherit', constraint_object.connoinherit,
      'parentConstraint', CASE WHEN parent_constraint.oid IS NULL THEN NULL ELSE
        pg_catalog.format('%I.%I.%I', parent_namespace.nspname, parent_relation.relname, parent_constraint.conname) END,
      'inheritanceCount', constraint_object.coninhcount, 'isLocal', constraint_object.conislocal,
      'columns', pg_catalog.to_jsonb(constraint_object.conkey::pg_catalog.int2[]),
      'referencedRelation', CASE WHEN referenced_relation.oid IS NULL THEN NULL ELSE
        pg_catalog.format('%I.%I', referenced_namespace.nspname, referenced_relation.relname) END,
      'referencedColumns', pg_catalog.to_jsonb(constraint_object.confkey::pg_catalog.int2[]),
      'indexName', CASE WHEN index_relation.oid IS NULL THEN NULL ELSE
        pg_catalog.format('%I.%I', index_namespace.nspname, index_relation.relname) END,
      'foreignUpdateAction', constraint_object.confupdtype,
      'foreignDeleteAction', constraint_object.confdeltype,
      'foreignMatchType', constraint_object.confmatchtype, 'period', false
    ) AS fields
    FROM pg_catalog.pg_constraint AS constraint_object
    JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_object.conrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_constraint AS parent_constraint ON parent_constraint.oid = constraint_object.conparentid
    LEFT JOIN pg_catalog.pg_class AS parent_relation ON parent_relation.oid = parent_constraint.conrelid
    LEFT JOIN pg_catalog.pg_namespace AS parent_namespace ON parent_namespace.oid = parent_relation.relnamespace
    LEFT JOIN pg_catalog.pg_class AS referenced_relation ON referenced_relation.oid = constraint_object.confrelid
    LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_relation.relnamespace
    LEFT JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = constraint_object.conindid
    LEFT JOIN pg_catalog.pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
    WHERE namespace.nspname = ANY(ARRAY['pintpath_app','pintpath_ops']) AND relation.relkind = 'r'
    ORDER BY namespace.nspname COLLATE pg_catalog."C", relation.relname COLLATE pg_catalog."C", constraint_object.conname COLLATE pg_catalog."C"`,
  indexes: `SELECT pg_catalog.format('%I.%I', namespace.nspname, index_relation.relname) AS identity,
    pg_catalog.jsonb_build_object(
      'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
      'indexName', index_relation.relname, 'owner', owner.rolname, 'accessMethod', access_method.amname,
      'persistence', index_relation.relpersistence,
      'tablespace', CASE WHEN index_relation.reltablespace = 0 THEN '$database_default' ELSE tablespace.spcname END,
      'options', pg_catalog.to_jsonb(index_relation.reloptions), 'unique', index_object.indisunique,
      'nullsNotDistinct', index_object.indnullsnotdistinct, 'primary', index_object.indisprimary,
      'exclusion', index_object.indisexclusion, 'immediate', index_object.indimmediate,
      'clustered', index_object.indisclustered, 'valid', index_object.indisvalid,
      'checkXmin', index_object.indcheckxmin, 'ready', index_object.indisready,
      'live', index_object.indislive, 'replicaIdentity', index_object.indisreplident,
      'keyAttributeCount', index_object.indnkeyatts, 'attributeCount', index_object.indnatts,
      'keyColumns', (SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(index_relation.oid, ordinal, true)
        ORDER BY ordinal) FROM pg_catalog.generate_series(1, index_object.indnatts) AS ordinal),
      'collations', (SELECT pg_catalog.jsonb_agg(CASE WHEN collation_oid = 0 THEN NULL ELSE
          pg_catalog.format('%I.%I', collation_namespace.nspname, collation_object.collname) END ORDER BY ordinal)
        FROM pg_catalog.unnest(index_object.indcollation::pg_catalog.oid[]) WITH ORDINALITY AS item(collation_oid, ordinal)
        LEFT JOIN pg_catalog.pg_collation AS collation_object ON collation_object.oid = item.collation_oid
        LEFT JOIN pg_catalog.pg_namespace AS collation_namespace ON collation_namespace.oid = collation_object.collnamespace),
      'operatorClasses', (SELECT pg_catalog.jsonb_agg(pg_catalog.format('%I.%I', opclass_namespace.nspname,
          opclass.opcname) ORDER BY ordinal)
        FROM pg_catalog.unnest(index_object.indclass::pg_catalog.oid[]) WITH ORDINALITY AS item(opclass_oid, ordinal)
        JOIN pg_catalog.pg_opclass AS opclass ON opclass.oid = item.opclass_oid
        JOIN pg_catalog.pg_namespace AS opclass_namespace ON opclass_namespace.oid = opclass.opcnamespace),
      'optionsBits', pg_catalog.to_jsonb(index_object.indoption::pg_catalog.int2[]),
      'predicate', pg_catalog.pg_get_expr(index_object.indpred, index_object.indrelid, false),
      'expressions', pg_catalog.pg_get_expr(index_object.indexprs, index_object.indrelid, false),
      'definition', pg_catalog.pg_get_indexdef(index_relation.oid),
      'isPartition', index_relation.relispartition,
      'parentIndex', CASE WHEN parent_index.oid IS NULL THEN NULL ELSE
        pg_catalog.format('%I.%I', parent_namespace.nspname, parent_index.relname) END
    ) AS fields
    FROM pg_catalog.pg_index AS index_object
    JOIN pg_catalog.pg_class AS relation ON relation.oid = index_object.indrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_object.indexrelid
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = index_relation.relowner
    JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_relation.relam
    LEFT JOIN pg_catalog.pg_tablespace AS tablespace ON tablespace.oid = index_relation.reltablespace
    LEFT JOIN pg_catalog.pg_inherits AS inheritance ON inheritance.inhrelid = index_relation.oid
    LEFT JOIN pg_catalog.pg_class AS parent_index ON parent_index.oid = inheritance.inhparent
    LEFT JOIN pg_catalog.pg_namespace AS parent_namespace ON parent_namespace.oid = parent_index.relnamespace
    WHERE namespace.nspname = ANY(ARRAY['pintpath_app','pintpath_ops']) AND relation.relkind = 'r'
    ORDER BY namespace.nspname COLLATE pg_catalog."C", index_relation.relname COLLATE pg_catalog."C"`,
  triggers: `SELECT pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, trigger_object.tgname) AS identity,
    pg_catalog.jsonb_build_object(
      'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
      'triggerName', trigger_object.tgname,
      'function', pg_catalog.format('%I.%I(%s)', function_namespace.nspname, function_object.proname,
        pg_catalog.pg_get_function_identity_arguments(function_object.oid)),
      'functionOwner', function_owner.rolname, 'internal', trigger_object.tgisinternal,
      'enabled', trigger_object.tgenabled, 'typeBits', trigger_object.tgtype,
      'constraintName', constraint_object.conname,
      'constraintRelation', CASE WHEN constraint_relation.oid IS NULL THEN NULL ELSE
        pg_catalog.format('%I.%I', constraint_namespace.nspname, constraint_relation.relname) END,
      'deferrable', trigger_object.tgdeferrable, 'initiallyDeferred', trigger_object.tginitdeferred,
      'columnNumbers', pg_catalog.to_jsonb(trigger_object.tgattr::pg_catalog.int2[]),
      'argumentsHex', pg_catalog.encode(trigger_object.tgargs, 'hex'),
      'whenExpression', pg_catalog.pg_get_expr(trigger_object.tgqual, trigger_object.tgrelid, false),
      'oldTransitionTable', trigger_object.tgoldtable, 'newTransitionTable', trigger_object.tgnewtable,
      'parentTrigger', CASE WHEN parent_trigger.oid IS NULL THEN NULL ELSE parent_trigger.tgname END
    ) AS fields
    FROM pg_catalog.pg_trigger AS trigger_object
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_object.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS function_object ON function_object.oid = trigger_object.tgfoid
    JOIN pg_catalog.pg_namespace AS function_namespace ON function_namespace.oid = function_object.pronamespace
    JOIN pg_catalog.pg_roles AS function_owner ON function_owner.oid = function_object.proowner
    LEFT JOIN pg_catalog.pg_constraint AS constraint_object ON constraint_object.oid = trigger_object.tgconstraint
    LEFT JOIN pg_catalog.pg_class AS constraint_relation ON constraint_relation.oid = trigger_object.tgconstrrelid
    LEFT JOIN pg_catalog.pg_namespace AS constraint_namespace ON constraint_namespace.oid = constraint_relation.relnamespace
    LEFT JOIN pg_catalog.pg_trigger AS parent_trigger ON parent_trigger.oid = trigger_object.tgparentid
    WHERE namespace.nspname = ANY(ARRAY['pintpath_app','pintpath_ops']) AND relation.relkind = 'r'
    ORDER BY namespace.nspname COLLATE pg_catalog."C", relation.relname COLLATE pg_catalog."C", trigger_object.tgname COLLATE pg_catalog."C"`,
  policies: `SELECT pg_catalog.format('%I.%I.%I', namespace.nspname, relation.relname, policy.polname) AS identity,
    pg_catalog.jsonb_build_object(
      'relation', pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
      'policyName', policy.polname, 'permissive', policy.polpermissive, 'command', policy.polcmd,
      'roles', (SELECT pg_catalog.jsonb_agg(COALESCE(role.rolname, 'PUBLIC')
        ORDER BY COALESCE(role.rolname, 'PUBLIC') COLLATE pg_catalog."C")
        FROM pg_catalog.unnest(policy.polroles) AS role_oid(oid)
        LEFT JOIN pg_catalog.pg_roles AS role ON role.oid = role_oid.oid),
      'usingExpression', pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false),
      'withCheckExpression', pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false)
    ) AS fields
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ANY(ARRAY['pintpath_app','pintpath_ops']) AND relation.relkind = 'r'
    ORDER BY namespace.nspname COLLATE pg_catalog."C", relation.relname COLLATE pg_catalog."C", policy.polname COLLATE pg_catalog."C"`,
  routines: `SELECT pg_catalog.format('%I.%I(%s)', namespace.nspname, routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid)) AS identity,
    pg_catalog.jsonb_build_object(
      'schemaName', namespace.nspname, 'routineName', routine.proname,
      'identityArguments', pg_catalog.pg_get_function_identity_arguments(routine.oid),
      'owner', owner.rolname, 'language', language.lanname, 'kind', routine.prokind,
      'resultType', pg_catalog.pg_get_function_result(routine.oid),
      'argumentTypes', (SELECT pg_catalog.jsonb_agg(pg_catalog.format_type(type_oid, NULL) ORDER BY ordinal)
        FROM pg_catalog.unnest(routine.proargtypes::pg_catalog.oid[]) WITH ORDINALITY AS item(type_oid, ordinal)),
      'allArgumentTypes', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.format_type(type_oid, NULL) ORDER BY ordinal)
        FROM pg_catalog.unnest(routine.proallargtypes) WITH ORDINALITY AS item(type_oid, ordinal)), '[]'::pg_catalog.jsonb),
      'argumentModes', COALESCE(pg_catalog.to_jsonb(routine.proargmodes), '[]'::pg_catalog.jsonb),
      'argumentNames', COALESCE(pg_catalog.to_jsonb(routine.proargnames), '[]'::pg_catalog.jsonb),
      'inputArgumentCount', routine.pronargs, 'argumentDefaultCount', routine.pronargdefaults,
      'argumentDefaults', pg_catalog.pg_get_expr(routine.proargdefaults, 0, false),
      'variadicType', CASE WHEN routine.provariadic = 0 THEN NULL ELSE pg_catalog.format_type(routine.provariadic, NULL) END,
      'transformTypes', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.format_type(type_oid, NULL) ORDER BY ordinal)
        FROM pg_catalog.unnest(routine.protrftypes) WITH ORDINALITY AS item(type_oid, ordinal)), '[]'::pg_catalog.jsonb),
      'securityDefiner', routine.prosecdef, 'leakproof', routine.proleakproof,
      'strict', routine.proisstrict, 'returnsSet', routine.proretset,
      'volatility', routine.provolatile, 'parallel', routine.proparallel,
      'cost', routine.procost::pg_catalog.int4, 'rows', routine.prorows::pg_catalog.int4,
      'supportFunction', CASE WHEN routine.prosupport = 0 THEN NULL ELSE routine.prosupport::pg_catalog.regprocedure::pg_catalog.text END,
      'config', COALESCE(pg_catalog.to_jsonb(routine.proconfig), '[]'::pg_catalog.jsonb),
      'source', routine.prosrc, 'binary', routine.probin,
      'sqlBody', CASE WHEN routine.prosqlbody IS NULL THEN NULL ELSE pg_catalog.pg_get_expr(routine.prosqlbody, 0, false) END,
      'aclIsNull', routine.proacl IS NULL
    ) AS fields
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
    JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
    WHERE namespace.nspname = ANY(ARRAY['pintpath_app','pintpath_ops'])
    ORDER BY namespace.nspname COLLATE pg_catalog."C", routine.proname COLLATE pg_catalog."C",
      pg_catalog.pg_get_function_identity_arguments(routine.oid) COLLATE pg_catalog."C"`,
  roles: `WITH database AS (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
    scoped AS (SELECT pg_catalog.unnest(ARRAY[
      'pintpath_logical_backup_d' || oid::text,
      'pintpath_reviewed_price_apply_owner_d' || oid::text,
      'pintpath_reviewed_price_apply_execute_d' || oid::text,
      'pintpath_reviewed_price_quarantine_owner_d' || oid::text,
      'pintpath_reviewed_price_quarantine_execute_d' || oid::text
    ]) AS role_name FROM database)
    SELECT role.rolname AS identity, pg_catalog.jsonb_build_object(
      'role', role.rolname, 'login', role.rolcanlogin, 'superuser', role.rolsuper,
      'inherit', role.rolinherit, 'createRole', role.rolcreaterole,
      'createDatabase', role.rolcreatedb, 'passwordIsNull', auth.rolpassword IS NULL,
      'replication', role.rolreplication, 'bypassRls', role.rolbypassrls,
      'connectionLimit', role.rolconnlimit,
      'validUntil', CASE WHEN role.rolvaliduntil IS NULL THEN NULL ELSE
        pg_catalog.to_char(role.rolvaliduntil AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
      'membershipsGranted', COALESCE((SELECT pg_catalog.jsonb_agg(granted.rolname ORDER BY granted.rolname COLLATE pg_catalog."C")
        FROM pg_catalog.pg_auth_members AS membership JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
        WHERE membership.member = role.oid), '[]'::pg_catalog.jsonb),
      'membershipsReceived', COALESCE((SELECT pg_catalog.jsonb_agg(member.rolname ORDER BY member.rolname COLLATE pg_catalog."C")
        FROM pg_catalog.pg_auth_members AS membership JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
        WHERE membership.roleid = role.oid), '[]'::pg_catalog.jsonb),
      'settings', COALESCE((SELECT pg_catalog.jsonb_agg(setting.setconfig::text ORDER BY setting.setdatabase,
          setting.setconfig::text COLLATE pg_catalog."C") FROM pg_catalog.pg_db_role_setting AS setting
        WHERE setting.setrole = role.oid), '[]'::pg_catalog.jsonb)
    ) AS fields
    FROM pg_catalog.pg_roles AS role JOIN pg_catalog.pg_authid AS auth ON auth.oid=role.oid
    WHERE role.rolname IN (SELECT role_name FROM scoped)
    ORDER BY role.rolname COLLATE pg_catalog."C"`,
  aclEntries: `WITH private_namespaces AS (
      SELECT oid,nspname,nspowner,nspacl FROM pg_catalog.pg_namespace
      WHERE nspname = ANY(ARRAY['pintpath_app','pintpath_ops'])
    ), private_relations AS (
      SELECT relation.oid,namespace.nspname,relation.relname,relation.relowner,relation.relacl
      FROM pg_catalog.pg_class AS relation JOIN private_namespaces AS namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind = 'r'
    ), private_routines AS (
      SELECT routine.oid,namespace.nspname,routine.proname,routine.proowner,routine.proacl,
        pg_catalog.pg_get_function_identity_arguments(routine.oid) AS args
      FROM pg_catalog.pg_proc AS routine JOIN private_namespaces AS namespace ON namespace.oid = routine.pronamespace
    ), entries AS (
      SELECT 'database'::text object_kind,pg_catalog.current_database() object_identity,privilege.*
      FROM pg_catalog.pg_database AS database CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(database.datacl,pg_catalog.acldefault('d',database.datdba))) AS privilege
      WHERE database.datname=pg_catalog.current_database()
      UNION ALL SELECT 'schema',namespace.nspname,privilege.* FROM private_namespaces AS namespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege WHERE namespace.nspacl IS NOT NULL
      UNION ALL SELECT 'relation',pg_catalog.format('%I.%I',relation.nspname,relation.relname),privilege.*
        FROM private_relations AS relation CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
        WHERE relation.relacl IS NOT NULL
      UNION ALL SELECT 'routine',pg_catalog.format('%I.%I(%s)',routine.nspname,routine.proname,routine.args),privilege.*
        FROM private_routines AS routine CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) AS privilege
        WHERE routine.proacl IS NOT NULL
    )
    SELECT pg_catalog.row_number() OVER ()::text AS identity, pg_catalog.jsonb_build_object(
      'objectKind', entries.object_kind, 'objectIdentity', entries.object_identity,
      'grantor', grantor.rolname, 'grantee', COALESCE(grantee.rolname,'PUBLIC'),
      'privilege', entries.privilege_type, 'grantable', entries.is_grantable
    ) AS fields
    FROM entries JOIN pg_catalog.pg_roles AS grantor ON grantor.oid=entries.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid=entries.grantee
    ORDER BY entries.object_kind COLLATE pg_catalog."C",entries.object_identity COLLATE pg_catalog."C",grantor.rolname COLLATE pg_catalog."C",
      COALESCE(grantee.rolname,'PUBLIC') COLLATE pg_catalog."C",entries.privilege_type COLLATE pg_catalog."C",entries.is_grantable`,
  defaultAcls: `SELECT default_acl.oid::text AS identity, pg_catalog.jsonb_build_object(
      'role', owner.rolname, 'schemaName', namespace.nspname, 'objectType', default_acl.defaclobjtype,
      'grantor', grantor.rolname, 'grantee', COALESCE(grantee.rolname,'PUBLIC'),
      'privilege', privilege.privilege_type, 'grantable', privilege.is_grantable
    ) AS fields
    FROM pg_catalog.pg_default_acl AS default_acl
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=default_acl.defaclrole
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=default_acl.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantor ON grantor.oid=privilege.grantor
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid=privilege.grantee
    WHERE namespace.nspname=ANY(ARRAY['pintpath_app','pintpath_ops'])`,
  dependencies: `SELECT pg_catalog.row_number() OVER ()::text AS identity, pg_catalog.jsonb_build_object(
      'dependentType', dependent.type, 'dependentNames', pg_catalog.to_jsonb(dependent.object_names),
      'dependentArguments', pg_catalog.to_jsonb(dependent.object_args),
      'referencedType', referenced.type, 'referencedNames', pg_catalog.to_jsonb(referenced.object_names),
      'referencedArguments', pg_catalog.to_jsonb(referenced.object_args), 'dependencyType', dependency.deptype
    ) AS fields
    FROM pg_catalog.pg_depend AS dependency
    CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
      dependency.classid,dependency.objid,dependency.objsubid) AS dependent
    CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
      dependency.refclassid,dependency.refobjid,dependency.refobjsubid) AS referenced
    WHERE dependent.object_names[1]=ANY(ARRAY['pintpath_app','pintpath_ops'])
       OR referenced.object_names[1]=ANY(ARRAY['pintpath_app','pintpath_ops'])`,
  sharedDependencies: `WITH database AS (
      SELECT database.oid,owner.rolname AS database_owner FROM pg_catalog.pg_database AS database
      JOIN pg_catalog.pg_roles AS owner ON owner.oid=database.datdba
      WHERE database.datname=pg_catalog.current_database()
    ) SELECT pg_catalog.row_number() OVER ()::text AS identity, pg_catalog.jsonb_build_object(
      'databaseScoped', dependency.dbid=(SELECT oid FROM database),
      'dependentType', dependent.type, 'dependentNames', pg_catalog.to_jsonb(dependent.object_names),
      'dependentArguments', pg_catalog.to_jsonb(dependent.object_args),
      'referencedType', referenced.type, 'referencedNames', pg_catalog.to_jsonb(referenced.object_names),
      'referencedArguments', pg_catalog.to_jsonb(referenced.object_args), 'dependencyType', dependency.deptype
    ) AS fields
    FROM pg_catalog.pg_shdepend AS dependency
    CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
      dependency.classid,dependency.objid,dependency.objsubid) AS dependent
    CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
      dependency.refclassid,dependency.refobjid,0) AS referenced
    WHERE dependency.dbid=(SELECT oid FROM database) AND (
      dependent.object_names[1]=ANY(ARRAY['pintpath_app','pintpath_ops'])
      OR (referenced.type='role' AND referenced.object_names[1] LIKE
        'pintpath_%_d'||(SELECT oid::text FROM database)))
      AND NOT (dependency.deptype='o' AND referenced.type='role'
        AND referenced.object_names[1]=(SELECT database_owner FROM database))`,
};

const ENVIRONMENT_SQL = `SELECT pg_catalog.jsonb_build_object(
    'encoding', pg_catalog.pg_encoding_to_char(database.encoding),
    'localeProvider', database.datlocprovider, 'collate', database.datcollate,
    'ctype', database.datctype, 'icuLocale', database.datlocale,
    'icuRules', database.daticurules, 'collationVersion', database.datcollversion,
    'allowConnections', database.datallowconn, 'isTemplate', database.datistemplate,
    'connectionLimit', database.datconnlimit, 'tablespace', tablespace.spcname
  ) AS environment
  FROM pg_catalog.pg_database AS database
  JOIN pg_catalog.pg_tablespace AS tablespace ON tablespace.oid=database.dattablespace
  WHERE database.datname=pg_catalog.current_database()`;

const FORBIDDEN_SQL = `WITH database AS (
    SELECT database.oid,owner.rolname AS database_owner FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS owner ON owner.oid=database.datdba
    WHERE database.datname=pg_catalog.current_database()
  ), all_pintpath_namespaces AS (
    SELECT oid,nspname FROM pg_catalog.pg_namespace WHERE nspname LIKE 'pintpath\\_%' ESCAPE '\\'
  ), private_namespaces AS (
    SELECT oid,nspname FROM pg_catalog.pg_namespace WHERE nspname=ANY(ARRAY['pintpath_app','pintpath_ops'])
  ), private_objects AS (
    SELECT class.oid,class.relkind FROM pg_catalog.pg_class AS class
    WHERE class.relnamespace IN (SELECT oid FROM private_namespaces)
  ), private_relations AS (SELECT oid FROM private_objects WHERE relkind='r'),
  private_dependency_count AS (
    SELECT count(*)::integer AS count FROM pg_catalog.pg_depend AS dependency
    CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
      dependency.classid,dependency.objid,dependency.objsubid) AS dependent
    CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
      dependency.refclassid,dependency.refobjid,dependency.refobjsubid) AS referenced
    WHERE dependent.object_names[1]=ANY(ARRAY['pintpath_app','pintpath_ops'])
       OR referenced.object_names[1]=ANY(ARRAY['pintpath_app','pintpath_ops'])
  ), shared_dependency_count AS (
    SELECT count(*)::integer AS count FROM pg_catalog.pg_shdepend AS dependency
    CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
      dependency.classid,dependency.objid,dependency.objsubid) AS dependent
    CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
      dependency.refclassid,dependency.refobjid,0) AS referenced
    WHERE dependency.dbid=(SELECT oid FROM database) AND (
      dependent.object_names[1]=ANY(ARRAY['pintpath_app','pintpath_ops'])
      OR (referenced.type='role' AND referenced.object_names[1] LIKE
        'pintpath_%_d'||(SELECT oid::text FROM database)))
      AND NOT (dependency.deptype='o' AND referenced.type='role'
        AND referenced.object_names[1]=(SELECT database_owner FROM database))
  )
  SELECT pg_catalog.jsonb_build_object(
    'unexpectedPrivateSchemas',(SELECT count(*)::integer FROM all_pintpath_namespaces
      WHERE nspname<>ALL(ARRAY['pintpath_app','pintpath_ops'])),
    'unexpectedPrivateRelations',(SELECT count(*)::integer FROM private_objects WHERE relkind='r'
      AND oid NOT IN (SELECT pg_catalog.to_regclass(name)::oid FROM pg_catalog.unnest($1::text[]) AS name)),
    'otherPrivateRelationKinds',(SELECT count(*)::integer FROM private_objects WHERE relkind NOT IN ('r','i')),
    'partitionedRelations',(SELECT count(*)::integer FROM private_objects WHERE relkind IN ('p','I')),
    'partitions',(SELECT count(*)::integer FROM pg_catalog.pg_inherits WHERE inhrelid IN (SELECT oid FROM private_objects)
      OR inhparent IN (SELECT oid FROM private_objects)),
    'inheritanceEdges',(SELECT count(*)::integer FROM pg_catalog.pg_inherits WHERE inhrelid IN (SELECT oid FROM private_relations)
      OR inhparent IN (SELECT oid FROM private_relations)),
    'sequences',(SELECT count(*)::integer FROM private_objects WHERE relkind='S'),
    'views',(SELECT count(*)::integer FROM private_objects WHERE relkind='v'),
    'materializedViews',(SELECT count(*)::integer FROM private_objects WHERE relkind='m'),
    'foreignTables',(SELECT count(*)::integer FROM private_objects WHERE relkind='f'),
    'standaloneTypes',(SELECT count(*)::integer FROM pg_catalog.pg_type AS type_object
      WHERE type_object.typnamespace IN (SELECT oid FROM private_namespaces) AND type_object.typrelid=0
        AND NOT (type_object.typcategory='A' AND type_object.typelem<>0)),
    'rewriteRules',(SELECT count(*)::integer FROM pg_catalog.pg_rewrite WHERE ev_class IN (SELECT oid FROM private_relations)),
    'publications',(SELECT count(*)::integer FROM pg_catalog.pg_publication),
    'publicationRelations',(SELECT count(*)::integer FROM pg_catalog.pg_publication_rel
      WHERE prrelid IN (SELECT oid FROM private_relations)),
    'publicationSchemas',(SELECT count(*)::integer FROM pg_catalog.pg_publication_namespace
      WHERE pnnspid IN (SELECT oid FROM private_namespaces)),
    'privateExtensionDependencies',(SELECT count(*)::integer FROM pg_catalog.pg_depend AS dependency
      CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
        dependency.classid,dependency.objid,dependency.objsubid) AS dependent
      WHERE dependency.deptype='e'
        AND dependent.object_names[1] IN (SELECT nspname FROM all_pintpath_namespaces)),
    'unexpectedExtensions',(SELECT count(*)::integer FROM pg_catalog.pg_extension
      WHERE extname<>'plpgsql'),
    'privateTypeAcls',(SELECT count(*)::integer FROM pg_catalog.pg_type AS type_object
      WHERE type_object.typnamespace IN (SELECT oid FROM all_pintpath_namespaces)
        AND type_object.typacl IS NOT NULL),
    'privateComments',(SELECT count(*)::integer FROM pg_catalog.pg_description AS description
      CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
        description.classoid,description.objoid,description.objsubid) AS commented
      WHERE commented.object_names[1] IN (SELECT nspname FROM all_pintpath_namespaces)),
    'privateSecurityLabels',(SELECT count(*)::integer FROM pg_catalog.pg_seclabel AS label
      CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(
        label.classoid,label.objoid,label.objsubid) AS labeled
      WHERE labeled.object_names[1] IN (SELECT nspname FROM all_pintpath_namespaces)),
    'eventTriggers',(SELECT count(*)::integer FROM pg_catalog.pg_event_trigger),
    'foreignDataWrappers',(SELECT count(*)::integer FROM pg_catalog.pg_foreign_data_wrapper),
    'foreignServers',(SELECT count(*)::integer FROM pg_catalog.pg_foreign_server),
    'userMappings',(SELECT count(*)::integer FROM pg_catalog.pg_user_mapping),
    'privateForeignObjects',(SELECT count(*)::integer FROM private_objects WHERE relkind='f'),
    'statisticsObjects',(SELECT count(*)::integer FROM pg_catalog.pg_statistic_ext
      WHERE stxnamespace IN (SELECT oid FROM private_namespaces)),
    'unexpectedDefaultAcls',(SELECT count(*)::integer FROM pg_catalog.pg_default_acl
      WHERE defaclnamespace IN (SELECT oid FROM private_namespaces)),
    'unexpectedPrivateObjects',(
      (SELECT pg_catalog.abs(count(*) FILTER (WHERE relkind='r') - 62)
        + pg_catalog.abs(count(*) FILTER (WHERE relkind='i') - 270)
        + count(*) FILTER (WHERE relkind NOT IN ('r','i')) FROM private_objects)
      + (SELECT pg_catalog.abs(count(*) - 10) FROM pg_catalog.pg_proc
          WHERE pronamespace IN (SELECT oid FROM private_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_type AS type_object
          WHERE type_object.typnamespace IN (SELECT oid FROM all_pintpath_namespaces)
            AND NOT (
              type_object.typrelid IN (SELECT oid FROM private_relations)
              OR type_object.typelem IN (SELECT oid FROM pg_catalog.pg_type
                WHERE typrelid IN (SELECT oid FROM private_relations))
            ))
      + (SELECT count(*) FROM pg_catalog.pg_class AS class
          WHERE class.relnamespace IN (SELECT oid FROM all_pintpath_namespaces
            WHERE nspname<>ALL(ARRAY['pintpath_app','pintpath_ops'])))
      + (SELECT count(*) FROM pg_catalog.pg_proc AS routine
          WHERE routine.pronamespace IN (SELECT oid FROM all_pintpath_namespaces
            WHERE nspname<>ALL(ARRAY['pintpath_app','pintpath_ops'])))
      + (SELECT count(*) FROM pg_catalog.pg_collation
          WHERE collnamespace IN (SELECT oid FROM all_pintpath_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_conversion
          WHERE connamespace IN (SELECT oid FROM all_pintpath_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_operator
          WHERE oprnamespace IN (SELECT oid FROM all_pintpath_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_opclass
          WHERE opcnamespace IN (SELECT oid FROM all_pintpath_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_opfamily
          WHERE opfnamespace IN (SELECT oid FROM all_pintpath_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_ts_config
          WHERE cfgnamespace IN (SELECT oid FROM all_pintpath_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_ts_dict
          WHERE dictnamespace IN (SELECT oid FROM all_pintpath_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_ts_parser
          WHERE prsnamespace IN (SELECT oid FROM all_pintpath_namespaces))
      + (SELECT count(*) FROM pg_catalog.pg_ts_template
          WHERE tmplnamespace IN (SELECT oid FROM all_pintpath_namespaces))
    ),
    'unexpectedPrivateDependencies',(SELECT pg_catalog.abs(count - 1933) FROM private_dependency_count),
    'unexpectedSharedDependencies',(SELECT pg_catalog.abs(count - 384) FROM shared_dependency_count)
  ) AS counts`;

async function capture(client: Client): Promise<PostgresLogicalPhysicalSchemaV4Capture> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
    // The exact relation locks are deliberately the first snapshot-relevant
    // operation. Both SET TRANSACTION statements must succeed before any SELECT;
    // PostgreSQL rejects the first one if a caller already established a snapshot.
    await client.query(`LOCK TABLE ${POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS.map(
      (name) => `ONLY ${name.split(".").map(quoteIdentifier).join(".")}`,
    ).join(",")} IN ACCESS SHARE MODE`);
    try {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY, NOT DEFERRABLE",
      );
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY, NOT DEFERRABLE",
      );
    } catch {
      throw new Error("physical_schema_v4_stale_or_preexisting_snapshot");
    }
    const identity = await client.query<{
      databaseName: string; databaseOid: string; databaseOwner: string; backendPid: string;
      version: string; isolation: string; readOnly: string; searchPath: string; firstSchema: string;
    }>(`SELECT pg_catalog.current_database() AS "databaseName", database.oid::text AS "databaseOid",
        owner.rolname AS "databaseOwner", pg_catalog.pg_backend_pid()::text AS "backendPid",
        pg_catalog.current_setting('server_version_num') AS version,
        pg_catalog.current_setting('transaction_isolation') AS isolation,
        pg_catalog.current_setting('transaction_read_only') AS "readOnly",
        pg_catalog.current_setting('search_path') AS "searchPath",
        (pg_catalog.current_schemas(true))[1] AS "firstSchema"
      FROM pg_catalog.pg_database AS database JOIN pg_catalog.pg_roles AS owner ON owner.oid=database.datdba
      WHERE database.datname=pg_catalog.current_database()`);
    const row = identity.rows[0]!;
    if (row.isolation !== "repeatable read" || row.readOnly !== "on"
      || row.searchPath !== "pg_catalog, pg_temp" || row.firstSchema !== "pg_catalog") {
      throw new Error("physical_schema_v4_untrusted_catalog_session");
    }
    const mapping: PostgresLogicalPhysicalSchemaV4RoleMapping = {
      databaseName: row.databaseName,
      databaseOid: row.databaseOid,
      databaseOwner: row.databaseOwner,
      logicalBackup: `pintpath_logical_backup_d${row.databaseOid}`,
      applyOwner: `pintpath_reviewed_price_apply_owner_d${row.databaseOid}`,
      applyExecute: `pintpath_reviewed_price_apply_execute_d${row.databaseOid}`,
      quarantineOwner: `pintpath_reviewed_price_quarantine_owner_d${row.databaseOid}`,
      quarantineExecute: `pintpath_reviewed_price_quarantine_execute_d${row.databaseOid}`,
    };
    const started = await client.query<{ at: string; snapshot: string }>(`SELECT
      pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
      pg_catalog.txid_current_snapshot()::text AS snapshot`);
    const graph = Object.create(null) as Record<PostgresLogicalPhysicalSchemaV4Category,
      PostgresLogicalPhysicalSchemaV4CatalogEntry[]>;
    for (const [category, sql] of Object.entries(CATEGORY_SQL) as Array<[
      PostgresLogicalPhysicalSchemaV4Category, string,
    ]>) {
      const result = await client.query<CatalogRow>(sql);
      graph[category] = transformRows(category, result.rows, mapping);
    }
    const environment = await client.query<{ environment: PostgresLogicalPhysicalSchemaV4Capture["databaseEnvironment"] }>(
      ENVIRONMENT_SQL,
    );
    const forbidden = await client.query<{ counts: PostgresLogicalPhysicalSchemaV4Capture["forbiddenCounts"] }>(
      FORBIDDEN_SQL,
      [POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS],
    );
    const ended = await client.query<{ captured: string; ended: string }>(`SELECT
      pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured,
      pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended`);
    await client.query("COMMIT");
    return {
      roleMapping: mapping,
      session: {
        serverVersionNum: Number(row.version),
        claimedTransactionIsolation: "repeatable read",
        claimedTransactionReadOnly: true,
        claimedTrustedSearchPath: "pg_catalog, pg_temp",
        claimedEffectiveFirstSchema: "pg_catalog",
        claimedSameSession: true,
        claimedBackendPid: row.backendPid,
        claimedSnapshotIdentifierSha256: crypto.createHash("sha256")
          .update(started.rows[0]!.snapshot).digest("hex"),
        claimedPrivateRelationLockMode: "ACCESS SHARE",
        claimedLockedPrivateRelations: POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS,
        claimedCatalogSnapshotFreshnessValidated: true,
        claimedTransactionStartedAt: new Date(started.rows[0]!.at).toISOString(),
        claimedCatalogCapturedAt: new Date(ended.rows[0]!.captured).toISOString(),
        claimedTransactionEndedAt: new Date(ended.rows[0]!.ended).toISOString(),
      },
      databaseEnvironment: environment.rows[0]!.environment,
      graph: graph as PostgresLogicalPhysicalSchemaV4CatalogGraph,
      forbiddenCounts: forbidden.rows[0]!.counts,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

describe.skipIf(!configuredAdminUrl)("passive physical-schema V4 against disposable PG17", () => {
  let adminUrl: URL;
  let maintenance: Client;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;
  let verifierAuthorityRoleExisted = false;
  const clients = new Set<Client>();
  const databaseOids = new Set<string>();

  async function databaseOidByName(name: string): Promise<string | null> {
    const result = await maintenance.query<{ oid: string }>(
      "SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname=$1",
      [name],
    );
    const oid = result.rows[0]?.oid ?? null;
    if (result.rows.length > 1 || (oid !== null && !/^[1-9][0-9]{0,9}$/.test(oid))) {
      throw new Error("unsafe_test_database_oid");
    }
    return oid;
  }

  async function dropScopedRoles(databaseOid: string): Promise<void> {
    for (const role of scopedRoleNames(databaseOid)) {
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
    }
  }

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    maintenance = new Client({ connectionString: adminUrl.toString() });
    await maintenance.connect();
    const state = await maintenance.query<{ version: string; superuser: boolean }>(`SELECT
      pg_catalog.current_setting('server_version_num') AS version, role.rolsuper AS superuser
      FROM pg_catalog.pg_roles AS role WHERE role.rolname=current_user`);
    if (!/^17[0-9]{4}$/.test(state.rows[0]?.version ?? "") || state.rows[0]?.superuser !== true) {
      throw new Error("Physical-schema V4 integration requires a disposable PG17 superuser.");
    }
    const roles = await maintenance.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator", verifierAuthorityRole]],
    );
    runtimeRoleExisted = roles.rows.some(({ rolname }) => rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some(({ rolname }) => rolname === "pintpath_migrator");
    verifierAuthorityRoleExisted = roles.rows.some(({ rolname }) => (
      rolname === verifierAuthorityRole
    ));
    for (const database of [firstDatabase, secondDatabase]) {
      const existingOid = await databaseOidByName(database);
      if (existingOid) databaseOids.add(existingOid);
      await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
      if (existingOid) await dropScopedRoles(existingOid);
    }
    await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(secondOwner)}`);
  }, 30_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const client of clients) await client.end().catch(() => undefined);
    for (const database of [firstDatabase, secondDatabase]) {
      try {
        const currentOid = await databaseOidByName(database);
        if (currentOid) databaseOids.add(currentOid);
        await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const oid of databaseOids) {
      await dropScopedRoles(oid).catch((error) => failures.push(error));
    }
    await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(secondOwner)}`)
      .catch((error) => failures.push(error));
    if (!runtimeRoleExisted) await maintenance.query("DROP ROLE IF EXISTS pintpath_runtime")
      .catch((error) => failures.push(error));
    if (!migratorRoleExisted) await maintenance.query("DROP ROLE IF EXISTS pintpath_migrator")
      .catch((error) => failures.push(error));
    if (!verifierAuthorityRoleExisted) {
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(verifierAuthorityRole)}`)
        .catch((error) => failures.push(error));
    }
    try {
      const residue = await maintenance.query<{
        databaseCount: string;
        ownerCount: string;
        scopedRoleCount: string;
        verifierAuthorityRoleCount: string;
      }>(`SELECT
        (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname=ANY($1::text[])) AS "databaseCount",
        (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname=$2) AS "ownerCount",
        (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname=ANY($3::text[])) AS "scopedRoleCount",
        (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname=$4) AS "verifierAuthorityRoleCount"`,
      [
        [firstDatabase, secondDatabase],
        secondOwner,
        [...databaseOids].flatMap(scopedRoleNames),
        verifierAuthorityRole,
      ]);
      if (residue.rows[0]?.databaseCount !== "0" || residue.rows[0]?.ownerCount !== "0"
        || residue.rows[0]?.scopedRoleCount !== "0"
        || residue.rows[0]?.verifierAuthorityRoleCount !== (verifierAuthorityRoleExisted ? "1" : "0")) {
        failures.push(new Error("physical_schema_v4_test_residue_detected"));
      }
    } catch (error) {
      failures.push(error);
    }
    await maintenance.end().catch((error) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  }, 30_000);

  async function createDatabase(name: string, owner?: string): Promise<Client> {
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(name)}${owner ? ` OWNER ${quoteIdentifier(owner)}` : ""}`);
    const createdOid = await databaseOidByName(name);
    if (!createdOid) throw new Error("test_database_oid_unavailable");
    databaseOids.add(createdOid);
    const client = new Client({ connectionString: withDatabase(adminUrl, name) });
    await client.connect();
    clients.add(client);
    if (owner) {
      await client.query(`SET ROLE ${quoteIdentifier(owner)}`);
      await client.query(schemaSql);
      await client.query(kernelSql);
      await client.query("RESET ROLE");
      await client.query(kernelSql);
    } else {
      await client.query(schemaSql);
      await client.query(kernelSql);
    }
    return client;
  }

  it("is portable across owner/OID changes, raw-sensitive, exact, and drift rejecting", async () => {
    const first = await createDatabase(firstDatabase);
    await maintenance.query(`CREATE ROLE ${quoteIdentifier(secondOwner)} NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    const second = await createDatabase(secondDatabase, secondOwner);
    const firstCapture = await capture(first);
    const secondCapture = await capture(second);
    expect(Object.fromEntries(Object.entries(firstCapture.graph).map(([key, value]) => [key, value.length])))
      .toEqual(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_COUNTS);
    expect(Object.fromEntries(Object.entries(secondCapture.graph).map(([key, value]) => [key, value.length])))
      .toEqual(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_COUNTS);
    const firstDerived = derivePostgresLogicalPhysicalSchemaV4(firstCapture);
    const secondDerived = derivePostgresLogicalPhysicalSchemaV4(secondCapture);
    expect(firstDerived.portableSchemaSha256).toBe(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PORTABLE_SCHEMA_SHA256);
    expect(secondDerived.portableSchemaSha256).toBe(firstDerived.portableSchemaSha256);
    expect(secondDerived.rawPhysicalSha256).not.toBe(firstDerived.rawPhysicalSha256);
    const record = buildPostgresLogicalPhysicalSchemaV4Record(firstCapture);
    const canonicalRecord = canonicalizePostgresLogicalPhysicalSchemaV4Record(record);
    expect(parsePostgresLogicalPhysicalSchemaV4Record(
      Buffer.from(canonicalRecord),
    )).toEqual(record);
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonicalRecord)]),
    )).toThrowError(expect.objectContaining({ code: "record_invalid" }));
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record(
      Buffer.from(`${canonicalRecord}\n`),
    )).toThrowError(expect.objectContaining({ code: "record_invalid" }));
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record(
      Buffer.from([0xff]),
    )).toThrowError(expect.objectContaining({ code: "record_invalid" }));
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record(
      new Proxy(Buffer.from(canonicalRecord), {}),
    )).toThrowError(expect.objectContaining({ code: "record_invalid" }));
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record(
      new Uint8Array(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_BYTES + 1),
    )).toThrowError(expect.objectContaining({ code: "record_invalid" }));
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record(
      Object.defineProperty({ ...record }, "kind", { get: () => record.kind, enumerable: true }),
    )).toThrowError(expect.objectContaining({ code: "record_invalid" }));
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record({ ...record, extra: false }))
      .toThrowError(expect.objectContaining({ code: "record_invalid" }));
    const { receiptSha256: _omitted, ...missing } = record;
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record(missing))
      .toThrowError(expect.objectContaining({ code: "record_invalid" }));
    expect(() => parsePostgresLogicalPhysicalSchemaV4Record({
      ...record,
      derived: { ...record.derived, portableSchemaSha256: "f".repeat(64) },
    })).toThrowError(expect.objectContaining({ code: "record_invalid" }));

    await first.query("BEGIN");
    try {
      await first.query(`CREATE COLLATION pintpath_app.physical_v4_case_insensitive (
        provider = icu,
        locale = 'und-u-ks-level2',
        deterministic = false
      )`);
      await first.query(`CREATE UNIQUE INDEX idx_accounts_public_account
        ON pintpath_app.accounts (
          public_account_id COLLATE pintpath_app.physical_v4_case_insensitive
        )`);
      await first.query(`INSERT INTO pintpath_app.accounts (
        id, public_account_id, email, password_hash, created_at, updated_at
      ) VALUES (
        'physical-v4-semantic-index-one',
        'PintPath-Semantic-Index',
        'physical-v4-semantic-index-one@example.test',
        'not-a-real-password-hash',
        pg_catalog.now(),
        pg_catalog.now()
      )`);

      await first.query("SAVEPOINT semantic_index_migration_guard");
      const migrationError = await first.query(redundantPublicAccountIndexMigrationSql)
        .catch((error: unknown) => error as { code?: string; message?: string });
      expect(migrationError).toMatchObject({ code: "P0001" });
      expect("message" in migrationError ? migrationError.message : undefined)
        .toContain("existing object is not the exact redundant unique index");
      await first.query("ROLLBACK TO SAVEPOINT semantic_index_migration_guard");
      await first.query("RELEASE SAVEPOINT semantic_index_migration_guard");

      const semanticIndex = await first.query<{
        readonly targetCount: string;
        readonly semanticVectorsMatch: boolean;
      }>(`SELECT
          pg_catalog.count(*)::pg_catalog.text AS "targetCount",
          pg_catalog.bool_and(
            target_definition.relam = constraint_definition.relam
            AND target_index.indkey = constraint_index.indkey
            AND target_index.indcollation = constraint_index.indcollation
            AND target_index.indclass = constraint_index.indclass
            AND target_index.indoption = constraint_index.indoption
          ) AS "semanticVectorsMatch"
        FROM pg_catalog.pg_class AS target_definition
        JOIN pg_catalog.pg_index AS target_index
          ON target_index.indexrelid = target_definition.oid
        JOIN pg_catalog.pg_constraint AS unique_constraint
          ON unique_constraint.conrelid = 'pintpath_app.accounts'::pg_catalog.regclass
         AND unique_constraint.conname = 'accounts_public_account_id_key'
        JOIN pg_catalog.pg_class AS constraint_definition
          ON constraint_definition.oid = unique_constraint.conindid
        JOIN pg_catalog.pg_index AS constraint_index
          ON constraint_index.indexrelid = constraint_definition.oid
        WHERE target_definition.oid =
          pg_catalog.to_regclass('pintpath_app.idx_accounts_public_account')`);
      expect(semanticIndex.rows).toEqual([{
        targetCount: "1",
        semanticVectorsMatch: false,
      }]);

      await first.query("SAVEPOINT semantic_index_invariant");
      const duplicateError = await first.query(`INSERT INTO pintpath_app.accounts (
        id, public_account_id, email, password_hash, created_at, updated_at
      ) VALUES (
        'physical-v4-semantic-index-two',
        'pintpath-semantic-index',
        'physical-v4-semantic-index-two@example.test',
        'not-a-real-password-hash',
        pg_catalog.now(),
        pg_catalog.now()
      )`).catch((error: unknown) => error as { code?: string; constraint?: string });
      expect(duplicateError).toMatchObject({
        code: "23505",
        constraint: "idx_accounts_public_account",
      });
      await first.query("ROLLBACK TO SAVEPOINT semantic_index_invariant");
      await first.query("RELEASE SAVEPOINT semantic_index_invariant");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
    }

    await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await first.query("SELECT 1 FROM pg_catalog.pg_class LIMIT 1");
    await expect(capture(first)).rejects.toThrow("physical_schema_v4_stale_or_preexisting_snapshot");
    await first.query("ROLLBACK").catch(() => undefined);

    await first.query("CREATE SCHEMA pintpath_physical_v4_unexpected");
    try {
      const unexpectedSchema = await capture(first);
      expect(unexpectedSchema.forbiddenCounts.unexpectedPrivateSchemas).toBe(1);
      expect(() => derivePostgresLogicalPhysicalSchemaV4(unexpectedSchema))
        .toThrowError(expect.objectContaining({ code: "catalog_mismatch" }));
    } finally {
      await first.query("DROP SCHEMA pintpath_physical_v4_unexpected");
    }

    await first.query(`CREATE FUNCTION pintpath_app.physical_v4_unexpected()
      RETURNS pg_catalog.int4 LANGUAGE sql AS 'SELECT 1'`);
    try {
      const unexpectedRoutine = await capture(first);
      expect(unexpectedRoutine.forbiddenCounts.unexpectedPrivateObjects).toBeGreaterThan(0);
      expect(() => derivePostgresLogicalPhysicalSchemaV4(unexpectedRoutine))
        .toThrowError(expect.objectContaining({ code: "catalog_mismatch" }));

      await first.query("ALTER EXTENSION plpgsql ADD FUNCTION pintpath_app.physical_v4_unexpected()");
      try {
        const extensionDependency = await capture(first);
        expect(extensionDependency.forbiddenCounts.privateExtensionDependencies).toBe(1);
        expect(() => derivePostgresLogicalPhysicalSchemaV4(extensionDependency))
          .toThrowError(expect.objectContaining({ code: "catalog_mismatch" }));
      } finally {
        await first.query("ALTER EXTENSION plpgsql DROP FUNCTION pintpath_app.physical_v4_unexpected()")
          .catch(() => undefined);
      }
    } finally {
      await first.query("DROP FUNCTION IF EXISTS pintpath_app.physical_v4_unexpected()")
        .catch(() => undefined);
    }

    await first.query("GRANT USAGE ON TYPE pintpath_app.accounts TO PUBLIC");
    try {
      const typeAcl = await capture(first);
      expect(typeAcl.forbiddenCounts.privateTypeAcls).toBe(1);
      expect(() => derivePostgresLogicalPhysicalSchemaV4(typeAcl))
        .toThrowError(expect.objectContaining({ code: "catalog_mismatch" }));
    } finally {
      // SQL GRANT materializes an explicit ACL; restore the canonical NULL ACL
      // directly in this disposable superuser-only drift fixture.
      await first.query(`UPDATE pg_catalog.pg_type SET typacl=NULL
        WHERE oid='pintpath_app.accounts'::pg_catalog.regtype`);
    }

    await first.query("ALTER TABLE pintpath_app.accounts ADD COLUMN physical_v4_drift text");
    await expect(capture(first).then(derivePostgresLogicalPhysicalSchemaV4))
      .rejects.toMatchObject({ code: "catalog_mismatch" });
  }, 60_000);
});
