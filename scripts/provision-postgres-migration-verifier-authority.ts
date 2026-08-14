import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client, type ClientConfig, type QueryResultRow } from "pg";

import {
  POSTGRES_MIGRATION_ADVISORY_LOCK_KEY,
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE,
  assertPostgresMigrationVerifierPublicKey,
  finalizePostgresMigrationVerifierAuthorityReceipt,
  loadPostgresMigrationVerifierAuthorityPolicy,
  postgresMigrationVerifierAuthoritySchema,
  sha256PostgresMigrationAuthorityIdentity,
  sha256PostgresMigrationVerifierAuthorityBinding,
  type PostgresMigrationVerifierAuthority,
  type PostgresMigrationVerifierAuthorityEnvironment,
  type PostgresMigrationVerifierAuthorityReceipt,
} from "../src/db/postgres-migration-verifier-authority.js";
import {
  sha256PostgresMigrationBytes,
  serializeCanonicalPostgresMigrationJson,
} from "../src/db/postgres-migration-schema.js";
import {
  sha256PostgresMigrationTargetIdentity,
  sha256PostgresMigrationTransportAuthority,
  type PostgresMigrationTargetIdentity,
} from "../src/db/postgres-migration-receipt.js";
import { postgresMigrationTargetInternals } from "../src/db/postgres-migration-target.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  checkPostgresRailwayStockLocalhostServerIdentity,
  openPostgresRailwayStockLocalhostCaTransport,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const CONFIRMATION = "PROVISION_POSTGRES_MIGRATION_VERIFIER_AUTHORITY" as const;
const WORKFLOW = ".github/workflows/provision-postgres-migration-verifier-authority.yml" as const;
const MAX_PRIVATE_FILE_BYTES = 64 * 1_024;

const ARGUMENTS = new Set([
  "--candidate-sha",
  "--confirmation",
  "--expected-environment",
  "--expected-previous-authority-sha256",
  "--operator-id-file",
  "--output-dir",
  "--root-ca-der-sha256",
  "--root-ca-file",
  "--target-identity-sha256",
  "--target-url-file",
  "--target-url-sha256",
  "--verifier-id-file",
  "--verifier-public-key",
]);

export type ExpectedPreviousAuthority = "absent" | string;

export class PostgresMigrationVerifierAuthorityProvisionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PostgresMigrationVerifierAuthorityProvisionError";
  }
}

function fail(code: string): never {
  throw new PostgresMigrationVerifierAuthorityProvisionError(code);
}

export interface AuthorityQueryResult<Row extends QueryResultRow = QueryResultRow> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface AuthorityConnection {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<AuthorityQueryResult<Row>>;
  assertExact(): Promise<void>;
  close(): Promise<void>;
}

interface TargetAuthorityInspectionRow extends QueryResultRow {
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly serverVersionNum: string;
  readonly systemIdentifier: string;
  readonly loginSafe: boolean;
  readonly membershipExact: boolean;
  readonly roleSafe: boolean;
  readonly roleParentsAbsent: boolean;
  readonly roleChildrenExact: boolean;
  readonly roleSettingsAbsent: boolean;
  readonly databaseAuthorityExact: boolean;
  readonly schemaAuthorityExact: boolean;
  readonly tableAuthorityExact: boolean;
  readonly columnPrivilegesAbsent: boolean;
  readonly routinePrivilegesAbsent: boolean;
  readonly sequencePrivilegesAbsent: boolean;
  readonly ownershipAbsent: boolean;
  readonly defaultPrivilegesAbsent: boolean;
  readonly migratorReadOnlyExact: boolean;
  readonly rowSecurityExact: boolean;
}

interface AuthorityRow extends QueryResultRow {
  readonly expectedEnvironment: string;
  readonly candidateSha: string;
  readonly operatorIdSha256: string;
  readonly verifierIdSha256: string;
  readonly verifierPublicKeySha256: string;
  readonly authorityPolicySha256: string;
  readonly authoritySha256: string;
  readonly installedAt: Date | string;
}

