import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
if (process.env[REQUIRED_ENV] === "true" && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is required when ${REQUIRED_ENV}=true.`);
}

const suffix = crypto.randomBytes(6).toString("hex");
const databaseName = `pintpath_activation_${suffix}`;
const migrationLogin = `pintpath_supabase_migration_${suffix}`;
const runtimeLogin = `pintpath_runtime_login_${suffix}`;
const reviewerLogin = `pintpath_reviewer_login_${suffix}`;
const operatorLogin = `pintpath_operator_login_${suffix}`;
const verifierMembershipProbe = `pintpath_verifier_membership_probe_${suffix}`;
const password = `PintpathActivation-${suffix}-Test`;
const verifierAuthorityMigrationPath = path.resolve(
  "supabase/migrations/20260813165508_add_postgres_migration_verifier_authority.sql",
);
const sqlFiles = [
  "src/db/postgres-schema.sql",
  "supabase/migrations/20260810003612_add_pintpath_logical_backup_role.sql",
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
  "supabase/migrations/20260812235959_add_privacy_maintenance_role.sql",
  "supabase/migrations/20260813000000_activate_reviewed_price_promotion_kernel.sql",
  "supabase/migrations/20260813165508_add_postgres_migration_verifier_authority.sql",
] as const;

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe_test_identifier");
  return `"${value}"`;
}

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be a disposable loopback PostgreSQL URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    )
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || !url.password
    || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash
    || /[\r\n\0]/.test(value)
  ) throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`);
  return url;
}

function withDatabase(url: URL, database: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result.toString();
}

function loginUrl(adminUrl: URL, role: string): string {
  const result = new URL(withDatabase(adminUrl, databaseName));
  result.username = role;
  result.password = password;
  return result.toString();
}

function databaseLoginUrl(adminUrl: URL, database: string, role: string): string {
  const result = new URL(withDatabase(adminUrl, database));
  result.username = role;
  result.password = password;
  return result.toString();
}

async function expectDenied(work: () => Promise<unknown>): Promise<void> {
  const error = await work().then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as { code?: string }).code).toMatch(/^(42501|42P01)$/);
}

