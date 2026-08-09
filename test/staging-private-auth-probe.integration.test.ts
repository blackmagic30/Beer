import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCandidateHandoffMarker,
  createCandidateOwnerMarker,
  createScramSha256Verifier,
  stagingPrivateAuthProbeInternals,
} from "../scripts/staging-private-auth-probe.js";

const PRIMARY_ADMIN_URL_ENV = "PINTPATH_STAGING_AUTH_PROBE_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_STAGING_AUTH_PROBE_TEST_REQUIRED";
const CI_POSTGRES_CONTAINER_ID_ENV = "PINTPATH_CI_POSTGRES_CONTAINER_ID";
const configuredAdminUrl = process.env[PRIMARY_ADMIN_URL_ENV]?.trim() || "";
const integrationRequired = process.env[REQUIRED_ENV]?.trim() === "true";
const psqlVersion = spawnSync("psql", ["--version"], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    ...(process.env[CI_POSTGRES_CONTAINER_ID_ENV]
      ? {
          [CI_POSTGRES_CONTAINER_ID_ENV]:
            process.env[CI_POSTGRES_CONTAINER_ID_ENV],
        }
      : {}),
  },
});
const hasPsql17 =
  psqlVersion.status === 0 &&
  /^psql \(PostgreSQL\) 17\.[0-9]+(?:\s|$)/.test(psqlVersion.stdout.trim());
if (integrationRequired && (!configuredAdminUrl || !hasPsql17)) {
  throw new Error(
    `${REQUIRED_ENV}=true requires ${PRIMARY_ADMIN_URL_ENV} and an executable PostgreSQL 17 psql client.`,
  );
}
const suffix =
  `${process.pid}_${crypto.randomBytes(5).toString("hex")}`.toLowerCase();
const testDatabase = `pintpath_auth_probe_${suffix}`;
const candidateLogin = `pintpath_staging_runtime_login_20260809${crypto.randomBytes(8).toString("hex")}`;
const predecessorLogin = `pintpath_probe_old_${suffix}`;
const unownedLogin = `pintpath_probe_unowned_${suffix}`;
const candidatePassword = crypto.randomBytes(32).toString("base64url");
const predecessorPassword = crypto.randomBytes(32).toString("base64url");
const candidateOwnerSecret = crypto.randomBytes(32).toString("base64url");
const ownerMarker = createCandidateOwnerMarker(
  candidateOwnerSecret,
  candidateLogin,
)!;
const handoffMarker = createCandidateHandoffMarker(
  candidateOwnerSecret,
  candidateLogin,
)!;