export interface ProvisionExecutionInput {
  readonly authority: PostgresMigrationVerifierAuthority;
  readonly expectedPreviousAuthoritySha256: ExpectedPreviousAuthority;
  readonly expectedTargetIdentitySha256: string;
  readonly onExactPreflight?: (
    before: PostgresMigrationVerifierAuthority | null,
  ) => void;
}

function normalizeEnvironment(value: string): PostgresMigrationVerifierAuthorityEnvironment {
  if (value === "permanent-staging" || value === "production") return value;
  fail("argument_invalid");
}

function normalizeExpectedPrevious(value: string): ExpectedPreviousAuthority {
  if (value === "absent" || SHA256.test(value)) return value;
  fail("argument_invalid");
}

function exactTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.toISOString();
  if (timestamp !== (value instanceof Date ? value.toISOString() : value)) {
    fail("database_authority_invalid");
  }
  return timestamp;
}

function parseAuthorityRow(row: AuthorityRow): PostgresMigrationVerifierAuthority {
  try {
    return postgresMigrationVerifierAuthoritySchema.parse({
      expectedEnvironment: row.expectedEnvironment,
      candidateSha: row.candidateSha,
      operatorIdSha256: row.operatorIdSha256,
      verifierIdSha256: row.verifierIdSha256,
      verifierPublicKeySha256: row.verifierPublicKeySha256,
      authorityPolicySha256: row.authorityPolicySha256,
      authoritySha256: row.authoritySha256,
      installedAt: exactTimestamp(row.installedAt),
    });
  } catch {
    fail("database_authority_invalid");
  }
}

async function loadAuthority(
  connection: AuthorityConnection,
): Promise<PostgresMigrationVerifierAuthority | null> {
  const result = await connection.query<AuthorityRow>(
    `/* pintpath:migration-verifier-authority:read */
     SELECT expected_environment AS "expectedEnvironment",
            candidate_commit_sha AS "candidateSha",
            operator_id_sha256 AS "operatorIdSha256",
            verifier_id_sha256 AS "verifierIdSha256",
            verifier_public_key_sha256 AS "verifierPublicKeySha256",
            authority_policy_sha256 AS "authorityPolicySha256",
            authority_sha256 AS "authoritySha256",
            installed_at AS "installedAt"
       FROM pintpath_ops.migration_verifier_authority
      WHERE authority_id = 'active'
      ORDER BY authority_id`,
  );
  if (result.rows.length === 0 && result.rowCount === 0) return null;
  if (result.rows.length !== 1 || result.rowCount !== 1 || !result.rows[0]) {
    fail("database_authority_ambiguous");
  }
  return parseAuthorityRow(result.rows[0]);
}

