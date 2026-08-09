import crypto from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Client, type QueryResultRow } from "pg";

import { checkPostgresRuntimeReadiness } from "../src/db/postgres-runtime.js";
import { createPostgresDatabase } from "../src/db/sql-database.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const STAGING_PRIVATE_AUTH_PROBE_LOCK = Object.freeze({
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  postgresServiceId: "c454955f-263b-4599-aee0-dc447a4d3d15",
  redisServiceId: "d6351cec-fe04-4a6f-8e05-1cc164ea1e73",
  postgresResourceId:
    "railway:a4e0f507-d6d3-4df9-a818-ad92c0071a35:c454955f-263b-4599-aee0-dc447a4d3d15",
  redisResourceId:
    "railway:a4e0f507-d6d3-4df9-a818-ad92c0071a35:d6351cec-fe04-4a6f-8e05-1cc164ea1e73",
  postgresPrivateHost: "postgres-staging.railway.internal",
  redisPrivateHost: "redis.railway.internal",
  postgresDatabase: "pintpath_staging",
  postgresAdminDatabases: ["railway", "pintpath_staging"] as const,
  postgresAdminLogin: "postgres",
  postgresPredecessorRuntimeLogin: "pintpath_staging_runtime_login",
  redisLogin: "default",
  postgresPort: "5432",
  redisPort: "6379",
  maximumDurationMs: 20 * 60 * 1_000,
  attemptTimeoutMs: 15_000,
  pollIntervalMs: 2_000,
});

export type StagingPrivateAuthProbeMode =
  | "watch-old-rejection"
  | "provision-runtime-candidate"
  | "verify-current"
  | "retire-old-runtime";

export type StagingPrivateAuthProbeTarget =
  | "all"
  | "postgres-admin"
  | "postgres-runtime"
  | "redis";

type ReceiptMode = StagingPrivateAuthProbeMode | "invalid";
type ReceiptTarget = StagingPrivateAuthProbeTarget | "invalid";
type ProbeOutcome = "passed" | "failed" | "inconclusive";
export type AuthenticationResult = "accepted" | "rejected" | "inconclusive";
type AuthenticationReceipt = AuthenticationResult | "not-run";
type TransitionReceipt = "observed" | "not-observed" | "not-run";
type HandoffReceipt = "observed" | "not-observed" | "inconclusive" | "not-run";
type ReadinessReceipt = "ready" | "not-ready" | "inconclusive" | "not-run";
type MutationReceipt =
  | "completed"
  | "rolled-back"
  | "cleanup-inconclusive"
  | "inconclusive"
  | "not-run";
type CandidateCleanupResult = "cleaned" | "absent" | "unowned" | "inconclusive";
type CandidateOwnershipResult =
  | "owned"
  | "handed-off"
  | "absent"
  | "unowned"
  | "inconclusive";
type CandidateHandoffResult =
  | "handed-off"
  | "absent"
  | "unsafe"
  | "unowned"
  | "inconclusive";
type ProvisionRuntimeRoleResult =
  | "created"
  | "existing-owned"
  | "existing-handoff"
  | "unowned"
  | "inconclusive";
type RuntimeIdentityPhase = "predecessor" | "candidate" | "invalid";

export interface StagingPrivateAuthProbeReceipt {
  schemaVersion: "staging-private-auth-probe/v1";
  timestamp: string;
  deploymentId: string;
  mode: ReceiptMode;
  target: ReceiptTarget;
  outcome: ProbeOutcome;
  identity: {
    project: boolean;
    environment: boolean;
    service: boolean;
    deployment: boolean;
    debugLoggingDisabled: boolean;
    postgresResource: boolean;
    redisResource: boolean;
    postgresAdminTarget: boolean;
    postgresRuntimeTarget: boolean;
    redisTarget: boolean;
    postgresAdminLogin: boolean;
    postgresRuntimeLogin: boolean;
    redisLogin: boolean;
    postgresCredentialsDistinct: boolean;
    providerCredentialsDistinct: boolean;
    postgresClient17: boolean;
    runtimeCandidateDistinct: boolean;
    runtimeCandidateSecretDistinct: boolean;
    runtimeCandidateOwnerSecretValid: boolean;
    retiredRuntimeDistinct: boolean;
  };
  checks: {
    postgresAdminAuth: AuthenticationReceipt;
    postgresRuntimeAuth: AuthenticationReceipt;
    redisAuth: AuthenticationReceipt;
    postgresAdminTransition: TransitionReceipt;
    postgresRuntimeTransition: TransitionReceipt;
    redisTransition: TransitionReceipt;
    runtimeHandoff: HandoffReceipt;
    runtimeReadiness: ReadinessReceipt;
    runtimeMutation: MutationReceipt;
  };
}

export interface StagingPrivateAuthProbeProgress {
  schemaVersion: "staging-private-auth-probe-progress/v1";
  deploymentId: string;
  mode: "watch-old-rejection";
  target: StagingPrivateAuthProbeTarget;
  event: "watcher-armed";
  outcome: "accepted";
}

interface ParsedPostgresTarget {
  raw: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  database: string;
  sslMode: "prefer" | "require" | "verify-ca" | "verify-full";
  sslRootCertificate?: string;
}

interface ParsedRedisTarget {
  raw: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
}

export interface CapturedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
  outputOverflow: boolean;
}

export interface PsqlExecutionRequest {
  psqlPath: string;
  connectionUrl: string;
  stdin: string;
  additionalEnvironment?: Readonly<Record<string, string>>;
  timeoutMs: number;
}

type PsqlRunner = (
  request: PsqlExecutionRequest,
) => Promise<CapturedProcessResult>;

interface RuntimeRoleMutationInput {
  adminUrl: string;
  login: string;
  psqlPath: string;
  timeoutMs: number;
}

interface CandidateRoleMutationInput extends RuntimeRoleMutationInput {
  ownerMarker: string;
}

interface CandidateRoleHandoffInput extends RuntimeRoleMutationInput {
  handoffMarker: string;
}

interface FinalizeCandidateRoleInput
  extends CandidateRoleMutationInput,
    CandidateRoleHandoffInput {}

interface ProvisionRuntimeRoleInput extends FinalizeCandidateRoleInput {
  verifier: string;
}

interface ProbeConfiguration {
  mode: StagingPrivateAuthProbeMode;
  target: StagingPrivateAuthProbeTarget;
  deploymentId: string;
  psqlPath: string;
  postgresAdminUrl: string;
  postgresRuntimeUrl: string;
  redisUrl: string;
  candidateLogin: string;
  candidatePassword: string;
  candidateOwnerSecret: string;
  runtimeIdentityPhase: RuntimeIdentityPhase;
  identity: StagingPrivateAuthProbeReceipt["identity"];
}

