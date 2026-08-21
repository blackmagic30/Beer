import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import {
  Client,
  type ClientConfig,
  type QueryResultRow,
} from "pg";

import { postgresMigrationTargetInternals } from "../src/db/postgres-migration-target.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  checkPostgresRailwayStockLocalhostServerIdentity,
  openPostgresRailwayStockLocalhostCaTransport,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import {
  PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA,
  PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_SCHEMA,
  parseProductionMaintenanceRoleLimitPrerequisitesVerification,
  parseProductionRoleLimitReconciliationAuthorityVerification,
  type ProductionMaintenanceRoleLimitPrerequisitesVerification,
} from "./verify-production-maintenance-role-limit-prerequisites.js";

export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_PATH =
  "ops/postgres/protected-production-maintenance-login-limit-policy.json" as const;
export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256 =
  "e85c95824a5f706f46a2574066201aa4095010f9567b62c858ca587fe66e81a4" as const;
export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_WORKFLOW =
  ".github/workflows/transition-production-postgres-maintenance-role-limit.yml" as const;
export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT =
  "production-postgres-maintenance-role-limit" as const;
export const PRODUCTION_MAINTENANCE_LOGIN =
  "privacy_maintenance_login" as const;
export const PRODUCTION_MAINTENANCE_GROUP_ROLE =
  "pintpath_maintenance" as const;
export const PRODUCTION_MAINTENANCE_OLD_LIMIT = 2 as const;
export const PRODUCTION_MAINTENANCE_NEW_LIMIT = 8 as const;

const GITHUB_REPOSITORY = "blackmagic30/Beer" as const;
const REQUIRED_GIT_REF = "refs/heads/main" as const;
const PRODUCTION_DATABASE_HOST =
  "postgres-production.railway.internal" as const;
const PRODUCTION_DATABASE_NAME = "pintpath" as const;
const PRODUCTION_AUTHORITY_LOGIN = "postgres" as const;
const APPLY_CONFIRMATION =
  "ALTER_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_2_TO_8" as const;
const RECONCILE_CONFIRMATION =
  "RECONCILE_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_8" as const;
const INTENT_SCHEMA =
  "pintpath-production-maintenance-login-limit-intent/v1" as const;
const TERMINAL_SCHEMA =
  "pintpath-production-maintenance-login-limit-terminal/v1" as const;
const RECEIPT_SCHEMA =
  "pintpath-production-maintenance-login-limit-receipt/v1" as const;
const POLICY_ID =
  "pintpath-production-maintenance-login-limit-2-to-8" as const;
const GITHUB_CONTEXT_ENV =
  "PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT" as const;
const OPERATION_MODE_ENV =
  "PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_MODE" as const;
const CONFIRMATION_ENV =
  "PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_CONFIRMATION" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^[a-f0-9]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const INTENT_MAXIMUM_AGE_MS = 3_600_000;
const PRIOR_INTENT_MAXIMUM_AGE_MS = 2_592_000_000;
const MAXIMUM_CLOCK_SKEW_MS = 300_000;
const ADVISORY_LOCK_CLASS_ID = 1_885_957_733;
const ADVISORY_LOCK_OBJECT_ID = 2;
const MAXIMUM_PRIVATE_FILE_BYTES = 64 * 1024;

export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_CATALOG_QUERY = `/* pintpath:production-maintenance-role-limit:catalog */
WITH login_role AS (
  SELECT role.*
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'privacy_maintenance_login'
), group_role AS (
  SELECT role.*
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = 'pintpath_maintenance'
), authority_role AS (
  SELECT role.*
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = session_user
)
SELECT
  pg_catalog.current_database() AS "databaseName",
  session_user AS "sessionUser",
  current_user AS "currentUser",
  pg_catalog.current_setting('server_version_num') AS "serverVersionNum",
  pg_catalog.clock_timestamp()::text AS "observedAt",
  authority_role.rolname::text AS "authorityRoleName",
  authority_role.rolcanlogin AS "authorityCanLogin",
  authority_role.rolsuper AS "authorityIsSuperuser",
  authority_role.rolcreaterole AS "authorityCanCreateRole",
  login_role.rolname::text AS "loginRoleName",
  login_role.rolcanlogin AS "loginCanLogin",
  login_role.rolsuper AS "loginIsSuperuser",
  login_role.rolcreatedb AS "loginCanCreateDatabase",
  login_role.rolcreaterole AS "loginCanCreateRole",
  login_role.rolinherit AS "loginInheritsPrivileges",
  login_role.rolreplication AS "loginCanReplicate",
  login_role.rolbypassrls AS "loginBypassesRls",
  login_role.rolconnlimit AS "loginConnectionLimit",
  login_role.rolvaliduntil IS NULL AS "loginValidUntilNull",
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
     WHERE membership.member = login_role.oid
  ), false) AS "loginMembershipExact",
  NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.roleid = login_role.oid
  ) AS "loginChildrenAbsent",
  NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_db_role_setting AS setting
     WHERE setting.setrole = login_role.oid
  ) AS "loginRoleSettingsAbsent",
  group_role.rolname::text AS "groupRoleName",
  group_role.rolcanlogin AS "groupCanLogin",
  group_role.rolsuper AS "groupIsSuperuser",
  group_role.rolcreatedb AS "groupCanCreateDatabase",
  group_role.rolcreaterole AS "groupCanCreateRole",
  group_role.rolinherit AS "groupInheritsPrivileges",
  group_role.rolreplication AS "groupCanReplicate",
  group_role.rolbypassrls AS "groupBypassesRls",
  group_role.rolconnlimit AS "groupConnectionLimit",
  group_role.rolvaliduntil IS NULL AS "groupValidUntilNull",
  NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS membership
     WHERE membership.member = group_role.oid
  ) AS "groupParentsAbsent",
  COALESCE((
    SELECT pg_catalog.count(*) = 1
      AND pg_catalog.bool_and(
        child.rolname = 'privacy_maintenance_login'
        AND NOT membership.admin_option
        AND NOT membership.inherit_option
        AND membership.set_option
      )
      FROM pg_catalog.pg_auth_members AS membership
      JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
     WHERE membership.roleid = group_role.oid
  ), false) AS "groupSoleMemberExact",
  NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_db_role_setting AS setting
     WHERE setting.setrole = group_role.oid
  ) AS "groupRoleSettingsAbsent"
FROM login_role
CROSS JOIN group_role
CROSS JOIN authority_role`;

export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_ADVISORY_LOCK_QUERY =
  `/* pintpath:production-maintenance-role-limit:lock */
SELECT pg_catalog.pg_try_advisory_xact_lock($1::integer, $2::integer) AS "locked"`;

export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_ALTER =
  "/* pintpath:production-maintenance-role-limit:single-write */ ALTER ROLE privacy_maintenance_login CONNECTION LIMIT 8" as const;

type Phase = "prepare" | "apply" | "reconcile";
type FailureCode =
  | "ambient_postgres_authority_present"
  | "argument_invalid"
  | "catalog_preflight_invalid"
  | "credential_custody_invalid"
  | "evidence_invalid"
  | "github_context_invalid"
  | "intent_invalid"
  | "mutation_uncertain"
  | "policy_invalid"
  | "prerequisite_invalid"
  | "repository_state_invalid"
  | "transport_invalid";