async function inspectTarget(
  connection: AuthorityConnection,
): Promise<{ readonly targetIdentitySha256: string }> {
  const result = await connection.query<TargetAuthorityInspectionRow>(
    `/* pintpath:migration-verifier-authority:target-boundary */
     SELECT current_user::text AS "currentUser",
            session_user::text AS "sessionUser",
            current_database()::text AS "databaseName",
            database.oid::text AS "databaseOid",
            current_setting('server_version_num')::text AS "serverVersionNum",
            control.system_identifier::text AS "systemIdentifier",
            (login.rolcanlogin AND NOT login.rolsuper AND NOT login.rolcreatedb
              AND NOT login.rolcreaterole AND NOT login.rolinherit
              AND NOT login.rolreplication AND NOT login.rolbypassrls
              AND login.rolconnlimit = 1 AND login.rolvaliduntil > clock_timestamp()
              AND login.rolvaliduntil <= clock_timestamp() + interval '24 hours') AS "loginSafe",
            COALESCE((SELECT count(*) = 1 AND bool_and(
                granted.rolname = '${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE}'
                AND NOT member.admin_option AND NOT member.inherit_option AND member.set_option)
              FROM pg_catalog.pg_auth_members AS member
              JOIN pg_catalog.pg_roles AS granted ON granted.oid = member.roleid
             WHERE member.member = login.oid), false) AS "membershipExact",
            (NOT active.rolcanlogin AND NOT active.rolsuper AND NOT active.rolcreatedb
              AND NOT active.rolcreaterole AND active.rolinherit
              AND NOT active.rolreplication AND NOT active.rolbypassrls
              AND active.rolconnlimit = -1 AND active.rolvaliduntil IS NULL) AS "roleSafe",
            NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = active.oid)
              AS "roleParentsAbsent",
            COALESCE((SELECT count(*) = 1 AND bool_and(child.oid = login.oid
                AND NOT member.admin_option AND NOT member.inherit_option AND member.set_option)
              FROM pg_catalog.pg_auth_members AS member
              JOIN pg_catalog.pg_roles AS child ON child.oid = member.member
             WHERE member.roleid = active.oid), false) AS "roleChildrenExact",
            NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting
              WHERE setrole IN (login.oid, active.oid)) AS "roleSettingsAbsent",
            (has_database_privilege(login.oid, database.oid, 'CONNECT')
              AND NOT has_database_privilege(login.oid, database.oid, 'CREATE')
              AND NOT has_database_privilege(login.oid, database.oid, 'TEMP')
              AND NOT has_database_privilege(active.oid, database.oid, 'CREATE')
              AND NOT has_database_privilege(active.oid, database.oid, 'TEMP'))
              AS "databaseAuthorityExact",
            (has_schema_privilege(active.oid, 'pintpath_ops', 'USAGE')
              AND NOT has_schema_privilege(active.oid, 'pintpath_ops', 'CREATE')
              AND NOT has_schema_privilege(active.oid, 'pintpath_app', 'USAGE'))
              AS "schemaAuthorityExact",
            (has_table_privilege(active.oid,
                'pintpath_ops.migration_verifier_authority', 'SELECT,INSERT,UPDATE')
              AND NOT has_table_privilege(active.oid,
                'pintpath_ops.migration_verifier_authority', 'DELETE,TRUNCATE,TRIGGER,REFERENCES')
              AND NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_class AS relation
                JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
               WHERE namespace.nspname IN ('pintpath_app', 'pintpath_ops')
                 AND relation.relkind IN ('r','p','S','v','m')
                 AND relation.relname <> 'migration_verifier_authority'
                 AND has_any_column_privilege(active.oid, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
              )) AS "tableAuthorityExact",
            NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS attribute
              CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
             WHERE attribute.attacl IS NOT NULL AND privilege.grantee = active.oid)
              AS "columnPrivilegesAbsent",
            NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS routine
              CROSS JOIN LATERAL pg_catalog.aclexplode(
                COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) AS privilege
             WHERE privilege.grantee = active.oid) AS "routinePrivilegesAbsent",
            NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS sequence
              CROSS JOIN LATERAL pg_catalog.aclexplode(
                COALESCE(sequence.relacl, pg_catalog.acldefault('S', sequence.relowner))) AS privilege
             WHERE sequence.relkind = 'S' AND privilege.grantee = active.oid)
              AS "sequencePrivilegesAbsent",
            NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
             WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
               AND dependency.refobjid IN (login.oid, active.oid)
               AND dependency.deptype = 'o') AS "ownershipAbsent",
            NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl
             WHERE defaclrole IN (login.oid, active.oid)) AS "defaultPrivilegesAbsent",
            (has_table_privilege('pintpath_migrator',
                'pintpath_ops.migration_verifier_authority', 'SELECT')
              AND NOT has_table_privilege('pintpath_migrator',
                'pintpath_ops.migration_verifier_authority',
                'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'))
              AS "migratorReadOnlyExact",
            (authority.relrowsecurity AND authority.relforcerowsecurity
              AND (SELECT count(*) = 4 FROM pg_catalog.pg_policy
                    WHERE polrelid = authority.oid)) AS "rowSecurityExact"
       FROM pg_catalog.pg_database AS database
       CROSS JOIN pg_catalog.pg_control_system() AS control
       JOIN pg_catalog.pg_roles AS login ON login.rolname = session_user
       JOIN pg_catalog.pg_roles AS active ON active.rolname = current_user
       JOIN pg_catalog.pg_class AS authority
         ON authority.oid = 'pintpath_ops.migration_verifier_authority'::pg_catalog.regclass
      WHERE database.datname = current_database()`,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 || result.rowCount !== 1 || !row
    || row.currentUser !== POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE
    || row.sessionUser === row.currentUser
    || !row.loginSafe || !row.membershipExact || !row.roleSafe
    || !row.roleParentsAbsent || !row.roleChildrenExact || !row.roleSettingsAbsent
    || !row.databaseAuthorityExact || !row.schemaAuthorityExact
    || !row.tableAuthorityExact || !row.columnPrivilegesAbsent
    || !row.routinePrivilegesAbsent || !row.sequencePrivilegesAbsent
    || !row.ownershipAbsent || !row.defaultPrivilegesAbsent
    || !row.migratorReadOnlyExact || !row.rowSecurityExact
  ) fail("database_role_invalid");
  let identity: PostgresMigrationTargetIdentity;
  try {
    identity = {
      currentUser: row.currentUser,
      databaseName: row.databaseName,
      databaseOid: row.databaseOid,
      serverVersionNum: row.serverVersionNum,
      sessionUser: row.sessionUser,
      systemIdentifier: row.systemIdentifier,
    };
    return { targetIdentitySha256: sha256PostgresMigrationTargetIdentity(identity) };
  } catch {
    fail("database_identity_invalid");
  }
}