export interface StagingPrivateAuthProbeDependencies {
  env: Readonly<Record<string, string | undefined>>;
  now: () => Date;
  monotonicNow: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  randomBytes: (size: number) => Buffer;
  validatePostgresClient: (
    psqlPath: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  attemptPostgres: (
    connectionUrl: string,
    psqlPath: string,
    timeoutMs: number,
  ) => Promise<AuthenticationResult>;
  attemptRedis: (
    connectionUrl: string,
    timeoutMs: number,
  ) => Promise<AuthenticationResult>;
  checkRuntimeReadiness: (
    connectionUrl: string,
    timeoutMs: number,
  ) => Promise<ReadinessReceipt>;
  provisionRuntimeRole: (
    input: ProvisionRuntimeRoleInput,
  ) => Promise<ProvisionRuntimeRoleResult>;
  inspectRuntimeRoleOwnership: (
    input: FinalizeCandidateRoleInput,
  ) => Promise<CandidateOwnershipResult>;
  finalizeRuntimeRoleOwnership: (
    input: FinalizeCandidateRoleInput,
  ) => Promise<CandidateHandoffResult>;
  inspectRuntimeRoleHandoff: (
    input: CandidateRoleHandoffInput,
  ) => Promise<CandidateHandoffResult>;
  cleanupRuntimeRole: (
    input: CandidateRoleMutationInput,
  ) => Promise<CandidateCleanupResult>;
  acquireProvisionLifecycleLock: (
    adminUrl: string,
    timeoutMs: number,
  ) => Promise<ProvisionLifecycleLock | null>;
  retireRuntimeRole: (input: RuntimeRoleMutationInput) => Promise<boolean>;
  writeOutput: (output: string) => void;
}

export interface ProvisionLifecycleLock {
  verify: (timeoutMs: number) => Promise<boolean>;
  release: (timeoutMs: number) => Promise<void>;
}

const PROBE_MODES = new Set<StagingPrivateAuthProbeMode>([
  "watch-old-rejection",
  "provision-runtime-candidate",
  "verify-current",
  "retire-old-runtime",
]);

const PROBE_TARGETS = new Set<StagingPrivateAuthProbeTarget>([
  "all",
  "postgres-admin",
  "postgres-runtime",
  "redis",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSIONED_RUNTIME_LOGIN_PATTERN =
  /^pintpath_staging_runtime_login_[0-9]{8}[a-z0-9]{1,16}$/;
const URL_SAFE_PASSWORD_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const SCRAM_ITERATIONS = 4_096;
const MAX_CAPTURED_PROCESS_BYTES = 64 * 1_024;
const INTERNAL_READINESS_URL_ENV = "STAGING_AUTH_PROBE_INTERNAL_RUNTIME_URL";
const PROVISION_LIFECYCLE_LOCK_KEYS = [1_347_427_924, 1_096_110_152] as const;
const PROVISION_LIFECYCLE_LOCK_QUERY = `/* pintpath:staging-auth-probe:lifecycle-lock */
SELECT
  pg_catalog.pg_backend_pid() AS "backendPid",
  pg_catalog.pg_try_advisory_lock($1::integer, $2::integer) AS "acquired"`;
const VERIFY_PROVISION_LIFECYCLE_LOCK_QUERY = `/* pintpath:staging-auth-probe:lifecycle-lock-verify */
SELECT
  pg_catalog.pg_backend_pid() AS "backendPid",
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks
    WHERE locktype = 'advisory'
      AND pid = pg_catalog.pg_backend_pid()
      AND classid = $1::integer::oid
      AND objid = $2::integer::oid
      AND objsubid = 2
      AND granted
  ) AS "held"`;
const RUNTIME_ROLE_SAFETY_QUERY = `/* pintpath:staging-auth-probe:role-safety */
SELECT
  rolcanlogin AS "canLogin",
  rolinherit AS "inheritsMembership",
  rolsuper AS "isSuperuser",
  rolcreatedb AS "canCreateDatabase",
  rolcreaterole AS "canCreateRole",
  rolreplication AS "canReplicate",
  rolbypassrls AS "canBypassRls"
FROM pg_catalog.pg_roles
WHERE rolname = session_user`;
const PROVISION_RUNTIME_SCRIPT = String.raw`\set ON_ERROR_STOP on
\getenv candidate_login STAGING_AUTH_PROBE_CANDIDATE_LOGIN
\getenv candidate_verifier STAGING_AUTH_PROBE_CANDIDATE_VERIFIER
\getenv candidate_owner STAGING_AUTH_PROBE_CANDIDATE_OWNER
\getenv candidate_handoff STAGING_AUTH_PROBE_CANDIDATE_HANDOFF
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(:'candidate_login', 0)
) \g /dev/null
SELECT NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'candidate_login'
) AS candidate_absent,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_owner'
) AS candidate_owned,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_handoff'
) AS candidate_handed_off \gset
\if :candidate_absent
SET LOCAL password_encryption = 'scram-sha-256';
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS',
  :'candidate_login',
  :'candidate_verifier'
) \gexec
SELECT format('GRANT pintpath_runtime TO %I', :'candidate_login') \gexec
SELECT format(
  'GRANT CONNECT ON DATABASE pintpath_staging TO %I',
  :'candidate_login'
) \gexec
SELECT format('COMMENT ON ROLE %I IS %L', :'candidate_login', :'candidate_owner') \gexec
SELECT format(
  'ALTER ROLE %I IN DATABASE pintpath_staging SET search_path = pintpath_app, pg_catalog',
  :'candidate_login'
) \gexec
COMMIT;
SELECT 'created';
\elif :candidate_owned
COMMIT;
SELECT 'existing-owned';
\elif :candidate_handed_off
COMMIT;
SELECT 'existing-handoff';
\else
ROLLBACK;
SELECT 'unowned';
\endif
`;
const INSPECT_RUNTIME_OWNERSHIP_SCRIPT = String.raw`\set ON_ERROR_STOP on
\getenv candidate_login STAGING_AUTH_PROBE_CANDIDATE_LOGIN
\getenv candidate_owner STAGING_AUTH_PROBE_CANDIDATE_OWNER
\getenv candidate_handoff STAGING_AUTH_PROBE_CANDIDATE_HANDOFF
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(:'candidate_login', 0)
) \g /dev/null
SELECT NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'candidate_login'
) AS candidate_absent,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_owner'
) AS candidate_owned,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_handoff'
) AS candidate_handed_off \gset
\if :candidate_absent
COMMIT;
SELECT 'absent';
\elif :candidate_owned
COMMIT;
SELECT 'owned';
\elif :candidate_handed_off
COMMIT;
SELECT 'handed-off';
\else
ROLLBACK;
SELECT 'unowned';
\endif
`;
const FINALIZE_RUNTIME_OWNERSHIP_SCRIPT = String.raw`\set ON_ERROR_STOP on
\getenv candidate_login STAGING_AUTH_PROBE_CANDIDATE_LOGIN
\getenv candidate_owner STAGING_AUTH_PROBE_CANDIDATE_OWNER
\getenv candidate_handoff STAGING_AUTH_PROBE_CANDIDATE_HANDOFF
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(:'candidate_login', 0)
) \g /dev/null
SELECT NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'candidate_login'
) AS candidate_absent,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_owner'
) AS candidate_owned,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles AS candidate_role
  WHERE candidate_role.rolname = :'candidate_login'
    AND pg_catalog.shobj_description(candidate_role.oid, 'pg_authid') = :'candidate_owner'
    AND candidate_role.rolcanlogin
    AND candidate_role.rolinherit
    AND NOT candidate_role.rolsuper
    AND NOT candidate_role.rolcreatedb
    AND NOT candidate_role.rolcreaterole
    AND NOT candidate_role.rolreplication
    AND NOT candidate_role.rolbypassrls
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS granted_role
        ON granted_role.oid = membership.roleid
      WHERE membership.member = candidate_role.oid
        AND granted_role.rolname = 'pintpath_runtime'
    )
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database AS runtime_database
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          runtime_database.datacl,
          pg_catalog.acldefault('d', runtime_database.datdba)
        )
      ) AS database_privilege
      WHERE runtime_database.datname = 'pintpath_staging'
        AND database_privilege.grantee = candidate_role.oid
        AND database_privilege.privilege_type = 'CONNECT'
        AND NOT database_privilege.is_grantable
    )
) AS candidate_safe \gset
\if :candidate_absent
ROLLBACK;
SELECT 'absent';
\elif :candidate_safe
SELECT format(
  'COMMENT ON ROLE %I IS %L',
  :'candidate_login',
  :'candidate_handoff'
) \gexec
SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_handoff'
) AS candidate_handed_off \gset
\if :candidate_handed_off
COMMIT;
SELECT 'handed-off';
\else
ROLLBACK;
SELECT 'unowned';
\endif
\else
ROLLBACK;
\if :candidate_owned
SELECT 'unsafe';
\else
SELECT 'unowned';
\endif
\endif
`;
const INSPECT_RUNTIME_HANDOFF_SCRIPT = String.raw`\set ON_ERROR_STOP on
\getenv candidate_login STAGING_AUTH_PROBE_CANDIDATE_LOGIN
\getenv candidate_handoff STAGING_AUTH_PROBE_CANDIDATE_HANDOFF
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(:'candidate_login', 0)
) \g /dev/null
SELECT NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'candidate_login'
) AS candidate_absent,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_handoff'
) AS candidate_handed_off \gset
\if :candidate_absent
COMMIT;
SELECT 'absent';
\elif :candidate_handed_off
COMMIT;
SELECT 'handed-off';
\else
ROLLBACK;
SELECT 'unowned';
\endif
`;
const CLEANUP_RUNTIME_SCRIPT = String.raw`\set ON_ERROR_STOP on
\getenv candidate_login STAGING_AUTH_PROBE_CANDIDATE_LOGIN
\getenv candidate_owner STAGING_AUTH_PROBE_CANDIDATE_OWNER
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(:'candidate_login', 0)
) \g /dev/null
SELECT NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'candidate_login'
) AS candidate_absent,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_owner'
) AS candidate_owned \gset
\if :candidate_absent
COMMIT;
SELECT 'absent';
\elif :candidate_owned
SELECT format('ALTER ROLE %I NOLOGIN', :'candidate_login') \gexec
SELECT format(
  'REVOKE CONNECT ON DATABASE pintpath_staging FROM %I',
  :'candidate_login'
) \gexec
SELECT format('REVOKE pintpath_runtime FROM %I', :'candidate_login') \gexec
SELECT format('ALTER ROLE %I PASSWORD NULL', :'candidate_login') \gexec
COMMIT;
SELECT pg_catalog.pg_terminate_backend(pid, 5000)
FROM pg_catalog.pg_stat_activity
WHERE usename = :'candidate_login' AND pid <> pg_catalog.pg_backend_pid() \g /dev/null
SELECT NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_stat_activity
  WHERE usename = :'candidate_login' AND pid <> pg_catalog.pg_backend_pid()
) AS candidate_sessions_gone \gset
\if :candidate_sessions_gone
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(:'candidate_login', 0)
) \g /dev/null
SELECT NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'candidate_login'
) AS cleanup_candidate_absent,
EXISTS (
  SELECT 1
  FROM pg_catalog.pg_roles
  WHERE rolname = :'candidate_login'
    AND pg_catalog.shobj_description(oid, 'pg_authid') = :'candidate_owner'
) AS cleanup_candidate_owned \gset
\if :cleanup_candidate_absent
COMMIT;
SELECT 'absent';
\elif :cleanup_candidate_owned
SELECT format('DROP ROLE %I', :'candidate_login') \gexec
COMMIT;
SELECT 'cleaned';
\else
ROLLBACK;
SELECT 'unowned';
\endif
\else
SELECT 'survivors';
\endif
\else
ROLLBACK;
SELECT 'unowned';
\endif
`;
const RETIRE_RUNTIME_SCRIPT = String.raw`\set ON_ERROR_STOP on
\getenv retired_login STAGING_AUTH_PROBE_RETIRED_LOGIN
SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'retired_login'
) AS retired_role_exists \gset
\if :retired_role_exists
BEGIN;
SELECT format('ALTER ROLE %I NOLOGIN', :'retired_login') \gexec
SELECT format(
  'REVOKE CONNECT ON DATABASE pintpath_staging FROM %I',
  :'retired_login'
) \gexec
SELECT format('REVOKE pintpath_runtime FROM %I', :'retired_login') \gexec
SELECT format('ALTER ROLE %I PASSWORD NULL', :'retired_login') \gexec
COMMIT;
SELECT pg_catalog.pg_terminate_backend(pid, 5000)
FROM pg_catalog.pg_stat_activity
WHERE usename = :'retired_login' AND pid <> pg_catalog.pg_backend_pid() \g /dev/null
SELECT NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_stat_activity
  WHERE usename = :'retired_login' AND pid <> pg_catalog.pg_backend_pid()
) AS retired_sessions_gone \gset
\if :retired_sessions_gone
SELECT 'retired';
\else
SELECT 'survivors';
\endif
\else
SELECT 'absent';
\endif
`;

function emptyIdentity(): StagingPrivateAuthProbeReceipt["identity"] {
  return {
    project: false,
    environment: false,
    service: false,
    deployment: false,
    debugLoggingDisabled: false,
    postgresResource: false,
    redisResource: false,
    postgresAdminTarget: false,
    postgresRuntimeTarget: false,
    redisTarget: false,
    postgresAdminLogin: false,
    postgresRuntimeLogin: false,
    redisLogin: false,
    postgresCredentialsDistinct: false,
    providerCredentialsDistinct: false,
    postgresClient17: false,
    runtimeCandidateDistinct: false,
    runtimeCandidateSecretDistinct: false,
    runtimeCandidateOwnerSecretValid: false,
    retiredRuntimeDistinct: false,
  };
}

function emptyChecks(): StagingPrivateAuthProbeReceipt["checks"] {
  return {
    postgresAdminAuth: "not-run",
    postgresRuntimeAuth: "not-run",
    redisAuth: "not-run",
    postgresAdminTransition: "not-run",
    postgresRuntimeTransition: "not-run",
    redisTransition: "not-run",
    runtimeHandoff: "not-run",
    runtimeReadiness: "not-run",
    runtimeMutation: "not-run",
  };
}

function safeTimestamp(now: () => Date): string {
  try {
    const value = now();
    return Number.isFinite(value.getTime())
      ? value.toISOString()
      : "1970-01-01T00:00:00.000Z";
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function safeDeploymentId(value: string | undefined): string {
  const candidate = value?.trim() ?? "";
  return UUID_PATTERN.test(candidate) ? candidate : "unavailable";
}

function createReceipt(input: {
  dependencies: Pick<StagingPrivateAuthProbeDependencies, "now">;
  deploymentId: string;
  mode: ReceiptMode;
  target: ReceiptTarget;
  outcome: ProbeOutcome;
  identity?: StagingPrivateAuthProbeReceipt["identity"];
  checks?: StagingPrivateAuthProbeReceipt["checks"];
}): StagingPrivateAuthProbeReceipt {
  return {
    schemaVersion: "staging-private-auth-probe/v1",
    timestamp: safeTimestamp(input.dependencies.now),
    deploymentId: input.deploymentId,
    mode: input.mode,
    target: input.target,
    outcome: input.outcome,
    identity: input.identity ?? emptyIdentity(),
    checks: input.checks ?? emptyChecks(),
  };
}

function createWatcherArmedProgress(
  deploymentId: string,
  target: StagingPrivateAuthProbeTarget,
): StagingPrivateAuthProbeProgress {
  return {
    schemaVersion: "staging-private-auth-probe-progress/v1",
    deploymentId,
    mode: "watch-old-rejection",
    target,
    event: "watcher-armed",
    outcome: "accepted",
  };
}

function trimmedEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  maximumBytes = 8_192,
): string {
  const value = env[name]?.trim() ?? "";
  return Buffer.byteLength(value, "utf8") <= maximumBytes &&
    !/[\r\n\0]/.test(value)
    ? value
    : "";
}

function decodeUrlComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parsePostgresTarget(
  value: string,
  requireTls: boolean,
  allowedDatabases: readonly string[] = [
    STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresDatabase,
  ],
): ParsedPostgresTarget | null {
  if (!value || value.length > 4_096 || /[\r\n\0]/.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hash ||
    parsed.hostname.toLowerCase() !==
      STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresPrivateHost ||
    parsed.port !== STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresPort
  ) {
    return null;
  }
  const username = decodeUrlComponent(parsed.username);
  const password = decodeUrlComponent(parsed.password);
  const database = decodeUrlComponent(parsed.pathname.replace(/^\//, ""));
  if (
    !username ||
    !password ||
    !database ||
    !allowedDatabases.includes(database) ||
    parsed.pathname.slice(1).includes("/")
  ) {
    return null;
  }

  const allowedParameters = new Set([
    "sslmode",
    "sslrootcert",
    "uselibpqcompat",
  ]);
  if (
    [...parsed.searchParams.keys()].some((name) => !allowedParameters.has(name))
  )
    return null;
  const sslModes = parsed.searchParams.getAll("sslmode");
  if (sslModes.length > 1) return null;
  const configuredSslMode = sslModes[0]?.toLowerCase();
  if (
    configuredSslMode !== undefined &&
    !["require", "verify-ca", "verify-full"].includes(configuredSslMode)
  ) {
    return null;
  }
  if (requireTls && configuredSslMode === undefined) return null;
  const compatibility = parsed.searchParams.getAll("uselibpqcompat");
  if (
    compatibility.length > 1 ||
    (compatibility.length === 1 && compatibility[0] !== "true")
  ) {
    return null;
  }
  const roots = parsed.searchParams.getAll("sslrootcert");
  if (roots.length > 1 || (roots.length === 1 && !roots[0]?.trim()))
    return null;
  if (
    ["verify-ca", "verify-full"].includes(configuredSslMode ?? "") &&
    roots.length !== 1
  ) {
    return null;
  }

  return {
    raw: value,
    username,
    password,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
    database,
    sslMode: (configuredSslMode ?? "prefer") as ParsedPostgresTarget["sslMode"],
    ...(roots[0] ? { sslRootCertificate: roots[0] } : {}),
  };
}

function parseRedisTarget(value: string): ParsedRedisTarget | null {
  if (!value || value.length > 4_096 || /[\r\n\0]/.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const username = decodeUrlComponent(parsed.username);
  const password = decodeUrlComponent(parsed.password);
  if (
    parsed.protocol !== "redis:" ||
    parsed.hash ||
    parsed.hostname.toLowerCase() !==
      STAGING_PRIVATE_AUTH_PROBE_LOCK.redisPrivateHost ||
    parsed.port !== STAGING_PRIVATE_AUTH_PROBE_LOCK.redisPort ||
    username !== STAGING_PRIVATE_AUTH_PROBE_LOCK.redisLogin ||
    !password ||
    !["", "/"].includes(parsed.pathname) ||
    [...parsed.searchParams.keys()].length !== 0
  ) {
    return null;
  }
  return {
    raw: value,
    username,
    password,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
  };
}

function replacePostgresUserInfo(
  parsed: ParsedPostgresTarget,
  username: string,
  password: string,
): string | null {
  if (
    !VERSIONED_RUNTIME_LOGIN_PATTERN.test(username) ||
    !URL_SAFE_PASSWORD_PATTERN.test(password)
  ) {
    return null;
  }
  const schemeEnd = parsed.raw.indexOf("://");
  const authorityStart = schemeEnd + 3;
  const authorityEnd = parsed.raw.indexOf("/", authorityStart);
  const at = parsed.raw.lastIndexOf("@", authorityEnd);
  if (schemeEnd < 0 || authorityEnd < 0 || at < authorityStart) return null;
  const candidate = `${parsed.raw.slice(0, authorityStart)}${username}:${password}${parsed.raw.slice(at)}`;
  return parsePostgresTarget(candidate, true) ? candidate : null;
}

function selectedTargets(
  target: StagingPrivateAuthProbeTarget,
): Array<Exclude<StagingPrivateAuthProbeTarget, "all">> {
  return target === "all"
    ? ["postgres-admin", "postgres-runtime", "redis"]
    : [target];
}

function configurationFromEnvironment(
  mode: StagingPrivateAuthProbeMode,
  target: StagingPrivateAuthProbeTarget,
  env: Readonly<Record<string, string | undefined>>,
): ProbeConfiguration {
  const postgresAdminUrl = trimmedEnvironmentValue(
    env,
    "STAGING_AUTH_PROBE_POSTGRES_ADMIN_URL",
  );
  const postgresRuntimeUrl = trimmedEnvironmentValue(
    env,
    "STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL",
  );
  const redisUrl = trimmedEnvironmentValue(env, "STAGING_AUTH_PROBE_REDIS_URL");
  const candidateLogin = trimmedEnvironmentValue(
    env,
    "STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_LOGIN",
    128,
  );
  const candidatePassword = trimmedEnvironmentValue(
    env,
    "STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_PASSWORD",
    256,
  );
  const candidateOwnerSecret = trimmedEnvironmentValue(
    env,
    "STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_OWNER_SECRET",
    256,
  );
  const psqlPath = "psql";
  const deploymentId = safeDeploymentId(env.RAILWAY_DEPLOYMENT_ID);
  const parsedAdmin = parsePostgresTarget(
    postgresAdminUrl,
    true,
    STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresAdminDatabases,
  );
  const parsedRuntime = parsePostgresTarget(postgresRuntimeUrl, true);
  const parsedRedis = parseRedisTarget(redisUrl);
  const candidateUrl = parsedRuntime
    ? replacePostgresUserInfo(parsedRuntime, candidateLogin, candidatePassword)
    : null;
  const configuredRuntimePhase = trimmedEnvironmentValue(
    env,
    "STAGING_AUTH_PROBE_RUNTIME_IDENTITY",
    32,
  );
  const runtimeIdentityPhase: RuntimeIdentityPhase =
    mode === "watch-old-rejection" || mode === "provision-runtime-candidate"
      ? "predecessor"
      : mode === "retire-old-runtime"
        ? "candidate"
        : configuredRuntimePhase === "predecessor" ||
            configuredRuntimePhase === "candidate"
          ? configuredRuntimePhase
          : "invalid";
  const runtimeLoginExact = Boolean(
    parsedRuntime &&
      (runtimeIdentityPhase === "predecessor"
        ? parsedRuntime.username ===
          STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresPredecessorRuntimeLogin
        : runtimeIdentityPhase === "candidate" &&
          VERSIONED_RUNTIME_LOGIN_PATTERN.test(candidateLogin) &&
          URL_SAFE_PASSWORD_PATTERN.test(candidatePassword) &&
          parsedRuntime.username === candidateLogin &&
          parsedRuntime.password === candidatePassword),
  );
  const postgresCredentialsDistinct = Boolean(
    parsedAdmin &&
      parsedRuntime &&
      parsedAdmin.raw !== parsedRuntime.raw &&
      parsedAdmin.username !== parsedRuntime.username &&
      parsedAdmin.password !== parsedRuntime.password,
  );
  const candidateSecretDistinct = Boolean(
    parsedAdmin &&
      parsedRuntime &&
      parsedRedis &&
      URL_SAFE_PASSWORD_PATTERN.test(candidatePassword) &&
      candidatePassword !== parsedAdmin.password &&
      candidatePassword !== parsedRedis.password &&
      (runtimeIdentityPhase === "candidate"
        ? candidatePassword === parsedRuntime.password
        : candidatePassword !== parsedRuntime.password),
  );
  const providerCredentialsDistinct = Boolean(
    parsedAdmin &&
      parsedRuntime &&
      parsedRedis &&
      new Set([
        parsedAdmin.password,
        parsedRuntime.password,
        parsedRedis.password,
      ]).size === 3,
  );
  const candidateOwnerSecretValid = Boolean(
    parsedAdmin &&
      parsedRuntime &&
      parsedRedis &&
      URL_SAFE_PASSWORD_PATTERN.test(candidateOwnerSecret) &&
      candidateOwnerSecret !== candidatePassword &&
      candidateOwnerSecret !== parsedAdmin.password &&
      candidateOwnerSecret !== parsedRuntime.password &&
      candidateOwnerSecret !== parsedRedis.password,
  );

  return {
    mode,
    target,
    deploymentId,
    psqlPath,
    postgresAdminUrl,
    postgresRuntimeUrl,
    redisUrl,
    candidateLogin,
    candidatePassword,
    candidateOwnerSecret,
    runtimeIdentityPhase,
    identity: {
      project:
        trimmedEnvironmentValue(env, "RAILWAY_PROJECT_ID", 128) ===
        STAGING_PRIVATE_AUTH_PROBE_LOCK.projectId,
      environment:
        trimmedEnvironmentValue(env, "RAILWAY_ENVIRONMENT_ID", 128) ===
        STAGING_PRIVATE_AUTH_PROBE_LOCK.environmentId,
      service: (() => {
        const actual = trimmedEnvironmentValue(env, "RAILWAY_SERVICE_ID", 128);
        const expected = trimmedEnvironmentValue(
          env,
          "STAGING_AUTH_PROBE_EXPECTED_SERVICE_ID",
          128,
        );
        return (
          UUID_PATTERN.test(actual) &&
          UUID_PATTERN.test(expected) &&
          actual === expected
        );
      })(),
      deployment: deploymentId !== "unavailable",
      debugLoggingDisabled: [
        "DEBUG",
        "DEBUG_FD",
        "NODE_DEBUG",
        "NODE_DEBUG_NATIVE",
        "NODE_OPTIONS",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "PGDEBUG",
        "PGOPTIONS",
      ].every((name) => env[name] === undefined || env[name] === ""),
      postgresResource:
        trimmedEnvironmentValue(
          env,
          "STAGING_AUTH_PROBE_POSTGRES_RESOURCE_ID",
          256,
        ) === STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresResourceId,
      redisResource:
        trimmedEnvironmentValue(
          env,
          "STAGING_AUTH_PROBE_REDIS_RESOURCE_ID",
          256,
        ) === STAGING_PRIVATE_AUTH_PROBE_LOCK.redisResourceId,
      postgresAdminTarget: parsedAdmin !== null,
      postgresRuntimeTarget: parsedRuntime !== null,
      redisTarget: parsedRedis !== null,
      postgresAdminLogin:
        parsedAdmin?.username ===
        STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresAdminLogin,
      postgresRuntimeLogin: runtimeLoginExact,
      redisLogin:
        parsedRedis?.username === STAGING_PRIVATE_AUTH_PROBE_LOCK.redisLogin,
      postgresCredentialsDistinct,
      providerCredentialsDistinct,
      postgresClient17: false,
      runtimeCandidateDistinct: Boolean(
        candidateUrl &&
          parsedRuntime &&
          candidateLogin !== parsedRuntime.username,
      ),
      runtimeCandidateSecretDistinct: candidateSecretDistinct,
      runtimeCandidateOwnerSecretValid: candidateOwnerSecretValid,
      retiredRuntimeDistinct: Boolean(
        parsedRuntime &&
          runtimeIdentityPhase === "candidate" &&
          parsedRuntime.username !==
            STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresPredecessorRuntimeLogin,
      ),
    },
  };
}

function identityIsValid(configuration: ProbeConfiguration): boolean {
  const targets = selectedTargets(configuration.target);
  const base =
    configuration.identity.project &&
    configuration.identity.environment &&
    configuration.identity.service &&
    configuration.identity.deployment &&
    configuration.identity.debugLoggingDisabled;
  if (!base) return false;
  if (targets.includes("postgres-admin")) {
    if (
      !configuration.identity.postgresResource ||
      !configuration.identity.postgresAdminTarget ||
      !configuration.identity.postgresAdminLogin
    )
      return false;
  }
  if (targets.includes("postgres-runtime")) {
    if (
      !configuration.identity.postgresResource ||
      !configuration.identity.postgresRuntimeTarget ||
      !configuration.identity.postgresRuntimeLogin
    )
      return false;
  }
  if (targets.includes("redis")) {
    if (
      !configuration.identity.redisResource ||
      !configuration.identity.redisTarget ||
      !configuration.identity.redisLogin
    )
      return false;
  }
  if (
    targets.includes("postgres-admin") &&
    targets.includes("postgres-runtime")
  ) {
    if (!configuration.identity.postgresCredentialsDistinct) return false;
  }
  if (
    configuration.target === "all" &&
    !configuration.identity.providerCredentialsDistinct
  ) {
    return false;
  }
  if (targets.some((target) => target.startsWith("postgres"))) {
    if (!configuration.identity.postgresClient17) return false;
  }
  if (configuration.mode === "provision-runtime-candidate") {
    return (
      configuration.target === "postgres-runtime" &&
      configuration.identity.postgresAdminTarget &&
      configuration.identity.postgresAdminLogin &&
      configuration.identity.postgresCredentialsDistinct &&
      configuration.identity.providerCredentialsDistinct &&
      configuration.identity.redisResource &&
      configuration.identity.redisTarget &&
      configuration.identity.redisLogin &&
      configuration.identity.runtimeCandidateDistinct &&
      configuration.identity.runtimeCandidateSecretDistinct &&
      configuration.identity.runtimeCandidateOwnerSecretValid
    );
  }
  if (configuration.mode === "retire-old-runtime") {
    return (
      configuration.target === "postgres-runtime" &&
      configuration.identity.postgresAdminTarget &&
      configuration.identity.postgresAdminLogin &&
      configuration.identity.postgresCredentialsDistinct &&
      configuration.identity.providerCredentialsDistinct &&
      configuration.identity.redisResource &&
      configuration.identity.redisTarget &&
      configuration.identity.redisLogin &&
      configuration.identity.runtimeCandidateSecretDistinct &&
      configuration.identity.runtimeCandidateOwnerSecretValid &&
      configuration.identity.retiredRuntimeDistinct
    );
  }
  return true;
}

function boundedTimeout(deadline: number, monotonicNow: () => number): number {
  const remaining = Math.trunc(deadline - monotonicNow());
  return Math.max(
    1,
    Math.min(STAGING_PRIVATE_AUTH_PROBE_LOCK.attemptTimeoutMs, remaining),
  );
}

function deadlineReached(
  deadline: number,
  monotonicNow: () => number,
): boolean {
  return monotonicNow() >= deadline;
}

function hasMutationBudget(
  deadline: number,
  monotonicNow: () => number,
  attempts: number,
): boolean {
  return (
    deadline - monotonicNow() >=
    STAGING_PRIVATE_AUTH_PROBE_LOCK.attemptTimeoutMs * attempts
  );
}

function isPostgresTarget(target: StagingPrivateAuthProbeTarget): boolean {
  return (
    target === "all" ||
    target === "postgres-admin" ||
    target === "postgres-runtime"
  );
}

function appendCaptured(
  current: string,
  chunk: Buffer | string,
): { value: string; overflow: boolean } {
  if (Buffer.byteLength(current, "utf8") >= MAX_CAPTURED_PROCESS_BYTES) {
    return { value: current, overflow: true };
  }
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const remaining =
    MAX_CAPTURED_PROCESS_BYTES - Buffer.byteLength(current, "utf8");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= remaining)
    return { value: current + text, overflow: false };
  return {
    value: current + bytes.subarray(0, remaining).toString("utf8"),
    overflow: true,
  };
}

async function runCapturedProcess(input: {
  command: string;
  arguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  stdin: string;
  timeoutMs: number;
}): Promise<CapturedProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnFailed = false;
    let outputOverflow = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(input.command, input.arguments, {
      env: { ...input.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        spawnFailed,
        outputOverflow,
      });
    };
    timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
        finish(null);
      },
      Math.max(1, input.timeoutMs),
    );

    child.stdout.on("data", (chunk: Buffer) => {
      const captured = appendCaptured(stdout, chunk);
      stdout = captured.value;
      outputOverflow ||= captured.overflow;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const captured = appendCaptured(stderr, chunk);
      stderr = captured.value;
      outputOverflow ||= captured.overflow;
    });
    child.on("error", () => {
      spawnFailed = true;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {
      // A failed child can close stdin before the captured close event.
    });
    child.stdin.end(input.stdin);
  });
}

function safePsqlPath(value: string): boolean {
  return value === "psql";
}

function narrowBaseProcessEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
}

export function buildPsqlEnvironment(
  connectionUrl: string,
  additionalEnvironment: Readonly<Record<string, string>> = {},
): Record<string, string> | null {
  const target = parsePostgresTarget(
    connectionUrl,
    true,
    STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresAdminDatabases,
  );
  if (!target) return null;
  const allowedAdditionalNames = new Set([
    "STAGING_AUTH_PROBE_CANDIDATE_LOGIN",
    "STAGING_AUTH_PROBE_CANDIDATE_HANDOFF",
    "STAGING_AUTH_PROBE_CANDIDATE_OWNER",
    "STAGING_AUTH_PROBE_CANDIDATE_VERIFIER",
    "STAGING_AUTH_PROBE_RETIRED_LOGIN",
  ]);
  if (
    Object.keys(additionalEnvironment).some(
      (name) => !allowedAdditionalNames.has(name),
    )
  ) {
    return null;
  }
  return {
    ...narrowBaseProcessEnvironment(),
    PGHOST: target.hostname,
    PGPORT: target.port,
    PGDATABASE: target.database,
    PGUSER: target.username,
    PGPASSWORD: target.password,
    PGAPPNAME: "pintpath-staging-private-auth-probe",
    PGCONNECT_TIMEOUT: "10",
    PGREQUIREAUTH: "scram-sha-256",
    PGSSLMODE: target.sslMode,
    ...(target.sslRootCertificate
      ? { PGSSLROOTCERT: target.sslRootCertificate }
      : {}),
    ...additionalEnvironment,
  };
}

export async function runPsql(
  request: PsqlExecutionRequest,
): Promise<CapturedProcessResult> {
  const environment = buildPsqlEnvironment(
    request.connectionUrl,
    request.additionalEnvironment,
  );
  if (!environment || !safePsqlPath(request.psqlPath)) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnFailed: true,
      outputOverflow: false,
    };
  }
  return runCapturedProcess({
    command: request.psqlPath,
    arguments: [
      "-X",
      "-q",
      "-A",
      "-t",
      "--no-password",
      "--set=ON_ERROR_STOP=1",
      "--set=VERBOSITY=sqlstate",
    ],
    environment,
    stdin: request.stdin,
    timeoutMs: request.timeoutMs,
  });
}