describe.skipIf(!configuredAdminUrl)(
  "activated reviewed-price and current-role boundary on real PostgreSQL 17",
  () => {
    let cluster: Client;
    let database: Client;
    let runtime: Client;
    let reviewer: Client;
    let operator: Client;
    let databaseOid = "";
    let backupRole = "";
    let reviewerExecute = "";
    let applyExecute = "";
    let quarantineExecute = "";
    let applyOwner = "";
    let quarantineOwner = "";
    let bootstrapMembershipEdgeCount = "";
    let ownsRoleNamespace = false;

    beforeAll(async () => {
      const adminUrl = validateAdminUrl(configuredAdminUrl);
      cluster = new Client({ connectionString: adminUrl.toString() });
      await cluster.connect();
      const version = await cluster.query<{ version: string }>(
        "select current_setting('server_version_num') as version",
      );
      if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
        throw new Error("Activation integration requires PostgreSQL 17.");
      }
      const fixedRoles = [
        "pintpath_runtime",
        "pintpath_migrator",
        "pintpath_migration_verifier_authority",
        "pintpath_maintenance",
      ];
      const existing = await cluster.query<{ roleName: string }>(
        "select rolname as \"roleName\" from pg_roles where rolname = any($1::text[])",
        [fixedRoles],
      );
      if (existing.rowCount !== 0) throw new Error("activation_test_role_collision");
      ownsRoleNamespace = true;
      await cluster.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      for (const role of [runtimeLogin, reviewerLogin, operatorLogin, migrationLogin]) {
        await cluster.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
      }
      await cluster.query(`CREATE ROLE ${quoteIdentifier(migrationLogin)} LOGIN
        PASSWORD '${password}' NOSUPERUSER CREATEDB CREATEROLE INHERIT
        REPLICATION BYPASSRLS CONNECTION LIMIT 1`);
      await cluster.query(
        `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(migrationLogin)}`,
      );
      database = new Client({
        connectionString: databaseLoginUrl(adminUrl, databaseName, migrationLogin),
      });
      await database.connect();
      await database.query("create schema if not exists extensions");
      await database.query("create extension if not exists pgcrypto with schema extensions");
      for (const filename of sqlFiles) {
        await database.query(fs.readFileSync(path.resolve(filename), "utf8"));
      }
      const oid = await database.query<{ oid: string }>(
        "select oid::text as oid from pg_database where datname=current_database()",
      );
      databaseOid = oid.rows[0]!.oid;
      backupRole = `pintpath_logical_backup_d${databaseOid}`;
      reviewerExecute = `pintpath_reviewed_price_reviewer_execute_d${databaseOid}`;
      applyExecute = `pintpath_reviewed_price_apply_execute_d${databaseOid}`;
      quarantineExecute = `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`;
      applyOwner = `pintpath_reviewed_price_apply_owner_d${databaseOid}`;
      quarantineOwner = `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`;
      const bootstrapMemberships = await database.query<{ edgeCount: string }>(
        `select count(*)::text as "edgeCount"
          from pg_roles role
          join pg_auth_members membership
            on membership.roleid = role.oid or membership.member = role.oid
          where role.rolname = any($1::text[])`,
        [[
          reviewerExecute,
          applyExecute,
          quarantineExecute,
          applyOwner,
          quarantineOwner,
        ]],
      );
      bootstrapMembershipEdgeCount = bootstrapMemberships.rows[0]!.edgeCount;
      for (const role of [runtimeLogin, reviewerLogin, operatorLogin]) {
        await database.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN
          PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
          NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1`);
        await database.query(
          `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(role)}`,
        );
      }
      await database.query(`GRANT pintpath_runtime TO ${quoteIdentifier(runtimeLogin)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await database.query(`GRANT ${quoteIdentifier(reviewerExecute)}
        TO ${quoteIdentifier(reviewerLogin)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      for (const role of [applyExecute, quarantineExecute]) {
        await database.query(`GRANT ${quoteIdentifier(role)}
          TO ${quoteIdentifier(operatorLogin)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      }
      runtime = new Client({ connectionString: loginUrl(adminUrl, runtimeLogin) });
      reviewer = new Client({ connectionString: loginUrl(adminUrl, reviewerLogin) });
      operator = new Client({ connectionString: loginUrl(adminUrl, operatorLogin) });
      await runtime.connect();
      await reviewer.connect();
      await operator.connect();
    }, 30_000);

    afterAll(async () => {
      const failures: unknown[] = [];
      for (const client of [runtime, reviewer, operator, database]) {
        await client?.end().catch((error) => failures.push(error));
      }
      try {
        await cluster?.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
        if (ownsRoleNamespace) {
          for (const role of [
            runtimeLogin,
            reviewerLogin,
            operatorLogin,
            reviewerExecute,
            applyExecute,
            quarantineExecute,
            applyOwner,
            quarantineOwner,
            backupRole,
            "pintpath_maintenance",
            verifierMembershipProbe,
            "pintpath_migration_verifier_authority",
            "pintpath_migrator",
            "pintpath_runtime",
            migrationLogin,
          ]) {
            if (role) await cluster.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
          }
        }
      } catch (error) {
        failures.push(error);
      }
      await cluster?.end().catch((error) => failures.push(error));
      if (failures.length > 0) throw failures[0];
    }, 30_000);

    it("keeps external logins inert until the exact startup role is active", async () => {
      await expectDenied(() => runtime.query("select value from pintpath_app.schema_metadata"));
      const identity = await runtime.query<{ sessionRole: string; activeRole: string }>(
        `select session_user::text as "sessionRole", current_user::text as "activeRole"`,
      );
      expect(identity.rows[0]).toEqual({ sessionRole: runtimeLogin, activeRole: runtimeLogin });
      await runtime.query("set role pintpath_runtime");
      const active = await runtime.query<{ sessionRole: string; activeRole: string }>(
        `select session_user::text as "sessionRole", current_user::text as "activeRole"`,
      );
      expect(active.rows[0]).toEqual({ sessionRole: runtimeLogin, activeRole: "pintpath_runtime" });
      await expect(runtime.query("select value from pintpath_app.schema_metadata limit 1"))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(runtime.query("select count(*) from pintpath_app.venue_price_records"))
        .resolves.toMatchObject({ rowCount: 1 });
    });

    it("exposes each protected function only through its exact execute role", async () => {
      await expectDenied(() => reviewer.query(
        "select pintpath_ops.authorize_reviewed_price_promotion('{}'::jsonb)",
      ));
      await reviewer.query(`set role ${quoteIdentifier(reviewerExecute)}`);
      const reviewerError = await reviewer.query(
        "select pintpath_ops.authorize_reviewed_price_promotion('{}'::jsonb)",
      ).then(() => null, (error: unknown) => error);
      expect(reviewerError).toBeInstanceOf(Error);
      expect((reviewerError as { code?: string }).code).not.toBe("42501");

      await operator.query(`set role ${quoteIdentifier(applyExecute)}`);
      const applyError = await operator.query(
        "select pintpath_ops.apply_reviewed_price_promotion('{}'::jsonb)",
      ).then(() => null, (error: unknown) => error);
      expect(applyError).toBeInstanceOf(Error);
      expect((applyError as { code?: string }).code).not.toBe("42501");
      await expectDenied(() => operator.query(
        "select count(*) from pintpath_ops.reviewed_price_promotion_operations",
      ));
    });

    it("preserves exact activated policy and owner authority inventory", async () => {
      const result = await database.query<{
        authorityForceRls: boolean;
        authorityPolicyCount: string;
        authorityPublicPolicyCount: string;
        authorityRowCount: string;
        authorityManagedAdminOnlyEdges: string;
        authorityTotalMembershipEdges: string;
        policyCount: string;
        publicPolicyCount: string;
        safeScopedRoles: string;
        managedAdminOnlyEdges: string;
        totalScopedMembershipEdges: string;
        ownerExtensionsUsageCount: string;
        protectedFunctionCount: string;
      }>(`select
        (select relation.relrowsecurity and relation.relforcerowsecurity
          from pg_class relation
          where relation.oid =
            'pintpath_ops.migration_verifier_authority'::regclass)
          as "authorityForceRls",
        (select count(*)::text from pg_policy policy
          where policy.polrelid =
            'pintpath_ops.migration_verifier_authority'::regclass)
          as "authorityPolicyCount",
        (select count(*)::text from pg_policy policy
          where policy.polrelid =
              'pintpath_ops.migration_verifier_authority'::regclass
            and policy.polroles = array[0]::oid[])
          as "authorityPublicPolicyCount",
        (select count(*)::text
          from pintpath_ops.migration_verifier_authority)
          as "authorityRowCount",
        (select count(*)::text
          from pg_auth_members membership
          join pg_roles grantor on grantor.oid = membership.grantor
          where membership.roleid =
              'pintpath_migration_verifier_authority'::regrole
            and membership.member = $2::regrole
            and membership.grantor = 10::oid
            and grantor.rolsuper
            and membership.admin_option
            and not membership.inherit_option
            and not membership.set_option)
          as "authorityManagedAdminOnlyEdges",
        (select count(*)::text
          from pg_auth_members membership
          where membership.roleid =
                'pintpath_migration_verifier_authority'::regrole
             or membership.member =
                'pintpath_migration_verifier_authority'::regrole)
          as "authorityTotalMembershipEdges",
        (select count(*)::text from pg_policy policy
          join pg_class relation on relation.oid=policy.polrelid
          join pg_namespace namespace on namespace.oid=relation.relnamespace
          where namespace.nspname in ('pintpath_app','pintpath_ops')) as "policyCount",
        (select count(*)::text from pg_policy policy
          join pg_class relation on relation.oid=policy.polrelid
          join pg_namespace namespace on namespace.oid=relation.relnamespace
          where namespace.nspname in ('pintpath_app','pintpath_ops')
            and policy.polroles=array[0]::oid[]) as "publicPolicyCount",
        (select count(*)::text from pg_roles role
          where role.rolname = any($1::text[])
            and not role.rolcanlogin and not role.rolsuper and not role.rolcreatedb
            and not role.rolcreaterole and not role.rolinherit
            and not role.rolreplication and not role.rolbypassrls) as "safeScopedRoles",
        (select count(*)::text
          from pg_roles role
          join pg_auth_members membership on membership.roleid = role.oid
          join pg_roles grantor on grantor.oid = membership.grantor
          where role.rolname = any($1::text[])
            and membership.member = $2::regrole
            and membership.grantor = 10::oid
            and grantor.rolsuper
            and membership.admin_option
            and not membership.inherit_option
            and not membership.set_option) as "managedAdminOnlyEdges",
        (select count(*)::text
          from pg_roles role
          join pg_auth_members membership
            on membership.roleid = role.oid or membership.member = role.oid
          where role.rolname = any($1::text[])) as "totalScopedMembershipEdges",
        (select count(*)::text
          from unnest(array[$3::text, $4::text]) role_name
          where has_schema_privilege(role_name, 'extensions', 'USAGE'))
          as "ownerExtensionsUsageCount",
        (select count(*)::text from pg_proc routine
          join pg_namespace namespace on namespace.oid=routine.pronamespace
          where namespace.nspname='pintpath_ops'
            and routine.proname = any(array[
              'authorize_reviewed_price_promotion','apply_reviewed_price_promotion',
              'quarantine_reviewed_price_promotion'
            ]) and routine.prosecdef) as "protectedFunctionCount"`, [[
        reviewerExecute,
        applyExecute,
        quarantineExecute,
        applyOwner,
        quarantineOwner,
      ], migrationLogin, applyOwner, quarantineOwner]);
      expect(result.rows[0]).toEqual({
        authorityForceRls: true,
        authorityPolicyCount: "4",
        authorityPublicPolicyCount: "0",
        authorityRowCount: "0",
        authorityManagedAdminOnlyEdges: "1",
        authorityTotalMembershipEdges: "1",
        policyCount: "244",
        publicPolicyCount: "71",
        safeScopedRoles: "5",
        managedAdminOnlyEdges: "5",
        totalScopedMembershipEdges: "8",
        ownerExtensionsUsageCount: "0",
        protectedFunctionCount: "3",
      });
      expect(bootstrapMembershipEdgeCount).toBe("5");
    });

    it("rejects every additional verifier-authority membership edge", async () => {
      await database.query(`CREATE ROLE ${quoteIdentifier(verifierMembershipProbe)}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1`);
      try {
        await database.query(`GRANT pintpath_migration_verifier_authority
          TO ${quoteIdentifier(verifierMembershipProbe)}
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
        const migrationError = await database.query(
          fs.readFileSync(verifierAuthorityMigrationPath, "utf8"),
        ).then(() => null, (error: unknown) => error);
        expect(migrationError).toBeInstanceOf(Error);
        expect(migrationError).toMatchObject({
          code: "42501",
          message: "postgres_migration_verifier_authority_boundary_invalid",
        });
      } finally {
        await database.query("rollback");
        await database.query(`REVOKE pintpath_migration_verifier_authority
          FROM ${quoteIdentifier(verifierMembershipProbe)}`);
        await database.query(`DROP ROLE ${quoteIdentifier(verifierMembershipProbe)}`);
      }
    });
  },
);