class MaintenanceRoleLimitError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = "MaintenanceRoleLimitError";
  }
}

function fail(code: FailureCode): never {
  throw new MaintenanceRoleLimitError(code);
}

interface ParsedArguments {
  readonly phase: Phase;
  readonly candidateSha: string;
  readonly evidenceDirectory: string;
  readonly rootCaDerSha256: string;
  readonly intentFile: string | null;
  readonly credentialFile: string | null;
  readonly rootCaFile: string | null;
  readonly priorRunId: string | null;
  readonly fenceRunId: string | null;
  readonly deploymentRunId: string | null;
  readonly prerequisitesVerificationFile: string | null;
  readonly reconciliationAuthorityFile: string | null;
}

interface GithubContext {
  readonly repository: typeof GITHUB_REPOSITORY;
  readonly workflowPath: typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_WORKFLOW;
  readonly githubEnvironment:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT;
  readonly runId: string;
  readonly runAttempt: 1;
}

interface MaintenanceRoleLimitIntent {
  readonly schemaVersion: typeof INTENT_SCHEMA;
  readonly policyId: typeof POLICY_ID;
  readonly policySha256:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256;
  readonly candidateSha: string;
  readonly repository: typeof GITHUB_REPOSITORY;
  readonly workflowPath: typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_WORKFLOW;
  readonly githubEnvironment:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT;
  readonly githubRunId: string;
  readonly githubRunAttempt: 1;
  readonly targetEnvironment: "production";
  readonly databaseHost: typeof PRODUCTION_DATABASE_HOST;
  readonly databasePort: 5432;
  readonly databaseName: typeof PRODUCTION_DATABASE_NAME;
  readonly authorityLogin: typeof PRODUCTION_AUTHORITY_LOGIN;
  readonly loginRole: typeof PRODUCTION_MAINTENANCE_LOGIN;
  readonly groupRole: typeof PRODUCTION_MAINTENANCE_GROUP_ROLE;
  readonly expectedOldConnectionLimit: typeof PRODUCTION_MAINTENANCE_OLD_LIMIT;
  readonly desiredConnectionLimit: typeof PRODUCTION_MAINTENANCE_NEW_LIMIT;
  readonly prerequisitesVerificationSchema:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA;
  readonly prerequisitesVerificationSha256: string;
  readonly workerFenceRunId: string;
  readonly productionDeploymentRunId: string;
  readonly rootCaDerSha256: string;
  readonly maximumWriteAttempts: 1;
  readonly retryAllowed: false;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

interface CatalogRow extends QueryResultRow {
  readonly databaseName: string;
  readonly sessionUser: string;
  readonly currentUser: string;
  readonly serverVersionNum: string;
  readonly observedAt: string;
  readonly authorityRoleName: string;
  readonly authorityCanLogin: boolean;
  readonly authorityIsSuperuser: boolean;
  readonly authorityCanCreateRole: boolean;
  readonly loginRoleName: string;
  readonly loginCanLogin: boolean;
  readonly loginIsSuperuser: boolean;
  readonly loginCanCreateDatabase: boolean;
  readonly loginCanCreateRole: boolean;
  readonly loginInheritsPrivileges: boolean;
  readonly loginCanReplicate: boolean;
  readonly loginBypassesRls: boolean;
  readonly loginConnectionLimit: number;
  readonly loginValidUntilNull: boolean;
  readonly loginMembershipExact: boolean;
  readonly loginChildrenAbsent: boolean;
  readonly loginRoleSettingsAbsent: boolean;
  readonly groupRoleName: string;
  readonly groupCanLogin: boolean;
  readonly groupIsSuperuser: boolean;
  readonly groupCanCreateDatabase: boolean;
  readonly groupCanCreateRole: boolean;
  readonly groupInheritsPrivileges: boolean;
  readonly groupCanReplicate: boolean;
  readonly groupBypassesRls: boolean;
  readonly groupConnectionLimit: number;
  readonly groupValidUntilNull: boolean;
  readonly groupParentsAbsent: boolean;
  readonly groupSoleMemberExact: boolean;
  readonly groupRoleSettingsAbsent: boolean;
}

interface QueryResult<Row extends QueryResultRow = QueryResultRow> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface ProductionMaintenanceRoleLimitConnection {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  assertExact(): Promise<void>;
  close(): Promise<void>;
}

interface ConnectionInput {
  readonly targetUrl: string;
  readonly rootCaFile: string;
  readonly expectedRootCaDerSha256: string;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly now: () => Date;
  readonly connect: (
    input: ConnectionInput,
  ) => Promise<ProductionMaintenanceRoleLimitConnection>;
  readonly reassertRepository: (
    cwd: string,
    candidateSha: string,
  ) => Promise<boolean>;
  readonly readPrivateFile: (filename: string) => Buffer;
  readonly writeEvidence: (
    directory: string,
    leaf: string,
    source: string,
  ) => string;
  readonly writeOutput: (source: string) => void;
}

interface Checks {
  policyExact: boolean;
  githubContextExact: boolean;
  ambientPostgresAuthorityAbsent: boolean;
  intentExact: boolean;
  priorIntentRequiredForAlreadyDesired: boolean;
  prerequisiteIntentBindingExact: boolean;
  prerequisiteVerificationExact: boolean;
  repositoryPreflightExact: boolean;
  credentialCustodyExact: boolean;
  transportExact: boolean;
  catalogPreflightExact: boolean;
  repositoryPrewriteExact: boolean;
  advisoryLockExact: boolean;
  immediateCatalogPrewriteExact: boolean;
  oneAlterRoleAtMost: boolean;
  automaticRetryAbsent: boolean;
  postflightAttempted: boolean;
  catalogPostflightExact: boolean;
  primaryConnectionCleanupExact: boolean;
  postflightConnectionCleanupExact: boolean;
  terminalEvidenceExact: boolean;
  receiptEvidenceExact: boolean;
}

function checks(): Checks {
  return {
    policyExact: false,
    githubContextExact: false,
    ambientPostgresAuthorityAbsent: false,
    intentExact: false,
    priorIntentRequiredForAlreadyDesired: false,
    prerequisiteIntentBindingExact: false,
    prerequisiteVerificationExact: false,
    repositoryPreflightExact: false,
    credentialCustodyExact: false,
    transportExact: false,
    catalogPreflightExact: false,
    repositoryPrewriteExact: false,
    advisoryLockExact: false,
    immediateCatalogPrewriteExact: false,
    oneAlterRoleAtMost: true,
    automaticRetryAbsent: true,
    postflightAttempted: false,
    catalogPostflightExact: false,
    primaryConnectionCleanupExact: false,
    postflightConnectionCleanupExact: true,
    terminalEvidenceExact: false,
    receiptEvidenceExact: false,
  };
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key, index) => actual[index] === key);
}

