import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client, type ClientConfig } from "pg";

import {
  POSTGRES_REVIEWED_PRICE_OPERATION_MAX_APPROVAL_BYTES,
  POSTGRES_REVIEWED_PRICE_OPERATION_MAX_PLAN_BYTES,
  POSTGRES_REVIEWED_PRICE_OPERATION_MAX_RECEIPT_BYTES,
  POSTGRES_REVIEWED_PRICE_OPERATION_MAX_REVIEW_PACKET_BYTES,
  postgresReviewedPriceOperationAuthorizationResponseSchema,
  postgresReviewedPriceOperationDatabaseResponseSchema,
  validatePostgresReviewedPriceOperationArtifacts,
  type PostgresReviewedPriceOperationAuthorizationReceipt,
  type PostgresReviewedPriceOperationRequest,
  type PostgresReviewedPriceOperationReceipt,
} from "../src/lib/postgres-reviewed-price-promotion-operation.js";
import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../src/db/postgres-migration-schema.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  checkPostgresRailwayStockLocalhostServerIdentity,
  openPostgresRailwayStockLocalhostCaTransport,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const RAILWAY_PRIVATE_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal$/;
const REQUIRED_COMMON_ARGUMENTS = Object.freeze([
  "approval-file",
  "approval-file-sha256",
  "database-url-file",
  "database-url-file-sha256",
  "expected-root-ca-der-sha256",
  "output-receipt",
  "plan-file",
  "plan-file-sha256",
  "review-packet-file",
  "review-packet-file-sha256",
  "reviewer-public-key-file",
  "reviewer-public-key-file-sha256",
  "root-ca-file",
  "root-ca-file-sha256",
] as const);
const APPLY_ONLY_ARGUMENTS = Object.freeze([] as const);
const QUARANTINE_ONLY_ARGUMENTS = Object.freeze([
  "apply-receipt-file",
  "apply-receipt-file-sha256",
] as const);

type OperationKind = "apply" | "quarantine";
type OperatorCommand = OperationKind | "authorize-apply" | "authorize-quarantine";
type ReviewedPriceAuthorityKind = "operator" | "reviewer";

interface ParsedArguments {
  readonly command: OperatorCommand;
  readonly values: Readonly<Record<string, string>>;
}

interface PrivateFile {
  readonly bytes: Buffer;
  readonly sha256: string;
}

type DatabaseExecutionResult = {
  readonly artifact: PostgresReviewedPriceOperationReceipt;
  readonly artifactKind: "receipt";
  readonly replayed: boolean;
} | {
  readonly artifact: PostgresReviewedPriceOperationAuthorizationReceipt;
  readonly artifactKind: "authorization";
  readonly replayed: boolean;
};

export interface PostgresReviewedPriceOperatorDependencies {
  readonly executeDatabase: (input: {
    readonly databaseUrl: URL;
    readonly command: OperatorCommand;
    readonly expectedRootCaDerSha256: string;
    readonly request: PostgresReviewedPriceOperationRequest;
    readonly rootCaFile: string;
  }) => Promise<DatabaseExecutionResult>;
  readonly now: () => Date;
  readonly writeOutput: (value: string) => void;
}

interface ReviewedPriceOperatorDatabaseDependencies {
  readonly createPostgresClient: (config: ClientConfig) => Client;
  readonly getUid: () => number | null;
  readonly getEuid: () => number | null;
  readonly openTransport: (
    options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  ) => Promise<PostgresRailwayStockLocalhostCaTransport>;
}

class OperatorCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OperatorCliError";
  }
}

function fail(code: string): never {
  throw new OperatorCliError(code);
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0];
  if (
    command !== "apply" && command !== "quarantine"
    && command !== "authorize-apply" && command !== "authorize-quarantine"
  ) fail("argument_invalid");
  const operation = operationForCommand(command);
  const expected = new Set<string>([
    ...REQUIRED_COMMON_ARGUMENTS,
    ...(operation === "apply" ? APPLY_ONLY_ARGUMENTS : QUARANTINE_ONLY_ARGUMENTS),
  ]);
  if (argv.length !== expected.size + 1) fail("argument_invalid");
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const argument of argv.slice(1)) {
    if (!argument.startsWith("--")) fail("argument_invalid");
    const separator = argument.indexOf("=");
    if (separator < 3) fail("argument_invalid");
    const key = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!expected.has(key) || Object.hasOwn(values, key) || !value) {
      fail("argument_invalid");
    }
    values[key] = value;
  }
  if ([...expected].some((key) => !Object.hasOwn(values, key))) fail("argument_invalid");
  return { command, values };
}