async function acquireLock(connection: AuthorityConnection): Promise<void> {
  const result = await connection.query<{ acquired: boolean }>(
    "/* pintpath:migration-verifier-authority:lock */ SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [POSTGRES_MIGRATION_ADVISORY_LOCK_KEY],
  );
  if (result.rows.length !== 1 || result.rows[0]?.acquired !== true) fail("target_busy");
}

async function releaseLock(connection: AuthorityConnection): Promise<void> {
  const result = await connection.query<{ released: boolean }>(
    "/* pintpath:migration-verifier-authority:unlock */ SELECT pg_advisory_unlock($1::bigint) AS released",
    [POSTGRES_MIGRATION_ADVISORY_LOCK_KEY],
  );
  if (result.rows.length !== 1 || result.rows[0]?.released !== true) fail("target_release_failed");
}

function sameAuthority(
  left: PostgresMigrationVerifierAuthority | null,
  right: PostgresMigrationVerifierAuthority,
): boolean {
  return left !== null && serializeCanonicalPostgresMigrationJson(left)
    .equals(serializeCanonicalPostgresMigrationJson(right));
}

export async function provisionPostgresMigrationVerifierAuthorityWithConnection(
  input: ProvisionExecutionInput,
  connection: AuthorityConnection,
): Promise<{ readonly before: PostgresMigrationVerifierAuthority | null; readonly writeAttempts: 1 }> {
  if (!SHA256.test(input.expectedTargetIdentitySha256)) fail("argument_invalid");
  const authority = postgresMigrationVerifierAuthoritySchema.parse(input.authority);
  let locked = false;
  try {
    await connection.assertExact();
    await acquireLock(connection);
    locked = true;
    const inspection = await inspectTarget(connection);
    if (inspection.targetIdentitySha256 !== input.expectedTargetIdentitySha256) {
      fail("database_identity_invalid");
    }
    const before = await loadAuthority(connection);
    if (
      (input.expectedPreviousAuthoritySha256 === "absent" && before !== null)
      || (input.expectedPreviousAuthoritySha256 !== "absent"
        && before?.authoritySha256 !== input.expectedPreviousAuthoritySha256)
      || sameAuthority(before, authority)
    ) fail("preflight_mismatch");
    await connection.assertExact();
    const reasserted = await loadAuthority(connection);
    if (JSON.stringify(reasserted) !== JSON.stringify(before)) fail("preflight_drift");
    input.onExactPreflight?.(before);
    const values = [
      authority.expectedEnvironment,
      authority.candidateSha,
      authority.operatorIdSha256,
      authority.verifierIdSha256,
      authority.verifierPublicKeySha256,
      authority.authorityPolicySha256,
      authority.authoritySha256,
      authority.installedAt,
    ];
    const result = input.expectedPreviousAuthoritySha256 === "absent"
      ? await connection.query(
        `/* pintpath:migration-verifier-authority:write-once */
         INSERT INTO pintpath_ops.migration_verifier_authority (
           authority_id, expected_environment, candidate_commit_sha,
           operator_id_sha256, verifier_id_sha256, verifier_public_key_sha256,
           authority_policy_sha256, authority_sha256, installed_at
         ) VALUES ('active', $1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
         ON CONFLICT (authority_id) DO NOTHING`,
        values,
      )
      : await connection.query(
        `/* pintpath:migration-verifier-authority:write-once */
         UPDATE pintpath_ops.migration_verifier_authority
            SET expected_environment = $1, candidate_commit_sha = $2,
                operator_id_sha256 = $3, verifier_id_sha256 = $4,
                verifier_public_key_sha256 = $5, authority_policy_sha256 = $6,
                authority_sha256 = $7, installed_at = $8::timestamptz
          WHERE authority_id = 'active' AND authority_sha256 = $9`,
        [...values, input.expectedPreviousAuthoritySha256],
      );
    if (result.rowCount !== 1) fail("write_rejected");
    await connection.assertExact();
    const after = await loadAuthority(connection);
    if (!sameAuthority(after, authority)) fail("postflight_mismatch");
    return { before, writeAttempts: 1 };
  } finally {
    if (locked) await releaseLock(connection);
  }
}