function exactAbsolutePath(value: string): boolean {
  return path.isAbsolute(value)
    && path.resolve(value) === value
    && path.normalize(value) === value
    && !value.includes("\0");
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length < 8 || argv.length % 2 !== 0) fail("argument_invalid");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      fail("argument_invalid");
    }
    values.set(key, value);
  }
  const phase = values.get("--phase");
  const candidateSha = values.get("--candidate-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const rootCaDerSha256 = values.get("--root-ca-der-sha256") ?? "";
  if (
    phase !== "prepare"
    && phase !== "apply"
    && phase !== "reconcile"
  ) fail("argument_invalid");
  if (
    !CANDIDATE_PATTERN.test(candidateSha)
    || !SHA256_PATTERN.test(rootCaDerSha256)
    || !exactAbsolutePath(evidenceDirectory)
  ) fail("argument_invalid");

  const base = [
    "--phase",
    "--candidate-sha",
    "--evidence-dir",
    "--root-ca-der-sha256",
  ];
  const applyPrerequisites = [
    "--fence-run-id",
    "--deployment-run-id",
    "--prerequisites-verification-file",
  ];
  const required = phase === "prepare"
    ? [...base, ...applyPrerequisites]
    : phase === "apply"
      ? [
          ...base,
          ...applyPrerequisites,
          "--intent-file",
          "--credential-file",
          "--root-ca-file",
        ]
      : [
          ...base,
          "--intent-file",
          "--prior-run-id",
          "--prerequisites-verification-file",
          "--reconciliation-authority-file",
          "--credential-file",
          "--root-ca-file",
        ];
  if (
    values.size !== required.length
    || required.some((key) => !values.has(key))
    || [...values.keys()].some((key) => !required.includes(key))
  ) fail("argument_invalid");

  const intentFile = values.get("--intent-file") ?? null;
  const credentialFile = values.get("--credential-file") ?? null;
  const rootCaFile = values.get("--root-ca-file") ?? null;
  const priorRunId = values.get("--prior-run-id") ?? null;
  const fenceRunId = values.get("--fence-run-id") ?? null;
  const deploymentRunId = values.get("--deployment-run-id") ?? null;
  const prerequisitesVerificationFile =
    values.get("--prerequisites-verification-file") ?? null;
  const reconciliationAuthorityFile =
    values.get("--reconciliation-authority-file") ?? null;
  for (const filename of [
    intentFile,
    credentialFile,
    rootCaFile,
    prerequisitesVerificationFile,
    reconciliationAuthorityFile,
  ]) {
    if (filename !== null && !exactAbsolutePath(filename)) {
      fail("argument_invalid");
    }
  }
  if (priorRunId !== null && !RUN_ID_PATTERN.test(priorRunId)) {
    fail("argument_invalid");
  }
  if (
    phase !== "reconcile"
    && (!fenceRunId
      || !RUN_ID_PATTERN.test(fenceRunId)
      || !deploymentRunId
      || !RUN_ID_PATTERN.test(deploymentRunId)
      || fenceRunId === deploymentRunId
      || prerequisitesVerificationFile === null)
  ) fail("argument_invalid");
  return {
    phase,
    candidateSha,
    evidenceDirectory,
    rootCaDerSha256,
    intentFile,
    credentialFile,
    rootCaFile,
    priorRunId,
    fenceRunId,
    deploymentRunId,
    prerequisitesVerificationFile,
    reconciliationAuthorityFile,
  };
}

function validatePolicy(cwd: string): void {
  try {
    const source = readTrustedRegularFile(
      path.resolve(cwd, PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_PATH),
      {
        minBytes: 1,
        maxBytes: 16 * 1024,
      },
    );
    const digest = sha256(source);
    const value = JSON.parse(source.toString("utf8")) as unknown;
    source.fill(0);
    if (
      digest !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
      || !exactKeys(value, [
        "schemaVersion",
        "policyId",
        "activationState",
        "sourceAuthority",
        "target",
        "catalogContract",
        "mutationPrerequisites",
        "transportContract",
        "writeContract",
        "evidenceContract",
      ])
      || value.schemaVersion
        !== "pintpath-protected-production-maintenance-login-limit-policy/v1"
      || value.policyId !== POLICY_ID
      || value.activationState !== "GITHUB_ENVIRONMENT_PROTECTED"
      || !exactKeys(value.target, [
        "environment",
        "databaseHost",
        "databasePort",
        "databaseName",
        "authorityLogin",
        "loginRole",
        "groupRole",
        "expectedOldConnectionLimit",
        "desiredConnectionLimit",
      ])
      || value.target.environment !== "production"
      || value.target.databaseHost !== PRODUCTION_DATABASE_HOST
      || value.target.databasePort !== 5432
      || value.target.databaseName !== PRODUCTION_DATABASE_NAME
      || value.target.authorityLogin !== PRODUCTION_AUTHORITY_LOGIN
      || value.target.loginRole !== PRODUCTION_MAINTENANCE_LOGIN
      || value.target.groupRole !== PRODUCTION_MAINTENANCE_GROUP_ROLE
      || value.target.expectedOldConnectionLimit
        !== PRODUCTION_MAINTENANCE_OLD_LIMIT
      || value.target.desiredConnectionLimit
        !== PRODUCTION_MAINTENANCE_NEW_LIMIT
    ) fail("policy_invalid");
  } catch (error) {
    if (error instanceof MaintenanceRoleLimitError) throw error;
    fail("policy_invalid");
  }
}

function hasAmbientPostgresAuthority(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return Object.keys(env).some((key) =>
    key === "DATABASE_URL"
    || key === "DATABASE_MAINTENANCE_URL"
    || /^PG[A-Z0-9_]+$/.test(key));
}

function githubContext(
  phase: Phase,
  candidateSha: string,
  env: Readonly<Record<string, string | undefined>>,
): GithubContext {
  const runId = env.GITHUB_RUN_ID ?? "";
  const expectedMode = phase === "reconcile" ? "reconcile" : "apply";
  const expectedConfirmation = phase === "reconcile"
    ? RECONCILE_CONFIRMATION
    : APPLY_CONFIRMATION;
  if (
    env.GITHUB_ACTIONS !== "true"
    || env.GITHUB_REPOSITORY !== GITHUB_REPOSITORY
    || env.GITHUB_REF !== REQUIRED_GIT_REF
    || env.GITHUB_SHA !== candidateSha
    || env.GITHUB_RUN_ATTEMPT !== "1"
    || !RUN_ID_PATTERN.test(runId)
    || env.GITHUB_WORKFLOW_REF?.split("@")[0]
      !== `${GITHUB_REPOSITORY}/${PRODUCTION_MAINTENANCE_ROLE_LIMIT_WORKFLOW}`
    || env[GITHUB_CONTEXT_ENV]
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT
    || env[OPERATION_MODE_ENV] !== expectedMode
    || env[CONFIRMATION_ENV] !== expectedConfirmation
  ) fail("github_context_invalid");
  return {
    repository: GITHUB_REPOSITORY,
    workflowPath: PRODUCTION_MAINTENANCE_ROLE_LIMIT_WORKFLOW,
    githubEnvironment: PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT,
    runId,
    runAttempt: 1,
  };
}

function validDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? date
    : null;
}

