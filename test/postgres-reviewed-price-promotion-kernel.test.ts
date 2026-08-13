import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT,
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256,
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_RESTORE_SOURCE_DATABASE_OID_SETTING,
  sha256PostgresReviewedPricePromotionKernelMigration,
} from "../src/lib/postgres-reviewed-price-promotion-kernel.js";

const migrationPath = path.resolve(
  POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE,
);
const migrationBytes = fs.readFileSync(migrationPath);
const migrationSql = migrationBytes.toString("utf8");

describe("inert reviewed-price promotion kernel contract", () => {
  it("pins the sole executable migration authority by exact SHA-256", () => {
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_FILE).toBe(
      "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
    );
    expect(sha256PostgresReviewedPricePromotionKernelMigration(migrationBytes)).toBe(
      POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256,
    );
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.migrationSha256)
      .toBe(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_MIGRATION_SHA256);
  });

  it("declares the exact successor inventory without generating SQL", () => {
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.inventory).toEqual({
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
    });
    expect(Object.values(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables)
      .map((table) => table.qualifiedName)).toEqual([
      "pintpath_ops.reviewed_price_promotion_operations",
      "pintpath_ops.reviewed_price_promotion_rows",
    ]);
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.operations.columns)
      .toHaveLength(15);
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.rows.columns)
      .toHaveLength(11);
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.operations
      .primaryKey).toEqual(["operation_id"]);
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.tables.rows.primaryKey)
      .toEqual(["operation_id", "row_ordinal"]);
  });

  it("keeps every function owner-guarded and unconditionally disabled", () => {
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.activation).toEqual({
      mutationEnabled: false,
      callerMembershipCreated: false,
      requestInspected: false,
      relationReadByFunctions: false,
      relationWrittenByFunctions: false,
    });
    for (const functionContract of Object.values(
      POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.functions,
    )) {
      expect(functionContract).toMatchObject({
        identityArguments: "pg_catalog.jsonb",
        resultType: "pg_catalog.jsonb",
        securityDefiner: true,
        volatility: "volatile",
        parallel: "unsafe",
        strict: false,
        setReturning: false,
        searchPath: "pg_catalog",
      });
    }
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.failureContract)
      .toEqual({
        ownerGuardSqlState: "42501",
        ownerGuardMessage: "reviewed_price_promotion_kernel_owner_unsafe",
        disabledSqlState: "55000",
        disabledMessage: "reviewed_price_promotion_kernel_disabled",
      });
    expect(migrationSql).toContain("set local search_path = pg_catalog;");
    expect(migrationSql).toContain(
      POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_RESTORE_SOURCE_DATABASE_OID_SETTING,
    );
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_CONTRACT.restoreTransition)
      .toEqual({
        sourceDatabaseOidSetting:
          POSTGRES_REVIEWED_PRICE_PROMOTION_KERNEL_RESTORE_SOURCE_DATABASE_OID_SETTING,
        explicitSourceDatabaseOidRequiredForCrossDatabaseGuardRewrite: true,
        exactSourceGuardRequiredBeforeRewrite: true,
        targetDatabaseOidGuardRequiredAfterRewrite: true,
        transactionallyVerifiedBeforeCommit: true,
      });
    expect(migrationSql.match(/reviewed_price_promotion_kernel_disabled/g))
      .toHaveLength(2);
    expect(migrationSql).not.toMatch(
      /(?:insert\s+into|update|delete\s+from|truncate)\s+pintpath_ops\.reviewed_price_promotion_(?:operations|rows)/i,
    );
  });

  it("binds byte identities, RLS, ACLs, and transition postconditions", () => {
    expect(migrationSql.match(/collate pg_catalog\."C"/g)).toHaveLength(18);
    expect(migrationSql).toContain("force row level security");
    expect(migrationSql).toContain(
      "reviewed_price_promotion_kernel_inert_ledger_not_empty",
    );
    expect(migrationSql).toContain(
      "reviewed_price_promotion_kernel_schema_acl_unsafe",
    );
    expect(migrationSql).toContain(
      "reviewed_price_promotion_kernel_legacy_backup_authority_unsafe",
    );
    expect(migrationSql).toContain(
      "reviewed_price_promotion_kernel_fk_trigger_unsafe",
    );
    expect(migrationSql).toContain(
      "reviewed_price_promotion_kernel_column_collation_unsafe",
    );
    expect(migrationSql).toContain(
      "reviewed_price_promotion_kernel_publication_unsafe",
    );
    expect(migrationSql).toContain("routine.proargtypes[0] =");
    expect(migrationSql).toContain("'pg_catalog.jsonb'::pg_catalog.regtype::oid");
  });
});
