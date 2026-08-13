import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  postgresReviewedPricePromotionOperatorInternals,
} from "../scripts/postgres-reviewed-price-promotion-operator.js";

const ADMIN_URL_ENV =
  "PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_ADMIN_URL";
const REQUIRED_ENV =
  "PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";
const suffix = `${process.pid}_${crypto.randomBytes(5).toString("hex")}`;
const superDatabase = `pintpath_kernel_super_${suffix}`;
const siblingDatabase = `pintpath_kernel_sibling_${suffix}`;
const mixedDatabase = `pintpath_kernel_mixed_${suffix}`;
const poisonDatabase = `pintpath_kernel_poison_${suffix}`;
const policyDatabase = `pintpath_kernel_policy_${suffix}`;
const policyOwner = `pintpath_kernel_policy_owner_${suffix}`;
const restoreSourceDatabase = `pintpath_kernel_restore_source_${suffix}`;
const restoreTargetDatabase = `pintpath_kernel_restore_target_${suffix}`;
const restorePolicyOwner = `pintpath_kernel_restore_owner_${suffix}`;
const explicitPublication = `pintpath_kernel_explicit_${suffix}`;
const allTablesPublication = `pintpath_kernel_all_${suffix}`;
const schemaPublication = `pintpath_kernel_schema_${suffix}`;
const schemaSql = fs.readFileSync(
  path.resolve("src/db/postgres-schema.sql"),
  "utf8",
);