interface PsqlResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function classifyPsqlFailure(stderr: string): string {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes("connect_timeout") ||
    normalized.includes("invalid integer value")
  )
    return "invalid-connect-timeout";
  if (
    normalized.includes("no such file or directory") ||
    normalized.includes("connection to server on socket")
  )
    return "socket-connect";
  if (
    normalized.includes("authentication method requirement") ||
    normalized.includes("password authentication failed")
  )
    return "auth-policy";
  if (normalized.includes("timeout:")) return "wrapper-timeout";
  if (
    normalized.includes("syntax error") ||
    normalized.includes("unrecognized option") ||
    normalized.includes("sh:")
  )
    return "script-error";
  return stderr ? "other" : "empty";
}

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${PRIMARY_ADMIN_URL_ENV} must be a loopback PG17 admin URL.`,
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    ) ||
    decodeURIComponent(url.pathname.slice(1)) !== "postgres" ||
    url.username !== "postgres" ||
    !url.password ||
    url.searchParams.get("sslmode") !== "disable" ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
    url.hash ||
    /[\r\n\0]/.test(value)
  )
    throw new Error(
      `${PRIMARY_ADMIN_URL_ENV} must be a disposable loopback PG17 admin URL.`,
    );
  return url;
}

function withConnection(
  source: URL,
  database: string,
  username?: string,
  password?: string,
): string {
  const target = new URL(source.toString());
  target.pathname = `/${database}`;
  if (username !== undefined) target.username = username;
  if (password !== undefined) target.password = password;
  return target.toString();
}

function forTestDatabase(script: string): string {
  return script.replaceAll("pintpath_staging", testDatabase);
}

async function inspectDatabaseConnectPrivilege(
  client: Client,
  database: string,
  roleName: string,
): Promise<
  | {
      roleOid: number;
      directConnect: boolean;
      effectiveConnect: boolean;
    }
  | undefined
> {
  const result = await client.query<{
    roleOid: number;
    directConnect: boolean;
    effectiveConnect: boolean;
  }>(
    `SELECT role.oid::integer AS "roleOid",
            pg_catalog.has_database_privilege(
              role.oid,
              runtime_database.oid,
              'CONNECT'
            ) AS "effectiveConnect",
            EXISTS (
              SELECT 1
              FROM pg_catalog.aclexplode(
                COALESCE(
                  runtime_database.datacl,
                  pg_catalog.acldefault('d', runtime_database.datdba)
                )
              ) AS database_privilege
              WHERE database_privilege.grantee = role.oid
                AND database_privilege.privilege_type = 'CONNECT'
                AND NOT database_privilege.is_grantable
            ) AS "directConnect"
       FROM pg_catalog.pg_roles AS role
       JOIN pg_catalog.pg_database AS runtime_database
         ON runtime_database.datname = $1
      WHERE role.rolname = $2`,
    [database, roleName],
  );
  return result.rows[0];
}

async function databaseAclHasGrantee(
  client: Client,
  database: string,
  roleOid: number,
): Promise<boolean> {
  const result = await client.query<{ hasGrantee: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_database AS runtime_database
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           runtime_database.datacl,
           pg_catalog.acldefault('d', runtime_database.datdba)
         )
       ) AS database_privilege
       WHERE runtime_database.datname = $1
         AND database_privilege.grantee = $2::oid
     ) AS "hasGrantee"`,
    [database, roleOid],
  );
  return result.rows[0]?.hasGrantee === true;
}

async function runPsql17(input: {
  connectionUrl: string;
  stdin?: string;
  additionalEnvironment?: Readonly<Record<string, string>>;
}): Promise<PsqlResult> {
  const url = new URL(input.connectionUrl);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      "psql",
      ["-X", "-q", "-A", "-t", "--no-password", "--set=ON_ERROR_STOP=1"],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
          ...(process.env[CI_POSTGRES_CONTAINER_ID_ENV]
            ? {
                [CI_POSTGRES_CONTAINER_ID_ENV]:
                  process.env[CI_POSTGRES_CONTAINER_ID_ENV],
              }
            : {}),
          PGHOST: url.hostname,
          PGPORT: url.port,
          PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          PGSSLMODE: "disable",
          PGREQUIREAUTH: "scram-sha-256",
          ...input.additionalEnvironment,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 32_768) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 32_768) stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: "", stderr: "" });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.stdin ?? "");
  });
}

