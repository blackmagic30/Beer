import type { QueryResultRow } from "pg";

import type { SqlDatabase } from "./sql-database.js";

export const POSTGRES_MAINTENANCE_ROLE = "pintpath_maintenance";

export const POSTGRES_MAINTENANCE_SELECT_TABLES = Object.freeze([
  "account_deletion_completion_outbox",
  "account_deletion_notice_recipient_secrets",
  "account_deletion_notification_events",
  "account_deletion_requests",
  "account_discount_passes",
  "account_preferences",
  "account_privacy_settings",
  "account_reward_vouchers",
  "accounts",
  "age_verifications",
  "auth_sessions",
  "billing_checkout_reservations",
  "contribution_ledger",
  "discount_redemptions",
  "events",
  "feedback",
  "free_pint_reward_codes",
  "free_pint_reward_redemptions",
  "leaderboard_prize_awards",
  "leaderboard_prize_campaigns",
  "migration_quarantined_records",
  "mission_progress",
  "pint_point_drink_records",
  "pint_point_ledger",
  "profiles",
  "revoked_provider_sessions",
  "saved_items",
  "security_audit_log",
  "source_evidence_objects",
  "stripe_webhook_events",
  "submission_items",
  "submission_source_evidence",
  "submissions",
  "system_state",
  "user_activity_events",
  "venue_claim_requests",
  "venue_interest_requests",
  "venue_manager_assignments",
  "venue_partner_outreach",
  "venue_pending_changes",
  "venue_price_records",
  "venue_requests",
  "verifications",
  "wrong_price_reports",
] as const);

export const POSTGRES_MAINTENANCE_UPDATE_TABLES = Object.freeze([
  "account_deletion_completion_outbox",
  "account_deletion_notice_recipient_secrets",
  "account_deletion_requests",
  "accounts",
  "discount_redemptions",
  "events",
  "feedback",
  "free_pint_reward_codes",
  "free_pint_reward_redemptions",
  "leaderboard_prize_campaigns",
  "migration_quarantined_records",
  "pint_point_drink_records",
  "profiles",
  "security_audit_log",
  "source_evidence_objects",
  "stripe_webhook_events",
  "submissions",
  "system_state",
  "venue_claim_requests",
  "venue_interest_requests",
  "venue_manager_assignments",
  "venue_partner_outreach",
  "venue_pending_changes",
  "venue_requests",
  "wrong_price_reports",
] as const);

export const POSTGRES_MAINTENANCE_DELETE_TABLES = Object.freeze([
  "account_deletion_notification_events",
  "account_deletion_notice_recipient_secrets",
  "account_discount_passes",
  "account_preferences",
  "account_privacy_settings",
  "account_reward_vouchers",
  "age_verifications",
  "auth_sessions",
  "billing_checkout_reservations",
  "contribution_ledger",
  "discount_redemptions",
  "events",
  "free_pint_reward_codes",
  "free_pint_reward_redemptions",
  "leaderboard_prize_awards",
  "mission_progress",
  "pint_point_drink_records",
  "pint_point_ledger",
  "revoked_provider_sessions",
  "saved_items",
  "security_audit_log",
  "submission_items",
  "submissions",
  "user_activity_events",
  "venue_manager_assignments",
  "venue_pending_changes",
  "venue_price_records",
  "verifications",
] as const);

interface MaintenanceAuthorityRow extends QueryResultRow {
  activeRoleExact: boolean;
  isMaintenanceMember: boolean;
  isRuntimeMember: boolean;
  isMigratorMember: boolean;
  loginCanLogin: boolean;
  loginIsSuperuser: boolean;
  loginCanCreateDatabase: boolean;
  loginCanCreateRole: boolean;
  loginInheritsPrivileges: boolean;
  loginCanReplicate: boolean;
  loginBypassesRls: boolean;
  loginConnectionLimit: number;
  loginValidUntilNull: boolean;
  loginMemberships: unknown;
  loginMembershipOptionsExact: boolean;
  maintenanceRoleSafe: boolean;
  maintenanceRoleParents: unknown;
  hasRoleSettings: boolean;
  insertTables: unknown;
  selectTables: unknown;
  updateTables: unknown;
  deleteTables: unknown;
  directInsertTables: unknown;
  directSelectTables: unknown;
  directUpdateTables: unknown;
  directDeleteTables: unknown;
  applicationSchemaAclExact: boolean;
  hasUnexpectedDirectTableAuthority: boolean;
  hasColumnAclEntries: boolean;
  hasUnexpectedMaintenanceAclDependency: boolean;
  hasGrantableAcl: boolean;
  canUseApplicationSchema: boolean;
  canCreateApplicationObjects: boolean;
  canUseOperationsSchema: boolean;
  canCreateOperationsObjects: boolean;
  canConnectDatabase: boolean;
  canCreateDatabaseObjects: boolean;
  canCreateTemporaryObjects: boolean;
  databaseAclExact: boolean;
  hasApplicationSequenceAccess: boolean;
  hasOperationsSequenceAccess: boolean;
  hasApplicationFunctionAccess: boolean;
  hasOperationsFunctionAccess: boolean;
  hasUnsafeDirectAclDependencies: boolean;
  ownsDatabaseObjects: boolean;
  hasUnsafeDefaultPrivileges: boolean;
}

