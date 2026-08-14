import { describe, expect, it } from "vitest";

import {
  checkPostgresMaintenanceRuntimeReadiness,
  POSTGRES_MAINTENANCE_DELETE_TABLES,
  POSTGRES_MAINTENANCE_SELECT_TABLES,
  POSTGRES_MAINTENANCE_UPDATE_TABLES,
} from "../src/db/postgres-maintenance-runtime.js";
import type { SqlDatabase } from "../src/db/sql-database.js";

function database(row: Record<string, unknown>, dialect: "postgres" | "sqlite" = "postgres"): SqlDatabase {
  return {
    dialect,
    prepare: () => ({
      run: async () => ({ changes: 0 }),
      get: async () => row,
      all: async () => [],
    }),
    exec: async () => undefined,
    transaction: (work) => async () => work(),
    close: async () => undefined,
    metrics: () => ({
      dialect,
      totalConnections: 1,
      idleConnections: 1,
      waitingRequests: 0,
      completedQueries: 1,
      failedQueries: 0,
      transactionFailures: 0,
      lastQueryDurationMs: 1,
    }),
  };
}

const safeAuthority = {
  activeRoleExact: true,
  isMaintenanceMember: true,
  isRuntimeMember: false,
  isMigratorMember: false,
  loginCanLogin: true,
  loginIsSuperuser: false,
  loginCanCreateDatabase: false,
  loginCanCreateRole: false,
  loginInheritsPrivileges: false,
  loginCanReplicate: false,
  loginBypassesRls: false,
  loginConnectionLimit: 2,
  loginValidUntilNull: true,
  loginMemberships: ["pintpath_maintenance"],
  loginMembershipOptionsExact: true,
  maintenanceRoleSafe: true,
  maintenanceRoleParents: [],
  hasRoleSettings: false,
  insertTables: [],
  selectTables: [...POSTGRES_MAINTENANCE_SELECT_TABLES],
  updateTables: [...POSTGRES_MAINTENANCE_UPDATE_TABLES],
  deleteTables: [...POSTGRES_MAINTENANCE_DELETE_TABLES],
  directInsertTables: [],
  directSelectTables: [...POSTGRES_MAINTENANCE_SELECT_TABLES],
  directUpdateTables: [...POSTGRES_MAINTENANCE_UPDATE_TABLES],
  directDeleteTables: [...POSTGRES_MAINTENANCE_DELETE_TABLES],
  applicationSchemaAclExact: true,
  hasUnexpectedDirectTableAuthority: false,
  hasColumnAclEntries: false,
  hasUnexpectedMaintenanceAclDependency: false,
  hasGrantableAcl: false,
  canUseApplicationSchema: true,
  canCreateApplicationObjects: false,
  canUseOperationsSchema: false,
  canCreateOperationsObjects: false,
  canConnectDatabase: true,
  canCreateDatabaseObjects: false,
  canCreateTemporaryObjects: false,
  databaseAclExact: true,
  hasApplicationSequenceAccess: false,
  hasOperationsSequenceAccess: false,
  hasApplicationFunctionAccess: false,
  hasOperationsFunctionAccess: false,
  hasUnsafeDirectAclDependencies: false,
  ownsDatabaseObjects: false,
  hasUnsafeDefaultPrivileges: false,
};