class DirectAuthorityConnection implements AuthorityConnection {
  private constructor(
    private readonly client: Client,
    private readonly transport: PostgresRailwayStockLocalhostCaTransport,
  ) {}

  static async connect(input: {
    readonly targetUrl: string;
    readonly rootCaFile: string;
    readonly expectedRootCaDerSha256: string;
  }): Promise<DirectAuthorityConnection> {
    const validated = postgresMigrationTargetInternals.validateTargetUrl(input.targetUrl);
    const uid = process.getuid?.();
    const euid = process.geteuid?.();
    if (uid === undefined || euid === undefined || uid !== euid) fail("transport_invalid");
    const transport = await openPostgresRailwayStockLocalhostCaTransport({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile: input.rootCaFile,
      expectedRootCaDerSha256: input.expectedRootCaDerSha256,
      expectedUid: uid,
      sourceUrlAuthority: validated.sourceUrlAuthority,
    });
    let client: Client | null = null;
    try {
      const config: ClientConfig = {
        application_name: "pintpath-postgres-migration-verifier-authority",
        connectionTimeoutMillis: 10_000,
        database: validated.database,
        host: transport.nodeConnection.host,
        options: `-c role=${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE} -c search_path=pg_catalog -c row_security=on -c statement_timeout=30000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=30000 -c synchronous_commit=on`,
        password: validated.password,
        port: transport.nodeConnection.port,
        query_timeout: 30_000,
        ssl: transport.nodeConnection.ssl,
        user: validated.user,
      };
      client = new Client(config);
      await client.connect();
      const connection = new DirectAuthorityConnection(client, transport);
      await connection.assertExact();
      return connection;
    } catch (error) {
      if (client) await client.end().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<AuthorityQueryResult<Row>> {
    return values === undefined
      ? this.client.query<Row>(text)
      : this.client.query<Row>(text, [...values]);
  }

  async assertExact(): Promise<void> {
    await this.transport.assertExact();
    if (
      this.transport.profile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
      || this.transport.resolvedAddress !== this.transport.nodeConnection.host
      || !this.transport.resolvedAddress.toLowerCase().startsWith("fd12:")
      || this.transport.nodeConnection.port !== 5_432
      || this.transport.nodeConnection.ssl.servername !== "localhost"
      || this.transport.nodeConnection.ssl.rejectUnauthorized !== true
      || this.transport.nodeConnection.ssl.minVersion !== "TLSv1.2"
      || this.transport.nodeConnection.ssl.checkServerIdentity
        !== checkPostgresRailwayStockLocalhostServerIdentity
    ) fail("transport_invalid");
  }

  async close(): Promise<void> {
    let failure: unknown = null;
    try { await this.client.end(); } catch (error) { failure = error; }
    try { await this.transport.close(); } catch (error) { failure = error; }
    if (failure) fail("target_release_failed");
  }
}

function exactPrivateFile(filePath: string, maximumBytes = MAX_PRIVATE_FILE_BYTES): Buffer {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath || filePath.includes("\0")) {
    fail("artifact_invalid");
  }
  const uid = process.geteuid?.();
  if (uid === undefined) fail("artifact_invalid");
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() || !named.isFile() || named.isSymbolicLink()
      || before.uid !== BigInt(uid) || named.uid !== BigInt(uid)
      || before.nlink !== 1n || named.nlink !== 1n
      || Number(before.mode & 0o7777n) !== 0o600
      || Number(named.mode & 0o7777n) !== 0o600
      || before.dev !== named.dev || before.ino !== named.ino
      || before.size < 1n || before.size > BigInt(maximumBytes)
      || fs.realpathSync(filePath) !== filePath
    ) fail("artifact_invalid");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) fail("artifact_invalid");
    return bytes;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function exactPrivateText(filePath: string): string {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(exactPrivateFile(filePath));
  if (value.length < 1 || value.length > 16_384 || /[\r\n\0]/.test(value)) fail("artifact_invalid");
  return value;
}

function assertOutputDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) fail("artifact_invalid");
  const uid = process.geteuid?.();
  const stat = fs.lstatSync(directory, { bigint: true });
  if (
    uid === undefined || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== BigInt(uid) || Number(stat.mode & 0o7777n) !== 0o700
    || fs.realpathSync(directory) !== directory
  ) fail("artifact_invalid");
}

function writeNewEvidence(directory: string, name: string, value: unknown): string {
  assertOutputDirectory(directory);
  const bytes = serializeCanonicalPostgresMigrationJson(value);
  const filePath = path.join(directory, name);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  return sha256PostgresMigrationBytes(bytes);
}

function githubContext(environment: PostgresMigrationVerifierAuthorityEnvironment): {
  githubEnvironment: "permanent-staging-postgres-migration-verifier-authority"
    | "production-postgres-migration-verifier-authority";
  githubRunIdSha256: string;
} {
  const expectedGithubEnvironment = loadPostgresMigrationVerifierAuthorityPolicy()
    .policy.githubEnvironments[environment];
  if (
    process.env.GITHUB_ACTIONS !== "true"
    || process.env.GITHUB_REF !== "refs/heads/main"
    || process.env.GITHUB_WORKFLOW_REF?.split("@")[0]
      !== `${process.env.GITHUB_REPOSITORY}/${WORKFLOW}`
    || process.env.GITHUB_RUN_ATTEMPT !== "1"
    || process.env.PINTPATH_POSTGRES_MIGRATION_VERIFIER_GITHUB_ENVIRONMENT
      !== expectedGithubEnvironment
    || !RUN_ID.test(process.env.GITHUB_RUN_ID ?? "")
  ) fail("github_context_invalid");
  return {
    githubEnvironment: expectedGithubEnvironment,
    githubRunIdSha256: sha256PostgresMigrationBytes(
      `github-run-id\0${process.env.GITHUB_RUN_ID}`,
    ),
  };
}