function buildIntent(
  args: ParsedArguments,
  context: GithubContext,
  now: Date,
  verification: ProductionMaintenanceRoleLimitPrerequisitesVerification,
  prerequisitesVerificationSha256: string,
): MaintenanceRoleLimitIntent {
  return {
    schemaVersion: INTENT_SCHEMA,
    policyId: POLICY_ID,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: args.candidateSha,
    repository: context.repository,
    workflowPath: context.workflowPath,
    githubEnvironment: context.githubEnvironment,
    githubRunId: context.runId,
    githubRunAttempt: context.runAttempt,
    targetEnvironment: "production",
    databaseHost: PRODUCTION_DATABASE_HOST,
    databasePort: 5432,
    databaseName: PRODUCTION_DATABASE_NAME,
    authorityLogin: PRODUCTION_AUTHORITY_LOGIN,
    loginRole: PRODUCTION_MAINTENANCE_LOGIN,
    groupRole: PRODUCTION_MAINTENANCE_GROUP_ROLE,
    expectedOldConnectionLimit: PRODUCTION_MAINTENANCE_OLD_LIMIT,
    desiredConnectionLimit: PRODUCTION_MAINTENANCE_NEW_LIMIT,
    prerequisitesVerificationSchema:
      PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA,
    prerequisitesVerificationSha256,
    workerFenceRunId: verification.workerFence.runId,
    productionDeploymentRunId: verification.productionDeployment.runId,
    rootCaDerSha256: args.rootCaDerSha256,
    maximumWriteAttempts: 1,
    retryAllowed: false,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INTENT_MAXIMUM_AGE_MS).toISOString(),
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
}

const INTENT_KEYS = [
  "schemaVersion",
  "policyId",
  "policySha256",
  "candidateSha",
  "repository",
  "workflowPath",
  "githubEnvironment",
  "githubRunId",
  "githubRunAttempt",
  "targetEnvironment",
  "databaseHost",
  "databasePort",
  "databaseName",
  "authorityLogin",
  "loginRole",
  "groupRole",
  "expectedOldConnectionLimit",
  "desiredConnectionLimit",
  "prerequisitesVerificationSchema",
  "prerequisitesVerificationSha256",
  "workerFenceRunId",
  "productionDeploymentRunId",
  "rootCaDerSha256",
  "maximumWriteAttempts",
  "retryAllowed",
  "createdAt",
  "expiresAt",
  "secretMaterialIncluded",
  "secretDerivedCommitmentsIncluded",
] as const;

function parseIntent(
  source: string,
  args: ParsedArguments,
  context: GithubContext,
  now: Date,
): MaintenanceRoleLimitIntent {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("intent_invalid");
  }
  if (!exactKeys(value, INTENT_KEYS) || canonical(value) !== source) {
    fail("intent_invalid");
  }
  const createdAt = validDate(value.createdAt);
  const expiresAt = validDate(value.expiresAt);
  const maximumAge = args.phase === "reconcile"
    ? PRIOR_INTENT_MAXIMUM_AGE_MS
    : INTENT_MAXIMUM_AGE_MS;
  const priorRunExact = args.phase === "reconcile"
    ? value.githubRunId === args.priorRunId
      && value.githubRunId !== context.runId
    : value.githubRunId === context.runId;
  const prerequisiteRunIdsExact = args.phase === "reconcile"
    ? RUN_ID_PATTERN.test(String(value.workerFenceRunId))
      && RUN_ID_PATTERN.test(String(value.productionDeploymentRunId))
      && value.workerFenceRunId !== value.productionDeploymentRunId
    : value.workerFenceRunId === args.fenceRunId
      && value.productionDeploymentRunId === args.deploymentRunId;
  if (
    value.schemaVersion !== INTENT_SCHEMA
    || value.policyId !== POLICY_ID
    || value.policySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || value.candidateSha !== args.candidateSha
    || value.repository !== GITHUB_REPOSITORY
    || value.workflowPath !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_WORKFLOW
    || value.githubEnvironment
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT
    || !priorRunExact
    || value.githubRunAttempt !== 1
    || value.targetEnvironment !== "production"
    || value.databaseHost !== PRODUCTION_DATABASE_HOST
    || value.databasePort !== 5432
    || value.databaseName !== PRODUCTION_DATABASE_NAME
    || value.authorityLogin !== PRODUCTION_AUTHORITY_LOGIN
    || value.loginRole !== PRODUCTION_MAINTENANCE_LOGIN
    || value.groupRole !== PRODUCTION_MAINTENANCE_GROUP_ROLE
    || value.expectedOldConnectionLimit
      !== PRODUCTION_MAINTENANCE_OLD_LIMIT
    || value.desiredConnectionLimit !== PRODUCTION_MAINTENANCE_NEW_LIMIT
    || value.prerequisitesVerificationSchema
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA
    || !SHA256_PATTERN.test(String(value.prerequisitesVerificationSha256))
    || !prerequisiteRunIdsExact
    || value.rootCaDerSha256 !== args.rootCaDerSha256
    || value.maximumWriteAttempts !== 1
    || value.retryAllowed !== false
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || createdAt === null
    || expiresAt === null
    || expiresAt.getTime() - createdAt.getTime() !== INTENT_MAXIMUM_AGE_MS
    || createdAt.getTime() > now.getTime() + MAXIMUM_CLOCK_SKEW_MS
    || now.getTime() - createdAt.getTime() > maximumAge
    || (args.phase !== "reconcile" && now.getTime() > expiresAt.getTime())
  ) fail("intent_invalid");
  return value as unknown as MaintenanceRoleLimitIntent;
}

function readPrerequisiteVerification(
  args: ParsedArguments,
  context: GithubContext,
  now: Date,
  readPrivateFile: (filename: string) => Buffer,
): {
  readonly verification: ProductionMaintenanceRoleLimitPrerequisitesVerification;
  readonly sha256: string;
} {
  if (
    args.phase === "reconcile"
    || args.prerequisitesVerificationFile === null
    || args.fenceRunId === null
    || args.deploymentRunId === null
  ) fail("prerequisite_invalid");
  let bytes: Buffer | null = null;
  try {
    bytes = readPrivateFile(args.prerequisitesVerificationFile);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const verification =
      parseProductionMaintenanceRoleLimitPrerequisitesVerification(source, {
        candidateSha: args.candidateSha,
        currentRunId: context.runId,
        fenceRunId: args.fenceRunId,
        deploymentRunId: args.deploymentRunId,
        now,
      });
    return { verification, sha256: sha256(source) };
  } catch {
    throw new MaintenanceRoleLimitError("prerequisite_invalid");
  } finally {
    bytes?.fill(0);
  }
}