export function classifyPostgresPsqlResult(
  result: CapturedProcessResult,
): AuthenticationResult {
  if (
    result.timedOut ||
    result.spawnFailed ||
    result.outputOverflow ||
    result.exitCode === null
  ) {
    return "inconclusive";
  }
  if (result.exitCode === 0) return "accepted";
  return "inconclusive";
}

async function validatePostgresClient17(
  psqlPath: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!safePsqlPath(psqlPath)) return false;
  const result = await runCapturedProcess({
    command: psqlPath,
    arguments: ["--version"],
    environment: narrowBaseProcessEnvironment(),
    stdin: "",
    timeoutMs,
  });
  return (
    !result.timedOut &&
    !result.spawnFailed &&
    !result.outputOverflow &&
    result.exitCode === 0 &&
    /^psql \(PostgreSQL\) 17\.[0-9]+(?:\s|$)/.test(result.stdout.trim())
  );
}

async function attemptPostgres(
  connectionUrl: string,
  psqlPath: string,
  timeoutMs: number,
): Promise<AuthenticationResult> {
  const splitTimeout = Math.max(1, Math.floor(timeoutMs / 2));
  const psqlResult = classifyPostgresPsqlResult(
    await runPsql({
      psqlPath,
      connectionUrl,
      stdin: "",
      timeoutMs: splitTimeout,
    }),
  );
  if (psqlResult === "accepted") return "accepted";
  const structured = await attemptPostgresStructured(
    connectionUrl,
    splitTimeout,
  );
  return structured === "rejected" ? "rejected" : "inconclusive";
}

