import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_MAINTENANCE_DELETE_TABLES,
  POSTGRES_MAINTENANCE_SELECT_TABLES,
  POSTGRES_MAINTENANCE_UPDATE_TABLES,
} from "../src/db/postgres-maintenance-runtime.js";

const migrationName = "20260812235959_add_privacy_maintenance_role.sql";
const migration = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations", migrationName),
  "utf8",
);

function migrationArray(name: string, nextName: string): string[] {
  const start = migration.indexOf(`${name} constant text[] := array[`);
  const end = migration.indexOf(nextName, start + name.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return Array.from(
    migration.slice(start, end).matchAll(/^    '([a-z_]+)',?$/gm),
    (match) => match[1]!,
  );
}

describe("Postgres privacy-maintenance migration", () => {
  it("runs after the inert kernel and before reviewed-price activation", () => {
    const names = fs.readdirSync(path.resolve(process.cwd(), "supabase/migrations"));
    expect(names.indexOf(migrationName)).toBeGreaterThan(
      names.indexOf("20260812022314_add_inert_reviewed_price_promotion_kernel.sql"),
    );
    expect(names.indexOf(migrationName)).toBeLessThan(
      names.indexOf("20260813000000_activate_reviewed_price_promotion_kernel.sql"),
    );
  });

  it("pins the runtime append-only and maintenance table ACL inventories", () => {
    expect(migrationArray("select_tables", "update_tables").sort()).toEqual(
      [...POSTGRES_MAINTENANCE_SELECT_TABLES].sort(),
    );
    expect(migrationArray("update_tables", "delete_tables").sort()).toEqual(
      [...POSTGRES_MAINTENANCE_UPDATE_TABLES].sort(),
    );
    expect(migrationArray("delete_tables", "runtime_role_oid").sort()).toEqual(
      [...POSTGRES_MAINTENANCE_DELETE_TABLES].sort(),
    );
    expect(migration).toContain(
      "revoke update, delete on pintpath_app.security_audit_log from pintpath_runtime;",
    );
    expect(migration).toContain(
      "revoke update, delete on pintpath_app.contribution_ledger from pintpath_runtime;",
    );
    expect(migration).toContain(
      "revoke update, delete on pintpath_app.pint_point_ledger from pintpath_runtime;",
    );
  });

  it("fails closed on role drift and grants no insert, function, or ops access", () => {
    expect(migration).toContain(
      "create role pintpath_maintenance\n      nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;",
    );
    expect(migration).toContain("revoke all on schema pintpath_ops from pintpath_maintenance;");
    expect(migration).toContain("revoke all on all functions in schema pintpath_app from pintpath_maintenance;");
    expect(migration).toContain("revoke all on all functions in schema pintpath_ops from pintpath_maintenance;");
    expect(migration).toContain("'pintpath_maintenance', pg_catalog.format('pintpath_app.%I', table_name), 'INSERT'");
    expect(migration).toContain(
      "alter policy schema_metadata_runtime_read on pintpath_app.schema_metadata\n    to pintpath_runtime, pintpath_maintenance using (true);",
    );
    expect(migration).toContain(
      "'pintpath_maintenance', 'pintpath_app.schema_metadata', 'SELECT'",
    );
    expect(migration).toContain("Privacy maintenance authority escaped its reviewed table-only boundary.");
    expect(migration).not.toMatch(/grant\s+insert\b[^;]*\bto\s+pintpath_maintenance/i);
    expect(migration).not.toMatch(/grant\s+execute\b[^;]*\bto\s+pintpath_maintenance/i);
  });
});