function operationForCommand(command: OperatorCommand): OperationKind {
  return command.endsWith("quarantine") ? "quarantine" : "apply";
}

function safeAbsolutePath(value: string): string {
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) fail("path_invalid");
  return path.resolve(value);
}

function readPrivateFile(
  filename: string,
  maximumBytes: number,
  expectedSha256?: string,
): PrivateFile {
  const resolved = safeAbsolutePath(filename);
  if (expectedSha256 !== undefined && !SHA256_PATTERN.test(expectedSha256)) {
    fail("hash_invalid");
  }
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const effectiveUid = process.geteuid?.();
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.size < 1n
      || before.size > BigInt(maximumBytes)
      || (before.mode & 0o077n) !== 0n
      || (effectiveUid !== undefined && before.uid !== BigInt(effectiveUid))
    ) fail("private_file_unsafe");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail("private_file_read_failed");
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode
      || before.uid !== after.uid || before.gid !== after.gid
    ) fail("private_file_changed");
    const sha256 = sha256PostgresMigrationBytes(bytes);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      fail("artifact_hash_mismatch");
    }
    return { bytes, sha256 };
  } catch (error) {
    if (error instanceof OperatorCliError) throw error;
    return fail("private_file_unsafe");
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function parseDatabaseUrl(bytes: Buffer): URL {
  let url: URL;
  let database: string;
  let password: string;
  let username: string;
  try {
    const value = bytes.toString("utf8");
    if (value !== value.trim() || /[\r\n\0]/.test(value)) fail("database_url_invalid");
    url = new URL(value);
    const authorityStart = value.indexOf("://") + 3;
    const authorityEnd = value.indexOf("/", authorityStart);
    const userInfoEnd = value.lastIndexOf("@", authorityEnd);
    if (
      authorityStart < 3
      || authorityEnd < 0
      || userInfoEnd < authorityStart
      || value.slice(userInfoEnd + 1, authorityEnd)
        !== `${url.hostname}:5432`
    ) fail("database_url_invalid");
    database = decodeURIComponent(url.pathname.slice(1));
    password = decodeURIComponent(url.password);
    username = decodeURIComponent(url.username);
  } catch (error) {
    if (error instanceof OperatorCliError) throw error;
    return fail("database_url_invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !ROLE_PATTERN.test(username)
    || !password
    || !RAILWAY_PRIVATE_HOST_PATTERN.test(url.hostname)
    || url.hostname !== url.hostname.toLowerCase()
    || url.port !== "5432"
    || !database
    || database.length > 63
    || url.hash
    || url.searchParams.get("sslmode") !== "verify-full"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || /[\u0000-\u001f\u007f]/.test(database)
  ) fail("database_url_invalid");
  return url;
}

function quoteIdentifier(value: string): string {
  if (!ROLE_PATTERN.test(value)) fail("database_role_invalid");
  return `"${value}"`;
}

function reviewedPriceAuthority(
  databaseOid: string,
  kind: ReviewedPriceAuthorityKind,
): readonly { readonly roleName: string; readonly functionName: string }[] {
  if (!/^[1-9][0-9]{0,9}$/.test(databaseOid)) fail("database_role_invalid");
  return kind === "reviewer"
    ? [{
      functionName: "authorize_reviewed_price_promotion",
      roleName: `pintpath_reviewed_price_reviewer_execute_d${databaseOid}`,
    }]
    : [
      {
        functionName: "apply_reviewed_price_promotion",
        roleName: `pintpath_reviewed_price_apply_execute_d${databaseOid}`,
      },
      {
        functionName: "quarantine_reviewed_price_promotion",
        roleName: `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`,
      },
    ];
}

async function verifyReviewedPriceLoginAuthority(
  client: Client,
  input: {
    readonly databaseOid: string;
    readonly kind: ReviewedPriceAuthorityKind;
    readonly loginRole: string;
  },
): Promise<void> {
  if (!ROLE_PATTERN.test(input.loginRole)) fail("database_role_invalid");
  const authority = reviewedPriceAuthority(input.databaseOid, input.kind);
  if (authority.some(({ roleName }) => !ROLE_PATTERN.test(roleName))) {
    fail("database_role_invalid");
  }
  const roleNames = authority.map(({ roleName }) => roleName);
  const functionNames = authority.map(({ functionName }) => functionName);
  const result = await client.query<{ safe: boolean }>(`WITH RECURSIVE
    expected_authority(role_name, function_name) AS (
      SELECT role.role_name, routine.function_name
        FROM pg_catalog.unnest($3::pg_catalog.text[])
          WITH ORDINALITY AS role(role_name, position)
        JOIN pg_catalog.unnest($4::pg_catalog.text[])
          WITH ORDINALITY AS routine(function_name, position)
          USING (position)
    ), login_role AS (
      SELECT role.*
        FROM pg_catalog.pg_roles AS role
       WHERE role.rolname = session_user
         AND role.rolname = $2
    ), target_database AS (
      SELECT database.*
        FROM pg_catalog.pg_database AS database
       WHERE database.oid = $1::pg_catalog.oid
         AND database.datname = pg_catalog.current_database()
    ), operations_namespace AS (
      SELECT namespace.*
        FROM pg_catalog.pg_namespace AS namespace
       WHERE namespace.nspname = 'pintpath_ops'
    ), expected_roles AS (
      SELECT role.*, expected.function_name, routine.oid AS function_oid
        FROM expected_authority AS expected
        JOIN pg_catalog.pg_roles AS role
          ON role.rolname = expected.role_name
        CROSS JOIN operations_namespace AS namespace
        JOIN pg_catalog.pg_proc AS routine
          ON routine.pronamespace = namespace.oid
         AND routine.proname = expected.function_name
         AND routine.prokind = 'f'
         AND routine.pronargs = 1
         AND routine.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype
    ), all_authority_roles AS (
      SELECT login.oid FROM login_role AS login
      UNION ALL
      SELECT role.oid FROM expected_roles AS role
    ), set_role_paths(role_oid, path) AS (
      SELECT membership.roleid,
             ARRAY[login.oid, membership.roleid]::pg_catalog.oid[]
        FROM login_role AS login
        JOIN pg_catalog.pg_auth_members AS membership
          ON membership.member = login.oid
         AND membership.set_option
      UNION ALL
      SELECT membership.roleid, path.path || membership.roleid
        FROM set_role_paths AS path
        JOIN pg_catalog.pg_auth_members AS membership
          ON membership.member = path.role_oid
         AND membership.set_option
       WHERE NOT membership.roleid = ANY(path.path)
    ), actual_acl_dependencies AS (
      SELECT dependency.dbid, dependency.classid, dependency.objid,
             dependency.objsubid, dependency.refobjid
        FROM pg_catalog.pg_shdepend AS dependency
        JOIN all_authority_roles AS role
          ON role.oid = dependency.refobjid
       WHERE dependency.refclassid =
               'pg_catalog.pg_authid'::pg_catalog.regclass
         AND dependency.deptype = 'a'
    ), expected_acl_dependencies AS (
      SELECT 0::pg_catalog.oid AS dbid,
             'pg_catalog.pg_database'::pg_catalog.regclass::pg_catalog.oid
               AS classid,
             database.oid AS objid, 0 AS objsubid, login.oid AS refobjid
        FROM target_database AS database
        CROSS JOIN login_role AS login
      UNION ALL
      SELECT database.oid,
             'pg_catalog.pg_namespace'::pg_catalog.regclass::pg_catalog.oid,
             namespace.oid, 0, role.oid
        FROM target_database AS database
        CROSS JOIN operations_namespace AS namespace
        CROSS JOIN expected_roles AS role
      UNION ALL
      SELECT database.oid,
             'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid,
             role.function_oid, 0, role.oid
        FROM target_database AS database
        CROSS JOIN expected_roles AS role
    )
    SELECT (
      (SELECT pg_catalog.count(*) = 1
          AND pg_catalog.bool_and(
            login.rolcanlogin
            AND NOT login.rolsuper
            AND NOT login.rolcreatedb
            AND NOT login.rolcreaterole
            AND NOT login.rolinherit
            AND NOT login.rolreplication
            AND NOT login.rolbypassrls
            AND login.rolconnlimit = 1
            AND login.rolvaliduntil IS NOT NULL
            AND login.rolvaliduntil > pg_catalog.statement_timestamp()
            AND login.rolvaliduntil
                  <= pg_catalog.statement_timestamp() + interval '24 hours'
          )
         FROM login_role AS login)
      AND (SELECT pg_catalog.count(*) = 1
             AND pg_catalog.bool_and(
               NOT database.datistemplate AND database.datallowconn
             )
             FROM target_database AS database)
      AND (SELECT pg_catalog.count(*) = pg_catalog.cardinality($3::pg_catalog.text[])
             AND pg_catalog.bool_and(
               NOT role.rolcanlogin
               AND NOT role.rolsuper
               AND NOT role.rolcreatedb
               AND NOT role.rolcreaterole
               AND NOT role.rolinherit
               AND NOT role.rolreplication
               AND NOT role.rolbypassrls
               AND role.rolconnlimit = -1
               AND role.rolvaliduntil IS NULL
             )
             FROM expected_roles AS role)
      AND (SELECT pg_catalog.count(*) = pg_catalog.cardinality($3::pg_catalog.text[])
             AND pg_catalog.bool_and(
               expected.oid IS NOT NULL
               AND NOT membership.admin_option
               AND NOT membership.inherit_option
               AND membership.set_option
             )
             FROM login_role AS login
             JOIN pg_catalog.pg_auth_members AS membership
               ON membership.member = login.oid
             LEFT JOIN expected_roles AS expected
               ON expected.oid = membership.roleid)
      AND NOT EXISTS (
        SELECT 1
          FROM login_role AS login
          JOIN pg_catalog.pg_auth_members AS membership
            ON membership.roleid = login.oid
      )
      AND (SELECT pg_catalog.count(*) = pg_catalog.cardinality($3::pg_catalog.text[])
             AND pg_catalog.bool_and(
               membership.member = login.oid
               AND NOT membership.admin_option
               AND NOT membership.inherit_option
               AND membership.set_option
             )
             FROM expected_roles AS role
             JOIN pg_catalog.pg_auth_members AS membership
               ON membership.roleid = role.oid
             CROSS JOIN login_role AS login)
      AND NOT EXISTS (
        SELECT 1
          FROM expected_roles AS role
          JOIN pg_catalog.pg_auth_members AS membership
            ON membership.member = role.oid
      )
      AND COALESCE((
        SELECT pg_catalog.array_agg(
                 DISTINCT reachable.rolname::pg_catalog.text COLLATE "C"
                 ORDER BY reachable.rolname::pg_catalog.text COLLATE "C"
               )
          FROM set_role_paths AS path
          JOIN pg_catalog.pg_roles AS reachable
            ON reachable.oid = path.role_oid
      ), ARRAY[]::pg_catalog.text[]) = $3::pg_catalog.text[]
      AND NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_db_role_setting AS setting
         WHERE setting.setrole IN (SELECT role.oid FROM all_authority_roles AS role)
            OR (
              setting.setrole = 0::pg_catalog.oid
              AND setting.setdatabase IN (
                0::pg_catalog.oid,
                (SELECT database.oid FROM target_database AS database)
              )
            )
      )
      AND (SELECT pg_catalog.count(*) = 1
             AND pg_catalog.bool_and(
               database.oid = target.oid
               AND privilege.grantee = login.oid
               AND privilege.privilege_type = 'CONNECT'
               AND NOT privilege.is_grantable
             )
             FROM pg_catalog.pg_database AS database
             CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
               database.datacl,
               pg_catalog.acldefault('d', database.datdba)
             )) AS privilege
             JOIN all_authority_roles AS authority
               ON authority.oid = privilege.grantee
             CROSS JOIN target_database AS target
             CROSS JOIN login_role AS login)
      AND (SELECT pg_catalog.has_database_privilege(
                   login.oid, database.oid, 'CONNECT'
                 )
               AND NOT pg_catalog.has_database_privilege(
                 login.oid, database.oid, 'CREATE'
               )
               AND NOT pg_catalog.has_database_privilege(
                 login.oid, database.oid, 'TEMP'
               )
             FROM login_role AS login
             CROSS JOIN target_database AS database)
      AND (SELECT pg_catalog.count(*) = pg_catalog.cardinality($3::pg_catalog.text[])
             AND pg_catalog.bool_and(
               namespace.oid = operations.oid
               AND expected.oid = privilege.grantee
               AND privilege.privilege_type = 'USAGE'
               AND NOT privilege.is_grantable
             )
             FROM pg_catalog.pg_namespace AS namespace
             CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
             JOIN all_authority_roles AS authority
               ON authority.oid = privilege.grantee
             LEFT JOIN expected_roles AS expected
               ON expected.oid = privilege.grantee
             CROSS JOIN operations_namespace AS operations)
      AND NOT EXISTS (
        SELECT 1
          FROM operations_namespace AS namespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            namespace.nspacl,
            pg_catalog.acldefault('n', namespace.nspowner)
          )) AS privilege
         WHERE privilege.grantee = 0::pg_catalog.oid
      )
      AND (SELECT pg_catalog.count(*) = pg_catalog.cardinality($3::pg_catalog.text[])
             AND pg_catalog.bool_and(
               expected.oid = privilege.grantee
               AND expected.function_oid = routine.oid
               AND privilege.privilege_type = 'EXECUTE'
               AND NOT privilege.is_grantable
             )
             FROM pg_catalog.pg_proc AS routine
             CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) AS privilege
             JOIN all_authority_roles AS authority
               ON authority.oid = privilege.grantee
             LEFT JOIN expected_roles AS expected
               ON expected.oid = privilege.grantee
              AND expected.function_oid = routine.oid)
      AND NOT EXISTS (
        SELECT 1
          FROM expected_roles AS expected
          JOIN pg_catalog.pg_proc AS routine
            ON routine.oid = expected.function_oid
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )) AS privilege
         WHERE privilege.grantee = 0::pg_catalog.oid
      )
      AND NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
          JOIN all_authority_roles AS authority
            ON authority.oid = privilege.grantee
      )
      AND NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          JOIN all_authority_roles AS authority
            ON authority.oid = privilege.grantee
         WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
      )
      AND NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_type AS type
          CROSS JOIN LATERAL pg_catalog.aclexplode(type.typacl) AS privilege
          JOIN all_authority_roles AS authority
            ON authority.oid = privilege.grantee
      )
      AND NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_shdepend AS dependency
          JOIN all_authority_roles AS role
            ON role.oid = dependency.refobjid
         WHERE dependency.refclassid =
                 'pg_catalog.pg_authid'::pg_catalog.regclass
           AND dependency.deptype = 'o'
      )
      AND NOT EXISTS (
        (SELECT actual.dbid, actual.classid, actual.objid,
                actual.objsubid, actual.refobjid
           FROM actual_acl_dependencies AS actual
         EXCEPT
         SELECT expected.dbid, expected.classid, expected.objid,
                expected.objsubid, expected.refobjid
           FROM expected_acl_dependencies AS expected)
        UNION ALL
        (SELECT expected.dbid, expected.classid, expected.objid,
                expected.objsubid, expected.refobjid
           FROM expected_acl_dependencies AS expected
         EXCEPT
         SELECT actual.dbid, actual.classid, actual.objid,
                actual.objsubid, actual.refobjid
           FROM actual_acl_dependencies AS actual)
      )
    ) AS safe`, [
    input.databaseOid,
    input.loginRole,
    roleNames,
    functionNames,
  ]);
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true) {
    fail("database_role_invalid");
  }
}

const DEFAULT_REVIEWED_PRICE_DATABASE_DEPENDENCIES:
ReviewedPriceOperatorDatabaseDependencies = Object.freeze({
  createPostgresClient: (config: ClientConfig) => new Client(config),
  getUid: () => process.getuid?.() ?? null,
  getEuid: () => process.geteuid?.() ?? null,
  openTransport: openPostgresRailwayStockLocalhostCaTransport,
});

async function executeDatabaseWithDependencies(input: {
  readonly databaseUrl: URL;
  readonly command: OperatorCommand;
  readonly expectedRootCaDerSha256: string;
  readonly request: PostgresReviewedPriceOperationRequest;
  readonly rootCaFile: string;
}, dependencies: ReviewedPriceOperatorDatabaseDependencies): Promise<DatabaseExecutionResult> {
  if (!SHA256_PATTERN.test(input.expectedRootCaDerSha256)) {
    fail("root_ca_pin_invalid");
  }
  const uid = dependencies.getUid();
  const euid = dependencies.getEuid();
  if (uid === null || euid === null || uid !== euid) fail("transport_invalid");
  const operation = operationForCommand(input.command);
  const isAuthorization = input.command.startsWith("authorize-");
  const username = decodeURIComponent(input.databaseUrl.username);
  let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
  let client: Client | null = null;
  let transactionOpen = false;
  let result: DatabaseExecutionResult | null = null;
  let failure: unknown = null;
  try {
    transport = await dependencies.openTransport({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile: input.rootCaFile,
      expectedRootCaDerSha256: input.expectedRootCaDerSha256,
      expectedUid: uid,
      sourceUrlAuthority: {
        hostname: input.databaseUrl.hostname,
        port: input.databaseUrl.port ? Number(input.databaseUrl.port) : 5_432,
      },
    });
    if (
      transport.profile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
      || transport.rootCaDerSha256 !== input.expectedRootCaDerSha256
      || transport.sourceUrlAuthority.hostname !== input.databaseUrl.hostname
      || transport.sourceUrlAuthority.port !== 5_432
      || transport.resolvedAddress !== transport.nodeConnection.host
      || !transport.resolvedAddress.toLowerCase().startsWith("fd12:")
      || transport.nodeConnection.port !== 5_432
      || transport.nodeConnection.ssl.servername !== "localhost"
      || transport.nodeConnection.ssl.rejectUnauthorized !== true
      || transport.nodeConnection.ssl.minVersion !== "TLSv1.2"
      || transport.nodeConnection.ssl.checkServerIdentity
        !== checkPostgresRailwayStockLocalhostServerIdentity
    ) fail("transport_invalid");
    await transport.assertExact();
    const config: ClientConfig = {
      application_name: `pintpath-reviewed-price-${input.command}-operator`,
      connectionTimeoutMillis: 10_000,
      database: decodeURIComponent(input.databaseUrl.pathname.slice(1)),
      host: transport.nodeConnection.host,
      password: decodeURIComponent(input.databaseUrl.password),
      port: transport.nodeConnection.port,
      query_timeout: 180_000,
      ssl: transport.nodeConnection.ssl,
      user: username,
    };
    if (Object.hasOwn(config, "connectionString")) fail("transport_invalid");
    client = dependencies.createPostgresClient(config);
    await client.connect();
    await transport.assertExact();
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    await client.query("SET LOCAL search_path = pg_catalog");
    await client.query("SET LOCAL row_security = on");
    await client.query("SET LOCAL statement_timeout = '180s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    await client.query("SET LOCAL synchronous_commit = on");
    const identity = await client.query<{
      currentUser: string;
      databaseOid: string;
      sessionUser: string;
    }>(`SELECT current_user::text AS "currentUser",
              database.oid::text AS "databaseOid",
              session_user::text AS "sessionUser"
         FROM pg_catalog.pg_database AS database
        WHERE database.datname = pg_catalog.current_database()`);
    const identityRow = identity.rows[0];
    if (
      identity.rows.length !== 1
      || !identityRow
      || identityRow.currentUser !== username
      || identityRow.sessionUser !== username
      || !/^[1-9][0-9]{0,9}$/.test(identityRow.databaseOid)
    ) fail("database_identity_invalid");
    const authorityKind = isAuthorization ? "reviewer" : "operator";
    const authority = reviewedPriceAuthority(identityRow.databaseOid, authorityKind);
    const executeRole = isAuthorization
      ? authority[0]!.roleName
      : authority.find(({ functionName }) => functionName.startsWith(operation))!
        .roleName;
    if (!ROLE_PATTERN.test(executeRole)) fail("database_role_invalid");
    await verifyReviewedPriceLoginAuthority(client, {
      databaseOid: identityRow.databaseOid,
      kind: authorityKind,
      loginRole: username,
    });
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(executeRole)}`);
    const roleIdentity = await client.query<{ currentUser: string }>(
      "SELECT current_user::text AS \"currentUser\"",
    );
    if (roleIdentity.rows[0]?.currentUser !== executeRole) fail("database_role_invalid");
    const functionName = isAuthorization
      ? "authorize_reviewed_price_promotion"
      : operation === "apply"
        ? "apply_reviewed_price_promotion"
        : "quarantine_reviewed_price_promotion";
    const queryResult = await client.query<{ response: unknown }>(
      `SELECT pintpath_ops.${functionName}($1::pg_catalog.jsonb) AS response`,
      [JSON.stringify(input.request)],
    );
    const response = isAuthorization
      ? postgresReviewedPriceOperationAuthorizationResponseSchema.safeParse(
        queryResult.rows[0]?.response,
      )
      : postgresReviewedPriceOperationDatabaseResponseSchema.safeParse(
        queryResult.rows[0]?.response,
      );
    if (queryResult.rows.length !== 1 || !response.success) {
      fail("database_receipt_invalid");
    }
    await client.query("RESET ROLE");
    await verifyReviewedPriceLoginAuthority(client, {
      databaseOid: identityRow.databaseOid,
      kind: authorityKind,
      loginRole: username,
    });
    await transport.assertExact();
    await client.query("COMMIT");
    transactionOpen = false;
    await transport.assertExact();
    result = isAuthorization
      ? {
        artifact: (response.data as {
          authorization: PostgresReviewedPriceOperationAuthorizationReceipt;
        }).authorization,
        artifactKind: "authorization",
        replayed: response.data.replayed,
      }
      : {
        artifact: (response.data as { receipt: PostgresReviewedPriceOperationReceipt }).receipt,
        artifactKind: "receipt",
        replayed: response.data.replayed,
      };
  } catch (error) {
    failure = error;
    if (transactionOpen && client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        failure = new OperatorCliError("database_rollback_failed");
      }
    }
  }
  if (transport) {
    try {
      await transport.assertExact();
    } catch {
      failure = new OperatorCliError("transport_invalid");
    }
  }
  if (client) {
    try {
      await client.end();
    } catch {
      failure = new OperatorCliError("database_release_failed");
    }
  }
  if (transport) {
    try {
      await transport.close();
    } catch {
      failure = new OperatorCliError("database_release_failed");
    }
  }
  if (failure) throw failure;
  if (!result) fail("database_receipt_invalid");
  return result;
}

async function executeDatabase(input: {
  readonly databaseUrl: URL;
  readonly command: OperatorCommand;
  readonly expectedRootCaDerSha256: string;
  readonly request: PostgresReviewedPriceOperationRequest;
  readonly rootCaFile: string;
}): Promise<DatabaseExecutionResult> {
  return executeDatabaseWithDependencies(
    input,
    DEFAULT_REVIEWED_PRICE_DATABASE_DEPENDENCIES,
  );
}

function publishReceipt(
  filename: string,
  receipt: PostgresReviewedPriceOperationReceipt
    | PostgresReviewedPriceOperationAuthorizationReceipt,
): void {
  const resolved = safeAbsolutePath(filename);
  const bytes = serializeCanonicalPostgresMigrationJson(receipt);
  if (bytes.length > POSTGRES_REVIEWED_PRICE_OPERATION_MAX_RECEIPT_BYTES) {
    fail("receipt_output_invalid");
  }
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (count <= 0) fail("receipt_output_invalid");
      offset += count;
    }
    fs.fsyncSync(descriptor);
    fsyncParentDirectory(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readPrivateFile(
        resolved,
        POSTGRES_REVIEWED_PRICE_OPERATION_MAX_RECEIPT_BYTES,
      );
      if (!existing.bytes.equals(bytes)) fail("receipt_output_conflict");
      fsyncParentDirectory(resolved);
      return;
    }
    if (error instanceof OperatorCliError) throw error;
    return fail("receipt_output_invalid");
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function fsyncParentDirectory(filename: string): void {
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      path.dirname(filename),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
        | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isDirectory()) fail("receipt_output_invalid");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof OperatorCliError) throw error;
    return fail("receipt_output_invalid");
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

const DEFAULT_DEPENDENCIES: PostgresReviewedPriceOperatorDependencies = Object.freeze({
  executeDatabase,
  now: () => new Date(),
  writeOutput: (value: string) => process.stdout.write(value),
});

export async function runPostgresReviewedPricePromotionOperatorWithDependencies(
  argv: readonly string[],
  dependencies: PostgresReviewedPriceOperatorDependencies,
): Promise<0 | 1> {
  let command: OperatorCommand | "unknown" = "unknown";
  try {
    const parsed = parseArguments(argv);
    command = parsed.command;
    const values = parsed.values;
    const plan = readPrivateFile(
      values["plan-file"]!,
      POSTGRES_REVIEWED_PRICE_OPERATION_MAX_PLAN_BYTES,
      values["plan-file-sha256"]!,
    );
    const packet = readPrivateFile(
      values["review-packet-file"]!,
      POSTGRES_REVIEWED_PRICE_OPERATION_MAX_REVIEW_PACKET_BYTES,
      values["review-packet-file-sha256"]!,
    );
    const approval = readPrivateFile(
      values["approval-file"]!,
      POSTGRES_REVIEWED_PRICE_OPERATION_MAX_APPROVAL_BYTES,
      values["approval-file-sha256"]!,
    );
    const publicKeyFile = readPrivateFile(
      values["reviewer-public-key-file"]!,
      64 * 1_024,
      values["reviewer-public-key-file-sha256"]!,
    );
    const rootCa = readPrivateFile(
      values["root-ca-file"]!,
      1024 * 1_024,
      values["root-ca-file-sha256"]!,
    );
    const databaseUrlFile = readPrivateFile(
      values["database-url-file"]!,
      16 * 1_024,
      values["database-url-file-sha256"]!,
    );
    const databaseUrl = parseDatabaseUrl(databaseUrlFile.bytes);
    const reviewerPublicKey = crypto.createPublicKey(publicKeyFile.bytes);
    let applyReceipt: PrivateFile | undefined;
    const operation = operationForCommand(parsed.command);
    const isAuthorization = parsed.command.startsWith("authorize-");
    if (operation === "quarantine") {
      applyReceipt = readPrivateFile(
        values["apply-receipt-file"]!,
        POSTGRES_REVIEWED_PRICE_OPERATION_MAX_RECEIPT_BYTES,
        values["apply-receipt-file-sha256"]!,
      );
    }
    const validated = validatePostgresReviewedPriceOperationArtifacts({
      approvalBytes: approval.bytes,
      approvalFileSha256: approval.sha256,
      ...(applyReceipt ? {
        applyReceiptBytes: applyReceipt.bytes,
        applyReceiptFileSha256: applyReceipt.sha256,
        expectedApplyReceiptFileSha256: values["apply-receipt-file-sha256"]!,
      } : {}),
      expectedApprovalFileSha256: values["approval-file-sha256"]!,
      expectedPlanFileSha256: values["plan-file-sha256"]!,
      expectedReviewPacketFileSha256: values["review-packet-file-sha256"]!,
      expectedReviewerPublicKeySha256:
        values["reviewer-public-key-file-sha256"]!,
      expectedRootCaSha256: values["root-ca-file-sha256"]!,
      now: dependencies.now(),
      ...(isAuthorization
        ? { reviewerLogin: decodeURIComponent(databaseUrl.username) }
        : { operatorLogin: decodeURIComponent(databaseUrl.username) }),
      planBytes: plan.bytes,
      planFileSha256: plan.sha256,
      reviewPacketBytes: packet.bytes,
      reviewPacketFileSha256: packet.sha256,
      reviewerPublicKey,
      reviewerPublicKeyBytes: publicKeyFile.bytes,
    });
    if (validated.approval.payload.operationKind !== operation) {
      fail("operation_kind_mismatch");
    }
    const result = await dependencies.executeDatabase({
      databaseUrl,
      command: parsed.command,
      expectedRootCaDerSha256: values["expected-root-ca-der-sha256"]!,
      request: validated.request,
      rootCaFile: safeAbsolutePath(values["root-ca-file"]!),
    });
    publishReceipt(values["output-receipt"]!, result.artifact);
    const artifactFileSha256 = sha256PostgresMigrationBytes(
      serializeCanonicalPostgresMigrationJson(result.artifact),
    );
    dependencies.writeOutput(`${JSON.stringify(result.artifactKind === "receipt" ? {
      command: parsed.command,
      ok: true,
      operationId: result.artifact.operationId,
      receiptFileSha256: artifactFileSha256,
      receiptSha256: result.artifact.receiptSha256,
      replayed: result.replayed,
      rowCount: result.artifact.requestedRowCount,
    } : {
      authorizationFileSha256: artifactFileSha256,
      authorizationId: result.artifact.authorizationId,
      command: parsed.command,
      ok: true,
      operationId: result.artifact.operationId,
      replayed: result.replayed,
    })}\n`);
    return 0;
  } catch (error) {
    const failureCode = error instanceof OperatorCliError
      ? error.code
      : error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "unexpected_failure";
    dependencies.writeOutput(`${JSON.stringify({ command, failureCode, ok: false })}\n`);
    return 1;
  }
}

export async function runPostgresReviewedPricePromotionOperator(
  argv: readonly string[],
): Promise<0 | 1> {
  return runPostgresReviewedPricePromotionOperatorWithDependencies(
    argv,
    DEFAULT_DEPENDENCIES,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresReviewedPricePromotionOperator(process.argv.slice(2));
}

export const postgresReviewedPricePromotionOperatorInternals = Object.freeze({
  executeDatabaseWithDependencies,
  parseArguments,
  parseDatabaseUrl,
  verifyReviewedPriceLoginAuthority,
});