export interface PostgresClientShutdownSurface {
  end: () => Promise<void>;
  connection?: {
    stream?: {
      destroy: () => void;
    };
  };
}

export async function closePostgresClientBounded(
  client: PostgresClientShutdownSurface,
  timeoutMs: number,
): Promise<void> {
  const destroy = () => {
    try {
      client.connection?.stream?.destroy();
    } catch {
      // Shutdown is best effort and never changes an authentication result.
    }
  };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    destroy();
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  const endPromise = Promise.resolve()
    .then(() => client.end())
    .then(
      () => true,
      () => false,
    );
  const ended = await Promise.race([
    endPromise,
    new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        Math.max(1, Math.trunc(timeoutMs)),
      );
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!ended) destroy();
  void endPromise.catch(() => undefined);
}

type BoundedPostgresOperation<T> =
  | { completed: true; value: T }
  | { completed: false };

async function runPostgresOperationBounded<T>(
  client: PostgresClientShutdownSurface,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<BoundedPostgresOperation<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    try {
      client.connection?.stream?.destroy();
    } catch {
      // A closed stream is already a safe failed operation.
    }
    return { completed: false };
  }

  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const operationPromise = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ completed: true as const, value }),
      () => ({ completed: false as const }),
    );
  const result = await Promise.race([
    operationPromise,
    new Promise<{ completed: false }>((resolve) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          resolve({ completed: false });
        },
        Math.max(1, Math.trunc(timeoutMs)),
      );
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    try {
      client.connection?.stream?.destroy();
    } catch {
      // The operation is already failed closed.
    }
  }
  void operationPromise.catch(() => undefined);
  return result;
}

interface ProvisionLifecycleLockRow extends QueryResultRow {
  backendPid: number;
  acquired: boolean;
}

interface ProvisionLifecycleLockVerificationRow extends QueryResultRow {
  backendPid: number;
  held: boolean;
}

function lifecycleLockConnectionUrl(adminUrl: string): string | null {
  if (
    !parsePostgresTarget(
      adminUrl,
      true,
      STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresAdminDatabases,
    )
  ) {
    return null;
  }
  const normalized = new URL(adminUrl);
  normalized.pathname = `/${STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresDatabase}`;
  normalized.searchParams.set("uselibpqcompat", "true");
  const value = normalized.toString();
  return parsePostgresTarget(value, true) ? value : null;
}