function readPriorPrerequisiteVerificationBinding(
  args: ParsedArguments,
  intent: MaintenanceRoleLimitIntent,
  readPrivateFile: (filename: string) => Buffer,
): void {
  if (
    args.phase !== "reconcile"
    || args.prerequisitesVerificationFile === null
  ) fail("prerequisite_invalid");
  let bytes: Buffer | null = null;
  try {
    bytes = readPrivateFile(args.prerequisitesVerificationFile);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (sha256(source) !== intent.prerequisitesVerificationSha256) {
      fail("prerequisite_invalid");
    }
    const raw = JSON.parse(source) as unknown;
    if (
      typeof raw !== "object"
      || raw === null
      || Array.isArray(raw)
      || !("verifiedAt" in raw)
      || typeof raw.verifiedAt !== "string"
    ) {
      fail("prerequisite_invalid");
    }
    const historicalNow = validDate(raw.verifiedAt);
    if (historicalNow === null) fail("prerequisite_invalid");
    const verification =
      parseProductionMaintenanceRoleLimitPrerequisitesVerification(source, {
        candidateSha: args.candidateSha,
        currentRunId: intent.githubRunId,
        fenceRunId: intent.workerFenceRunId,
        deploymentRunId: intent.productionDeploymentRunId,
        now: historicalNow,
      });
    if (
      verification.policySha256 !== intent.policySha256
      || verification.workerFence.runId !== intent.workerFenceRunId
      || verification.productionDeployment.runId
        !== intent.productionDeploymentRunId
    ) fail("prerequisite_invalid");
  } catch (error) {
    if (error instanceof MaintenanceRoleLimitError) throw error;
    fail("prerequisite_invalid");
  } finally {
    bytes?.fill(0);
  }
}

function readReconciliationAuthorityBinding(
  args: ParsedArguments,
  context: GithubContext,
  intent: MaintenanceRoleLimitIntent,
  now: Date,
  readPrivateFile: (filename: string) => Buffer,
): void {
  if (
    args.phase !== "reconcile"
    || args.priorRunId === null
    || args.reconciliationAuthorityFile === null
  ) fail("prerequisite_invalid");
  let bytes: Buffer | null = null;
  try {
    bytes = readPrivateFile(args.reconciliationAuthorityFile);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const verification =
      parseProductionRoleLimitReconciliationAuthorityVerification(source, {
        candidateSha: args.candidateSha,
        currentRunId: context.runId,
        priorRoleRunId: args.priorRunId,
        now,
      });
    if (
      verification.schemaVersion
        !== PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_SCHEMA
      || verification.priorApply.intentSha256
        !== sha256(canonical(intent))
      || verification.priorApply.prerequisitesSha256
        !== intent.prerequisitesVerificationSha256
    ) fail("prerequisite_invalid");
  } catch (error) {
    if (error instanceof MaintenanceRoleLimitError) throw error;
    fail("prerequisite_invalid");
  } finally {
    bytes?.fill(0);
  }
}

function readPrivateText(
  filename: string,
  readPrivateFile: (path: string) => Buffer,
): string {
  const bytes = readPrivateFile(filename);
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      source.length < 1
      || source.length > 16_384
      || /[\u0000\r\n]/.test(source)
      || source !== source.trim()
    ) fail("credential_custody_invalid");
    return source;
  } catch (error) {
    if (error instanceof MaintenanceRoleLimitError) throw error;
    fail("credential_custody_invalid");
  } finally {
    bytes.fill(0);
  }
}

function validatePrivateFile(
  filename: string,
  readPrivateFile: (path: string) => Buffer,
): void {
  try {
    const bytes = readPrivateFile(filename);
    bytes.fill(0);
  } catch {
    fail("credential_custody_invalid");
  }
}

function parseAuthorityUrl(value: string): void {
  try {
    const parsed = postgresMigrationTargetInternals.validateTargetUrl(value);
    if (
      parsed.sourceUrlAuthority.hostname !== PRODUCTION_DATABASE_HOST
      || parsed.sourceUrlAuthority.port !== 5432
      || parsed.database !== PRODUCTION_DATABASE_NAME
      || parsed.user !== PRODUCTION_AUTHORITY_LOGIN
    ) fail("transport_invalid");
  } catch (error) {
    if (error instanceof MaintenanceRoleLimitError) throw error;
    fail("transport_invalid");
  }
}

function exactNonRootProcessIdentity(
  uid: number | undefined,
  euid: number | undefined,
): uid is number {
  return uid !== undefined
    && euid !== undefined
    && uid === euid
    && Number.isSafeInteger(uid)
    && uid > 0;
}

function catalogDigest(row: CatalogRow): string {
  return sha256(canonical(row));
}