export async function runPostgresMigrationVerifierAuthorityProvisioner(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: {
    readonly connect?: (input: {
      readonly targetUrl: string;
      readonly rootCaFile: string;
      readonly expectedRootCaDerSha256: string;
    }) => Promise<AuthorityConnection>;
    readonly now?: () => Date;
    readonly reassertRepository?: (candidateSha: string) => Promise<void>;
  } = {},
): Promise<PostgresMigrationVerifierAuthorityReceipt> {
  const args = parseStrictArguments(argv, { allowed: ARGUMENTS, required: ARGUMENTS });
  const candidateSha = args.get("--candidate-sha")!;
  const expectedEnvironment = normalizeEnvironment(args.get("--expected-environment")!);
  const expectedPreviousAuthoritySha256 = normalizeExpectedPrevious(
    args.get("--expected-previous-authority-sha256")!,
  );
  if (!CANDIDATE.test(candidateSha) || args.get("--confirmation") !== CONFIRMATION) {
    fail("argument_invalid");
  }
  const outputDirectory = args.get("--output-dir")!;
  assertOutputDirectory(outputDirectory);
  const context = githubContext(expectedEnvironment);
  const targetUrl = exactPrivateText(args.get("--target-url-file")!);
  const targetUrlSha256 = sha256PostgresMigrationBytes(targetUrl);
  if (targetUrlSha256 !== args.get("--target-url-sha256") || !SHA256.test(targetUrlSha256)) {
    fail("transport_invalid");
  }
  const rootCaFile = args.get("--root-ca-file")!;
  exactPrivateFile(rootCaFile);
  const expectedRootCaDerSha256 = args.get("--root-ca-der-sha256")!;
  const expectedTargetIdentitySha256 = args.get("--target-identity-sha256")!;
  if (!SHA256.test(expectedRootCaDerSha256) || !SHA256.test(expectedTargetIdentitySha256)) {
    fail("argument_invalid");
  }
  const operatorId = exactPrivateText(args.get("--operator-id-file")!);
  const verifierId = exactPrivateText(args.get("--verifier-id-file")!);
  if (operatorId.trim().replace(/\s+/g, " ") === verifierId.trim().replace(/\s+/g, " ")) {
    fail("authority_separation_invalid");
  }
  const publicKeyBytes = exactPrivateFile(args.get("--verifier-public-key")!);
  const verifierPublicKeySha256 = sha256PostgresMigrationBytes(publicKeyBytes);
  assertPostgresMigrationVerifierPublicKey({
    publicKeyBytes,
    expectedSha256: verifierPublicKeySha256,
  });
  const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const binding = {
    expectedEnvironment,
    candidateSha,
    operatorIdSha256: sha256PostgresMigrationAuthorityIdentity(operatorId, "operator-id"),
    verifierIdSha256: sha256PostgresMigrationAuthorityIdentity(verifierId, "verifier-id"),
    verifierPublicKeySha256,
    authorityPolicySha256: POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
  } as const;
  const authority = postgresMigrationVerifierAuthoritySchema.parse({
    ...binding,
    authoritySha256: sha256PostgresMigrationVerifierAuthorityBinding(binding),
    installedAt: startedAt,
  });
  const validatedUrl = postgresMigrationTargetInternals.validateTargetUrl(targetUrl);
  const transportAuthoritySha256 = sha256PostgresMigrationTransportAuthority({
    expectedRootCaDerSha256,
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    sourceUrlAuthority: validatedUrl.sourceUrlAuthority,
  });
  const intent = {
    schemaVersion: "pintpath-postgres-migration-verifier-authority-intent/v1",
    ...context,
    targetIdentitySha256: expectedTargetIdentitySha256,
    targetUrlSha256,
    transportAuthoritySha256,
    authorityPolicySha256: POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
    expectedPreviousAuthoritySha256,
    authority,
    startedAt,
  } as const;
  const intentSha256 = writeNewEvidence(outputDirectory, "intent.json", intent);
  await (dependencies.reassertRepository ?? (async (expectedSha: string) => {
    if (process.env.GITHUB_SHA !== expectedSha) fail("github_context_invalid");
  }))(candidateSha);
  const connect = dependencies.connect ?? DirectAuthorityConnection.connect;
  let connection: AuthorityConnection | null = null;
  let before: PostgresMigrationVerifierAuthority | null = null;
  let mutationAcknowledged = false;
  let mutationError: unknown = null;
  try {
    connection = await connect({ targetUrl, rootCaFile, expectedRootCaDerSha256 });
    const result = await provisionPostgresMigrationVerifierAuthorityWithConnection({
      authority,
      expectedPreviousAuthoritySha256,
      expectedTargetIdentitySha256,
      onExactPreflight: (observedBefore) => { before = observedBefore; },
    }, connection);
    before = result.before;
    mutationAcknowledged = true;
  } catch (error) {
    mutationError = error;
  } finally {
    if (connection) await connection.close().catch(() => undefined);
  }
  let reconciled = false;
  if (!mutationAcknowledged) {
    // The operation is never retried. A fresh connection performs only the
    // exact postflight read needed to distinguish a lost acknowledgement.
    let reconciliation: AuthorityConnection | null = null;
    try {
      reconciliation = await connect({ targetUrl, rootCaFile, expectedRootCaDerSha256 });
      await reconciliation.assertExact();
      const inspection = await inspectTarget(reconciliation);
      const after = await loadAuthority(reconciliation);
      reconciled = inspection.targetIdentitySha256 === expectedTargetIdentitySha256
        && sameAuthority(after, authority)
        && (expectedPreviousAuthoritySha256 === "absent"
          ? before === null
          : before?.authoritySha256 === expectedPreviousAuthoritySha256);
    } finally {
      if (reconciliation) await reconciliation.close().catch(() => undefined);
    }
    if (!reconciled) throw mutationError;
  }
  const completedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const terminal = {
    schemaVersion: "pintpath-postgres-migration-verifier-authority-terminal/v1",
    outcome: reconciled ? "reconciled_after_lost_ack" : "succeeded",
    authoritySha256: authority.authoritySha256,
    mutationAcknowledged,
    writeAttempts: 1,
    completedAt,
  } as const;
  const terminalEvidenceSha256 = writeNewEvidence(outputDirectory, "terminal.json", terminal);
  const receipt = finalizePostgresMigrationVerifierAuthorityReceipt({
    schemaVersion: "pintpath-postgres-migration-verifier-authority-receipt/v1",
    outcome: reconciled
      ? "reconciled_after_lost_ack"
      : expectedPreviousAuthoritySha256 === "absent" ? "installed" : "rotated",
    ...context,
    targetIdentitySha256: expectedTargetIdentitySha256,
    targetUrlSha256,
    transportAuthoritySha256,
    authorityPolicySha256: POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
    expectedPreviousAuthoritySha256,
    authority,
    intentSha256,
    terminalEvidenceSha256,
    startedAt,
    completedAt,
    checks: {
      githubContextExact: true,
      targetIdentityExact: true,
      transportExact: true,
      provisionerRoleExact: true,
      importerReadOnlyExact: true,
      preflightExact: true,
      oneWriteNoRetryExact: true,
      postflightExact: true,
    },
  });
  writeNewEvidence(outputDirectory, "receipt.json", receipt);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await runPostgresMigrationVerifierAuthorityProvisioner();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      outcome: receipt.outcome,
      authoritySha256: receipt.authority.authoritySha256,
      receiptSha256: receipt.receiptSha256,
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      failureCode: error instanceof PostgresMigrationVerifierAuthorityProvisionError
        ? error.code : "unexpected_failure",
    })}\n`);
    process.exitCode = 1;
  }
}