export async function acquireProvisionLifecycleLock(
  adminUrl: string,
  timeoutMs: number,
): Promise<ProvisionLifecycleLock | null> {
  const connectionString = lifecycleLockConnectionUrl(adminUrl);
  if (!connectionString || timeoutMs < 1) return null;
  const startedAt = performance.now();
  const effectiveTimeout = Math.max(1, Math.trunc(timeoutMs));
  const client = new Client({
    connectionString,
    application_name: "pintpath-staging-private-auth-probe-lifecycle-lock",
    connectionTimeoutMillis: effectiveTimeout,
    query_timeout: effectiveTimeout,
    statement_timeout: effectiveTimeout,
  });
  const shutdownSurface = client as unknown as PostgresClientShutdownSurface;
  const connection = (
    client as unknown as {
      connection: {
        on: (event: string, listener: () => void) => void;
        off: (event: string, listener: () => void) => void;
      };
    }
  ).connection;
  let saslObserved = false;
  let connectionFailed = false;
  let released = false;
  const observeSasl = () => {
    saslObserved = true;
  };
  connection.on("authenticationSASL", observeSasl);
  client.on("error", () => {
    connectionFailed = true;
  });

  const remaining = () => effectiveTimeout - (performance.now() - startedAt);
  const connected = await runPostgresOperationBounded(
    shutdownSurface,
    () => client.connect(),
    remaining(),
  );
  connection.off("authenticationSASL", observeSasl);
  if (!connected.completed || !saslObserved || connectionFailed) {
    await closePostgresClientBounded(shutdownSurface, remaining());
    return null;
  }

  const acquired = await runPostgresOperationBounded(
    shutdownSurface,
    () =>
      client.query<ProvisionLifecycleLockRow>(PROVISION_LIFECYCLE_LOCK_QUERY, [
        ...PROVISION_LIFECYCLE_LOCK_KEYS,
      ]),
    remaining(),
  );
  const row = acquired.completed ? acquired.value.rows[0] : undefined;
  if (
    connectionFailed ||
    row?.acquired !== true ||
    !Number.isInteger(row.backendPid) ||
    row.backendPid <= 0
  ) {
    await closePostgresClientBounded(shutdownSurface, remaining());
    return null;
  }
  const backendPid = row.backendPid;

  return {
    verify: async (verificationTimeoutMs) => {
      if (released || connectionFailed || verificationTimeoutMs < 1)
        return false;
      const verification = await runPostgresOperationBounded(
        shutdownSurface,
        () =>
          client.query<ProvisionLifecycleLockVerificationRow>(
            VERIFY_PROVISION_LIFECYCLE_LOCK_QUERY,
            [...PROVISION_LIFECYCLE_LOCK_KEYS],
          ),
        verificationTimeoutMs,
      );
      const verificationRow = verification.completed
        ? verification.value.rows[0]
        : undefined;
      if (
        !verification.completed ||
        connectionFailed ||
        verificationRow?.backendPid !== backendPid ||
        verificationRow.held !== true
      ) {
        connectionFailed = true;
        try {
          shutdownSurface.connection?.stream?.destroy();
        } catch {
          // A failed verification has already invalidated this lock.
        }
        return false;
      }
      return true;
    },
    release: async (releaseTimeoutMs) => {
      if (released) return;
      released = true;
      await closePostgresClientBounded(shutdownSurface, releaseTimeoutMs);
    },
  };
}

export async function attemptPostgresStructured(
  connectionUrl: string,
  timeoutMs: number,
): Promise<AuthenticationResult> {
  if (
    !parsePostgresTarget(
      connectionUrl,
      true,
      STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresAdminDatabases,
    )
  )
    return "inconclusive";
  const startedAt = performance.now();
  const effectiveTimeout = Math.max(1, Math.trunc(timeoutMs));
  const shutdownReserve = Math.min(
    250,
    Math.max(1, Math.trunc(effectiveTimeout / 10)),
  );
  const normalizedConnectionUrl = new URL(connectionUrl);
  normalizedConnectionUrl.searchParams.set("uselibpqcompat", "true");
  const client = new Client({
    connectionString: normalizedConnectionUrl.toString(),
    connectionTimeoutMillis: Math.max(1, effectiveTimeout - shutdownReserve),
    application_name: "pintpath-staging-private-auth-probe",
  });
  let saslObserved = false;
  const connection = (
    client as unknown as {
      connection: {
        on: (event: string, listener: () => void) => void;
        off: (event: string, listener: () => void) => void;
      };
    }
  ).connection;
  const observeSasl = () => {
    saslObserved = true;
  };
  connection.on("authenticationSASL", observeSasl);
  client.on("error", () => {
    // Suppress the event surface; the structured connect result is authoritative.
  });
  try {
    await client.connect();
    return classifyStructuredPostgresAttempt({
      connected: true,
      saslObserved,
      errorCode: "",
    });
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "";
    return classifyStructuredPostgresAttempt({
      connected: false,
      saslObserved,
      errorCode: code,
    });
  } finally {
    connection.off("authenticationSASL", observeSasl);
    await closePostgresClientBounded(
      client as unknown as PostgresClientShutdownSurface,
      effectiveTimeout - (performance.now() - startedAt),
    );
  }
}

export function classifyStructuredPostgresAttempt(input: {
  connected: boolean;
  saslObserved: boolean;
  errorCode: string;
}): AuthenticationResult {
  if (input.connected) return input.saslObserved ? "accepted" : "inconclusive";
  // A NOLOGIN or removed role can produce 28000 before PostgreSQL offers
  // SASL. The watch mode separately requires that this exact URL was first
  // accepted, so the structured SQLSTATE is sufficient for the transition.
  return input.errorCode === "28P01" || input.errorCode === "28000"
    ? "rejected"
    : "inconclusive";
}

export interface RedisProtocolProbeTarget {
  hostname: string;
  port: number;
  username: string;
  password: string;
}

type RedisSocketFactory = (options: net.NetConnectOpts) => net.Socket;

function redisCommand(parts: readonly string[]): Buffer {
  const encoded = parts.map((part) => Buffer.from(part, "utf8"));
  const fragments: Buffer[] = [Buffer.from(`*${encoded.length}\r\n`, "ascii")];
  for (const part of encoded) {
    fragments.push(
      Buffer.from(`$${part.byteLength}\r\n`, "ascii"),
      part,
      Buffer.from("\r\n", "ascii"),
    );
  }
  const command = Buffer.concat(fragments);
  for (const part of encoded) part.fill(0);
  return command;
}

function classifyRedisAuthenticationLine(
  line: string,
): AuthenticationResult | "continue" {
  if (line === "+OK") return "continue";
  return /^-WRONGPASS(?:\s|$)/.test(line) ? "rejected" : "inconclusive";
}

export async function probeRedisProtocol(
  target: RedisProtocolProbeTarget,
  timeoutMs: number,
  createSocket: RedisSocketFactory = (options) => net.createConnection(options),
): Promise<AuthenticationResult> {
  if (
    target.username !== STAGING_PRIVATE_AUTH_PROBE_LOCK.redisLogin ||
    !target.password ||
    Buffer.byteLength(target.password, "utf8") > 1_024 ||
    /[\r\n\0]/.test(target.password) ||
    !target.hostname ||
    target.hostname.length > 253 ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535
  )
    return "inconclusive";

  return new Promise((resolve) => {
    let settled = false;
    let phase: "authentication" | "ping" = "authentication";
    let response = "";
    const secretBuffers: Buffer[] = [];
    let socket: net.Socket;
    const finish = (result: AuthenticationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const buffer of secretBuffers) buffer.fill(0);
      socket.destroy();
      resolve(result);
    };
    const writeCommand = (
      parts: readonly string[],
      containsSecret: boolean,
    ) => {
      const command = redisCommand(parts);
      if (containsSecret) secretBuffers.push(command);
      socket.write(command, () => {
        if (containsSecret) command.fill(0);
      });
    };
    const timer = setTimeout(
      () => finish("inconclusive"),
      Math.max(
        1,
        Math.min(STAGING_PRIVATE_AUTH_PROBE_LOCK.attemptTimeoutMs, timeoutMs),
      ),
    );

    try {
      socket = createSocket({ host: target.hostname, port: target.port });
    } catch {
      clearTimeout(timer);
      resolve("inconclusive");
      return;
    }
    socket.setNoDelay(true);
    socket.once("connect", () => {
      writeCommand(["AUTH", target.username, target.password], true);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > 4_096) {
        finish("inconclusive");
        return;
      }
      const lineEnd = response.indexOf("\r\n");
      if (lineEnd < 0) return;
      const line = response.slice(0, lineEnd);
      response = response.slice(lineEnd + 2);
      if (phase === "authentication") {
        const authentication = classifyRedisAuthenticationLine(line);
        if (authentication !== "continue") {
          finish(authentication);
          return;
        }
        phase = "ping";
        writeCommand(["PING"], false);
        return;
      }
      finish(line === "+PONG" ? "accepted" : "inconclusive");
    });
    socket.once("error", () => finish("inconclusive"));
    socket.once("close", () => finish("inconclusive"));
  });
}

async function attemptRedis(
  connectionUrl: string,
  timeoutMs: number,
): Promise<AuthenticationResult> {
  const target = parseRedisTarget(connectionUrl);
  if (!target) return "inconclusive";
  return probeRedisProtocol(
    {
      hostname: target.hostname,
      port: Number(target.port),
      username: target.username,
      password: target.password,
    },
    timeoutMs,
  );
}

export function createScramSha256Verifier(
  password: string,
  salt: Buffer,
): string | null {
  if (!URL_SAFE_PASSWORD_PATTERN.test(password) || salt.byteLength !== 16)
    return null;
  const passwordBytes = Buffer.from(password, "utf8");
  let saltedPassword: Buffer | undefined;
  let clientKey: Buffer | undefined;
  let storedKey: Buffer | undefined;
  let serverKey: Buffer | undefined;
  try {
    saltedPassword = crypto.pbkdf2Sync(
      passwordBytes,
      salt,
      SCRAM_ITERATIONS,
      32,
      "sha256",
    );
    clientKey = crypto
      .createHmac("sha256", saltedPassword)
      .update("Client Key")
      .digest();
    storedKey = crypto.createHash("sha256").update(clientKey).digest();
    serverKey = crypto
      .createHmac("sha256", saltedPassword)
      .update("Server Key")
      .digest();
    return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
  } finally {
    passwordBytes.fill(0);
    saltedPassword?.fill(0);
    clientKey?.fill(0);
    storedKey?.fill(0);
    serverKey?.fill(0);
  }
}

function createCandidateMarker(
  ownerSecret: string,
  login: string,
  domain: "owner-v1" | "handoff-v1",
): string | null {
  if (
    !URL_SAFE_PASSWORD_PATTERN.test(ownerSecret) ||
    !VERSIONED_RUNTIME_LOGIN_PATTERN.test(login)
  ) {
    return null;
  }
  const key = Buffer.from(ownerSecret, "utf8");
  let digest: Buffer | undefined;
  try {
    digest = crypto
      .createHmac("sha256", key)
      .update(
        [
          `pintpath-staging-auth-probe-${domain}`,
          STAGING_PRIVATE_AUTH_PROBE_LOCK.projectId,
          STAGING_PRIVATE_AUTH_PROBE_LOCK.environmentId,
          STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresResourceId,
          login,
        ].join("\0"),
        "utf8",
      )
      .digest();
    const state = domain === "owner-v1" ? "v1" : "handoff-v1";
    return `pintpath-staging-auth-probe:${state}:${digest.toString("base64url")}`;
  } finally {
    key.fill(0);
    digest?.fill(0);
  }
}

export function createCandidateOwnerMarker(
  ownerSecret: string,
  login: string,
): string | null {
  return createCandidateMarker(ownerSecret, login, "owner-v1");
}

export function createCandidateHandoffMarker(
  ownerSecret: string,
  login: string,
): string | null {
  return createCandidateMarker(ownerSecret, login, "handoff-v1");
}