describe("Postgres privacy-maintenance authority", () => {
  it("accepts the exact isolated retention and erasure role shape", async () => {
    await expect(checkPostgresMaintenanceRuntimeReadiness(database(safeAuthority)))
      .resolves.toEqual({ ready: true, failures: [] });
  });

  it("rejects role overlap, unsafe login attributes, and excess object authority", async () => {
    const result = await checkPostgresMaintenanceRuntimeReadiness(database({
      ...safeAuthority,
      activeRoleExact: false,
      isRuntimeMember: true,
      isMigratorMember: true,
      loginCanLogin: false,
      loginIsSuperuser: true,
      loginCanCreateDatabase: true,
      loginCanCreateRole: true,
      loginInheritsPrivileges: true,
      loginCanReplicate: true,
      loginBypassesRls: true,
      loginConnectionLimit: -1,
      loginValidUntilNull: false,
      loginMemberships: ["pintpath_maintenance", "latent_noinherit_role"],
      loginMembershipOptionsExact: false,
      maintenanceRoleSafe: false,
      maintenanceRoleParents: ["latent_parent"],
      hasRoleSettings: true,
      insertTables: ["accounts"],
      directInsertTables: ["accounts"],
      directSelectTables: POSTGRES_MAINTENANCE_SELECT_TABLES.slice(1),
      directUpdateTables: [...POSTGRES_MAINTENANCE_UPDATE_TABLES, "venue_price_records"],
      directDeleteTables: POSTGRES_MAINTENANCE_DELETE_TABLES.slice(1),
      applicationSchemaAclExact: false,
      hasUnexpectedDirectTableAuthority: true,
      hasColumnAclEntries: true,
      hasUnexpectedMaintenanceAclDependency: true,
      hasGrantableAcl: true,
      canUseApplicationSchema: false,
      canCreateApplicationObjects: true,
      canUseOperationsSchema: true,
      canCreateOperationsObjects: true,
      canConnectDatabase: false,
      canCreateDatabaseObjects: true,
      canCreateTemporaryObjects: true,
      databaseAclExact: false,
      hasApplicationSequenceAccess: true,
      hasOperationsSequenceAccess: true,
      hasApplicationFunctionAccess: true,
      hasOperationsFunctionAccess: true,
      hasUnsafeDirectAclDependencies: true,
      ownsDatabaseObjects: true,
      hasUnsafeDefaultPrivileges: true,
    }));
    expect(result.ready).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "maintenance_role_not_active",
      "runtime_role_overlap",
      "migrator_role_overlap",
      "login_authority_missing",
      "superuser_authority_present",
      "database_create_authority_present",
      "role_create_authority_present",
      "inherit_authority_present",
      "replication_authority_present",
      "rls_bypass_authority_present",
      "connection_limit_invalid",
      "login_expiry_invalid",
      "membership_authority_invalid",
      "membership_options_invalid",
      "maintenance_role_unsafe",
      "maintenance_role_parent_present",
      "role_setting_present",
      "insert_authority_invalid",
      "direct_insert_authority_invalid",
      "direct_select_authority_invalid",
      "direct_update_authority_invalid",
      "direct_delete_authority_invalid",
      "application_schema_acl_invalid",
      "unexpected_table_authority_present",
      "column_acl_authority_present",
      "maintenance_acl_dependency_present",
      "grantable_acl_authority_present",
      "application_schema_inaccessible",
      "application_schema_create_authority_present",
      "operations_schema_accessible",
      "operations_schema_create_authority_present",
      "database_connect_authority_missing",
      "database_create_object_authority_present",
      "database_temporary_authority_present",
      "database_acl_authority_invalid",
      "application_sequence_authority_present",
      "operations_sequence_authority_present",
      "application_function_authority_present",
      "operations_function_authority_present",
      "direct_acl_authority_present",
      "database_object_ownership_present",
      "default_privilege_authority_present",
    ]));
  });

  it("rejects latent NOINHERIT memberships even when effective table grants look exact", async () => {
    const result = await checkPostgresMaintenanceRuntimeReadiness(database({
      ...safeAuthority,
      loginMemberships: ["pintpath_maintenance", "pintpath_migrator"],
    }));
    expect(result).toEqual({
      ready: false,
      failures: ["membership_authority_invalid"],
    });
  });

  it("rejects missing or excess table operations", async () => {
    const result = await checkPostgresMaintenanceRuntimeReadiness(database({
      ...safeAuthority,
      selectTables: POSTGRES_MAINTENANCE_SELECT_TABLES.slice(1),
      updateTables: [...POSTGRES_MAINTENANCE_UPDATE_TABLES, "venue_price_records"],
      deleteTables: POSTGRES_MAINTENANCE_DELETE_TABLES.slice(1),
    }));
    expect(result.failures).toEqual([
      "select_authority_invalid",
      "update_authority_invalid",
      "delete_authority_invalid",
    ]);
  });

  it("rejects a group-role ACL or ownership dependency outside the reviewed schema", async () => {
    const aclResult = await checkPostgresMaintenanceRuntimeReadiness(database({
      ...safeAuthority,
      hasUnexpectedMaintenanceAclDependency: true,
    }));
    expect(aclResult.failures).toEqual(["maintenance_acl_dependency_present"]);

    const ownershipResult = await checkPostgresMaintenanceRuntimeReadiness(database({
      ...safeAuthority,
      ownsDatabaseObjects: true,
    }));
    expect(ownershipResult.failures).toEqual(["database_object_ownership_present"]);
  });

  it("rejects non-Postgres connections before querying", async () => {
    await expect(checkPostgresMaintenanceRuntimeReadiness(database(safeAuthority, "sqlite")))
      .resolves.toEqual({ ready: false, failures: ["not_postgres"] });
  });
});