describe.skipIf(!configuredAdminUrl)(
  "reviewed-price operator login authority on real PostgreSQL 17",
  () => {
    const authorityDatabase = `pintpath_operator_authority_${suffix}`;
    const operatorLogin = `pintpath_operator_login_${suffix}`;
    const reviewerLogin = `pintpath_reviewer_login_${suffix}`;
    const extraRole = `pintpath_operator_extra_${suffix}`;
    let maintenance: Client;
    let databaseAdmin: Client;
    let operator: Client;
    let reviewer: Client;
    let adminRole = "";
    let oid = "";
    let reviewerExecute = "";
    let applyExecute = "";
    let quarantineExecute = "";

    const verifyOperator = async (): Promise<void> => {
      await postgresReviewedPricePromotionOperatorInternals
        .verifyReviewedPriceLoginAuthority(operator, {
          databaseOid: oid,
          kind: "operator",
          loginRole: operatorLogin,
        });
    };

    beforeAll(async () => {
      const adminUrl = validateAdminUrl(configuredAdminUrl);
      maintenance = new Client({ connectionString: adminUrl.toString() });
      await maintenance.connect();
      await maintenance.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(authorityDatabase)} WITH (FORCE)`,
      );
      for (const role of [operatorLogin, reviewerLogin, extraRole]) {
        await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
      }
      await maintenance.query(`CREATE DATABASE ${quoteIdentifier(authorityDatabase)}`);
      databaseAdmin = new Client({
        connectionString: withDatabase(adminUrl, authorityDatabase),
      });
      await databaseAdmin.connect();
      const version = await databaseAdmin.query<{ version: string; adminRole: string }>(
        `SELECT current_setting('server_version_num') AS version,
                current_user::text AS "adminRole"`,
      );
      if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
        throw new Error("Reviewed-price authority integration requires PostgreSQL 17.");
      }
      adminRole = version.rows[0]!.adminRole;
      oid = await databaseOid(databaseAdmin);
      reviewerExecute = `pintpath_reviewed_price_reviewer_execute_d${oid}`;
      applyExecute = `pintpath_reviewed_price_apply_execute_d${oid}`;
      quarantineExecute = `pintpath_reviewed_price_quarantine_execute_d${oid}`;
      for (const role of [
        reviewerExecute,
        applyExecute,
        quarantineExecute,
        extraRole,
      ]) {
        await databaseAdmin.query(`CREATE ROLE ${quoteIdentifier(role)}
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
          NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1`);
      }
      await databaseAdmin.query(`CREATE ROLE ${quoteIdentifier(operatorLogin)}
        LOGIN PASSWORD 'operator-authority-test-password'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1 VALID UNTIL 'tomorrow'`);
      await databaseAdmin.query(`CREATE ROLE ${quoteIdentifier(reviewerLogin)}
        LOGIN PASSWORD 'reviewer-authority-test-password'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1 VALID UNTIL 'tomorrow'`);
      await databaseAdmin.query("CREATE SCHEMA pintpath_ops");
      await databaseAdmin.query(`CREATE FUNCTION
        pintpath_ops.authorize_reviewed_price_promotion(pg_catalog.jsonb)
        RETURNS pg_catalog.jsonb LANGUAGE sql AS 'SELECT $1'`);
      await databaseAdmin.query(`CREATE FUNCTION
        pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb)
        RETURNS pg_catalog.jsonb LANGUAGE sql AS 'SELECT $1'`);
      await databaseAdmin.query(`CREATE FUNCTION
        pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb)
        RETURNS pg_catalog.jsonb LANGUAGE sql AS 'SELECT $1'`);
      await databaseAdmin.query(`CREATE TABLE pintpath_ops.authority_probe (
        id pg_catalog.int4 PRIMARY KEY,
        value pg_catalog.text NOT NULL
      )`);
      await databaseAdmin.query(
        "CREATE SEQUENCE pintpath_ops.authority_probe_sequence",
      );
      await databaseAdmin.query(
        "CREATE TYPE pintpath_ops.authority_probe_type AS ENUM ('probe')",
      );
      await databaseAdmin.query(
        `REVOKE ALL ON DATABASE ${quoteIdentifier(authorityDatabase)} FROM PUBLIC`,
      );
      await databaseAdmin.query("REVOKE ALL ON SCHEMA pintpath_ops FROM PUBLIC");
      await databaseAdmin.query(
        "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pintpath_ops FROM PUBLIC",
      );
      await databaseAdmin.query(
        "REVOKE ALL ON TYPE pintpath_ops.authority_probe_type FROM PUBLIC",
      );
      await databaseAdmin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(authorityDatabase)}
          TO ${quoteIdentifier(operatorLogin)}, ${quoteIdentifier(reviewerLogin)}`,
      );
      await databaseAdmin.query(`GRANT ${quoteIdentifier(reviewerExecute)}
        TO ${quoteIdentifier(reviewerLogin)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      for (const role of [applyExecute, quarantineExecute]) {
        await databaseAdmin.query(`GRANT ${quoteIdentifier(role)}
          TO ${quoteIdentifier(operatorLogin)}
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      }
      for (const role of [reviewerExecute, applyExecute, quarantineExecute]) {
        await databaseAdmin.query(
          `GRANT USAGE ON SCHEMA pintpath_ops TO ${quoteIdentifier(role)}`,
        );
      }
      await databaseAdmin.query(`GRANT EXECUTE ON FUNCTION
        pintpath_ops.authorize_reviewed_price_promotion(pg_catalog.jsonb)
        TO ${quoteIdentifier(reviewerExecute)}`);
      await databaseAdmin.query(`GRANT EXECUTE ON FUNCTION
        pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb)
        TO ${quoteIdentifier(applyExecute)}`);
      await databaseAdmin.query(`GRANT EXECUTE ON FUNCTION
        pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb)
        TO ${quoteIdentifier(quarantineExecute)}`);

      const operatorUrl = new URL(withDatabase(adminUrl, authorityDatabase));
      operatorUrl.username = operatorLogin;
      operatorUrl.password = "operator-authority-test-password";
      operator = new Client({ connectionString: operatorUrl.toString() });
      await operator.connect();
      const reviewerUrl = new URL(withDatabase(adminUrl, authorityDatabase));
      reviewerUrl.username = reviewerLogin;
      reviewerUrl.password = "reviewer-authority-test-password";
      reviewer = new Client({ connectionString: reviewerUrl.toString() });
      await reviewer.connect();
    }, 30_000);

    afterAll(async () => {
      const failures: unknown[] = [];
      await operator?.end().catch((error) => failures.push(error));
      await reviewer?.end().catch((error) => failures.push(error));
      await databaseAdmin?.end().catch((error) => failures.push(error));
      try {
        await maintenance?.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(authorityDatabase)} WITH (FORCE)`,
        );
        for (const role of [
          operatorLogin,
          reviewerLogin,
          reviewerExecute,
          applyExecute,
          quarantineExecute,
          extraRole,
        ]) {
          if (role) {
            await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
          }
        }
      } catch (error) {
        failures.push(error);
      }
      await maintenance?.end().catch((error) => failures.push(error));
      if (failures.length > 0) throw failures[0];
    }, 30_000);

    it("accepts only the canonical reviewer and operator memberships", async () => {
      await expect(verifyOperator()).resolves.toBeUndefined();
      await expect(
        postgresReviewedPricePromotionOperatorInternals
          .verifyReviewedPriceLoginAuthority(reviewer, {
            databaseOid: oid,
            kind: "reviewer",
            loginRole: reviewerLogin,
          }),
      ).resolves.toBeUndefined();

      await databaseAdmin.query(`GRANT ${quoteIdentifier(applyExecute)}
        TO ${quoteIdentifier(operatorLogin)}
        WITH ADMIN FALSE, INHERIT TRUE, SET TRUE`);
      await expect(verifyOperator()).rejects.toThrow("database_role_invalid");
      await databaseAdmin.query(`GRANT ${quoteIdentifier(applyExecute)}
        TO ${quoteIdentifier(operatorLogin)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await expect(verifyOperator()).resolves.toBeUndefined();

      await databaseAdmin.query(`GRANT ${quoteIdentifier(extraRole)}
        TO ${quoteIdentifier(applyExecute)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await expect(verifyOperator()).rejects.toThrow("database_role_invalid");
      await databaseAdmin.query(
        `REVOKE ${quoteIdentifier(extraRole)} FROM ${quoteIdentifier(applyExecute)}`,
      );
      await expect(verifyOperator()).resolves.toBeUndefined();

      await databaseAdmin.query(`ALTER ROLE ${quoteIdentifier(operatorLogin)}
        IN DATABASE ${quoteIdentifier(authorityDatabase)}
        SET statement_timeout = '1s'`);
      await expect(verifyOperator()).rejects.toThrow("database_role_invalid");
      await databaseAdmin.query(`ALTER ROLE ${quoteIdentifier(operatorLogin)}
        IN DATABASE ${quoteIdentifier(authorityDatabase)} RESET ALL`);
      await expect(verifyOperator()).resolves.toBeUndefined();

      await databaseAdmin.query(`ALTER DATABASE ${quoteIdentifier(authorityDatabase)}
        SET statement_timeout = '1s'`);
      await expect(verifyOperator()).rejects.toThrow("database_role_invalid");
      await databaseAdmin.query(`ALTER DATABASE ${quoteIdentifier(authorityDatabase)}
        RESET ALL`);
      await expect(verifyOperator()).resolves.toBeUndefined();

      await databaseAdmin.query(
        `ALTER ROLE ${quoteIdentifier(operatorLogin)} INHERIT`,
      );
      await expect(verifyOperator()).rejects.toThrow("database_role_invalid");
      await databaseAdmin.query(
        `ALTER ROLE ${quoteIdentifier(operatorLogin)} NOINHERIT`,
      );
      await expect(verifyOperator()).resolves.toBeUndefined();
    });

    it("rejects every direct database and private-object authority addition", async () => {
      const cases = [
        {
          grant: `GRANT CONNECT ON DATABASE postgres
            TO ${quoteIdentifier(operatorLogin)}`,
          revoke: `REVOKE CONNECT ON DATABASE postgres
            FROM ${quoteIdentifier(operatorLogin)}`,
        },
        {
          grant: `GRANT CREATE, TEMP ON DATABASE ${quoteIdentifier(authorityDatabase)}
            TO ${quoteIdentifier(operatorLogin)}`,
          revoke: `REVOKE CREATE, TEMP ON DATABASE ${quoteIdentifier(authorityDatabase)}
            FROM ${quoteIdentifier(operatorLogin)}`,
        },
        {
          grant: `GRANT USAGE ON SCHEMA pintpath_ops
            TO ${quoteIdentifier(operatorLogin)}`,
          revoke: `REVOKE USAGE ON SCHEMA pintpath_ops
            FROM ${quoteIdentifier(operatorLogin)}`,
        },
        {
          grant: `GRANT SELECT ON TABLE pintpath_ops.authority_probe
            TO ${quoteIdentifier(operatorLogin)}`,
          revoke: `REVOKE SELECT ON TABLE pintpath_ops.authority_probe
            FROM ${quoteIdentifier(operatorLogin)}`,
        },
        {
          grant: `GRANT SELECT ON TABLE pintpath_ops.authority_probe
            TO ${quoteIdentifier(applyExecute)}`,
          revoke: `REVOKE SELECT ON TABLE pintpath_ops.authority_probe
            FROM ${quoteIdentifier(applyExecute)}`,
        },
        {
          grant: `GRANT SELECT(value) ON TABLE pintpath_ops.authority_probe
            TO ${quoteIdentifier(operatorLogin)}`,
          revoke: `REVOKE SELECT(value) ON TABLE pintpath_ops.authority_probe
            FROM ${quoteIdentifier(operatorLogin)}`,
        },
        {
          grant: `GRANT USAGE ON SEQUENCE pintpath_ops.authority_probe_sequence
            TO ${quoteIdentifier(operatorLogin)}`,
          revoke: `REVOKE USAGE ON SEQUENCE pintpath_ops.authority_probe_sequence
            FROM ${quoteIdentifier(operatorLogin)}`,
        },
        {
          grant: `GRANT EXECUTE ON FUNCTION
            pintpath_ops.authorize_reviewed_price_promotion(pg_catalog.jsonb)
            TO ${quoteIdentifier(operatorLogin)}`,
          revoke: `REVOKE EXECUTE ON FUNCTION
            pintpath_ops.authorize_reviewed_price_promotion(pg_catalog.jsonb)
            FROM ${quoteIdentifier(operatorLogin)}`,
        },
        {
          grant: `GRANT USAGE ON TYPE pintpath_ops.authority_probe_type
            TO ${quoteIdentifier(operatorLogin)}`,
          revoke: `REVOKE USAGE ON TYPE pintpath_ops.authority_probe_type
            FROM ${quoteIdentifier(operatorLogin)}`,
        },
      ];
      for (const mutation of cases) {
        await databaseAdmin.query(mutation.grant);
        try {
          await expect(verifyOperator()).rejects.toThrow("database_role_invalid");
        } finally {
          await databaseAdmin.query(mutation.revoke);
        }
        await expect(verifyOperator()).resolves.toBeUndefined();
      }
    });

    it("rejects ownership even without an explicit grant", async () => {
      await databaseAdmin.query(`ALTER TABLE pintpath_ops.authority_probe
        OWNER TO ${quoteIdentifier(operatorLogin)}`);
      try {
        await expect(verifyOperator()).rejects.toThrow("database_role_invalid");
      } finally {
        await databaseAdmin.query(`ALTER TABLE pintpath_ops.authority_probe
          OWNER TO ${quoteIdentifier(adminRole)}`);
      }
      await expect(verifyOperator()).resolves.toBeUndefined();
    });
  },
);
const backupSql = fs.readFileSync(
  path.resolve(
    "supabase/migrations/20260810003612_add_pintpath_logical_backup_role.sql",
  ),
  "utf8",
);
const kernelSql = fs.readFileSync(
  path.resolve(
    "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
  ),
  "utf8",
);

if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredRequired === "true" && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
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
  ) {
    throw new Error(
      `${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`,
    );
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("unsafe_test_identifier");
  }
  return `"${value}"`;
}

function withDatabase(url: URL, database: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result.toString();
}

function scopedRoleNames(databaseOid: string): readonly string[] {
  if (!/^[1-9][0-9]{0,9}$/.test(databaseOid)) {
    throw new Error("unsafe_test_database_oid");
  }
  return [
    `pintpath_reviewed_price_apply_execute_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`,
    `pintpath_reviewed_price_apply_owner_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`,
    `pintpath_logical_backup_d${databaseOid}`,
  ];
}

interface CatalogCountsRow extends QueryResultRow {
  readonly authorityForceRls: boolean;
  readonly authorityPolicyCount: string;
  readonly authorityPublicPolicyCount: string;
  readonly authorityRowCount: string;
  readonly forceRlsCount: string;
  readonly functionCount: string;
  readonly policyCount: string;
  readonly relationCount: string;
  readonly rowCount: string;
  readonly sequenceCount: string;
}

interface FunctionRow extends QueryResultRow {
  readonly name: string;
  readonly owner: string;
  readonly acl: string;
  readonly body: string;
}

async function catalogCounts(client: Client): Promise<CatalogCountsRow> {
  const result = await client.query<CatalogCountsRow>(`SELECT
    (SELECT relation.relrowsecurity AND relation.relforcerowsecurity
       FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = 'pintpath_ops.migration_verifier_authority'::regclass)
      AS "authorityForceRls",
    (SELECT count(*)::text FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid =
        'pintpath_ops.migration_verifier_authority'::regclass)
      AS "authorityPolicyCount",
    (SELECT count(*)::text FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid =
          'pintpath_ops.migration_verifier_authority'::regclass
        AND policy.polroles = ARRAY[0]::oid[]) AS "authorityPublicPolicyCount",
    (SELECT count(*)::text
       FROM pintpath_ops.migration_verifier_authority) AS "authorityRowCount",
    (SELECT count(*)::text
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND relation.relkind IN ('r', 'p')) AS "relationCount",
    (SELECT count(*)::text
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND relation.relkind IN ('r', 'p')
        AND relation.relrowsecurity AND relation.relforcerowsecurity)
      AS "forceRlsCount",
    (SELECT count(*)::text
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
        AND relation.relkind = 'S') AS "sequenceCount",
    (SELECT count(*)::text
       FROM pg_catalog.pg_policy AS policy
       JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops']))
      AS "policyCount",
    (SELECT count(*)::text
       FROM pg_catalog.pg_proc AS routine
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'pintpath_ops'
        AND routine.proname IN (
          'apply_reviewed_price_promotion',
          'quarantine_reviewed_price_promotion'
        )) AS "functionCount",
    ((SELECT count(*) FROM pintpath_ops.reviewed_price_promotion_operations)
      + (SELECT count(*) FROM pintpath_ops.reviewed_price_promotion_rows))::text
      AS "rowCount"`);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) throw new Error("catalog_count_unavailable");
  return row;
}

async function databaseOid(client: Client): Promise<string> {
  const result = await client.query<{ oid: string }>(
    "SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname = current_database()",
  );
  const oid = result.rows[0]?.oid;
  if (result.rows.length !== 1 || !oid || !/^[1-9][0-9]{0,9}$/.test(oid)) {
    throw new Error("test_database_oid_unavailable");
  }
  return oid;
}

async function expectPgError(
  work: () => Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> {
  let captured: unknown;
  try {
    await work();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(Error);
  expect((captured as Error & { code?: string }).code).toBe(code);
  expect((captured as Error).message).toMatch(message);
}

async function asRole(
  client: Client,
  role: string,
  work: () => Promise<unknown>,
): Promise<void> {
  await client.query(`SET ROLE ${quoteIdentifier(role)}`);
  try {
    await work();
  } finally {
    await client.query("RESET ROLE");
  }
}

describe.skipIf(!configuredAdminUrl)(
  "inert reviewed-price promotion kernel on real PostgreSQL 17",
  () => {
    let adminUrl: URL;
    let maintenance: Client;
    let runtimeRoleExisted = false;
    let migratorRoleExisted = false;
    let verifierAuthorityRoleExisted = false;
    const databaseOids = new Map<string, string>();

    async function createDatabase(
      database: string,
      owner?: string,
    ): Promise<Client> {
      await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
      await maintenance.query(
        `CREATE DATABASE ${quoteIdentifier(database)}${
          owner ? ` OWNER ${quoteIdentifier(owner)}` : ""
        }`,
      );
      const client = new Client({
        connectionString: withDatabase(adminUrl, database),
      });
      await client.connect();
      databaseOids.set(database, await databaseOid(client));
      return client;
    }

    async function installLegacy(client: Client): Promise<void> {
      await client.query(schemaSql);
      await client.query(backupSql);
    }

    beforeAll(async () => {
      adminUrl = validateAdminUrl(configuredAdminUrl);
      maintenance = new Client({ connectionString: adminUrl.toString() });
      await maintenance.connect();
      const version = await maintenance.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      );
      if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
        throw new Error("Reviewed-price kernel integration requires PostgreSQL 17.");
      }
      const roles = await maintenance.query<{ rolname: string }>(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
        [[
          "pintpath_runtime",
          "pintpath_migrator",
          "pintpath_migration_verifier_authority",
        ]],
      );
      runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
      migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
      verifierAuthorityRoleExisted = roles.rows.some(
        (row) => row.rolname === "pintpath_migration_verifier_authority",
      );
      for (const database of [
        superDatabase,
        siblingDatabase,
        mixedDatabase,
        poisonDatabase,
        policyDatabase,
        restoreSourceDatabase,
        restoreTargetDatabase,
      ]) {
        await maintenance.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`,
        );
      }
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(policyOwner)}`);
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(restorePolicyOwner)}`);
    }, 30_000);

    afterAll(async () => {
      const failures: unknown[] = [];
      for (const database of [
        superDatabase,
        siblingDatabase,
        mixedDatabase,
        poisonDatabase,
        policyDatabase,
        restoreSourceDatabase,
        restoreTargetDatabase,
      ]) {
        try {
          await maintenance.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`,
          );
        } catch (error) {
          failures.push(error);
        }
      }
      for (const oid of databaseOids.values()) {
        for (const role of scopedRoleNames(oid)) {
          try {
            await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      try {
        await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(policyOwner)}`);
        await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(restorePolicyOwner)}`);
        if (!runtimeRoleExisted) {
          await maintenance.query("DROP ROLE IF EXISTS pintpath_runtime");
        }
        if (!migratorRoleExisted) {
          await maintenance.query("DROP ROLE IF EXISTS pintpath_migrator");
        }
        if (!verifierAuthorityRoleExisted) {
          await maintenance.query(
            "DROP ROLE IF EXISTS pintpath_migration_verifier_authority",
          );
        }
      } catch (error) {
        failures.push(error);
      }
      await maintenance.end().catch((error) => failures.push(error));
      if (failures.length > 0) throw failures[0];
    }, 30_000);

    it("installs and reruns the exact fully inert scoped authority", async () => {
      const client = await createDatabase(superDatabase);
      try {
        await installLegacy(client);
        await client.query(kernelSql);
        await client.query(kernelSql);

        expect(await catalogCounts(client)).toEqual({
          authorityForceRls: true,
          authorityPolicyCount: "4",
          authorityPublicPolicyCount: "0",
          authorityRowCount: "0",
          forceRlsCount: "62",
          functionCount: "2",
          policyCount: "244",
          relationCount: "62",
          rowCount: "0",
          sequenceCount: "0",
        });
        const oid = await databaseOid(client);
        const [applyExecute, quarantineExecute, applyOwner, quarantineOwner, backup] =
          scopedRoleNames(oid);
        const roles = await maintenance.query<{ rolname: string }>(
          "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname COLLATE \"C\"",
          [[applyExecute, quarantineExecute, applyOwner, quarantineOwner, backup]],
        );
        expect(roles.rows.map((row) => row.rolname).sort()).toEqual(
          [applyExecute, quarantineExecute, applyOwner, quarantineOwner, backup].sort(),
        );

        const functions = await client.query<FunctionRow>(`SELECT
          routine.proname AS name,
          pg_catalog.pg_get_userbyid(routine.proowner) AS owner,
          routine.proacl::text AS acl,
          routine.prosrc AS body
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'pintpath_ops'
          AND routine.proname IN (
            'apply_reviewed_price_promotion',
            'quarantine_reviewed_price_promotion'
          )
        ORDER BY routine.proname COLLATE "C"`);
        expect(functions.rows).toHaveLength(2);
        expect(functions.rows.map((row) => row.owner).sort()).toEqual(
          [applyOwner, quarantineOwner].sort(),
        );
        expect(functions.rows.every((row) =>
          row.body.includes("reviewed_price_promotion_kernel_disabled")
          && row.body.includes("PERFORM request"),
        )).toBe(true);
        expect(functions.rows.map((row) => row.acl).join("\n"))
          .not.toMatch(/(?:\{|,)=X\//);

        await asRole(client, applyExecute, () => expectPgError(
          () => client.query("SELECT pintpath_ops.apply_reviewed_price_promotion('{}'::jsonb)"),
          "55000",
          /^reviewed_price_promotion_kernel_disabled$/,
        ));
        await asRole(client, quarantineExecute, () => expectPgError(
          () => client.query("SELECT pintpath_ops.quarantine_reviewed_price_promotion('{}'::jsonb)"),
          "55000",
          /^reviewed_price_promotion_kernel_disabled$/,
        ));
        await asRole(client, applyOwner, () => expectPgError(
          () => client.query("SELECT pintpath_ops.apply_reviewed_price_promotion('{}'::jsonb)"),
          "42501",
          /permission denied/i,
        ));

        for (const role of ["pintpath_runtime", "pintpath_migrator"]) {
          await asRole(client, role, () => expectPgError(
            () => client.query(`INSERT INTO pintpath_ops.reviewed_price_promotion_operations (
              operation_id, operation_kind, candidate_sha, expected_environment,
              authority_bundle_sha256, plan_candidate_sha256,
              review_packet_candidate_sha256, target_physical_identity_sha256,
              source_snapshot_sha256, request_sha256, requested_row_count,
              committed_at, result_state_sha256, receipt_sha256
            ) VALUES (
              '11111111-1111-4111-8111-111111111111', 'apply', repeat('a', 40),
              'permanent-staging', repeat('b', 64), repeat('c', 64),
              repeat('d', 64), repeat('e', 64), repeat('f', 64), repeat('1', 64),
              1, '2026-08-12T00:00:00Z', repeat('2', 64), repeat('3', 64)
            )`),
            "42501",
            /(permission denied|row-level security)/i,
          ));
        }
        await asRole(client, "pintpath_runtime", () => expectPgError(
          () => client.query("SELECT pintpath_ops.apply_reviewed_price_promotion('{}'::jsonb)"),
          "42501",
          /permission denied/i,
        ));
        await asRole(client, "pintpath_migrator", async () => {
          const rows = await client.query(
            "SELECT count(*)::text AS count FROM pintpath_ops.reviewed_price_promotion_operations",
          );
          expect(rows.rows).toEqual([{ count: "0" }]);
        });
        await asRole(client, backup, async () => {
          const rows = await client.query(
            "SELECT count(*)::text AS count FROM pintpath_ops.reviewed_price_promotion_rows",
          );
          expect(rows.rows).toEqual([{ count: "0" }]);
        });

        await client.query(
          `GRANT INSERT ON TABLE pintpath_app.accounts TO ${quoteIdentifier(backup)}`,
        );
        await expectPgError(
          () => client.query(kernelSql),
          "42501",
          /^reviewed_price_promotion_kernel_backup_authority_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(
          `REVOKE INSERT ON TABLE pintpath_app.accounts FROM ${quoteIdentifier(backup)}`,
        );

        await client.query("GRANT CREATE ON SCHEMA pintpath_ops TO pintpath_runtime");
        await expectPgError(
          () => client.query(kernelSql),
          "42501",
          /^reviewed_price_promotion_kernel_schema_acl_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("REVOKE CREATE ON SCHEMA pintpath_ops FROM pintpath_runtime");

        await client.query(`INSERT INTO pintpath_ops.reviewed_price_promotion_operations (
          operation_id, operation_kind, candidate_sha, expected_environment,
          authority_bundle_sha256, plan_candidate_sha256,
          review_packet_candidate_sha256, target_physical_identity_sha256,
          source_snapshot_sha256, request_sha256, requested_row_count,
          committed_at, result_state_sha256, receipt_sha256
        ) VALUES (
          '33333333-3333-4333-8333-333333333333', 'apply', repeat('a', 40),
          'permanent-staging', repeat('b', 64), repeat('c', 64),
          repeat('d', 64), repeat('e', 64), repeat('f', 64), repeat('1', 64),
          1, '2026-08-12T00:00:00Z', repeat('2', 64), repeat('3', 64)
        )`);
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_inert_ledger_not_empty$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(
          "DELETE FROM pintpath_ops.reviewed_price_promotion_operations",
        );

        await client.query(
          "ALTER FUNCTION pintpath_ops.apply_reviewed_price_promotion(jsonb) OWNER TO CURRENT_USER",
        );
        await client.query(
          `REVOKE EXECUTE ON FUNCTION pintpath_ops.apply_reviewed_price_promotion(jsonb) FROM ${quoteIdentifier(applyExecute)}`,
        );
        await expectPgError(
          () => client.query(kernelSql),
          "42501",
          /^reviewed_price_promotion_kernel_function_(?:acl|owner)_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        const unrepaired = await client.query<{ executeAllowed: boolean; owner: string }>(
          `SELECT
            pg_catalog.pg_get_userbyid(routine.proowner) AS owner,
            pg_catalog.has_function_privilege(
              $1,
              'pintpath_ops.apply_reviewed_price_promotion(jsonb)',
              'EXECUTE'
            ) AS "executeAllowed"
          FROM pg_catalog.pg_proc AS routine
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = routine.pronamespace
          WHERE namespace.nspname = 'pintpath_ops'
            AND routine.proname = 'apply_reviewed_price_promotion'
            AND pg_catalog.oidvectortypes(routine.proargtypes) = 'jsonb'`,
          [applyExecute],
        );
        expect(unrepaired.rows).toEqual([{
          executeAllowed: false,
          owner: decodeURIComponent(new URL(configuredAdminUrl).username),
        }]);
        await client.query(
          `ALTER FUNCTION pintpath_ops.apply_reviewed_price_promotion(jsonb) OWNER TO ${quoteIdentifier(applyOwner)}`,
        );
        await client.query(
          `GRANT EXECUTE ON FUNCTION pintpath_ops.apply_reviewed_price_promotion(jsonb) TO ${quoteIdentifier(applyExecute)}`,
        );

        await client.query(
          `REVOKE EXECUTE ON FUNCTION pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) FROM ${quoteIdentifier(applyOwner)}`,
        );
        await expectPgError(
          () => client.query(kernelSql),
          "42501",
          /^reviewed_price_promotion_kernel_function_acl_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(
          `GRANT EXECUTE ON FUNCTION pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) TO ${quoteIdentifier(applyOwner)}`,
        );

        await client.query(
          "ALTER FUNCTION pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) STRICT",
        );
        await asRole(client, applyExecute, async () => {
          const bypassed = await client.query<{ result: unknown }>(
            "SELECT pintpath_ops.apply_reviewed_price_promotion(NULL::pg_catalog.jsonb) AS result",
          );
          expect(bypassed.rows).toEqual([{ result: null }]);
        });
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_function_contract_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(
          "ALTER FUNCTION pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) CALLED ON NULL INPUT",
        );

        await client.query(
          "ALTER TABLE pintpath_ops.reviewed_price_promotion_rows DISABLE TRIGGER ALL",
        );
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_fk_trigger_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(
          "ALTER TABLE pintpath_ops.reviewed_price_promotion_rows ENABLE TRIGGER ALL",
        );

        await client.query(`ALTER TABLE pintpath_ops.reviewed_price_promotion_operations
          ALTER COLUMN receipt_sha256 TYPE pg_catalog.text
          COLLATE pg_catalog."en-US-x-icu"
          USING receipt_sha256::pg_catalog.text`);
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_column_collation_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(`ALTER TABLE pintpath_ops.reviewed_price_promotion_operations
          ALTER COLUMN receipt_sha256 TYPE pg_catalog.text
          COLLATE pg_catalog."C"
          USING receipt_sha256::pg_catalog.text`);

        await client.query(
          `CREATE PUBLICATION ${quoteIdentifier(explicitPublication)} FOR TABLE pintpath_ops.reviewed_price_promotion_rows`,
        );
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_publication_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(`DROP PUBLICATION ${quoteIdentifier(explicitPublication)}`);

        await client.query(
          `CREATE PUBLICATION ${quoteIdentifier(allTablesPublication)} FOR ALL TABLES`,
        );
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_publication_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(`DROP PUBLICATION ${quoteIdentifier(allTablesPublication)}`);

        await client.query(
          `CREATE PUBLICATION ${quoteIdentifier(schemaPublication)} FOR TABLES IN SCHEMA pintpath_ops`,
        );
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_publication_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(`DROP PUBLICATION ${quoteIdentifier(schemaPublication)}`);
        expect((await catalogCounts(client)).rowCount).toBe("0");
      } finally {
        await client.end();
      }
    }, 30_000);

    it("binds every reconstructed role and function owner to the database OID", async () => {
      const client = await createDatabase(siblingDatabase);
      try {
        await client.query(schemaSql);
        await client.query(kernelSql);
        const siblingOid = await databaseOid(client);
        const superOid = databaseOids.get(superDatabase);
        expect(siblingOid).not.toBe(superOid);
        const allRoles = await maintenance.query<{ rolname: string }>(
          "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
          [[...scopedRoleNames(siblingOid), ...scopedRoleNames(String(superOid))]],
        );
        expect(allRoles.rows).toHaveLength(10);
        const owners = await client.query<{ owner: string }>(`SELECT
          pg_catalog.pg_get_userbyid(routine.proowner) AS owner
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'pintpath_ops'
          AND routine.proname IN (
            'apply_reviewed_price_promotion',
            'quarantine_reviewed_price_promotion'
          )`);
        expect(owners.rows.every((row) => row.owner.endsWith(`d${siblingOid}`))).toBe(true);
      } finally {
        await client.end();
      }
    }, 30_000);

    it("resolves every kernel type against pg_catalog under a poisoned search path", async () => {
      const client = await createDatabase(poisonDatabase);
      try {
        await installLegacy(client);
        await client.query(`CREATE SCHEMA pintpath_kernel_type_poison;
          CREATE DOMAIN pintpath_kernel_type_poison.jsonb AS pg_catalog.jsonb;
          SET search_path = pintpath_kernel_type_poison, pg_catalog`);
        await client.query(kernelSql);
        const signatures = await client.query<{
          argumentType: string;
          resultType: string;
        }>(`SELECT
          routine.proargtypes[0]::pg_catalog.regtype::text AS "argumentType",
          routine.prorettype::pg_catalog.regtype::text AS "resultType"
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'pintpath_ops'
          AND routine.proname IN (
            'apply_reviewed_price_promotion',
            'quarantine_reviewed_price_promotion'
          )
        ORDER BY routine.proname COLLATE "C"`);
        expect(signatures.rows).toEqual([
          { argumentType: "pg_catalog.jsonb", resultType: "pg_catalog.jsonb" },
          { argumentType: "pg_catalog.jsonb", resultType: "pg_catalog.jsonb" },
        ]);
      } finally {
        await client.end();
      }
    }, 30_000);

    it("rejects a mixed partial kernel without creating further authority", async () => {
      const client = await createDatabase(mixedDatabase);
      try {
        await installLegacy(client);
        const oid = await databaseOid(client);
        const backupRole = scopedRoleNames(oid)[4];
        if (!backupRole) throw new Error("backup_role_name_unavailable");
        await client.query(
          `REVOKE SELECT ON TABLE pintpath_app.accounts FROM ${quoteIdentifier(backupRole)}`,
        );
        await expectPgError(
          () => client.query(kernelSql),
          "42501",
          /^reviewed_price_promotion_kernel_legacy_backup_authority_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        const legacyResidue = await client.query<{
          hasSelect: boolean;
          relationCount: string;
        }>(`SELECT
          pg_catalog.has_table_privilege(
            $1, 'pintpath_app.accounts', 'SELECT'
          ) AS "hasSelect",
          (SELECT count(*)::text
             FROM pg_catalog.pg_class AS relation
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = ANY(ARRAY['pintpath_app', 'pintpath_ops'])
              AND relation.relkind IN ('r', 'p')) AS "relationCount"`,
          [backupRole],
        );
        expect(legacyResidue.rows).toEqual([{
          hasSelect: false,
          relationCount: "60",
        }]);
        await client.query(
          `GRANT SELECT ON TABLE pintpath_app.accounts TO ${quoteIdentifier(backupRole)}`,
        );
        await client.query(
          "CREATE TABLE pintpath_ops.reviewed_price_promotion_operations (operation_id uuid PRIMARY KEY)",
        );
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_relation_inventory_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        const residue = await client.query<{
          functions: string;
          relations: string;
          roles: string;
        }>(`SELECT
          (SELECT count(*)::text FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'pintpath_ops'
              AND relation.relname LIKE 'reviewed_price_promotion_%'
              AND relation.relkind IN ('r', 'p')) AS relations,
          (SELECT count(*)::text FROM pg_catalog.pg_proc AS routine
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
            WHERE namespace.nspname = 'pintpath_ops'
              AND routine.proname LIKE '%reviewed_price_promotion') AS functions,
          (SELECT count(*)::text FROM pg_catalog.pg_roles
            WHERE rolname LIKE 'pintpath_reviewed_price_%_d'
              || (SELECT oid::text FROM pg_catalog.pg_database
                  WHERE datname = current_database())) AS roles`);
        expect(residue.rows).toEqual([{ functions: "0", relations: "1", roles: "0" }]);
      } finally {
        await client.end();
      }
    }, 30_000);

    it("keeps the non-superuser policy-only state inert and role-free", async () => {
      await maintenance.query(
        `CREATE ROLE ${quoteIdentifier(policyOwner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      const client = await createDatabase(policyDatabase, policyOwner);
      try {
        await client.query(`SET ROLE ${quoteIdentifier(policyOwner)}`);
        try {
          await client.query(schemaSql);
          await client.query(backupSql);
          await client.query(kernelSql);
          await client.query(kernelSql);
        } finally {
          await client.query("RESET ROLE");
        }
        expect(await catalogCounts(client)).toEqual({
          authorityForceRls: true,
          authorityPolicyCount: "4",
          authorityPublicPolicyCount: "0",
          authorityRowCount: "0",
          forceRlsCount: "62",
          functionCount: "2",
          policyCount: "244",
          relationCount: "62",
          rowCount: "0",
          sequenceCount: "0",
        });
        const oid = await databaseOid(client);
        const roles = await maintenance.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
          [scopedRoleNames(oid)],
        );
        expect(roles.rows).toEqual([{ count: "0" }]);
        await asRole(client, policyOwner, () => expectPgError(
          () => client.query("SELECT pintpath_ops.apply_reviewed_price_promotion('{}'::jsonb)"),
          "42501",
          /^reviewed_price_promotion_kernel_owner_unsafe$/,
        ));
        await asRole(client, policyOwner, () => expectPgError(
          () => client.query(`INSERT INTO pintpath_ops.reviewed_price_promotion_operations (
            operation_id, operation_kind, candidate_sha, expected_environment,
            authority_bundle_sha256, plan_candidate_sha256,
            review_packet_candidate_sha256, target_physical_identity_sha256,
            source_snapshot_sha256, request_sha256, requested_row_count,
            committed_at, result_state_sha256, receipt_sha256
          ) VALUES (
            '22222222-2222-4222-8222-222222222222', 'apply', repeat('a', 40),
            'permanent-staging', repeat('b', 64), repeat('c', 64),
            repeat('d', 64), repeat('e', 64), repeat('f', 64), repeat('1', 64),
            1, '2026-08-12T00:00:00Z', repeat('2', 64), repeat('3', 64)
          )`),
          "42501",
          /row-level security/i,
        ));
        expect((await catalogCounts(client)).rowCount).toBe("0");

        await client.query(
          "ALTER EXTENSION plpgsql ADD TABLE pintpath_ops.reviewed_price_promotion_rows",
        );
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_extension_dependency_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query(
          "ALTER EXTENSION plpgsql DROP TABLE pintpath_ops.reviewed_price_promotion_rows",
        );

        await client.query(`SET ROLE ${quoteIdentifier(policyOwner)}`);
        await client.query(
          "SELECT pg_catalog.set_config('pintpath.restore_reviewed_price_kernel_source_database_oid', '123', false)",
        );
        await expectPgError(
          () => client.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_restore_binding_unsafe$/,
        );
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("RESET ROLE");
        await client.query(
          "SELECT pg_catalog.set_config('pintpath.restore_reviewed_price_kernel_source_database_oid', '', false)",
        );

        await client.query(kernelSql);
        await client.query(kernelSql);
        const promotedRoles = await maintenance.query<{ rolname: string }>(
          "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
          [scopedRoleNames(oid)],
        );
        expect(promotedRoles.rows).toHaveLength(5);
        const [applyExecute, , applyOwner] = scopedRoleNames(oid);
        await asRole(client, applyExecute, () => expectPgError(
          () => client.query(
            "SELECT pintpath_ops.apply_reviewed_price_promotion('{}'::pg_catalog.jsonb)",
          ),
          "55000",
          /^reviewed_price_promotion_kernel_disabled$/,
        ));
        const promotedOwner = await client.query<{ owner: string }>(`SELECT
          pg_catalog.pg_get_userbyid(routine.proowner) AS owner
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'pintpath_ops'
          AND routine.proname = 'apply_reviewed_price_promotion'
          AND routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype::oid`);
        expect(promotedOwner.rows).toEqual([{ owner: applyOwner }]);
      } finally {
        await client.end();
      }
    }, 30_000);

    it("rebinds only an exact portable source-OID function guard after cross-database restore", async () => {
      const source = await createDatabase(restoreSourceDatabase);
      let target: Client | undefined;
      try {
        await installLegacy(source);
        await source.query(kernelSql);
        const sourceOid = await databaseOid(source);
        const sourceBodies = await source.query<{ name: string; body: string }>(`SELECT
          routine.proname AS name,
          routine.prosrc AS body
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'pintpath_ops'
          AND routine.proname IN (
            'apply_reviewed_price_promotion',
            'quarantine_reviewed_price_promotion'
          )
        ORDER BY routine.proname COLLATE "C"`);
        expect(sourceBodies.rows).toHaveLength(2);

        await maintenance.query(
          `CREATE ROLE ${quoteIdentifier(restorePolicyOwner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        );
        target = await createDatabase(restoreTargetDatabase, restorePolicyOwner);
        await target.query(`SET ROLE ${quoteIdentifier(restorePolicyOwner)}`);
        try {
          await target.query(schemaSql);
          await target.query(backupSql);
          await target.query(kernelSql);
        } finally {
          await target.query("RESET ROLE");
        }
        const targetOid = await databaseOid(target);
        expect(targetOid).not.toBe(sourceOid);

        for (const row of sourceBodies.rows) {
          await target.query(`CREATE OR REPLACE FUNCTION pintpath_ops.${row.name}(
            request pg_catalog.jsonb
          ) RETURNS pg_catalog.jsonb
          LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
          SET search_path = pg_catalog
          AS $pintpath_source_body$${row.body}$pintpath_source_body$`);
        }
        await expectPgError(
          () => target!.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_restore_binding_unsafe$/,
        );
        await target.query("ROLLBACK").catch(() => undefined);
        await target.query(
          "SELECT pg_catalog.set_config('pintpath.restore_reviewed_price_kernel_source_database_oid', $1, false)",
          ["not-an-oid"],
        );
        await expectPgError(
          () => target!.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_restore_binding_unsafe$/,
        );
        await target.query("ROLLBACK").catch(() => undefined);
        await target.query(
          "SELECT pg_catalog.set_config('pintpath.restore_reviewed_price_kernel_source_database_oid', $1, false)",
          [targetOid],
        );
        await expectPgError(
          () => target!.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_restore_binding_unsafe$/,
        );
        await target.query("ROLLBACK").catch(() => undefined);
        await target.query(
          "SELECT pg_catalog.set_config('pintpath.restore_reviewed_price_kernel_source_database_oid', $1, false)",
          [sourceOid],
        );
        const quarantineSource = sourceBodies.rows.find(
          (row) => row.name === "quarantine_reviewed_price_promotion",
        );
        expect(quarantineSource).toBeDefined();
        await target.query(`CREATE OR REPLACE FUNCTION
          pintpath_ops.quarantine_reviewed_price_promotion(request pg_catalog.jsonb)
          RETURNS pg_catalog.jsonb
          LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
          SET search_path = pg_catalog
          AS $pintpath_asymmetric_body$${
            quarantineSource!.body.replace(`_d${sourceOid}`, `_d${targetOid}`)
          }$pintpath_asymmetric_body$`);
        await expectPgError(
          () => target!.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_policy_only_function_unsafe$/,
        );
        await target.query("ROLLBACK").catch(() => undefined);
        for (const row of sourceBodies.rows) {
          await target.query(`CREATE OR REPLACE FUNCTION pintpath_ops.${row.name}(
            request pg_catalog.jsonb
          ) RETURNS pg_catalog.jsonb
          LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
          SET search_path = pg_catalog
          AS $pintpath_source_body$${row.body}$pintpath_source_body$`);
        }
        await target.query(`CREATE OR REPLACE FUNCTION
          pintpath_ops.apply_reviewed_price_promotion(request pg_catalog.jsonb)
          RETURNS pg_catalog.jsonb
          LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
          SET search_path = pg_catalog
          AS $pintpath_tampered_body$
          BEGIN
            IF CURRENT_USER <> 'pintpath_reviewed_price_apply_owner_d${sourceOid}' THEN
              RAISE EXCEPTION USING ERRCODE = '42501',
                MESSAGE = 'reviewed_price_promotion_kernel_owner_unsafe';
            END IF;
            PERFORM 1;
            RAISE EXCEPTION USING ERRCODE = '55000',
              MESSAGE = 'reviewed_price_promotion_kernel_disabled';
          END
          $pintpath_tampered_body$`);
        await expectPgError(
          () => target!.query(kernelSql),
          "55000",
          /^reviewed_price_promotion_kernel_policy_only_function_unsafe$/,
        );
        await target.query("ROLLBACK").catch(() => undefined);

        for (const row of sourceBodies.rows) {
          await target.query(`CREATE OR REPLACE FUNCTION pintpath_ops.${row.name}(
            request pg_catalog.jsonb
          ) RETURNS pg_catalog.jsonb
          LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
          SET search_path = pg_catalog
          AS $pintpath_source_body$${row.body}$pintpath_source_body$`);
        }
        await target.query(kernelSql);
        await target.query(
          "SELECT pg_catalog.set_config('pintpath.restore_reviewed_price_kernel_source_database_oid', '', false)",
        );
        const rebuilt = await target.query<FunctionRow>(`SELECT
          routine.proname AS name,
          pg_catalog.pg_get_userbyid(routine.proowner) AS owner,
          routine.proacl::text AS acl,
          routine.prosrc AS body
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'pintpath_ops'
          AND routine.proname IN (
            'apply_reviewed_price_promotion',
            'quarantine_reviewed_price_promotion'
          )
        ORDER BY routine.proname COLLATE "C"`);
        expect(rebuilt.rows).toHaveLength(2);
        expect(rebuilt.rows.every((row) => row.body.includes(`_d${targetOid}`))).toBe(true);
        expect(rebuilt.rows.every((row) => !row.body.includes(`_d${sourceOid}`))).toBe(true);
        expect(rebuilt.rows.map((row) => row.owner).sort()).toEqual([
          `pintpath_reviewed_price_apply_owner_d${targetOid}`,
          `pintpath_reviewed_price_quarantine_owner_d${targetOid}`,
        ].sort());
        await target.query(kernelSql);
      } finally {
        await target?.end().catch(() => undefined);
        await source.end();
      }
    }, 30_000);
  },
);