export interface PostgresMaintenanceRuntimeReadiness {
  ready: boolean;
  failures: string[];
}

function canonicalTableList(value: unknown): string[] | null {
  let candidate = value;
  if (typeof candidate === "string" && candidate.length <= 65_536) {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (
    !Array.isArray(candidate)
    || candidate.some((entry) => typeof entry !== "string")
  ) {
    return null;
  }
  const sorted = [...candidate].sort();
  return new Set(sorted).size === sorted.length ? sorted : null;
}

function listsMatch(value: unknown, expected: readonly string[]): boolean {
  const actual = canonicalTableList(value);
  return actual !== null && JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

/**
 * Proves that the privacy pool is distinct from request/migration authority
 * and has exactly the reviewed table operations used by account erasure and
 * retention. No role, URL, credential, or row value is returned or logged.
 */
export async function checkPostgresMaintenanceRuntimeReadiness(
  database: SqlDatabase,
): Promise<PostgresMaintenanceRuntimeReadiness> {
  if (database.dialect !== "postgres") {
    return { ready: false, failures: ["not_postgres"] };
  }
  const row = await database.prepare(`
    WITH login_role AS (
      SELECT role.*
        FROM pg_catalog.pg_roles AS role
       WHERE role.rolname = session_user
    ), application_namespace AS (
      SELECT namespace.oid
        FROM pg_catalog.pg_namespace AS namespace
       WHERE namespace.nspname = 'pintpath_app'
    ), operations_namespace AS (
      SELECT namespace.oid
        FROM pg_catalog.pg_namespace AS namespace
       WHERE namespace.nspname = 'pintpath_ops'
    ), application_tables AS (
      SELECT relation.oid, relation.relname, relation.relowner, relation.relacl
        FROM pg_catalog.pg_class AS relation
        JOIN application_namespace AS namespace
          ON namespace.oid = relation.relnamespace
         AND relation.relkind IN ('r', 'p')
    ), application_columns AS (
      SELECT attribute.attrelid, attribute.attacl
        FROM pg_catalog.pg_attribute AS attribute
        JOIN application_tables AS relation ON relation.oid = attribute.attrelid
       WHERE attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attacl IS NOT NULL
    ), application_sequences AS (
      SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN application_namespace AS namespace
          ON namespace.oid = relation.relnamespace
       WHERE relation.relkind = 'S'
    ), operations_sequences AS (
      SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN operations_namespace AS namespace
          ON namespace.oid = relation.relnamespace
       WHERE relation.relkind = 'S'
    ), application_functions AS (
      SELECT routine.oid
        FROM pg_catalog.pg_proc AS routine
        JOIN application_namespace AS namespace
          ON namespace.oid = routine.pronamespace
    ), operations_functions AS (
      SELECT routine.oid
        FROM pg_catalog.pg_proc AS routine
        JOIN operations_namespace AS namespace
          ON namespace.oid = routine.pronamespace
    )
    SELECT
      (
        current_user = 'pintpath_maintenance'
        AND session_user <> current_user
      ) AS "activeRoleExact",
      COALESCE(pg_has_role(session_user, to_regrole('pintpath_maintenance'), 'MEMBER'), false)
        AS "isMaintenanceMember",
      COALESCE(pg_has_role(session_user, to_regrole('pintpath_runtime'), 'MEMBER'), false)
        AS "isRuntimeMember",
      COALESCE(pg_has_role(session_user, to_regrole('pintpath_migrator'), 'MEMBER'), false)
        AS "isMigratorMember",
      role.rolcanlogin AS "loginCanLogin",
      role.rolsuper AS "loginIsSuperuser",
      role.rolcreatedb AS "loginCanCreateDatabase",
      role.rolcreaterole AS "loginCanCreateRole",
      role.rolinherit AS "loginInheritsPrivileges",
      role.rolreplication AS "loginCanReplicate",
      role.rolbypassrls AS "loginBypassesRls",
      role.rolconnlimit AS "loginConnectionLimit",
      role.rolvaliduntil IS NULL AS "loginValidUntilNull",
      COALESCE((
        SELECT jsonb_agg(granted.rolname::text ORDER BY granted.rolname::text COLLATE "C")
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
         WHERE membership.member = role.oid
      ), '[]'::jsonb) AS "loginMemberships",
      COALESCE((
        SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(
            granted.rolname = 'pintpath_maintenance'
            AND NOT membership.admin_option
            AND NOT membership.inherit_option
            AND membership.set_option
          )
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
         WHERE membership.member = role.oid
      ), false) AS "loginMembershipOptionsExact",
      COALESCE((
        SELECT NOT maintenance.rolcanlogin
          AND NOT maintenance.rolsuper
          AND NOT maintenance.rolcreatedb
          AND NOT maintenance.rolcreaterole
          AND NOT maintenance.rolinherit
          AND NOT maintenance.rolreplication
          AND NOT maintenance.rolbypassrls
          AND maintenance.rolconnlimit = -1
          AND maintenance.rolvaliduntil IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members AS child
             WHERE child.roleid = maintenance.oid
               AND child.member <> role.oid
          )
        FROM pg_catalog.pg_roles AS maintenance
        WHERE maintenance.rolname = 'pintpath_maintenance'
      ), false) AS "maintenanceRoleSafe",
      COALESCE((
        SELECT jsonb_agg(parent.rolname::text ORDER BY parent.rolname::text COLLATE "C")
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
         WHERE membership.member = pg_catalog.to_regrole('pintpath_maintenance')
      ), '[]'::jsonb) AS "maintenanceRoleParents",
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_db_role_setting AS setting
         WHERE setting.setrole IN (role.oid, pg_catalog.to_regrole('pintpath_maintenance'))
      ) AS "hasRoleSettings",
      COALESCE((
        SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
          FROM application_tables AS table_name
         WHERE has_table_privilege(current_user, table_name.oid, 'INSERT')
      ), '[]'::jsonb) AS "insertTables",
      COALESCE((
        SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
          FROM application_tables AS table_name
         WHERE has_table_privilege(current_user, table_name.oid, 'SELECT')
      ), '[]'::jsonb) AS "selectTables",
      COALESCE((
        SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
          FROM application_tables AS table_name
         WHERE has_table_privilege(current_user, table_name.oid, 'UPDATE')
      ), '[]'::jsonb) AS "updateTables",
      COALESCE((
        SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
          FROM application_tables AS table_name
         WHERE has_table_privilege(current_user, table_name.oid, 'DELETE')
      ), '[]'::jsonb) AS "deleteTables",
      COALESCE((
        SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
          FROM application_tables AS table_name
         WHERE EXISTS (
           SELECT 1 FROM pg_catalog.aclexplode(table_name.relacl) AS privilege
            WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
              AND privilege.privilege_type = 'INSERT'
         )
      ), '[]'::jsonb) AS "directInsertTables",
      COALESCE((
        SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
          FROM application_tables AS table_name
         WHERE EXISTS (
           SELECT 1 FROM pg_catalog.aclexplode(table_name.relacl) AS privilege
            WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
              AND privilege.privilege_type = 'SELECT'
         )
      ), '[]'::jsonb) AS "directSelectTables",
      COALESCE((
        SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
          FROM application_tables AS table_name
         WHERE EXISTS (
           SELECT 1 FROM pg_catalog.aclexplode(table_name.relacl) AS privilege
            WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
              AND privilege.privilege_type = 'UPDATE'
         )
      ), '[]'::jsonb) AS "directUpdateTables",
      COALESCE((
        SELECT jsonb_agg(table_name.relname ORDER BY table_name.relname)
          FROM application_tables AS table_name
         WHERE EXISTS (
           SELECT 1 FROM pg_catalog.aclexplode(table_name.relacl) AS privilege
            WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
              AND privilege.privilege_type = 'DELETE'
         )
      ), '[]'::jsonb) AS "directDeleteTables",
      COALESCE((
        SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(
            privilege.privilege_type = 'USAGE'
            AND NOT privilege.is_grantable
          )
          FROM application_namespace AS namespace
          JOIN pg_catalog.pg_namespace AS source ON source.oid = namespace.oid
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(source.nspacl, pg_catalog.acldefault('n', source.nspowner))
          ) AS privilege
         WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
      ), false) AS "applicationSchemaAclExact",
      EXISTS (
        SELECT 1 FROM application_tables AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
         WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
           AND privilege.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')
      ) AS "hasUnexpectedDirectTableAuthority",
      EXISTS (
        SELECT 1 FROM application_columns AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
         WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
      ) AS "hasColumnAclEntries",
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.refobjid = pg_catalog.to_regrole('pintpath_maintenance')
           AND dependency.deptype = 'a'
           AND NOT (
             dependency.dbid = (
               SELECT database.oid FROM pg_catalog.pg_database AS database
                WHERE database.datname = pg_catalog.current_database()
             )
             AND (
               (dependency.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
                 AND dependency.objid IN (SELECT oid FROM application_namespace))
               OR (dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                 AND dependency.objid IN (SELECT oid FROM application_tables))
             )
           )
      ) AS "hasUnexpectedMaintenanceAclDependency",
      EXISTS (
        SELECT 1 FROM application_namespace AS namespace
        JOIN pg_catalog.pg_namespace AS source ON source.oid = namespace.oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(source.nspacl, pg_catalog.acldefault('n', source.nspowner))
        ) AS privilege
         WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
           AND privilege.is_grantable
        UNION ALL
        SELECT 1 FROM application_tables AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) AS privilege
         WHERE privilege.grantee = pg_catalog.to_regrole('pintpath_maintenance')
           AND privilege.is_grantable
      ) AS "hasGrantableAcl",
      has_schema_privilege(current_user, 'pintpath_app', 'USAGE')
        AS "canUseApplicationSchema",
      has_schema_privilege(current_user, 'pintpath_app', 'CREATE')
        AS "canCreateApplicationObjects",
      has_schema_privilege(current_user, 'pintpath_ops', 'USAGE')
        AS "canUseOperationsSchema",
      has_schema_privilege(current_user, 'pintpath_ops', 'CREATE')
        AS "canCreateOperationsObjects",
      has_database_privilege(session_user, current_database(), 'CONNECT')
        AS "canConnectDatabase",
      has_database_privilege(session_user, current_database(), 'CREATE')
        AS "canCreateDatabaseObjects",
      has_database_privilege(session_user, current_database(), 'TEMP')
        AS "canCreateTemporaryObjects",
      COALESCE((
        SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(
            grant_entry.privilege_type = 'CONNECT'
            AND NOT grant_entry.is_grantable
          )
          FROM pg_catalog.pg_database AS database
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              database.datacl,
              pg_catalog.acldefault('d', database.datdba)
            )
          ) AS grant_entry
         WHERE database.datname = pg_catalog.current_database()
           AND grant_entry.grantee = role.oid
      ), false) AS "databaseAclExact",
      EXISTS (
        SELECT 1 FROM application_sequences AS sequence
         WHERE has_sequence_privilege(current_user, sequence.oid, 'USAGE')
            OR has_sequence_privilege(current_user, sequence.oid, 'SELECT')
            OR has_sequence_privilege(current_user, sequence.oid, 'UPDATE')
      ) AS "hasApplicationSequenceAccess",
      EXISTS (
        SELECT 1 FROM operations_sequences AS sequence
         WHERE has_sequence_privilege(current_user, sequence.oid, 'USAGE')
            OR has_sequence_privilege(current_user, sequence.oid, 'SELECT')
            OR has_sequence_privilege(current_user, sequence.oid, 'UPDATE')
      ) AS "hasOperationsSequenceAccess",
      EXISTS (
        SELECT 1 FROM application_functions AS routine
         WHERE has_function_privilege(current_user, routine.oid, 'EXECUTE')
      ) AS "hasApplicationFunctionAccess",
      EXISTS (
        SELECT 1 FROM operations_functions AS routine
         WHERE has_function_privilege(current_user, routine.oid, 'EXECUTE')
      ) AS "hasOperationsFunctionAccess",
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.refobjid = role.oid
           AND dependency.deptype = 'a'
           AND NOT (
             dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
             AND dependency.objid = (
               SELECT database.oid FROM pg_catalog.pg_database AS database
                WHERE database.datname = pg_catalog.current_database()
             )
           )
      ) AS "hasUnsafeDirectAclDependencies",
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
         WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.refobjid IN (
             role.oid,
             pg_catalog.to_regrole('pintpath_maintenance')
           )
           AND dependency.deptype = 'o'
      ) AS "ownsDatabaseObjects",
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_default_acl AS defaults
         WHERE defaults.defaclrole IN (role.oid, pg_catalog.to_regrole('pintpath_maintenance'))
      ) AS "hasUnsafeDefaultPrivileges"
      FROM login_role AS role
  `).get<MaintenanceAuthorityRow>();
  const failures = [
    !row?.activeRoleExact ? "maintenance_role_not_active" : null,
    !row?.isMaintenanceMember ? "maintenance_role_missing" : null,
    row?.isRuntimeMember ? "runtime_role_overlap" : null,
    row?.isMigratorMember ? "migrator_role_overlap" : null,
    !row?.loginCanLogin ? "login_authority_missing" : null,
    row?.loginIsSuperuser ? "superuser_authority_present" : null,
    row?.loginCanCreateDatabase ? "database_create_authority_present" : null,
    row?.loginCanCreateRole ? "role_create_authority_present" : null,
    row?.loginInheritsPrivileges ? "inherit_authority_present" : null,
    row?.loginCanReplicate ? "replication_authority_present" : null,
    row?.loginBypassesRls ? "rls_bypass_authority_present" : null,
    row?.loginConnectionLimit !== 2 ? "connection_limit_invalid" : null,
    !row?.loginValidUntilNull ? "login_expiry_invalid" : null,
    !listsMatch(row?.loginMemberships, [POSTGRES_MAINTENANCE_ROLE])
      ? "membership_authority_invalid"
      : null,
    !row?.loginMembershipOptionsExact ? "membership_options_invalid" : null,
    !row?.maintenanceRoleSafe ? "maintenance_role_unsafe" : null,
    !listsMatch(row?.maintenanceRoleParents, []) ? "maintenance_role_parent_present" : null,
    row?.hasRoleSettings ? "role_setting_present" : null,
    !listsMatch(row?.insertTables, []) ? "insert_authority_invalid" : null,
    !listsMatch(row?.selectTables, POSTGRES_MAINTENANCE_SELECT_TABLES)
      ? "select_authority_invalid"
      : null,
    !listsMatch(row?.updateTables, POSTGRES_MAINTENANCE_UPDATE_TABLES)
      ? "update_authority_invalid"
      : null,
    !listsMatch(row?.deleteTables, POSTGRES_MAINTENANCE_DELETE_TABLES)
      ? "delete_authority_invalid"
      : null,
    !listsMatch(row?.directInsertTables, []) ? "direct_insert_authority_invalid" : null,
    !listsMatch(row?.directSelectTables, POSTGRES_MAINTENANCE_SELECT_TABLES)
      ? "direct_select_authority_invalid"
      : null,
    !listsMatch(row?.directUpdateTables, POSTGRES_MAINTENANCE_UPDATE_TABLES)
      ? "direct_update_authority_invalid"
      : null,
    !listsMatch(row?.directDeleteTables, POSTGRES_MAINTENANCE_DELETE_TABLES)
      ? "direct_delete_authority_invalid"
      : null,
    !row?.applicationSchemaAclExact ? "application_schema_acl_invalid" : null,
    row?.hasUnexpectedDirectTableAuthority ? "unexpected_table_authority_present" : null,
    row?.hasColumnAclEntries ? "column_acl_authority_present" : null,
    row?.hasUnexpectedMaintenanceAclDependency
      ? "maintenance_acl_dependency_present"
      : null,
    row?.hasGrantableAcl ? "grantable_acl_authority_present" : null,
    !row?.canUseApplicationSchema ? "application_schema_inaccessible" : null,
    row?.canCreateApplicationObjects ? "application_schema_create_authority_present" : null,
    row?.canUseOperationsSchema ? "operations_schema_accessible" : null,
    row?.canCreateOperationsObjects ? "operations_schema_create_authority_present" : null,
    !row?.canConnectDatabase ? "database_connect_authority_missing" : null,
    row?.canCreateDatabaseObjects ? "database_create_object_authority_present" : null,
    row?.canCreateTemporaryObjects ? "database_temporary_authority_present" : null,
    !row?.databaseAclExact ? "database_acl_authority_invalid" : null,
    row?.hasApplicationSequenceAccess ? "application_sequence_authority_present" : null,
    row?.hasOperationsSequenceAccess ? "operations_sequence_authority_present" : null,
    row?.hasApplicationFunctionAccess ? "application_function_authority_present" : null,
    row?.hasOperationsFunctionAccess ? "operations_function_authority_present" : null,
    row?.hasUnsafeDirectAclDependencies ? "direct_acl_authority_present" : null,
    row?.ownsDatabaseObjects ? "database_object_ownership_present" : null,
    row?.hasUnsafeDefaultPrivileges ? "default_privilege_authority_present" : null,
  ].filter((failure): failure is string => failure !== null);
  return { ready: failures.length === 0, failures };
}