async function provisionRuntimeRole(
  input: ProvisionRuntimeRoleInput,
  runner: PsqlRunner = runPsql,
): Promise<ProvisionRuntimeRoleResult> {
  const result = await runner({
    psqlPath: input.psqlPath,
    connectionUrl: input.adminUrl,
    stdin: PROVISION_RUNTIME_SCRIPT,
    additionalEnvironment: {
      STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: input.handoffMarker,
      STAGING_AUTH_PROBE_CANDIDATE_LOGIN: input.login,
      STAGING_AUTH_PROBE_CANDIDATE_OWNER: input.ownerMarker,
      STAGING_AUTH_PROBE_CANDIDATE_VERIFIER: input.verifier,
    },
    timeoutMs: input.timeoutMs,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.spawnFailed ||
    result.outputOverflow
  ) {
    return "inconclusive";
  }
  const status = result.stdout.trim();
  return status === "created" ||
    status === "existing-owned" ||
    status === "existing-handoff" ||
    status === "unowned"
    ? status
    : "inconclusive";
}

async function inspectRuntimeRoleOwnership(
  input: FinalizeCandidateRoleInput,
  runner: PsqlRunner = runPsql,
): Promise<CandidateOwnershipResult> {
  const result = await runner({
    psqlPath: input.psqlPath,
    connectionUrl: input.adminUrl,
    stdin: INSPECT_RUNTIME_OWNERSHIP_SCRIPT,
    additionalEnvironment: {
      STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: input.handoffMarker,
      STAGING_AUTH_PROBE_CANDIDATE_LOGIN: input.login,
      STAGING_AUTH_PROBE_CANDIDATE_OWNER: input.ownerMarker,
    },
    timeoutMs: input.timeoutMs,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.spawnFailed ||
    result.outputOverflow
  ) {
    return "inconclusive";
  }
  const status = result.stdout.trim();
  return status === "owned" ||
    status === "handed-off" ||
    status === "absent" ||
    status === "unowned"
    ? status
    : "inconclusive";
}

async function finalizeRuntimeRoleOwnership(
  input: FinalizeCandidateRoleInput,
  runner: PsqlRunner = runPsql,
): Promise<CandidateHandoffResult> {
  const result = await runner({
    psqlPath: input.psqlPath,
    connectionUrl: input.adminUrl,
    stdin: FINALIZE_RUNTIME_OWNERSHIP_SCRIPT,
    additionalEnvironment: {
      STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: input.handoffMarker,
      STAGING_AUTH_PROBE_CANDIDATE_LOGIN: input.login,
      STAGING_AUTH_PROBE_CANDIDATE_OWNER: input.ownerMarker,
    },
    timeoutMs: input.timeoutMs,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.spawnFailed ||
    result.outputOverflow
  ) {
    return "inconclusive";
  }
  const status = result.stdout.trim();
  return status === "handed-off" ||
    status === "absent" ||
    status === "unsafe" ||
    status === "unowned"
    ? status
    : "inconclusive";
}

async function inspectRuntimeRoleHandoff(
  input: CandidateRoleHandoffInput,
  runner: PsqlRunner = runPsql,
): Promise<CandidateHandoffResult> {
  const result = await runner({
    psqlPath: input.psqlPath,
    connectionUrl: input.adminUrl,
    stdin: INSPECT_RUNTIME_HANDOFF_SCRIPT,
    additionalEnvironment: {
      STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: input.handoffMarker,
      STAGING_AUTH_PROBE_CANDIDATE_LOGIN: input.login,
    },
    timeoutMs: input.timeoutMs,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.spawnFailed ||
    result.outputOverflow
  ) {
    return "inconclusive";
  }
  const status = result.stdout.trim();
  return status === "handed-off" || status === "absent" || status === "unowned"
    ? status
    : "inconclusive";
}

async function cleanupRuntimeRole(
  input: CandidateRoleMutationInput,
  runner: PsqlRunner = runPsql,
): Promise<CandidateCleanupResult> {
  const result = await runner({
    psqlPath: input.psqlPath,
    connectionUrl: input.adminUrl,
    stdin: CLEANUP_RUNTIME_SCRIPT,
    additionalEnvironment: {
      STAGING_AUTH_PROBE_CANDIDATE_LOGIN: input.login,
      STAGING_AUTH_PROBE_CANDIDATE_OWNER: input.ownerMarker,
    },
    timeoutMs: input.timeoutMs,
  });
  if (result.timedOut || result.spawnFailed || result.outputOverflow)
    return "inconclusive";
  if (result.exitCode !== 0) return "inconclusive";
  const status = result.stdout.trim();
  if (status === "cleaned" || status === "absent" || status === "unowned")
    return status;
  return "inconclusive";
}

async function retireRuntimeRole(
  input: RuntimeRoleMutationInput,
  runner: PsqlRunner = runPsql,
): Promise<boolean> {
  const result = await runner({
    psqlPath: input.psqlPath,
    connectionUrl: input.adminUrl,
    stdin: RETIRE_RUNTIME_SCRIPT,
    additionalEnvironment: {
      STAGING_AUTH_PROBE_RETIRED_LOGIN: input.login,
    },
    timeoutMs: input.timeoutMs,
  });
  return (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.spawnFailed &&
    !result.outputOverflow &&
    result.stdout.trim() === "retired"
  );
}

interface RuntimeRoleSafetyRow extends QueryResultRow {
  canLogin: boolean;
  inheritsMembership: boolean;
  isSuperuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  canBypassRls: boolean;
}

function runtimeRoleIsRestricted(
  role: RuntimeRoleSafetyRow | undefined,
): boolean {
  return Boolean(
    role &&
      role.canLogin === true &&
      role.inheritsMembership === true &&
      role.isSuperuser === false &&
      role.canCreateDatabase === false &&
      role.canCreateRole === false &&
      role.canReplicate === false &&
      role.canBypassRls === false,
  );
}

function classifyRuntimeReadinessResult(readiness: {
  ready: boolean;
  failures: readonly string[];
}): Exclude<ReadinessReceipt, "not-run"> {
  if (readiness.ready) return "ready";
  return readiness.failures.includes("catalog_check_failed")
    ? "inconclusive"
    : "not-ready";
}

export async function checkRuntimeReadinessInWorker(
  connectionUrl: string,
): Promise<ReadinessReceipt> {
  if (!parsePostgresTarget(connectionUrl, true)) return "inconclusive";
  const normalizedConnectionUrl = new URL(connectionUrl);
  normalizedConnectionUrl.searchParams.set("uselibpqcompat", "true");
  const querySlice = Math.max(
    100,
    Math.floor(STAGING_PRIVATE_AUTH_PROBE_LOCK.attemptTimeoutMs / 8),
  );
  let database: ReturnType<typeof createPostgresDatabase>;
  try {
    database = createPostgresDatabase({
      connectionString: normalizedConnectionUrl.toString(),
      applicationName: "pintpath-staging-private-auth-probe",
      maxConnections: 1,
      idleTimeoutMs: querySlice,
      connectionTimeoutMs: querySlice,
      statementTimeoutMs: querySlice,
      idleInTransactionTimeoutMs: querySlice,
    });
  } catch {
    return "inconclusive";
  }

  let result: ReadinessReceipt = "inconclusive";
  try {
    const role = await database
      .prepare(RUNTIME_ROLE_SAFETY_QUERY)
      .get<RuntimeRoleSafetyRow>();
    if (!runtimeRoleIsRestricted(role)) {
      result = "not-ready";
    } else {
      const readiness = await checkPostgresRuntimeReadiness(database);
      result = classifyRuntimeReadinessResult(readiness);
    }
  } catch {
    result = "inconclusive";
  }
  try {
    await database.close();
  } catch {
    return "inconclusive";
  }
  return result;
}

async function checkRuntimeReadiness(
  connectionUrl: string,
  timeoutMs: number,
  runner: typeof runCapturedProcess = runCapturedProcess,
): Promise<ReadinessReceipt> {
  if (!parsePostgresTarget(connectionUrl, true) || timeoutMs < 1_000) {
    return "inconclusive";
  }
  const normalizedConnectionUrl = new URL(connectionUrl);
  normalizedConnectionUrl.searchParams.set("uselibpqcompat", "true");
  const sourcePath = fileURLToPath(import.meta.url);
  const invocation = readinessWorkerInvocation(sourcePath);
  if (!invocation) return "inconclusive";
  const result = await runner({
    command: invocation.command,
    arguments: invocation.arguments,
    environment: {
      ...narrowBaseProcessEnvironment(),
      [INTERNAL_READINESS_URL_ENV]: normalizedConnectionUrl.toString(),
    },
    stdin: "",
    timeoutMs: Math.min(
      STAGING_PRIVATE_AUTH_PROBE_LOCK.attemptTimeoutMs,
      Math.max(1, Math.trunc(timeoutMs)),
    ),
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.spawnFailed ||
    result.outputOverflow ||
    result.stderr.trim()
  ) {
    return "inconclusive";
  }
  const status = result.stdout.trim();
  return status === "ready" ||
    status === "not-ready" ||
    status === "inconclusive"
    ? status
    : "inconclusive";
}

function readinessWorkerInvocation(sourcePath: string): {
  command: string;
  arguments: string[];
} | null {
  const extension = path.extname(sourcePath);
  const scriptDirectory = path.dirname(sourcePath);
  if (extension === ".js") {
    return {
      command: process.execPath,
      arguments: [
        path.resolve(
          scriptDirectory,
          "lib/staging-private-auth-readiness-worker.js",
        ),
      ],
    };
  }
  if (extension !== ".ts") return null;
  return {
    command: process.execPath,
    arguments: [
      path.resolve(scriptDirectory, "../node_modules/tsx/dist/cli.mjs"),
      path.resolve(
        scriptDirectory,
        "lib/staging-private-auth-readiness-worker.ts",
      ),
    ],
  };
}

const DEFAULT_DEPENDENCIES: StagingPrivateAuthProbeDependencies = {
  env: process.env,
  now: () => new Date(),
  monotonicNow: () => performance.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  randomBytes: (size) => crypto.randomBytes(size),
  validatePostgresClient: validatePostgresClient17,
  attemptPostgres,
  attemptRedis,
  checkRuntimeReadiness,
  provisionRuntimeRole,
  inspectRuntimeRoleOwnership,
  finalizeRuntimeRoleOwnership,
  inspectRuntimeRoleHandoff,
  cleanupRuntimeRole,
  acquireProvisionLifecycleLock,
  retireRuntimeRole,
  writeOutput: (output) => process.stdout.write(output),
};

async function attemptSelectedTarget(
  target: Exclude<StagingPrivateAuthProbeTarget, "all">,
  configuration: ProbeConfiguration,
  dependencies: StagingPrivateAuthProbeDependencies,
  timeoutMs: number,
): Promise<AuthenticationResult> {
  if (target === "postgres-admin") {
    return dependencies.attemptPostgres(
      configuration.postgresAdminUrl,
      configuration.psqlPath,
      timeoutMs,
    );
  }
  if (target === "postgres-runtime") {
    return dependencies.attemptPostgres(
      configuration.postgresRuntimeUrl,
      configuration.psqlPath,
      timeoutMs,
    );
  }
  return dependencies.attemptRedis(configuration.redisUrl, timeoutMs);
}

function setAuthenticationReceipt(
  checks: StagingPrivateAuthProbeReceipt["checks"],
  target: Exclude<StagingPrivateAuthProbeTarget, "all">,
  value: AuthenticationResult,
): void {
  if (target === "postgres-admin") checks.postgresAdminAuth = value;
  else if (target === "postgres-runtime") checks.postgresRuntimeAuth = value;
  else checks.redisAuth = value;
}

function setTransitionReceipt(
  checks: StagingPrivateAuthProbeReceipt["checks"],
  target: Exclude<StagingPrivateAuthProbeTarget, "all">,
  value: TransitionReceipt,
): void {
  if (target === "postgres-admin") checks.postgresAdminTransition = value;
  else if (target === "postgres-runtime")
    checks.postgresRuntimeTransition = value;
  else checks.redisTransition = value;
}

async function watchOldRejection(
  configuration: ProbeConfiguration,
  dependencies: StagingPrivateAuthProbeDependencies,
  deadline: number,
  checks: StagingPrivateAuthProbeReceipt["checks"],
): Promise<ProbeOutcome> {
  let armedProgressEmitted = false;
  const states = new Map(
    selectedTargets(configuration.target).map((target) => [
      target,
      {
        accepted: false,
        transitioned: false,
      },
    ]),
  );
  for (const target of states.keys())
    setTransitionReceipt(checks, target, "not-observed");

  while (!deadlineReached(deadline, dependencies.monotonicNow)) {
    for (const [target, state] of states) {
      if (
        state.transitioned ||
        deadlineReached(deadline, dependencies.monotonicNow)
      )
        continue;
      const result = await attemptSelectedTarget(
        target,
        configuration,
        dependencies,
        boundedTimeout(deadline, dependencies.monotonicNow),
      );
      setAuthenticationReceipt(checks, target, result);
      if (result === "accepted") state.accepted = true;
      if (
        !armedProgressEmitted &&
        !deadlineReached(deadline, dependencies.monotonicNow) &&
        [...states.values()].every((candidate) => candidate.accepted)
      ) {
        armedProgressEmitted = true;
        dependencies.writeOutput(
          `${JSON.stringify(
            createWatcherArmedProgress(
              configuration.deploymentId,
              configuration.target,
            ),
          )}\n`,
        );
      }
      if (result === "rejected" && state.accepted) {
        if (!armedProgressEmitted) return "inconclusive";
        state.transitioned = true;
        setTransitionReceipt(checks, target, "observed");
      }
    }
    if ([...states.values()].every((state) => state.transitioned))
      return "passed";
    const remaining = deadline - dependencies.monotonicNow();
    if (remaining <= 0) break;
    await dependencies.sleep(
      Math.min(STAGING_PRIVATE_AUTH_PROBE_LOCK.pollIntervalMs, remaining),
    );
  }
  return "inconclusive";
}

async function verifyCurrent(
  configuration: ProbeConfiguration,
  dependencies: StagingPrivateAuthProbeDependencies,
  deadline: number,
  checks: StagingPrivateAuthProbeReceipt["checks"],
): Promise<ProbeOutcome> {
  let outcome: ProbeOutcome = "passed";
  for (const target of selectedTargets(configuration.target)) {
    if (deadlineReached(deadline, dependencies.monotonicNow))
      return "inconclusive";
    const result = await attemptSelectedTarget(
      target,
      configuration,
      dependencies,
      boundedTimeout(deadline, dependencies.monotonicNow),
    );
    setAuthenticationReceipt(checks, target, result);
    if (result === "rejected") outcome = "failed";
    else if (result === "inconclusive" && outcome !== "failed")
      outcome = "inconclusive";

    if (target === "postgres-runtime" && result === "accepted") {
      checks.runtimeReadiness = await dependencies.checkRuntimeReadiness(
        configuration.postgresRuntimeUrl,
        boundedTimeout(deadline, dependencies.monotonicNow),
      );
      if (checks.runtimeReadiness === "not-ready") outcome = "failed";
      else if (
        checks.runtimeReadiness === "inconclusive" &&
        outcome !== "failed"
      ) {
        outcome = "inconclusive";
      }
    }
  }

  return outcome;
}

async function provisionRuntimeCandidate(
  configuration: ProbeConfiguration,
  dependencies: StagingPrivateAuthProbeDependencies,
  deadline: number,
  checks: StagingPrivateAuthProbeReceipt["checks"],
): Promise<ProbeOutcome> {
  const parsedRuntime = parsePostgresTarget(
    configuration.postgresRuntimeUrl,
    true,
  );
  const candidateUrl = parsedRuntime
    ? replacePostgresUserInfo(
        parsedRuntime,
        configuration.candidateLogin,
        configuration.candidatePassword,
      )
    : null;
  if (!candidateUrl) return "failed";

  checks.postgresAdminAuth = await dependencies.attemptPostgres(
    configuration.postgresAdminUrl,
    configuration.psqlPath,
    boundedTimeout(deadline, dependencies.monotonicNow),
  );
  if (checks.postgresAdminAuth === "rejected") return "failed";
  if (checks.postgresAdminAuth !== "accepted") return "inconclusive";
  if (!hasMutationBudget(deadline, dependencies.monotonicNow, 14))
    return "inconclusive";

  const salt = dependencies.randomBytes(16);
  const verifier = createScramSha256Verifier(
    configuration.candidatePassword,
    salt,
  );
  salt.fill(0);
  const ownerMarker = createCandidateOwnerMarker(
    configuration.candidateOwnerSecret,
    configuration.candidateLogin,
  );
  const handoffMarker = createCandidateHandoffMarker(
    configuration.candidateOwnerSecret,
    configuration.candidateLogin,
  );
  if (
    !verifier ||
    !ownerMarker ||
    !handoffMarker ||
    !hasMutationBudget(deadline, dependencies.monotonicNow, 14)
  ) {
    return "inconclusive";
  }

  let lifecycleLock: ProvisionLifecycleLock | null = null;
  try {
    lifecycleLock = await dependencies.acquireProvisionLifecycleLock(
      configuration.postgresAdminUrl,
      boundedTimeout(deadline, dependencies.monotonicNow),
    );
  } catch {
    lifecycleLock = null;
  }
  if (!lifecycleLock) return "inconclusive";

  const lockIsHeld = async (): Promise<boolean> => {
    if (deadlineReached(deadline, dependencies.monotonicNow)) return false;
    try {
      return await lifecycleLock.verify(
        boundedTimeout(deadline, dependencies.monotonicNow),
      );
    } catch {
      return false;
    }
  };

  const mutationInput = {
    adminUrl: configuration.postgresAdminUrl,
    handoffMarker,
    login: configuration.candidateLogin,
    ownerMarker,
    psqlPath: configuration.psqlPath,
    timeoutMs: boundedTimeout(deadline, dependencies.monotonicNow),
  };
  try {
    if (!(await lockIsHeld())) return "inconclusive";
    let provisionStatus: ProvisionRuntimeRoleResult = "inconclusive";
    try {
      provisionStatus = await dependencies.provisionRuntimeRole({
        ...mutationInput,
        verifier,
      });
    } catch {
      provisionStatus = "inconclusive";
    }

    const createdThisRun = provisionStatus === "created";
    let forwardOnlyHandoff = provisionStatus === "existing-handoff";
    if (forwardOnlyHandoff) checks.runtimeHandoff = "observed";
    if (!(await lockIsHeld())) {
      checks.runtimeMutation = createdThisRun
        ? "cleanup-inconclusive"
        : "inconclusive";
      return "inconclusive";
    }

    if (provisionStatus === "unowned") {
      checks.runtimeMutation = "inconclusive";
      return "inconclusive";
    }
    if (provisionStatus === "inconclusive") {
      let ownership: CandidateOwnershipResult = "inconclusive";
      try {
        ownership = await dependencies.inspectRuntimeRoleOwnership({
          ...mutationInput,
          timeoutMs: boundedTimeout(deadline, dependencies.monotonicNow),
        });
      } catch {
        ownership = "inconclusive";
      }
      if (!(await lockIsHeld())) {
        checks.runtimeMutation = "cleanup-inconclusive";
        return "inconclusive";
      }
      if (ownership === "absent") {
        checks.runtimeMutation = "rolled-back";
        return "inconclusive";
      }
      if (ownership === "unowned") {
        checks.runtimeMutation = "inconclusive";
        return "inconclusive";
      }
      if (ownership === "handed-off") {
        forwardOnlyHandoff = true;
        checks.runtimeHandoff = "observed";
      }
      if (ownership !== "owned" && ownership !== "handed-off") {
        checks.runtimeMutation = "cleanup-inconclusive";
        return "inconclusive";
      }
    }

    let outcome: ProbeOutcome = "inconclusive";
    try {
      checks.postgresRuntimeAuth = await dependencies.attemptPostgres(
        candidateUrl,
        configuration.psqlPath,
        boundedTimeout(deadline, dependencies.monotonicNow),
      );
      if (checks.postgresRuntimeAuth === "accepted") {
        checks.runtimeReadiness = await dependencies.checkRuntimeReadiness(
          candidateUrl,
          boundedTimeout(deadline, dependencies.monotonicNow),
        );
      }
      if (
        checks.postgresRuntimeAuth === "accepted" &&
        checks.runtimeReadiness === "ready" &&
        !deadlineReached(deadline, dependencies.monotonicNow)
      ) {
        if (!(await lockIsHeld())) {
          checks.runtimeMutation = "inconclusive";
          return "inconclusive";
        }
        if (!forwardOnlyHandoff) {
          let handoff: CandidateHandoffResult = "inconclusive";
          try {
            handoff = await dependencies.finalizeRuntimeRoleOwnership({
              ...mutationInput,
              timeoutMs: boundedTimeout(deadline, dependencies.monotonicNow),
            });
          } catch {
            handoff = "inconclusive";
          }
          checks.runtimeHandoff =
            handoff === "handed-off"
              ? "observed"
              : handoff === "inconclusive"
                ? "inconclusive"
                : "not-observed";
          if (handoff === "unsafe") {
            if (!(await lockIsHeld())) {
              checks.runtimeMutation = "cleanup-inconclusive";
              return "inconclusive";
            }
            let cleanup: CandidateCleanupResult = "inconclusive";
            try {
              cleanup = await dependencies.cleanupRuntimeRole({
                ...mutationInput,
                timeoutMs: boundedTimeout(deadline, dependencies.monotonicNow),
              });
            } catch {
              cleanup = "inconclusive";
            }
            checks.runtimeMutation =
              cleanup === "cleaned" || cleanup === "absent"
                ? "rolled-back"
                : "cleanup-inconclusive";
            return checks.runtimeMutation === "rolled-back"
              ? "failed"
              : "inconclusive";
          }
          if (handoff === "handed-off") forwardOnlyHandoff = true;
          if (handoff !== "handed-off") {
            checks.runtimeMutation = "inconclusive";
            return handoff === "inconclusive" ? "inconclusive" : "failed";
          }
        }
        if (
          !(await lockIsHeld()) ||
          deadlineReached(deadline, dependencies.monotonicNow)
        ) {
          checks.runtimeMutation = "inconclusive";
          return "inconclusive";
        }
        checks.postgresRuntimeAuth = await dependencies.attemptPostgres(
          candidateUrl,
          configuration.psqlPath,
          boundedTimeout(deadline, dependencies.monotonicNow),
        );
        if (checks.postgresRuntimeAuth === "accepted") {
          checks.runtimeReadiness = await dependencies.checkRuntimeReadiness(
            candidateUrl,
            boundedTimeout(deadline, dependencies.monotonicNow),
          );
        }
        if (
          !(await lockIsHeld()) ||
          deadlineReached(deadline, dependencies.monotonicNow)
        ) {
          checks.runtimeMutation = "inconclusive";
          return "inconclusive";
        }
        if (
          checks.postgresRuntimeAuth === "accepted" &&
          checks.runtimeReadiness === "ready"
        ) {
          checks.runtimeMutation = "completed";
          return "passed";
        }
        checks.runtimeMutation = "inconclusive";
        return checks.postgresRuntimeAuth === "rejected" ||
          checks.runtimeReadiness === "not-ready"
          ? "failed"
          : "inconclusive";
      }
      outcome =
        checks.postgresRuntimeAuth === "rejected" ||
        checks.runtimeReadiness === "not-ready"
          ? "failed"
          : "inconclusive";
    } catch {
      outcome = "inconclusive";
    }

    // A durable handoff is forward-only: all proof failures preserve it for
    // reconciliation, including deterministic authentication/readiness failures.
    if (forwardOnlyHandoff) {
      checks.runtimeMutation = "inconclusive";
      return outcome;
    }

    // An inconclusive proof preserves a crash-owned role for a safe retry.
    // A deterministic rejection or unsafe-readiness result instead rolls the
    // exact marker-owned role back while the lifecycle lock is still held.
    if (!createdThisRun && outcome === "inconclusive") {
      checks.runtimeMutation = "inconclusive";
      return outcome;
    }

    if (!(await lockIsHeld())) {
      checks.runtimeMutation = "cleanup-inconclusive";
      return "inconclusive";
    }
    let cleanup: CandidateCleanupResult = "inconclusive";
    try {
      cleanup = await dependencies.cleanupRuntimeRole({
        ...mutationInput,
        timeoutMs: boundedTimeout(deadline, dependencies.monotonicNow),
      });
    } catch {
      cleanup = "inconclusive";
    }
    checks.runtimeMutation =
      cleanup === "cleaned" || cleanup === "absent"
        ? "rolled-back"
        : "cleanup-inconclusive";
    return checks.runtimeMutation === "rolled-back" ? outcome : "inconclusive";
  } finally {
    try {
      await lifecycleLock.release(
        boundedTimeout(deadline, dependencies.monotonicNow),
      );
    } catch {
      // The default release path force-destroys a stalled stream. A dependency
      // exception cannot make an incomplete lifecycle green.
    }
  }
}

async function retireOldRuntime(
  configuration: ProbeConfiguration,
  dependencies: StagingPrivateAuthProbeDependencies,
  deadline: number,
  checks: StagingPrivateAuthProbeReceipt["checks"],
): Promise<ProbeOutcome> {
  checks.postgresAdminAuth = await dependencies.attemptPostgres(
    configuration.postgresAdminUrl,
    configuration.psqlPath,
    boundedTimeout(deadline, dependencies.monotonicNow),
  );
  if (checks.postgresAdminAuth === "rejected") return "failed";
  if (checks.postgresAdminAuth !== "accepted") return "inconclusive";
  if (!hasMutationBudget(deadline, dependencies.monotonicNow, 10))
    return "inconclusive";

  const handoffMarker = createCandidateHandoffMarker(
    configuration.candidateOwnerSecret,
    configuration.candidateLogin,
  );
  if (!handoffMarker) return "inconclusive";

  let lifecycleLock: ProvisionLifecycleLock | null = null;
  try {
    lifecycleLock = await dependencies.acquireProvisionLifecycleLock(
      configuration.postgresAdminUrl,
      boundedTimeout(deadline, dependencies.monotonicNow),
    );
  } catch {
    lifecycleLock = null;
  }
  if (!lifecycleLock) return "inconclusive";

  const lockIsHeld = async (): Promise<boolean> => {
    if (deadlineReached(deadline, dependencies.monotonicNow)) return false;
    try {
      return await lifecycleLock.verify(
        boundedTimeout(deadline, dependencies.monotonicNow),
      );
    } catch {
      return false;
    }
  };

  try {
    if (!(await lockIsHeld())) return "inconclusive";
    checks.postgresRuntimeAuth = await dependencies.attemptPostgres(
      configuration.postgresRuntimeUrl,
      configuration.psqlPath,
      boundedTimeout(deadline, dependencies.monotonicNow),
    );
    if (checks.postgresRuntimeAuth === "rejected") return "failed";
    if (checks.postgresRuntimeAuth !== "accepted") return "inconclusive";
    checks.runtimeReadiness = await dependencies.checkRuntimeReadiness(
      configuration.postgresRuntimeUrl,
      boundedTimeout(deadline, dependencies.monotonicNow),
    );
    if (checks.runtimeReadiness === "not-ready") return "failed";
    if (checks.runtimeReadiness !== "ready") return "inconclusive";
    if (!(await lockIsHeld())) return "inconclusive";

    let handoff: CandidateHandoffResult = "inconclusive";
    try {
      handoff = await dependencies.inspectRuntimeRoleHandoff({
        adminUrl: configuration.postgresAdminUrl,
        login: configuration.candidateLogin,
        handoffMarker,
        psqlPath: configuration.psqlPath,
        timeoutMs: boundedTimeout(deadline, dependencies.monotonicNow),
      });
    } catch {
      handoff = "inconclusive";
    }
    checks.runtimeHandoff =
      handoff === "handed-off"
        ? "observed"
        : handoff === "inconclusive"
          ? "inconclusive"
          : "not-observed";
    if (handoff === "inconclusive") return "inconclusive";
    if (handoff !== "handed-off") return "failed";
    if (!(await lockIsHeld())) return "inconclusive";
    if (!hasMutationBudget(deadline, dependencies.monotonicNow, 5))
      return "inconclusive";

    let retired = false;
    try {
      retired = await dependencies.retireRuntimeRole({
        adminUrl: configuration.postgresAdminUrl,
        login: STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresPredecessorRuntimeLogin,
        psqlPath: configuration.psqlPath,
        timeoutMs: boundedTimeout(deadline, dependencies.monotonicNow),
      });
    } catch {
      retired = false;
    }
    checks.runtimeMutation = retired ? "completed" : "inconclusive";
    if (!retired) return "inconclusive";
    if (!(await lockIsHeld())) return "inconclusive";

    checks.postgresRuntimeAuth = await dependencies.attemptPostgres(
      configuration.postgresRuntimeUrl,
      configuration.psqlPath,
      boundedTimeout(deadline, dependencies.monotonicNow),
    );
    if (checks.postgresRuntimeAuth === "rejected") return "failed";
    if (checks.postgresRuntimeAuth !== "accepted") return "inconclusive";
    if (deadlineReached(deadline, dependencies.monotonicNow))
      return "inconclusive";
    checks.runtimeReadiness = await dependencies.checkRuntimeReadiness(
      configuration.postgresRuntimeUrl,
      boundedTimeout(deadline, dependencies.monotonicNow),
    );
    if (
      !(await lockIsHeld()) ||
      deadlineReached(deadline, dependencies.monotonicNow)
    ) {
      return "inconclusive";
    }
    return checks.runtimeReadiness === "ready"
      ? "passed"
      : checks.runtimeReadiness === "not-ready"
        ? "failed"
        : "inconclusive";
  } finally {
    try {
      await lifecycleLock.release(
        boundedTimeout(deadline, dependencies.monotonicNow),
      );
    } catch {
      // A thrown dependency release never turns an incomplete cutover green.
    }
  }
}

export async function runStagingPrivateAuthProbe(
  mode: StagingPrivateAuthProbeMode,
  target: StagingPrivateAuthProbeTarget,
  overrides: Partial<StagingPrivateAuthProbeDependencies> = {},
): Promise<0 | 1> {
  const dependencies: StagingPrivateAuthProbeDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  const configuration = configurationFromEnvironment(
    mode,
    target,
    dependencies.env,
  );
  const checks = emptyChecks();
  const startedAt = dependencies.monotonicNow();
  const deadline =
    startedAt + STAGING_PRIVATE_AUTH_PROBE_LOCK.maximumDurationMs;

  if (isPostgresTarget(target)) {
    try {
      configuration.identity.postgresClient17 =
        await dependencies.validatePostgresClient(
          configuration.psqlPath,
          boundedTimeout(deadline, dependencies.monotonicNow),
        );
    } catch {
      configuration.identity.postgresClient17 = false;
    }
  }
  if (!identityIsValid(configuration)) {
    const receipt = createReceipt({
      dependencies,
      deploymentId: configuration.deploymentId,
      mode,
      target,
      outcome: "failed",
      identity: configuration.identity,
      checks,
    });
    dependencies.writeOutput(`${JSON.stringify(receipt)}\n`);
    return 1;
  }

  let outcome: ProbeOutcome;
  try {
    if (mode === "watch-old-rejection") {
      outcome = await watchOldRejection(
        configuration,
        dependencies,
        deadline,
        checks,
      );
    } else if (mode === "verify-current") {
      outcome = await verifyCurrent(
        configuration,
        dependencies,
        deadline,
        checks,
      );
    } else if (mode === "provision-runtime-candidate") {
      outcome = await provisionRuntimeCandidate(
        configuration,
        dependencies,
        deadline,
        checks,
      );
    } else {
      outcome = await retireOldRuntime(
        configuration,
        dependencies,
        deadline,
        checks,
      );
    }
  } catch {
    outcome = "inconclusive";
  }
  if (
    outcome === "passed" &&
    deadlineReached(deadline, dependencies.monotonicNow)
  ) {
    outcome = "inconclusive";
  }
  const receipt = createReceipt({
    dependencies,
    deploymentId: configuration.deploymentId,
    mode,
    target,
    outcome,
    identity: configuration.identity,
    checks,
  });
  dependencies.writeOutput(`${JSON.stringify(receipt)}\n`);
  return outcome === "passed" ? 0 : 1;
}

export const stagingPrivateAuthProbeInternals = {
  acquireProvisionLifecycleLock,
  checkRuntimeReadiness,
  cleanupRuntimeRole,
  configurationFromEnvironment,
  finalizeRuntimeRoleOwnership,
  inspectRuntimeRoleHandoff,
  inspectRuntimeRoleOwnership,
  lifecycleLockConnectionUrl,
  lifecycleLockKeys: [...PROVISION_LIFECYCLE_LOCK_KEYS],
  parsePostgresTarget,
  parseRedisTarget,
  provisionRuntimeRole,
  replacePostgresUserInfo,
  retireRuntimeRole,
  runCapturedProcess,
  classifyRuntimeReadinessResult,
  readinessWorkerInvocation,
  runtimeRoleIsRestricted,
  queries: {
    acquireProvisionLifecycleLock: PROVISION_LIFECYCLE_LOCK_QUERY,
    runtimeRoleSafety: RUNTIME_ROLE_SAFETY_QUERY,
    verifyProvisionLifecycleLock: VERIFY_PROVISION_LIFECYCLE_LOCK_QUERY,
  },
  scripts: {
    cleanup: CLEANUP_RUNTIME_SCRIPT,
    finalizeOwnership: FINALIZE_RUNTIME_OWNERSHIP_SCRIPT,
    inspectHandoff: INSPECT_RUNTIME_HANDOFF_SCRIPT,
    inspectOwnership: INSPECT_RUNTIME_OWNERSHIP_SCRIPT,
    provision: PROVISION_RUNTIME_SCRIPT,
    retire: RETIRE_RUNTIME_SCRIPT,
  },
};

function parseCliArguments(argv: readonly string[]): {
  mode: StagingPrivateAuthProbeMode;
  target: StagingPrivateAuthProbeTarget;
} | null {
  try {
    const parsed = parseStrictArguments(argv, {
      allowed: new Set(["--target"]),
      required: new Set(["--target"]),
      positionalName: "mode",
    });
    const mode = parsed.get("mode") as StagingPrivateAuthProbeMode | undefined;
    const target = parsed.get("--target") as
      | StagingPrivateAuthProbeTarget
      | undefined;
    return mode && target && PROBE_MODES.has(mode) && PROBE_TARGETS.has(target)
      ? { mode, target }
      : null;
  } catch {
    return null;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const parsed = parseCliArguments(process.argv.slice(2));
  if (!parsed) {
    const receipt = createReceipt({
      dependencies: DEFAULT_DEPENDENCIES,
      deploymentId: safeDeploymentId(process.env.RAILWAY_DEPLOYMENT_ID),
      mode: "invalid",
      target: "invalid",
      outcome: "failed",
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = await runStagingPrivateAuthProbe(
      parsed.mode,
      parsed.target,
    );
  }
}