async function structuredPgAttempt(connectionString: string): Promise<{
  connected: boolean;
  saslObserved: boolean;
  errorCode: string;
}> {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
  });
  const connection = (
    client as unknown as {
      connection: { on: (event: string, listener: () => void) => void };
    }
  ).connection;
  let saslObserved = false;
  connection.on("authenticationSASL", () => {
    saslObserved = true;
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    return { connected: true, saslObserved, errorCode: "" };
  } catch (error) {
    const errorCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";
    return { connected: false, saslObserved, errorCode };
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe.skipIf(!configuredAdminUrl || !hasPsql17)(
  "real PG17 staging authentication probe contract",
  () => {
    let adminUrl: URL;
    let maintenance: Client | null = null;
    let databaseAdmin: Client | null = null;
    let createdRuntimeRole = false;
    let createdTestDatabase = false;
    let createdCandidateRole = false;
    let createdPredecessorRole = false;
    let createdUnownedRole = false;
    let candidateUrl = "";
    let predecessorUrl = "";

    beforeAll(async () => {
      adminUrl = validateAdminUrl(configuredAdminUrl);
      maintenance = new Client({ connectionString: adminUrl.toString() });
      await maintenance.connect();
      const version = await maintenance.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      );
      if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
        throw new Error(
          "Staging auth probe integration requires PostgreSQL 17.",
        );
      }
      const runtimeRole = await maintenance.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pintpath_runtime') AS exists",
      );
      if (runtimeRole.rows[0]?.exists !== true) {
        await maintenance.query(
          "CREATE ROLE pintpath_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS",
        );
        createdRuntimeRole = true;
      }
      await maintenance.query(`CREATE DATABASE ${testDatabase}`);
      createdTestDatabase = true;
      await maintenance.query(
        `REVOKE CONNECT ON DATABASE ${testDatabase} FROM PUBLIC`,
      );
      databaseAdmin = new Client({
        connectionString: withConnection(adminUrl, testDatabase),
      });
      await databaseAdmin.connect();
      await databaseAdmin.query(`
        CREATE SCHEMA pintpath_app;
        CREATE SCHEMA pintpath_ops;
        REVOKE ALL ON SCHEMA pintpath_app FROM PUBLIC;
        REVOKE ALL ON SCHEMA pintpath_ops FROM PUBLIC;
        GRANT USAGE ON SCHEMA pintpath_app TO pintpath_runtime;
        CREATE TABLE pintpath_app.schema_metadata (key text PRIMARY KEY, value text NOT NULL);
        INSERT INTO pintpath_app.schema_metadata (key, value)
        VALUES ('schema_version', '1'), ('import_state', 'ready');
        GRANT SELECT ON pintpath_app.schema_metadata TO pintpath_runtime;
      `);
      const predecessorVerifier = createScramSha256Verifier(
        predecessorPassword,
        crypto.randomBytes(16),
      );
      if (!predecessorVerifier)
        throw new Error("Could not create predecessor verifier.");
      await maintenance.query(
        `CREATE ROLE ${predecessorLogin} LOGIN PASSWORD '${predecessorVerifier}'
         NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
      );
      createdPredecessorRole = true;
      await maintenance.query(`GRANT pintpath_runtime TO ${predecessorLogin}`);
      await maintenance.query(
        `GRANT CONNECT ON DATABASE ${testDatabase} TO ${predecessorLogin}`,
      );
      candidateUrl = withConnection(
        adminUrl,
        testDatabase,
        candidateLogin,
        candidatePassword,
      );
      predecessorUrl = withConnection(
        adminUrl,
        testDatabase,
        predecessorLogin,
        predecessorPassword,
      );
    }, 30_000);

    afterAll(async () => {
      await databaseAdmin?.end().catch(() => undefined);
      if (maintenance) {
        if (createdTestDatabase) {
          await maintenance
            .query(
              "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
              [testDatabase],
            )
            .catch(() => undefined);
          await maintenance
            .query(`DROP DATABASE ${testDatabase}`)
            .catch(() => undefined);
        }
        for (const [role, created] of [
          [candidateLogin, createdCandidateRole],
          [predecessorLogin, createdPredecessorRole],
          [unownedLogin, createdUnownedRole],
        ] as const) {
          if (created) {
            await maintenance.query(`DROP ROLE ${role}`).catch(() => undefined);
          }
        }
        if (createdRuntimeRole) {
          await maintenance
            .query("DROP ROLE pintpath_runtime")
            .catch(() => undefined);
        }
        await maintenance.end().catch(() => undefined);
      }
    }, 30_000);

    it("proves require_auth SCRAM, least privilege, structured rejection, and owner cleanup", async () => {
      const socketDirectories = await maintenance!.query<{ setting: string }>(
        "SELECT current_setting('unix_socket_directories') AS setting",
      );
      const socketDirectory = socketDirectories.rows[0]?.setting
        ?.split(",")[0]
        ?.trim();
      expect(socketDirectory?.startsWith("/")).toBe(true);
      const trustAccepted = await runPsql17({
        connectionUrl: withConnection(adminUrl, "postgres"),
        additionalEnvironment: {
          PGHOST: socketDirectory!,
          PGPASSWORD: "",
          PGREQUIREAUTH: "none",
        },
      });
      expect(
        trustAccepted.exitCode,
        `trustAccepted=${classifyPsqlFailure(trustAccepted.stderr)}`,
      ).toBe(0);
      const trustRejected = await runPsql17({
        connectionUrl: withConnection(adminUrl, "postgres"),
        additionalEnvironment: {
          PGHOST: socketDirectory!,
          PGPASSWORD: "",
        },
      });
      expect(trustRejected.exitCode).toBe(2);

      const adminScramAccepted = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
      });
      expect(
        adminScramAccepted.exitCode,
        `adminScramAccepted=${classifyPsqlFailure(adminScramAccepted.stderr)}`,
      ).toBe(0);

      const lifecycleLockA = new Client({
        connectionString: withConnection(adminUrl, testDatabase),
      });
      const lifecycleLockB = new Client({
        connectionString: withConnection(adminUrl, testDatabase),
      });
      await lifecycleLockA.connect();
      await lifecycleLockB.connect();
      try {
        const acquiredA = await lifecycleLockA.query<{
          backendPid: number;
          acquired: boolean;
        }>(
          stagingPrivateAuthProbeInternals.queries
            .acquireProvisionLifecycleLock,
          stagingPrivateAuthProbeInternals.lifecycleLockKeys,
        );
        expect(acquiredA.rows[0]?.acquired).toBe(true);
        const verifiedA = await lifecycleLockA.query<{
          backendPid: number;
          held: boolean;
        }>(
          stagingPrivateAuthProbeInternals.queries.verifyProvisionLifecycleLock,
          stagingPrivateAuthProbeInternals.lifecycleLockKeys,
        );
        expect(verifiedA.rows[0]).toEqual({
          backendPid: acquiredA.rows[0]?.backendPid,
          held: true,
        });
        const refusedB = await lifecycleLockB.query<{ acquired: boolean }>(
          stagingPrivateAuthProbeInternals.queries
            .acquireProvisionLifecycleLock,
          stagingPrivateAuthProbeInternals.lifecycleLockKeys,
        );
        expect(refusedB.rows[0]?.acquired).toBe(false);
      } finally {
        await lifecycleLockA.end();
      }
      const acquiredAfterRelease = await lifecycleLockB.query<{
        acquired: boolean;
      }>(
        stagingPrivateAuthProbeInternals.queries.acquireProvisionLifecycleLock,
        stagingPrivateAuthProbeInternals.lifecycleLockKeys,
      );
      expect(acquiredAfterRelease.rows[0]?.acquired).toBe(true);
      await lifecycleLockB.end();

      const verifier = createScramSha256Verifier(
        candidatePassword,
        crypto.randomBytes(16),
      );
      expect(verifier).toMatch(/^SCRAM-SHA-256\$/);
      const provision = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(
          stagingPrivateAuthProbeInternals.scripts.provision,
        ),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
          STAGING_AUTH_PROBE_CANDIDATE_VERIFIER: verifier!,
        },
      });
      if (provision.exitCode === 0 && provision.stdout.trim() === "created") {
        createdCandidateRole = true;
      }
      expect(
        provision.exitCode,
        `provision=${classifyPsqlFailure(provision.stderr)}`,
      ).toBe(0);
      expect(provision.stdout.trim()).toBe("created");
      expect(provision.stdout).not.toContain(candidatePassword);
      expect(provision.stderr).not.toContain(candidatePassword);
      const resumedProvision = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(
          stagingPrivateAuthProbeInternals.scripts.provision,
        ),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
          STAGING_AUTH_PROBE_CANDIDATE_VERIFIER: verifier!,
        },
      });
      expect(resumedProvision.exitCode).toBe(0);
      expect(resumedProvision.stdout.trim()).toBe("existing-owned");
      const candidateConnectPrivilege = await inspectDatabaseConnectPrivilege(
        maintenance!,
        testDatabase,
        candidateLogin,
      );
      expect(candidateConnectPrivilege).toMatchObject({
        directConnect: true,
        effectiveConnect: true,
      });
      const candidateRoleOid = candidateConnectPrivilege!.roleOid;
      const ownedInspection = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: stagingPrivateAuthProbeInternals.scripts.inspectOwnership,
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(ownedInspection.exitCode).toBe(0);
      expect(ownedInspection.stdout.trim()).toBe("owned");
      const preHandoffInspection = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: stagingPrivateAuthProbeInternals.scripts.inspectHandoff,
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: handoffMarker,
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
        },
      });
      expect(preHandoffInspection.stdout.trim()).toBe("unowned");

      const accepted = await runPsql17({ connectionUrl: candidateUrl });
      expect(accepted.exitCode).toBe(0);
      const candidate = new Client({ connectionString: candidateUrl });
      await candidate.connect();
      const readiness = await candidate.query<{
        member: boolean;
        canLogin: boolean;
        inheritsMembership: boolean;
        superuser: boolean;
        canCreateDatabase: boolean;
        canCreateRole: boolean;
        canReplicate: boolean;
        bypassRls: boolean;
        searchPath: string[];
        operationsAccess: boolean;
        importState: string;
      }>(`SELECT
        pg_has_role(session_user, 'pintpath_runtime', 'MEMBER') AS member,
        role.rolcanlogin AS "canLogin",
        role.rolinherit AS "inheritsMembership",
        role.rolsuper AS superuser,
        role.rolcreatedb AS "canCreateDatabase",
        role.rolcreaterole AS "canCreateRole",
        role.rolreplication AS "canReplicate",
        role.rolbypassrls AS "bypassRls",
        current_schemas(false)::text[] AS "searchPath",
        has_schema_privilege(current_user, 'pintpath_ops', 'USAGE') AS "operationsAccess",
        (SELECT value FROM pintpath_app.schema_metadata WHERE key = 'import_state') AS "importState"
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = session_user`);
      expect(readiness.rows[0]).toEqual({
        member: true,
        canLogin: true,
        inheritsMembership: true,
        superuser: false,
        canCreateDatabase: false,
        canCreateRole: false,
        canReplicate: false,
        bypassRls: false,
        searchPath: ["pintpath_app", "pg_catalog"],
        operationsAccess: false,
        importState: "ready",
      });

      const restricted = await candidate.query(
        stagingPrivateAuthProbeInternals.queries.runtimeRoleSafety,
      );
      expect(
        stagingPrivateAuthProbeInternals.runtimeRoleIsRestricted(
          restricted.rows[0],
        ),
      ).toBe(true);
      await maintenance!.query(`ALTER ROLE ${candidateLogin} CREATEROLE`);
      const escalated = await candidate.query(
        stagingPrivateAuthProbeInternals.queries.runtimeRoleSafety,
      );
      expect(
        stagingPrivateAuthProbeInternals.runtimeRoleIsRestricted(
          escalated.rows[0],
        ),
      ).toBe(false);
      await maintenance!.query(`ALTER ROLE ${candidateLogin} NOCREATEROLE`);
      await candidate.end();

      await maintenance!.query(
        `REVOKE CONNECT ON DATABASE ${testDatabase} FROM ${candidateLogin}`,
      );
      const refusedMissingConnectHandoff = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(
          stagingPrivateAuthProbeInternals.scripts.finalizeOwnership,
        ),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: handoffMarker,
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(refusedMissingConnectHandoff.exitCode).toBe(0);
      expect(refusedMissingConnectHandoff.stdout.trim()).toBe("unsafe");
      await maintenance!.query(
        `GRANT CONNECT ON DATABASE ${testDatabase} TO ${candidateLogin}`,
      );

      const wrongCandidate = new URL(candidateUrl);
      wrongCandidate.password = crypto.randomBytes(32).toString("base64url");
      const wrong = await structuredPgAttempt(wrongCandidate.toString());
      expect(wrong).toMatchObject({
        connected: false,
        saslObserved: true,
        errorCode: "28P01",
      });

      const candidateSession = new Client({ connectionString: candidateUrl });
      candidateSession.on("error", () => undefined);
      await candidateSession.connect();
      await maintenance!.query(`
        BEGIN;
        ALTER ROLE ${candidateLogin} NOLOGIN;
        REVOKE pintpath_runtime FROM ${candidateLogin};
        ALTER ROLE ${candidateLogin} PASSWORD NULL;
        COMMIT;
      `);
      const refusedUnsafeHandoff = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(
          stagingPrivateAuthProbeInternals.scripts.finalizeOwnership,
        ),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: handoffMarker,
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(refusedUnsafeHandoff.exitCode).toBe(0);
      expect(refusedUnsafeHandoff.stdout.trim()).toBe("unsafe");
      const cleanup = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(stagingPrivateAuthProbeInternals.scripts.cleanup),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(cleanup.exitCode).toBe(0);
      expect(cleanup.stdout.trim()).toBe("cleaned");
      await expect(candidateSession.query("SELECT 1")).rejects.toBeDefined();
      await candidateSession.end().catch(() => undefined);
      const candidateSessions = await maintenance!.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_catalog.pg_stat_activity WHERE usename = $1",
        [candidateLogin],
      );
      expect(candidateSessions.rows[0]?.count).toBe(0);
      const candidateGone = await maintenance!.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists",
        [candidateLogin],
      );
      expect(candidateGone.rows[0]?.exists).toBe(false);
      expect(
        await databaseAclHasGrantee(
          maintenance!,
          testDatabase,
          candidateRoleOid,
        ),
      ).toBe(false);
      createdCandidateRole = false;
      const absentInspection = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: stagingPrivateAuthProbeInternals.scripts.inspectOwnership,
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(absentInspection.stdout.trim()).toBe("absent");

      const handoffProvision = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(
          stagingPrivateAuthProbeInternals.scripts.provision,
        ),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
          STAGING_AUTH_PROBE_CANDIDATE_VERIFIER: verifier!,
        },
      });
      if (
        handoffProvision.exitCode === 0 &&
        handoffProvision.stdout.trim() === "created"
      ) {
        createdCandidateRole = true;
      }
      expect(handoffProvision.stdout.trim()).toBe("created");
      const handoff = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(
          stagingPrivateAuthProbeInternals.scripts.finalizeOwnership,
        ),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: handoffMarker,
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(handoff.exitCode).toBe(0);
      expect(handoff.stdout.trim()).toBe("handed-off");
      const handedOffInspection = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: stagingPrivateAuthProbeInternals.scripts.inspectOwnership,
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(handedOffInspection.stdout.trim()).toBe("unowned");
      const durableHandoffInspection = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: stagingPrivateAuthProbeInternals.scripts.inspectHandoff,
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: handoffMarker,
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
        },
      });
      expect(durableHandoffInspection.exitCode).toBe(0);
      expect(durableHandoffInspection.stdout.trim()).toBe("handed-off");
      const refusedHandedOffCleanup = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(stagingPrivateAuthProbeInternals.scripts.cleanup),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(refusedHandedOffCleanup.stdout.trim()).toBe("unowned");
      const handedOffRole = await maintenance!.query<{ canLogin: boolean }>(
        'SELECT rolcanlogin AS "canLogin" FROM pg_catalog.pg_roles WHERE rolname = $1',
        [candidateLogin],
      );
      expect(handedOffRole.rows[0]?.canLogin).toBe(true);
      const postHandoffAccepted = await runPsql17({
        connectionUrl: candidateUrl,
      });
      expect(postHandoffAccepted.exitCode).toBe(0);
      const postHandoffCandidate = new Client({
        connectionString: candidateUrl,
      });
      await postHandoffCandidate.connect();
      const postHandoffSafety = await postHandoffCandidate.query(
        stagingPrivateAuthProbeInternals.queries.runtimeRoleSafety,
      );
      expect(
        stagingPrivateAuthProbeInternals.runtimeRoleIsRestricted(
          postHandoffSafety.rows[0],
        ),
      ).toBe(true);
      await postHandoffCandidate.end();

      const predecessorAccepted = await runPsql17({
        connectionUrl: predecessorUrl,
      });
      expect(predecessorAccepted.exitCode).toBe(0);
      const predecessorSession = new Client({
        connectionString: predecessorUrl,
      });
      predecessorSession.on("error", () => undefined);
      await predecessorSession.connect();
      const retirement = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(stagingPrivateAuthProbeInternals.scripts.retire),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_RETIRED_LOGIN: predecessorLogin,
        },
      });
      expect(retirement.exitCode).toBe(0);
      expect(retirement.stdout.trim()).toBe("retired");
      await expect(predecessorSession.query("SELECT 1")).rejects.toBeDefined();
      await predecessorSession.end().catch(() => undefined);
      const predecessorSessions = await maintenance!.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_catalog.pg_stat_activity WHERE usename = $1",
        [predecessorLogin],
      );
      expect(predecessorSessions.rows[0]?.count).toBe(0);
      const predecessorRejected = await structuredPgAttempt(predecessorUrl);
      expect(predecessorRejected.connected).toBe(false);
      expect(["28P01", "28000"]).toContain(predecessorRejected.errorCode);
      expect(
        await inspectDatabaseConnectPrivilege(
          maintenance!,
          testDatabase,
          predecessorLogin,
        ),
      ).toMatchObject({
        directConnect: false,
        effectiveConnect: false,
      });

      await maintenance!.query(
        `CREATE ROLE ${unownedLogin} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
      );
      createdUnownedRole = true;
      await maintenance!.query(
        `GRANT CONNECT ON DATABASE ${testDatabase} TO ${unownedLogin}`,
      );
      const refusedProvision = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(
          stagingPrivateAuthProbeInternals.scripts.provision,
        ),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: unownedLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
          STAGING_AUTH_PROBE_CANDIDATE_VERIFIER: verifier!,
        },
      });
      expect(refusedProvision.exitCode).toBe(0);
      expect(refusedProvision.stdout.trim()).toBe("unowned");
      const unownedInspection = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: stagingPrivateAuthProbeInternals.scripts.inspectOwnership,
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: unownedLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(unownedInspection.stdout.trim()).toBe("unowned");
      const refusedCleanup = await runPsql17({
        connectionUrl: withConnection(adminUrl, testDatabase),
        stdin: forTestDatabase(stagingPrivateAuthProbeInternals.scripts.cleanup),
        additionalEnvironment: {
          STAGING_AUTH_PROBE_CANDIDATE_LOGIN: unownedLogin,
          STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
        },
      });
      expect(refusedCleanup.exitCode).toBe(0);
      expect(refusedCleanup.stdout.trim()).toBe("unowned");
      const unownedStillLogin = await maintenance!.query<{ canLogin: boolean }>(
        'SELECT rolcanlogin AS "canLogin" FROM pg_catalog.pg_roles WHERE rolname = $1',
        [unownedLogin],
      );
      expect(unownedStillLogin.rows[0]?.canLogin).toBe(true);
      expect(
        await inspectDatabaseConnectPrivilege(
          maintenance!,
          testDatabase,
          unownedLogin,
        ),
      ).toMatchObject({
        directConnect: true,
        effectiveConnect: true,
      });
    }, 30_000);
  },
);