function exactCatalogRow(
  result: QueryResult<CatalogRow>,
  expectedConnectionLimit: 2 | 8,
  now: Date,
): CatalogRow | null {
  if (result.rowCount !== 1 || result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  const observedAt = new Date(row.observedAt);
  const serverVersionNum = Number(row.serverVersionNum);
  return row.databaseName === PRODUCTION_DATABASE_NAME
    && row.sessionUser === PRODUCTION_AUTHORITY_LOGIN
    && row.currentUser === PRODUCTION_AUTHORITY_LOGIN
    && Number.isSafeInteger(serverVersionNum)
    && serverVersionNum >= 170_000
    && serverVersionNum < 180_000
    && Number.isFinite(observedAt.getTime())
    && Math.abs(observedAt.getTime() - now.getTime()) <= MAXIMUM_CLOCK_SKEW_MS
    && row.authorityRoleName === PRODUCTION_AUTHORITY_LOGIN
    && row.authorityCanLogin === true
    && row.authorityIsSuperuser === true
    && row.authorityCanCreateRole === true
    && row.loginRoleName === PRODUCTION_MAINTENANCE_LOGIN
    && row.loginCanLogin === true
    && row.loginIsSuperuser === false
    && row.loginCanCreateDatabase === false
    && row.loginCanCreateRole === false
    && row.loginInheritsPrivileges === false
    && row.loginCanReplicate === false
    && row.loginBypassesRls === false
    && row.loginConnectionLimit === expectedConnectionLimit
    && row.loginValidUntilNull === true
    && row.loginMembershipExact === true
    && row.loginChildrenAbsent === true
    && row.loginRoleSettingsAbsent === true
    && row.groupRoleName === PRODUCTION_MAINTENANCE_GROUP_ROLE
    && row.groupCanLogin === false
    && row.groupIsSuperuser === false
    && row.groupCanCreateDatabase === false
    && row.groupCanCreateRole === false
    && row.groupInheritsPrivileges === false
    && row.groupCanReplicate === false
    && row.groupBypassesRls === false
    && row.groupConnectionLimit === -1
    && row.groupValidUntilNull === true
    && row.groupParentsAbsent === true
    && row.groupSoleMemberExact === true
    && row.groupRoleSettingsAbsent === true
    ? row
    : null;
}

async function inspectCatalogReadOnly(
  connection: ProductionMaintenanceRoleLimitConnection,
): Promise<QueryResult<CatalogRow>> {
  await connection.assertExact();
  await connection.query(
    "/* pintpath:production-maintenance-role-limit:read-only-begin */ BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY",
  );
  try {
    await connection.query(
      "/* pintpath:production-maintenance-role-limit:read-only-timeouts */ SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '10s'",
    );
    const result = await connection.query<CatalogRow>(
      PRODUCTION_MAINTENANCE_ROLE_LIMIT_CATALOG_QUERY,
    );
    await connection.query(
      "/* pintpath:production-maintenance-role-limit:read-only-commit */ COMMIT",
    );
    await connection.assertExact();
    return result;
  } catch (error) {
    await connection.query(
      "/* pintpath:production-maintenance-role-limit:read-only-rollback */ ROLLBACK",
    ).catch(() => undefined);
    throw error;
  }
}

async function applySingleRoleLimitWrite(
  connection: ProductionMaintenanceRoleLimitConnection,
  now: Date,
  state: Checks,
  onBeforeAlter: () => void,
): Promise<void> {
  await connection.assertExact();
  await connection.query(
    "/* pintpath:production-maintenance-role-limit:write-begin */ BEGIN",
  );
  let committed = false;
  try {
    await connection.query(
      "/* pintpath:production-maintenance-role-limit:write-timeouts */ SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '10s'; SET LOCAL synchronous_commit = on",
    );
    const lock = await connection.query<{ readonly locked: boolean }>(
      PRODUCTION_MAINTENANCE_ROLE_LIMIT_ADVISORY_LOCK_QUERY,
      [ADVISORY_LOCK_CLASS_ID, ADVISORY_LOCK_OBJECT_ID],
    );
    state.advisoryLockExact = lock.rowCount === 1
      && lock.rows.length === 1
      && lock.rows[0]?.locked === true;
    if (!state.advisoryLockExact) fail("catalog_preflight_invalid");
    const immediatelyBefore = await connection.query<CatalogRow>(
      PRODUCTION_MAINTENANCE_ROLE_LIMIT_CATALOG_QUERY,
    );
    state.immediateCatalogPrewriteExact = exactCatalogRow(
      immediatelyBefore,
      PRODUCTION_MAINTENANCE_OLD_LIMIT,
      now,
    ) !== null;
    if (!state.immediateCatalogPrewriteExact) {
      fail("catalog_preflight_invalid");
    }
    onBeforeAlter();
    await connection.query(PRODUCTION_MAINTENANCE_ROLE_LIMIT_ALTER);
    const insideTransaction = await connection.query<CatalogRow>(
      PRODUCTION_MAINTENANCE_ROLE_LIMIT_CATALOG_QUERY,
    );
    if (
      exactCatalogRow(
        insideTransaction,
        PRODUCTION_MAINTENANCE_NEW_LIMIT,
        now,
      ) === null
    ) fail("mutation_uncertain");
    await connection.query(
      "/* pintpath:production-maintenance-role-limit:write-commit */ COMMIT",
    );
    committed = true;
    await connection.assertExact();
  } catch (error) {
    if (!committed) {
      await connection.query(
        "/* pintpath:production-maintenance-role-limit:write-rollback */ ROLLBACK",
      ).catch(() => undefined);
    }
    throw error;
  }
}

function defaultReadPrivateFile(filename: string): Buffer {
  return readTrustedRegularFile(filename, {
    minBytes: 1,
    maxBytes: MAXIMUM_PRIVATE_FILE_BYTES,
    requireOwner: true,
    requirePrivate: true,
  });
}

function defaultWriteEvidence(
  directory: string,
  leaf: string,
  source: string,
): string {
  try {
    writePrivateExclusiveFile(directory, leaf, source, {
      requireExactDirectoryMode: true,
      requireOwner: true,
    });
    return sha256(source);
  } catch {
    fail("evidence_invalid");
  }
}

async function defaultReassertRepository(
  cwd: string,
  candidateSha: string,
): Promise<boolean> {
  try {
    execFileSync(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ],
      { cwd, stdio: ["ignore", "ignore", "ignore"] },
    );
    const run = (arguments_: readonly string[]): string => execFileSync(
      "git",
      [...arguments_],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return run(["rev-parse", "HEAD"]) === candidateSha
      && run(["rev-parse", "refs/remotes/origin/main"]) === candidateSha
      && run(["status", "--porcelain=v2", "--untracked-files=all"]) === "";
  } catch {
    return false;
  }
}

class DirectProductionMaintenanceRoleLimitConnection
implements ProductionMaintenanceRoleLimitConnection {
  private constructor(
    private readonly client: Client,
    private readonly transport: PostgresRailwayStockLocalhostCaTransport,
  ) {}

  static async connect(
    input: ConnectionInput,
  ): Promise<DirectProductionMaintenanceRoleLimitConnection> {
    parseAuthorityUrl(input.targetUrl);
    const validated = postgresMigrationTargetInternals.validateTargetUrl(
      input.targetUrl,
    );
    const uid = process.getuid?.();
    const euid = process.geteuid?.();
    if (!exactNonRootProcessIdentity(uid, euid)) fail("transport_invalid");
    let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
    let client: Client | null = null;
    try {
      transport = await openPostgresRailwayStockLocalhostCaTransport({
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaFile: input.rootCaFile,
        expectedRootCaDerSha256: input.expectedRootCaDerSha256,
        expectedUid: uid,
        sourceUrlAuthority: validated.sourceUrlAuthority,
      });
      const config: ClientConfig = {
        application_name: "pintpath-production-maintenance-role-limit",
        connectionTimeoutMillis: 10_000,
        database: validated.database,
        host: transport.nodeConnection.host,
        options: "-c search_path=pg_catalog -c row_security=on -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=10000 -c synchronous_commit=on",
        password: validated.password,
        port: transport.nodeConnection.port,
        query_timeout: 10_000,
        ssl: transport.nodeConnection.ssl,
        user: validated.user,
      };
      if (Object.hasOwn(config, "connectionString")) fail("transport_invalid");
      client = new Client(config);
      await client.connect();
      const connection = new DirectProductionMaintenanceRoleLimitConnection(
        client,
        transport,
      );
      await connection.assertExact();
      return connection;
    } catch {
      if (client) await client.end().catch(() => undefined);
      if (transport) await transport.close().catch(() => undefined);
      fail("transport_invalid");
    }
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    await this.assertExact();
    const result = await this.client.query<Row>(text, [...values]);
    await this.assertExact();
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async assertExact(): Promise<void> {
    await this.transport.assertExact();
    if (
      this.transport.profile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
      || this.transport.sourceUrlAuthority.hostname
        !== PRODUCTION_DATABASE_HOST
      || this.transport.sourceUrlAuthority.port !== 5432
      || this.transport.resolvedAddress !== this.transport.nodeConnection.host
      || !this.transport.resolvedAddress.toLowerCase().startsWith("fd12:")
      || this.transport.nodeConnection.port !== 5432
      || this.transport.nodeConnection.ssl.servername !== "localhost"
      || this.transport.nodeConnection.ssl.rejectUnauthorized !== true
      || this.transport.nodeConnection.ssl.minVersion !== "TLSv1.2"
      || this.transport.nodeConnection.ssl.checkServerIdentity
        !== checkPostgresRailwayStockLocalhostServerIdentity
    ) fail("transport_invalid");
  }

  async close(): Promise<void> {
    let exact = true;
    try {
      await this.client.end();
    } catch {
      exact = false;
    }
    try {
      await this.transport.close();
    } catch {
      exact = false;
    }
    if (!exact) fail("transport_invalid");
  }
}

function writePreparedIntent(
  args: ParsedArguments,
  context: GithubContext,
  dependencies: Dependencies,
): 0 {
  const now = dependencies.now();
  const prerequisite = readPrerequisiteVerification(
    args,
    context,
    now,
    dependencies.readPrivateFile,
  );
  const intent = buildIntent(
    args,
    context,
    now,
    prerequisite.verification,
    prerequisite.sha256,
  );
  const source = canonical(intent);
  const intentSha256 = dependencies.writeEvidence(
    args.evidenceDirectory,
    "intent.json",
    source,
  );
  if (intentSha256 !== sha256(source)) fail("evidence_invalid");
  dependencies.writeOutput(`${JSON.stringify({
    ok: true,
    phase: "prepare",
    candidateSha: args.candidateSha,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    intentSha256,
    prerequisitesVerificationSha256: prerequisite.sha256,
    workerFenceRunId: prerequisite.verification.workerFence.runId,
    productionDeploymentRunId:
      prerequisite.verification.productionDeployment.runId,
  })}\n`);
  return 0;
}

function failureCode(error: unknown): FailureCode {
  return error instanceof MaintenanceRoleLimitError
    ? error.code
    : "mutation_uncertain";
}

function buildReceiptPayload(input: {
  readonly args: ParsedArguments;
  readonly context: GithubContext;
  readonly outcome: string;
  readonly failure: FailureCode | null;
  readonly intentSha256: string | null;
  readonly prerequisitesVerificationSha256: string | null;
  readonly workerFenceRunId: string | null;
  readonly productionDeploymentRunId: string | null;
  readonly attempts: 0 | 1;
  readonly preflightCatalogSha256: string | null;
  readonly postflightCatalogSha256: string | null;
  readonly terminalEvidenceSha256: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly state: Checks;
}): Record<string, unknown> {
  return {
    schemaVersion: RECEIPT_SCHEMA,
    policyId: POLICY_ID,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    phase: input.args.phase,
    outcome: input.outcome,
    failureCode: input.failure,
    candidateSha: input.args.candidateSha,
    repository: input.context.repository,
    workflowPath: input.context.workflowPath,
    githubEnvironment: input.context.githubEnvironment,
    githubRunId: input.context.runId,
    githubRunAttempt: input.context.runAttempt,
    targetEnvironment: "production",
    databaseHost: PRODUCTION_DATABASE_HOST,
    databasePort: 5432,
    databaseName: PRODUCTION_DATABASE_NAME,
    authorityLogin: PRODUCTION_AUTHORITY_LOGIN,
    loginRole: PRODUCTION_MAINTENANCE_LOGIN,
    groupRole: PRODUCTION_MAINTENANCE_GROUP_ROLE,
    expectedOldConnectionLimit: PRODUCTION_MAINTENANCE_OLD_LIMIT,
    desiredConnectionLimit: PRODUCTION_MAINTENANCE_NEW_LIMIT,
    rootCaDerSha256: input.args.rootCaDerSha256,
    intentSha256: input.intentSha256,
    prerequisitesVerificationSha256:
      input.prerequisitesVerificationSha256,
    workerFenceRunId: input.workerFenceRunId,
    productionDeploymentRunId: input.productionDeploymentRunId,
    terminalEvidenceSha256: input.terminalEvidenceSha256,
    preflightCatalogSha256: input.preflightCatalogSha256,
    postflightCatalogSha256: input.postflightCatalogSha256,
    writeAttempts: input.attempts,
    maximumWriteAttempts: 1,
    retryAllowed: false,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    checks: input.state,
  };
}

async function executeOperation(
  args: ParsedArguments,
  context: GithubContext,
  dependencies: Dependencies,
): Promise<0 | 1> {
  const state = checks();
  state.policyExact = true;
  state.githubContextExact = true;
  state.ambientPostgresAuthorityAbsent = true;
  const startedAt = dependencies.now().toISOString();
  let intentSha256: string | null = null;
  let prerequisitesVerificationSha256: string | null = null;
  let workerFenceRunId: string | null = null;
  let productionDeploymentRunId: string | null = null;
  const writeState: { attempts: 0 | 1 } = { attempts: 0 };
  let preflightCatalogSha256: string | null = null;
  let postflightCatalogSha256: string | null = null;
  let terminalEvidenceSha256: string | null = null;
  let outcome = "failed_before_write";
  let failure: FailureCode | null = null;
  let targetUrl = "";
  let connection: ProductionMaintenanceRoleLimitConnection | null = null;
  let primaryConnectionOpened = false;
  let mutationAcknowledged = false;
  let postflight: CatalogRow | null = null;

  try {
    if (!args.intentFile || !args.credentialFile || !args.rootCaFile) {
      fail("argument_invalid");
    }
    const intentSource = new TextDecoder("utf-8", { fatal: true }).decode(
      dependencies.readPrivateFile(args.intentFile),
    );
    const intent = parseIntent(
      intentSource,
      args,
      context,
      dependencies.now(),
    );
    intentSha256 = sha256(intentSource);
    state.intentExact = true;
    state.priorIntentRequiredForAlreadyDesired = args.phase === "reconcile";
    state.prerequisiteIntentBindingExact = true;
    prerequisitesVerificationSha256 = intent.prerequisitesVerificationSha256;
    workerFenceRunId = intent.workerFenceRunId;
    productionDeploymentRunId = intent.productionDeploymentRunId;

    if (args.phase === "apply") {
      const prerequisite = readPrerequisiteVerification(
        args,
        context,
        dependencies.now(),
        dependencies.readPrivateFile,
      );
      state.prerequisiteVerificationExact =
        prerequisite.sha256 === intent.prerequisitesVerificationSha256
        && prerequisite.verification.workerFence.runId
          === intent.workerFenceRunId
        && prerequisite.verification.productionDeployment.runId
          === intent.productionDeploymentRunId;
      if (!state.prerequisiteVerificationExact) fail("prerequisite_invalid");
    } else {
      readPriorPrerequisiteVerificationBinding(
        args,
        intent,
        dependencies.readPrivateFile,
      );
      readReconciliationAuthorityBinding(
        args,
        context,
        intent,
        dependencies.now(),
        dependencies.readPrivateFile,
      );
      state.prerequisiteVerificationExact = true;
    }

    state.repositoryPreflightExact = await dependencies.reassertRepository(
      dependencies.cwd,
      args.candidateSha,
    );
    if (!state.repositoryPreflightExact) fail("repository_state_invalid");

    targetUrl = readPrivateText(args.credentialFile, dependencies.readPrivateFile);
    validatePrivateFile(args.rootCaFile, dependencies.readPrivateFile);
    parseAuthorityUrl(targetUrl);
    state.credentialCustodyExact = true;

    connection = await dependencies.connect({
      targetUrl,
      rootCaFile: args.rootCaFile,
      expectedRootCaDerSha256: args.rootCaDerSha256,
    });
    primaryConnectionOpened = true;
    await connection.assertExact();
    state.transportExact = true;
    const preflightResult = await inspectCatalogReadOnly(connection);
    const reconciliationAtNewLimit = args.phase === "reconcile"
      ? exactCatalogRow(
          preflightResult,
          PRODUCTION_MAINTENANCE_NEW_LIMIT,
          dependencies.now(),
        )
      : null;
    const reconciliationAtOldLimit = args.phase === "reconcile"
      ? exactCatalogRow(
          preflightResult,
          PRODUCTION_MAINTENANCE_OLD_LIMIT,
          dependencies.now(),
        )
      : null;
    const preflight = args.phase === "reconcile"
      ? reconciliationAtNewLimit ?? reconciliationAtOldLimit
      : exactCatalogRow(
          preflightResult,
          PRODUCTION_MAINTENANCE_OLD_LIMIT,
          dependencies.now(),
        );
    state.catalogPreflightExact = preflight !== null;
    if (!preflight) fail("catalog_preflight_invalid");
    preflightCatalogSha256 = catalogDigest(preflight);

    if (args.phase === "reconcile") {
      outcome = reconciliationAtNewLimit
        ? "reconciled_from_prior_intent"
        : "not_applied_after_prior_intent";
      state.catalogPostflightExact = true;
      postflightCatalogSha256 = preflightCatalogSha256;
    } else {
      state.repositoryPrewriteExact = await dependencies.reassertRepository(
        dependencies.cwd,
        args.candidateSha,
      );
      if (!state.repositoryPrewriteExact) fail("repository_state_invalid");
      await applySingleRoleLimitWrite(
        connection,
        dependencies.now(),
        state,
        () => {
          if (writeState.attempts !== 0) {
            state.oneAlterRoleAtMost = false;
            fail("mutation_uncertain");
          }
          writeState.attempts = 1;
        },
      );
      mutationAcknowledged = true;
    }
  } catch (error) {
    failure = failureCode(error);
    if (writeState.attempts === 1) outcome = "mutation_uncertain";
  } finally {
    if (connection) {
      try {
        await connection.close();
        state.primaryConnectionCleanupExact = true;
      } catch {
        state.primaryConnectionCleanupExact = false;
      }
      connection = null;
    }
    if (writeState.attempts === 1) {
      state.postflightAttempted = true;
      try {
        const reconciliation = await dependencies.connect({
          targetUrl,
          rootCaFile: args.rootCaFile!,
          expectedRootCaDerSha256: args.rootCaDerSha256,
        });
        state.postflightConnectionCleanupExact = false;
        try {
          await reconciliation.assertExact();
          const result = await inspectCatalogReadOnly(reconciliation);
          postflight = exactCatalogRow(
            result,
            PRODUCTION_MAINTENANCE_NEW_LIMIT,
            dependencies.now(),
          );
        } finally {
          try {
            await reconciliation.close();
            state.postflightConnectionCleanupExact = true;
          } catch {
            state.postflightConnectionCleanupExact = false;
          }
        }
      } catch {
        postflight = null;
      }
      state.catalogPostflightExact = postflight !== null;
      if (postflight) postflightCatalogSha256 = catalogDigest(postflight);
      if (
        state.catalogPostflightExact
        && state.primaryConnectionCleanupExact
        && state.postflightConnectionCleanupExact
      ) {
        outcome = mutationAcknowledged
          ? "updated"
          : "reconciled_after_ambiguous_write";
        failure = null;
      } else {
        outcome = "mutation_uncertain";
        failure = "mutation_uncertain";
      }
    } else if (
      primaryConnectionOpened
      && !state.primaryConnectionCleanupExact
    ) {
      outcome = "failed_before_write";
      failure = "transport_invalid";
    }
  }

  const completedAt = dependencies.now().toISOString();
  const terminalSource = canonical({
    schemaVersion: TERMINAL_SCHEMA,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: args.candidateSha,
    phase: args.phase,
    outcome,
    failureCode: failure,
    intentSha256,
    prerequisitesVerificationSha256,
    workerFenceRunId,
    productionDeploymentRunId,
    writeAttempts: writeState.attempts,
    retryAllowed: false,
    preflightCatalogSha256,
    postflightCatalogSha256,
    startedAt,
    completedAt,
    secretMaterialIncluded: false,
  });
  try {
    terminalEvidenceSha256 = dependencies.writeEvidence(
      args.evidenceDirectory,
      "terminal.json",
      terminalSource,
    );
    state.terminalEvidenceExact = terminalEvidenceSha256
      === sha256(terminalSource);
    if (!state.terminalEvidenceExact) {
      outcome = writeState.attempts === 1
        ? "mutation_uncertain"
        : "failed_before_write";
      failure = "evidence_invalid";
    }
  } catch {
    state.terminalEvidenceExact = false;
    outcome = writeState.attempts === 1
      ? "mutation_uncertain"
      : "failed_before_write";
    failure = "evidence_invalid";
  }

  state.receiptEvidenceExact = true;
  const receiptPayload = buildReceiptPayload({
    args,
    context,
    outcome,
    failure,
    intentSha256,
    prerequisitesVerificationSha256,
    workerFenceRunId,
    productionDeploymentRunId,
    attempts: writeState.attempts,
    preflightCatalogSha256,
    postflightCatalogSha256,
    terminalEvidenceSha256,
    startedAt,
    completedAt,
    state,
  });
  const receiptSha256 = sha256(canonical(receiptPayload));
  const receiptSource = canonical({ ...receiptPayload, receiptSha256 });
  try {
    const written = dependencies.writeEvidence(
      args.evidenceDirectory,
      "receipt.json",
      receiptSource,
    );
    state.receiptEvidenceExact = written === sha256(receiptSource);
    if (!state.receiptEvidenceExact) failure = "evidence_invalid";
  } catch {
    state.receiptEvidenceExact = false;
    failure = "evidence_invalid";
  }

  targetUrl = "";
  const successful = [
    "updated",
    "reconciled_after_ambiguous_write",
    "reconciled_from_prior_intent",
    "not_applied_after_prior_intent",
  ].includes(outcome)
    && state.terminalEvidenceExact
    && state.receiptEvidenceExact;
  dependencies.writeOutput(`${JSON.stringify({
    ok: successful,
    phase: args.phase,
    outcome,
    failureCode: successful ? null : failure,
    candidateSha: args.candidateSha,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    intentSha256,
    prerequisitesVerificationSha256,
    workerFenceRunId,
    productionDeploymentRunId,
    receiptSha256,
    writeAttempts: writeState.attempts,
    retryAllowed: false,
  })}\n`);
  return successful ? 0 : 1;
}

export async function runProtectedProductionMaintenanceRoleLimit(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    connect: DirectProductionMaintenanceRoleLimitConnection.connect,
    reassertRepository: defaultReassertRepository,
    readPrivateFile: defaultReadPrivateFile,
    writeEvidence: defaultWriteEvidence,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  try {
    const args = parseArguments(dependencies.argv);
    validatePolicy(dependencies.cwd);
    if (hasAmbientPostgresAuthority(dependencies.env)) {
      fail("ambient_postgres_authority_present");
    }
    const context = githubContext(
      args.phase,
      args.candidateSha,
      dependencies.env,
    );
    if (args.phase === "prepare") {
      return writePreparedIntent(args, context, dependencies);
    }
    return executeOperation(args, context, dependencies);
  } catch (error) {
    dependencies.writeOutput(`${JSON.stringify({
      ok: false,
      outcome: "blocked",
      failureCode: failureCode(error),
      writeAttempts: 0,
      retryAllowed: false,
    })}\n`);
    return 1;
  }
}

export const protectedProductionMaintenanceRoleLimitInternals = {
  parseArguments,
  validatePolicy,
  hasAmbientPostgresAuthority,
  githubContext,
  buildIntent,
  parseIntent,
  parseAuthorityUrl,
  exactNonRootProcessIdentity,
  exactCatalogRow,
  inspectCatalogReadOnly,
  applySingleRoleLimitWrite,
};

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProtectedProductionMaintenanceRoleLimit();
}
