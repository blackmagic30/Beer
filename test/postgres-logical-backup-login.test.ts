import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parsePostgresLogicalBackupLoginOptions,
  runPostgresLogicalBackupLoginCli,
} from "../scripts/manage-postgres-logical-backup-login.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT,
  POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT_ENV,
  POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE,
  POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
  POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV,
  POSTGRES_LOGICAL_BACKUP_LOGIN_OPERATION_ENV,
  POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_DISABLED_FILE,
  POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
  PostgresLogicalBackupLoginError,
  createPostgresLogicalBackupLoginScramVerifier,
  managePostgresLogicalBackupLogin,
  postgresLogicalBackupLoginMutationArm,
  type PostgresLogicalBackupLoginConnection,
  type PostgresLogicalBackupLoginDependencies,
  type PostgresLogicalBackupLoginManagerOptions,
} from "../src/lib/postgres-logical-backup-login.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const temporaryDirectories: string[] = [];
const uid = process.getuid?.() ?? 501;
const headSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const databaseOid = "16655";
const databaseName = "pintpath";
const systemIdentifier = "7568999345281279000";
const serverVersionNum = "170010";
const loginVersion = "2026081001";
const groupRole = `pintpath_logical_backup_d${databaseOid}`;
const loginRole = `${groupRole}_v${loginVersion}`;
const adminPassword = "admin-secret-must-never-escape";
const adminUrl = `postgresql://postgres:${adminPassword}@db.example.invalid:5432/${databaseName}?sslmode=verify-full`;
const rootCaPem = "-----BEGIN CERTIFICATE-----\nunit-test-held-root-ca\n-----END CERTIFICATE-----\n";
const rootCaDerSha256 = "c".repeat(64);
const receiptKeys = [
  "schemaVersion", "kind", "operation", "status", "createdAt", "operationId",
  "approvalReference", "expectedEnvironment", "executorUid", "mutationArm",
  "headSha", "treeSha", "nodeVersion", "adminUrlSha256", "transportProfile",
  "rootCaDerSha256",
  "databaseIdentitySha256", "databaseOid", "databaseNameSha256", "loginVersion",
  "loginRole", "loginRoleOid", "groupRole", "marker", "markerSha256",
  "escrowIntentSha256", "escrowUrlSha256", "loggerInventorySha256",
  "authorityPolicyCount", "authorityDependencyCount", "canary",
  "provisionReceiptSha256", "retireIntentSha256", "retireDisabledSha256",
].sort();

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const databaseIdentitySha256 = sha256(canonicalPostgresBackupJson({
  kind: "pintpath-postgres-logical-source-database",
  version: 1,
  systemIdentifier,
  databaseOid,
  databaseName,
  serverVersionNum,
}));

function temporaryDirectory(): string {
  const created = fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-backup-login-test-"),
  );
  const directory = fs.realpathSync(created);
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeAdminFile(root: string, value = adminUrl, mode = 0o600): string {
  const file = path.join(root, "admin-url.key");
  fs.writeFileSync(file, `${value}\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function writeRootCaFile(root: string, mode = 0o600): string {
  const file = path.join(root, "railway-stock-root-ca.pem");
  fs.writeFileSync(file, rootCaPem, { mode });
  fs.chmodSync(file, mode);
  return file;
}

type LeafHandleFault = "stat" | "write" | "chmod" | "sync" | "read";

function failFirstOpenedLeafMethod(
  leafName: string,
  method: LeafHandleFault,
  beforeFailure?: (filePath: string) => void,
): void {
  const originalOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation((async (
    filePath: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    const handle = await originalOpen(filePath, flags, mode);
    if (String(filePath).endsWith(`${path.sep}${leafName}`)) {
      const methods = handle as unknown as Record<
        LeafHandleFault,
        (...args: readonly unknown[]) => Promise<unknown>
      >;
      const original = methods[method].bind(handle);
      let failed = false;
      Object.defineProperty(handle, method, {
        configurable: true,
        value: async (...args: readonly unknown[]) => {
          if (!failed) {
            failed = true;
            beforeFailure?.(String(filePath));
            throw new Error(`forced-${method}-failure`);
          }
          return original(...args);
        },
      });
    }
    return handle;
  }) as typeof fs.promises.open);
}

function captureOpenedHandles(): FileHandle[] {
  const handles: FileHandle[] = [];
  const originalOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation((async (
    filePath: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    const handle = await originalOpen(filePath, flags, mode);
    handles.push(handle);
    return handle;
  }) as typeof fs.promises.open);
  return handles;
}

function captureUrlReadAndFailIntentOpen(
  urlPath: string,
  intentPath: string,
): () => Buffer | null {
  const originalOpen = fs.promises.open.bind(fs.promises);
  let captured: Buffer | null = null;
  vi.spyOn(fs.promises, "open").mockImplementation((async (
    filePath: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    if (String(filePath) === intentPath) throw new Error("forced-intent-open-failure");
    const handle = await originalOpen(filePath, flags, mode);
    if (String(filePath) === urlPath) {
      const originalRead = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: async (...args: Parameters<FileHandle["read"]>) => {
          if (Buffer.isBuffer(args[0]) && args[0].byteLength > 1) captured = args[0];
          return originalRead(...args);
        },
      });
    }
    return handle;
  }) as typeof fs.promises.open);
  return () => captured;
}

async function expectHandlesClosed(handles: readonly FileHandle[]): Promise<void> {
  expect(handles.length).toBeGreaterThan(0);
  for (const handle of handles) {
    await expect(handle.stat()).rejects.toBeDefined();
  }
}

function provisionOptions(root: string): PostgresLogicalBackupLoginManagerOptions {
  return {
    operation: "provision",
    adminConnectionFile: writeAdminFile(root),
    expectedAdminUrlSha256: sha256(adminUrl),
    transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaFile: writeRootCaFile(root),
    expectedRootCaDerSha256: rootCaDerSha256,
    expectedDatabaseIdentitySha256: databaseIdentitySha256,
    expectedHeadSha: headSha,
    expectedTreeSha: treeSha,
    expectedUid: uid,
    expectedNodeVersion: process.version,
    expectedEnvironment: POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT,
    operationId: "provision-20260810-a",
    approvalReference: "approval:backup-login:20260810",
    loginVersion,
    escrowDirectory: path.join(root, "escrow"),
    receiptFile: path.join(root, "provision-receipt.json"),
  };
}

function retireOptions(
  provision: PostgresLogicalBackupLoginManagerOptions,
  provisionReceiptSha256: string,
): PostgresLogicalBackupLoginManagerOptions {
  return {
    ...provision,
    operation: "retire",
    operationId: "retire-20260810-a",
    approvalReference: "approval:backup-retire:20260810",
    receiptFile: path.join(path.dirname(provision.receiptFile), "retire-receipt.json"),
    provisionReceiptFile: provision.receiptFile,
    expectedProvisionReceiptSha256: provisionReceiptSha256,
  };
}

interface FakeCandidate {
  exists: boolean;
  oid: string;
  marker: string | null;
  canLogin: boolean;
  hasPassword: boolean;
  membership: boolean;
  databasePrivilege: boolean;
  functionPrivilege: boolean;
  validUntilIsNull: boolean;
}

class FakeRailwayTransport implements PostgresRailwayStockLocalhostCaTransport {
  readonly profile = POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
  readonly rootCaDerSha256: string;
  readonly sourceUrlAuthority: { readonly hostname: string; readonly port: number };
  readonly resolvedAddress = "fd12:3456:789a::10";
  readonly temporaryDirectory = "/private/var/folders/unit/transport";
  readonly passwordFileDirectory = "/private/var/folders/unit/transport/pgpass";
  readonly passwordFileHost = "localhost" as const;
  readonly nodeConnection = {
    host: this.resolvedAddress,
    port: 5_432 as const,
    ssl: {
      ca: rootCaPem,
      servername: "localhost" as const,
      rejectUnauthorized: true as const,
      minVersion: "TLSv1.2" as const,
      checkServerIdentity: () => undefined,
    },
  };
  readonly libpqEnvironment = {
    PGHOST: "localhost" as const,
    PGHOSTADDR: this.resolvedAddress,
    PGPORT: "5432" as const,
    PGSSLMODE: "verify-full" as const,
    PGSSLROOTCERT: "/private/var/folders/unit/transport/root.crt",
    PGSSLMINPROTOCOLVERSION: "TLSv1.2" as const,
    PGSSLSNI: "1" as const,
  };
  assertCount = 0;
  closeCount = 0;
  failAssertAt = 0;
  failCloseCount = 0;

  constructor(options: PostgresLogicalBackupLoginManagerOptions) {
    this.rootCaDerSha256 = options.expectedRootCaDerSha256;
    const parsed = new URL(adminUrl);
    this.sourceUrlAuthority = {
      hostname: parsed.hostname,
      port: Number(parsed.port),
    };
  }

  async assertExact(): Promise<void> {
    this.assertCount += 1;
    if (this.assertCount === this.failAssertAt) throw new Error("forced-transport-drift");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeCount <= this.failCloseCount) throw new Error("forced-close-ambiguity");
  }
}

class FakePostgres {
  readonly statements: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly configs: Array<Record<string, unknown>> = [];
  readonly boundVerifiers: string[] = [];
  connectionCloseCount = 0;
  pgauditInstalled = false;
  canaryAuthenticationMethod: "scram-sha-256" | "other" = "scram-sha-256";
  groupExists = true;
  groupPolicyCount = 236;
  groupDependencyCount = 61;
  candidateExtraDependencyCount = 0;
  failCommitNumber = 0;
  commitCount = 0;
  mutationObserver: (() => void) | null = null;
  connectObserver: (() => void) | null = null;
  candidate: FakeCandidate = {
    exists: false,
    oid: "24680",
    marker: null,
    canLogin: false,
    hasPassword: false,
    membership: false,
    databasePrivilege: false,
    functionPrivilege: false,
    validUntilIsNull: true,
  };

  connect = async (config: Record<string, unknown>): Promise<PostgresLogicalBackupLoginConnection> => {
    this.connectObserver?.();
    this.configs.push(config);
    const canary = config.user === loginRole;
    return {
      authenticationMethod: canary ? this.canaryAuthenticationMethod : "unknown",
      close: async () => { this.connectionCloseCount += 1; },
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) => this.query<Row>(text, values, canary),
    };
  };

  private groupRow(roleName: string): Record<string, unknown> {
    const children = this.candidate.membership ? 1 : 0;
    const scoped = this.candidate.exists ? 1 : 0;
    return {
      roleName,
      canLogin: false,
      hasPassword: false,
      validUntilIsNull: true,
      inheritsPrivileges: false,
      connectionLimit: -1,
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      parentMembershipCount: 0,
      childMembershipCount: children,
      exactChildMembershipCount: children,
      scopedLoginCount: scoped,
      reservedLoginNamespaceCount: scoped,
      directDatabasePrivilegeCount: 0,
      directFunctionPrivilegeCount: 0,
      roleSettingCount: 0,
      ownedCurrentDatabaseObjectCount: 0,
      sharedDependencyCount: this.groupDependencyCount,
      exactSharedDependencyCount: this.groupDependencyCount,
      privateSchemaCount: 2,
      directSchemaPrivilegeCount: 2,
      exactSchemaPrivilegeCount: 2,
      privateRelationCount: 59,
      forceRlsRelationCount: 59,
      directRelationPrivilegeCount: 59,
      exactRelationPrivilegeCount: 59,
      privateSequenceCount: 0,
      directColumnPrivilegeCount: 0,
      executablePrivateFunctionCount: 0,
      privatePolicyCount: this.groupPolicyCount,
      exactBasePolicyCount: 177,
      exactBackupPolicyCount: 59,
      unsafePublicPolicyCount: 0,
      unsafeReservedPolicyCount: 0,
      directScopedPolicyCount: 0,
    };
  }

  private candidateRow(): Record<string, unknown> {
    const granted = this.candidate.databasePrivilege ? 1 : 0;
    const routine = this.candidate.functionPrivilege ? 1 : 0;
    const membership = this.candidate.membership ? 1 : 0;
    return {
      oid: this.candidate.oid,
      marker: this.candidate.marker,
      canLogin: this.candidate.canLogin,
      hasPassword: this.candidate.hasPassword,
      inheritsPrivileges: false,
      connectionLimit: 2,
      validUntilIsNull: this.candidate.validUntilIsNull,
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      parentMembershipCount: membership,
      childMembershipCount: 0,
      exactMembershipCount: membership,
      directDatabasePrivilegeCount: granted,
      exactDatabasePrivilegeCount: granted,
      directFunctionPrivilegeCount: routine,
      exactFunctionPrivilegeCount: routine,
      directPrivateObjectPrivilegeCount: 0,
      ownedPrivateObjectCount: 0,
      roleSettingCount: 0,
      sharedDependencyCount: granted + routine + this.candidateExtraDependencyCount,
      exactSharedDependencyCount: granted + routine,
    };
  }

  private async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
    canary: boolean,
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.statements.push({ text, values });
    const rows = (value: Record<string, unknown>[]): { rows: Row[]; rowCount: number } => ({
      rows: value as Row[],
      rowCount: value.length,
    });
    if (text.includes("backup-login:advisory-lock")) return rows([{ acquired: true }]);
    if (text.includes("backup-login:lock-verify")) return rows([{ held: true }]);
    if (text.includes("backup-login:source-identity")) return rows([{
      systemIdentifier,
      databaseOid,
      databaseName,
      serverVersionNum,
      adminRole: "postgres",
      currentRole: "postgres",
      adminCanLogin: true,
      adminSuperuser: true,
      transactionReadOnly: false,
      inRecovery: false,
    }]);
    if (text.includes("backup-login:logger-inventory")) return rows([{
      sharedPreloadLibraries: "",
      sessionPreloadLibraries: "",
      localPreloadLibraries: "",
      pgauditInstalled: this.pgauditInstalled,
      pgStatStatementsLoaded: false,
      autoExplainLoaded: false,
    }]);
    if (text.includes("backup-login:logger-guards-verify")) return rows([{
      logStatement: "none",
      logMinDurationStatement: "-1",
      logDuration: "off",
      logMinErrorStatement: "panic",
      logParameterMaxLength: "0",
      logParameterMaxLengthOnError: "0",
      logErrorVerbosity: "terse",
      logStatementStats: "off",
      logParserStats: "off",
      logPlannerStats: "off",
      logExecutorStats: "off",
      debugPrintParse: "off",
      debugPrintRewritten: "off",
      debugPrintPlan: "off",
      logMinDurationSample: "-1",
      logStatementSampleRate: "0",
      logTransactionSampleRate: "0",
      passwordEncryption: "scram-sha-256",
      pgStatStatementsTrack: null,
      autoExplainLogMinDuration: null,
      autoExplainLogNestedStatements: null,
    }]);
    if (text.includes("backup-login:logger-guards")) return rows([]);
    if (text.includes("backup-login:group-authority")) {
      return rows(this.groupExists ? [this.groupRow(String(values[0]))] : []);
    }
    if (text.includes("backup-login:candidate-state")) {
      return rows(this.candidate.exists ? [this.candidateRow()] : []);
    }
    if (text.includes("backup-login:create-candidate")) {
      this.mutationObserver?.();
      this.candidate.exists = true;
      return rows([]);
    }
    if (text.includes("FROM pg_catalog.pg_roles AS role") && text.includes("role.oid::text")) {
      return rows([{ oid: this.candidate.oid }]);
    }
    if (text.includes("backup-login:mark-candidate")) {
      this.candidate.marker = text.match(/ IS '([^']+)'/)?.[1] ?? null;
      return rows([]);
    }
    if (text.includes("backup-login:grant-connect")) {
      this.candidate.databasePrivilege = true;
      return rows([]);
    }
    if (text.includes("backup-login:grant-control-system")) {
      this.candidate.functionPrivilege = true;
      return rows([]);
    }
    if (text.includes("backup-login:grant-group")) {
      this.candidate.membership = true;
      return rows([]);
    }
    if (text.includes("backup-login:create-verifier-function")) return rows([]);
    if (text.includes("backup-login:bind-verifier")) {
      this.boundVerifiers.push(String(values[2]));
      this.candidate.hasPassword = true;
      return rows([]);
    }
    if (text.includes("backup-login:enable-last")) {
      this.candidate.canLogin = true;
      return rows([]);
    }
    if (/^\s*ALTER ROLE .* NOLOGIN/.test(text)) {
      this.candidate.canLogin = false;
      return rows([]);
    }
    if (/^\s*ALTER ROLE .* PASSWORD NULL/.test(text)) {
      this.candidate.hasPassword = false;
      return rows([]);
    }
    if (/^\s*REVOKE .* FROM /.test(text) && !text.includes("CONNECT") && !text.includes("EXECUTE")) {
      this.candidate.membership = false;
      return rows([]);
    }
    if (text.includes("REVOKE CONNECT")) {
      this.candidate.databasePrivilege = false;
      return rows([]);
    }
    if (text.includes("REVOKE EXECUTE")) {
      this.candidate.functionPrivilege = false;
      return rows([]);
    }
    if (text.includes("backup-login:terminate-sessions")) return rows([]);
    if (text.includes('AS "survivorCount"')) return rows([{ survivorCount: 0 }]);
    if (/^\s*DROP ROLE /.test(text)) {
      this.candidate.exists = false;
      return rows([]);
    }
    if (canary && text.includes("backup-login:read-only-canary")) return rows([{
      sessionRole: loginRole,
      effectiveRole: groupRole,
      transactionReadOnly: true,
      rowsObserved: 1,
    }]);
    if (/^\s*COMMIT\s*$/.test(text)) {
      this.commitCount += 1;
      if (this.commitCount === this.failCommitNumber) throw new Error("uncertain_commit");
      return rows([]);
    }
    return rows([]);
  }
}

function dependencies(
  options: PostgresLogicalBackupLoginManagerOptions,
  database: FakePostgres,
  transport = new FakeRailwayTransport(options),
): Partial<PostgresLogicalBackupLoginDependencies> {
  return {
    env: {
      NODE_ENV: "production",
      [POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT_ENV]: options.expectedEnvironment,
      [POSTGRES_LOGICAL_BACKUP_LOGIN_OPERATION_ENV]: options.operation,
      [POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV]:
        postgresLogicalBackupLoginMutationArm(options),
    },
    getUid: () => uid,
    getEuid: () => uid,
    nodeVersion: process.version,
    now: () => new Date("2026-08-10T01:02:03.004Z"),
    randomBytes: (size) => Buffer.alloc(size, size === 48 ? 0xab : 0xcd),
    repositoryRoot: process.cwd(),
    inspectRepository: async () => ({
      headSha,
      treeSha,
      upstreamSha: headSha,
      clean: true,
      root: fs.realpathSync(process.cwd()),
      coreRepositoryFormatVersion: "0",
      coreBare: "false",
      hooksPathAbsent: true,
      fsmonitorAbsentOrFalse: true,
    }),
    connect: database.connect,
    openTransport: async (openOptions: OpenPostgresRailwayStockLocalhostCaTransportOptions) => {
      expect(openOptions).toEqual({
        profile: options.transportProfile,
        rootCaFile: options.rootCaFile,
        expectedRootCaDerSha256: options.expectedRootCaDerSha256,
        expectedUid: options.expectedUid,
        sourceUrlAuthority: { hostname: "db.example.invalid", port: 5_432 },
      });
      return transport;
    },
  };
}

function expectOnlyHeldTransportConfigs(database: FakePostgres): void {
  expect(database.configs.length).toBeGreaterThan(0);
  for (const config of database.configs) {
    expect(config.host).toBe("fd12:3456:789a::10");
    expect(config.host).not.toBe("db.example.invalid");
    expect(config.port).toBe(5_432);
    expect(config.ssl).toMatchObject({
      ca: rootCaPem,
      servername: "localhost",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    expect(typeof (config.ssl as { checkServerIdentity?: unknown }).checkServerIdentity)
      .toBe("function");
  }
}

function optionArguments(options: PostgresLogicalBackupLoginManagerOptions): string[] {
  const values: Array<[string, string]> = [
    ["--admin-connection-file", options.adminConnectionFile],
    ["--approval-reference", options.approvalReference],
    ["--escrow-directory", options.escrowDirectory],
    ["--expected-admin-url-sha256", options.expectedAdminUrlSha256],
    ["--expected-database-identity-sha256", options.expectedDatabaseIdentitySha256],
    ["--expected-environment", options.expectedEnvironment],
    ["--expected-head-sha", options.expectedHeadSha],
    ["--expected-node-version", options.expectedNodeVersion],
    ["--expected-root-ca-der-sha256", options.expectedRootCaDerSha256],
    ["--expected-tree-sha", options.expectedTreeSha],
    ["--expected-uid", String(options.expectedUid)],
    ["--login-version", options.loginVersion],
    ["--operation-id", options.operationId],
    ["--receipt", options.receiptFile],
    ["--root-ca-file", options.rootCaFile],
    ["--transport-profile", options.transportProfile],
  ];
  if (options.operation === "retire") {
    values.push(
      ["--expected-provision-receipt-sha256", options.expectedProvisionReceiptSha256!],
      ["--provision-receipt", options.provisionReceiptFile!],
    );
  }
  return values.flat();
}

describe("PostgreSQL logical-backup LOGIN manager", () => {
  it("derives a deterministic PostgreSQL 17 SCRAM-SHA-256 verifier", () => {
    const password = "A".repeat(64);
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const first = createPostgresLogicalBackupLoginScramVerifier(password, salt);
    const second = createPostgresLogicalBackupLoginScramVerifier(password, salt);
    expect(first).toBe(second);
    expect(first).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
    expect(first).not.toContain(password);
    expect(() => createPostgresLogicalBackupLoginScramVerifier("short", salt))
      .toThrowError(new PostgresLogicalBackupLoginError("invalid_arguments"));
  });

  it("provisions, resumes, and retires only the exact marker-owned role", async () => {
    const root = temporaryDirectory();
    const provision = provisionOptions(root);
    const database = new FakePostgres();
    database.mutationObserver = () => {
      const escrowStat = fs.statSync(provision.escrowDirectory);
      expect(escrowStat.mode & 0o7777).toBe(0o700);
      for (const leaf of [
        POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
        POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE,
      ]) {
        const stat = fs.statSync(path.join(provision.escrowDirectory, leaf));
        expect(stat.mode & 0o7777).toBe(0o600);
        expect(stat.nlink).toBe(1);
      }
    };
    const provisioned = await managePostgresLogicalBackupLogin(
      provision,
      dependencies(provision, database),
    );
    expect(provisioned.receipt).toMatchObject({
      schemaVersion: 2,
      operation: "provision",
      status: "provisioned",
      databaseOid,
      loginRole,
      groupRole,
      authorityPolicyCount: 236,
      authorityDependencyCount: 61,
      transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaDerSha256,
      canary: { saslScramSha256: true, setRole: true, readOnly: true },
    });
    expect(Object.keys(provisioned.receipt).sort()).toEqual(receiptKeys);
    expectOnlyHeldTransportConfigs(database);
    const provisionReceiptBytes = fs.readFileSync(provision.receiptFile);
    expect(provisionReceiptBytes.toString("utf8"))
      .toBe(canonicalPostgresBackupJson(provisioned.receipt));
    expect(sha256(provisionReceiptBytes)).toBe(provisioned.receiptSha256);
    expect(fs.statSync(provision.receiptFile).mode & 0o7777).toBe(0o600);
    expect(provisionReceiptBytes.toString("utf8")).not.toContain(provision.rootCaFile);
    expect(provisionReceiptBytes.toString("utf8")).not.toContain(rootCaPem);
    expect(provisionReceiptBytes.toString("utf8")).not.toContain("fd12:3456:789a::10");
    const provisionIntent = JSON.parse(fs.readFileSync(path.join(
      provision.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE,
    ), "utf8")) as Record<string, unknown>;
    expect(provisionIntent).toMatchObject({
      schemaVersion: 2,
      transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaDerSha256,
    });
    expect(JSON.stringify(provisionIntent)).not.toContain(provision.rootCaFile);
    expect(JSON.stringify(provisionIntent)).not.toContain(rootCaPem);
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
    expect(database.boundVerifiers).toHaveLength(1);
    const escrowUrl = fs.readFileSync(
      path.join(provision.escrowDirectory, POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE),
      "utf8",
    ).trim();
    const generatedPassword = decodeURIComponent(new URL(escrowUrl).password);
    const queryText = database.statements.map((statement) => statement.text).join("\n");
    expect(queryText).not.toContain(adminPassword);
    expect(queryText).not.toContain(generatedPassword);
    expect(queryText).not.toContain(database.boundVerifiers[0]);
    const verifierBindings = database.statements.filter((statement) =>
      statement.values.includes(database.boundVerifiers[0]));
    expect(verifierBindings).toHaveLength(1);
    expect(verifierBindings[0]?.text).toContain("$3::text");

    const resumed = await managePostgresLogicalBackupLogin(
      provision,
      dependencies(provision, database),
    );
    expect(resumed.receiptSha256).toBe(provisioned.receiptSha256);
    expect(database.boundVerifiers).toHaveLength(1);

    const retirementBase = retireOptions(provision, provisioned.receiptSha256);
    const rotatedAdminUrl = adminUrl.replace(adminPassword, "rotated-admin-authority");
    const rotatedAdminFile = path.join(root, "retire-admin-url.key");
    fs.writeFileSync(rotatedAdminFile, `${rotatedAdminUrl}\n`, { mode: 0o600 });
    fs.chmodSync(rotatedAdminFile, 0o600);
    const retirement = {
      ...retirementBase,
      adminConnectionFile: rotatedAdminFile,
      expectedAdminUrlSha256: sha256(rotatedAdminUrl),
    };
    database.failCommitNumber = database.commitCount + 1;
    const retirementStart = database.statements.length;
    const retired = await managePostgresLogicalBackupLogin(
      retirement,
      dependencies(retirement, database),
    );
    expect(retired.receipt).toMatchObject({
      schemaVersion: 2,
      operation: "retire",
      status: "retired",
      loginRole,
      loginRoleOid: "24680",
      canary: { saslScramSha256: false, setRole: false, readOnly: false },
      provisionReceiptSha256: provisioned.receiptSha256,
      adminUrlSha256: sha256(rotatedAdminUrl),
      transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaDerSha256,
    });
    expect(Object.keys(retired.receipt).sort()).toEqual(receiptKeys);
    expect(database.candidate.exists).toBe(false);
    for (const leaf of [
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_DISABLED_FILE,
    ]) {
      const leafPath = path.join(provision.escrowDirectory, leaf);
      const stat = fs.statSync(leafPath);
      expect(stat.mode & 0o7777).toBe(0o600);
      expect(stat.nlink).toBe(1);
      const authority = JSON.parse(fs.readFileSync(leafPath, "utf8")) as Record<string, unknown>;
      expect(authority).toMatchObject({
        schemaVersion: 2,
        transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaDerSha256,
      });
      expect(JSON.stringify(authority)).not.toContain(provision.rootCaFile);
      expect(JSON.stringify(authority)).not.toContain(rootCaPem);
    }
    const retirementSql = database.statements.slice(retirementStart)
      .map((statement) => statement.text).join("\n");
    expect(retirementSql).not.toMatch(/DROP\s+OWNED/i);
    expect(retirementSql).not.toMatch(/CASCADE/i);
    expect(retirementSql).not.toMatch(/ALTER\s+ROLE[^;]+\s+LOGIN\b(?!.*NOLOGIN)/i);

    const retirementReplayStart = database.statements.length;
    const retiredAgain = await managePostgresLogicalBackupLogin(
      retirement,
      dependencies(retirement, database),
    );
    expect(retiredAgain.receiptSha256).toBe(retired.receiptSha256);
    expect(database.statements.slice(retirementReplayStart)
      .map((statement) => statement.text).join("\n")).not.toMatch(/^\s*DROP ROLE /m);

    const afterRetirement = database.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      provision,
      dependencies(provision, database),
    )).rejects.toMatchObject({ code: "escrow_invalid" });
    expect(database.candidate.exists).toBe(false);
    expect(database.statements.slice(afterRetirement).map((statement) => statement.text).join("\n"))
      .not.toContain("backup-login:create-candidate");
  });

  it("requires the exact host arm and stops before opening a connection", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    await expect(managePostgresLogicalBackupLogin(options, {
      ...dependencies(options, database),
      env: {
        ...dependencies(options, database).env,
        [POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV]: "0".repeat(64),
      },
    })).rejects.toMatchObject({ code: "host_gate_failed" });
    expect(database.configs).toHaveLength(0);
    expect(fs.existsSync(options.escrowDirectory)).toBe(false);

    await expect(managePostgresLogicalBackupLogin(options, {
      ...dependencies(options, database),
      env: {
        ...dependencies(options, database).env,
        PGOPTIONS: "-c log_statement=all",
      },
    })).rejects.toMatchObject({ code: "host_gate_failed" });
    expect(database.configs).toHaveLength(0);
  });

  it("preflights and holds the receipt authority before any database connection", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const receiptParent = path.join(root, "unsafe-receipts");
    fs.mkdirSync(receiptParent, { mode: 0o755 });
    fs.chmodSync(receiptParent, 0o755);
    const adjusted = { ...options, receiptFile: path.join(receiptParent, "receipt.json") };
    const database = new FakePostgres();
    let transportOpenCount = 0;
    const baseDependencies = dependencies(adjusted, database);
    await expect(managePostgresLogicalBackupLogin(
      adjusted,
      {
        ...baseDependencies,
        openTransport: async (transportOptions) => {
          transportOpenCount += 1;
          return baseDependencies.openTransport!(transportOptions);
        },
      },
    )).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(transportOpenCount).toBe(0);
    expect(database.configs).toHaveLength(0);
    expect(database.statements).toHaveLength(0);
    expect(fs.existsSync(adjusted.escrowDirectory)).toBe(false);
  });

  it("stops on held transport drift before DDL and after a committed candidate", async () => {
    const beforeRoot = temporaryDirectory();
    const beforeOptions = provisionOptions(beforeRoot);
    const beforeDatabase = new FakePostgres();
    const beforeTransport = new FakeRailwayTransport(beforeOptions);
    beforeTransport.failAssertAt = 6;
    await expect(managePostgresLogicalBackupLogin(
      beforeOptions,
      dependencies(beforeOptions, beforeDatabase, beforeTransport),
    )).rejects.toMatchObject({ code: "source_authority_invalid" });
    expect(beforeDatabase.candidate.exists).toBe(false);
    expect(beforeDatabase.statements.map((entry) => entry.text).join("\n"))
      .not.toContain("backup-login:create-candidate");
    expect(fs.existsSync(beforeOptions.receiptFile)).toBe(false);
    expect(beforeTransport.closeCount).toBe(1);

    const afterRoot = temporaryDirectory();
    const afterOptions = provisionOptions(afterRoot);
    const afterDatabase = new FakePostgres();
    const afterTransport = new FakeRailwayTransport(afterOptions);
    afterDatabase.mutationObserver = () => {
      afterTransport.failAssertAt = afterTransport.assertCount + 1;
    };
    await expect(managePostgresLogicalBackupLogin(
      afterOptions,
      dependencies(afterOptions, afterDatabase, afterTransport),
    )).rejects.toMatchObject({ code: "source_authority_invalid" });
    expect(afterDatabase.candidate).toMatchObject({ exists: true, canLogin: true });
    expect(fs.existsSync(afterOptions.receiptFile)).toBe(false);
    expect(afterTransport.closeCount).toBe(1);
  });

  it("opens one shared transport only after preflight and holds it through every connection", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const transport = new FakeRailwayTransport(options);
    const base = dependencies(options, database, transport);
    let openCount = 0;
    let opened = false;
    database.connectObserver = () => {
      expect(opened).toBe(true);
      expect(transport.closeCount).toBe(0);
    };
    await managePostgresLogicalBackupLogin(options, {
      ...base,
      openTransport: async (transportOptions) => {
        openCount += 1;
        opened = true;
        return base.openTransport!(transportOptions);
      },
    });
    expect(openCount).toBe(1);
    expect(transport.closeCount).toBe(1);
    expect(database.connectionCloseCount).toBe(database.configs.length);
    expectOnlyHeldTransportConfigs(database);
  });

  it("lets transport cleanup ambiguity dominate success and catalog failure", async () => {
    for (const withCatalogFailure of [false, true]) {
      const root = temporaryDirectory();
      const options = provisionOptions(root);
      const database = new FakePostgres();
      database.pgauditInstalled = withCatalogFailure;
      const transport = new FakeRailwayTransport(options);
      transport.failCloseCount = 1;
      await expect(managePostgresLogicalBackupLogin(
        options,
        dependencies(options, database, transport),
      )).rejects.toMatchObject({ code: "cleanup_failed" });
      expect(transport.closeCount).toBe(1);
      expectOnlyHeldTransportConfigs(database);
      if (withCatalogFailure) {
        expect(database.candidate.exists).toBe(false);
        expect(fs.existsSync(options.receiptFile)).toBe(false);
      } else {
        expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
        expect(fs.existsSync(options.receiptFile)).toBe(true);
      }
    }
  });

  it("rejects invalid transport authority options before opening transport or database", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const cases: PostgresLogicalBackupLoginManagerOptions[] = [
      {
        ...options,
        transportProfile: "railway-stock-unknown" as
          PostgresLogicalBackupLoginManagerOptions["transportProfile"],
      },
      { ...options, expectedRootCaDerSha256: "D".repeat(64) },
      { ...options, rootCaFile: options.adminConnectionFile },
    ];
    for (const invalid of cases) {
      const database = new FakePostgres();
      let opened = false;
      await expect(managePostgresLogicalBackupLogin(invalid, {
        ...dependencies(options, database),
        openTransport: async () => {
          opened = true;
          return new FakeRailwayTransport(options);
        },
      })).rejects.toMatchObject({ code: "invalid_arguments" });
      expect(opened).toBe(false);
      expect(database.configs).toHaveLength(0);
    }
  });

  it("rejects a mismatched opened transport and closes it before any database access", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const transport = new FakeRailwayTransport(options);
    Object.defineProperty(transport, "rootCaDerSha256", { value: "d".repeat(64) });
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database, transport),
    )).rejects.toMatchObject({ code: "source_authority_invalid" });
    expect(database.configs).toHaveLength(0);
    expect(transport.closeCount).toBe(1);
  });

  it("rejects receipt-parent replacement through the held preflight authority", async () => {
    const root = temporaryDirectory();
    const base = provisionOptions(root);
    const receiptParent = path.join(root, "receipts");
    const displacedParent = path.join(root, "receipts-displaced");
    fs.mkdirSync(receiptParent, { mode: 0o700 });
    fs.chmodSync(receiptParent, 0o700);
    const options = { ...base, receiptFile: path.join(receiptParent, "receipt.json") };
    const database = new FakePostgres();
    database.mutationObserver = () => {
      fs.renameSync(receiptParent, displacedParent);
      fs.mkdirSync(receiptParent, { mode: 0o700 });
      fs.chmodSync(receiptParent, 0o700);
    };
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
    expect(fs.existsSync(options.receiptFile)).toBe(false);
    expect(fs.readdirSync(displacedParent)).toEqual([]);
  });

  it("reconciles an existing provision receipt without recreating missing authority", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    await managePostgresLogicalBackupLogin(options, dependencies(options, database));
    database.candidate.exists = false;
    const before = database.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "mutation_ambiguous" });
    expect(database.statements.slice(before).map((entry) => entry.text).join("\n"))
      .not.toContain("backup-login:create-candidate");
    expect(database.boundVerifiers).toHaveLength(1);
  });

  it("rejects a provision receipt rebound to a different root CA pin", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const provisioned = await managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    );
    fs.writeFileSync(options.receiptFile, canonicalPostgresBackupJson({
      ...provisioned.receipt,
      rootCaDerSha256: "d".repeat(64),
    }), { mode: 0o600 });
    fs.chmodSync(options.receiptFile, 0o600);
    const before = database.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(database.statements.slice(before).map((entry) => entry.text).join("\n"))
      .not.toContain("backup-login:create-candidate");
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
  });

  it("revalidates logger authority and fresh SCRAM canary on an existing receipt", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    await managePostgresLogicalBackupLogin(options, dependencies(options, database));
    database.pgauditInstalled = true;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "logger_guard_failed" });
    database.pgauditInstalled = false;
    database.canaryAuthenticationMethod = "other";
    const before = database.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "canary_failed" });
    expect(database.statements.slice(before).map((entry) => entry.text).join("\n"))
      .not.toContain("backup-login:bind-verifier");
  });

  it.each<LeafHandleFault>(["stat", "write", "chmod", "sync", "read"])(
    "cleans an exact partial secret leaf after a forced %s failure",
    async (method) => {
      const root = temporaryDirectory();
      const options = provisionOptions(root);
      const database = new FakePostgres();
      failFirstOpenedLeafMethod(POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE, method);
      await expect(managePostgresLogicalBackupLogin(
        options,
        dependencies(options, database),
      )).rejects.toMatchObject({ code: "escrow_invalid" });
      expect(database.candidate.exists).toBe(false);
      expect(fs.existsSync(options.escrowDirectory)).toBe(false);
      expect(fs.readdirSync(root).some((entry) => entry.startsWith(".pintpath-login-escrow-")))
        .toBe(false);
    },
  );

  it("never reports cleanup success when a partial secret leaf has an extra hardlink", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const retained = path.join(root, "retained-secret-hardlink");
    failFirstOpenedLeafMethod(
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
      "sync",
      (leaf) => fs.linkSync(leaf, retained),
    );
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(fs.existsSync(retained)).toBe(true);
    expect(fs.statSync(retained).nlink).toBe(2);
    expect(database.candidate.exists).toBe(false);
    expect(fs.existsSync(options.receiptFile)).toBe(false);
  });

  it("zeros an allocated password buffer and closes every handle on synchronous RNG failure", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const handles = captureOpenedHandles();
    const passwordBytes = Buffer.alloc(48, 0x7a);
    let calls = 0;
    await expect(managePostgresLogicalBackupLogin(options, {
      ...dependencies(options, database),
      randomBytes: () => {
        calls += 1;
        if (calls === 1) return passwordBytes;
        throw new Error("forced-salt-rng-failure");
      },
    })).rejects.toMatchObject({ code: "escrow_invalid" });
    expect([...passwordBytes]).toEqual(new Array(48).fill(0));
    expect(fs.existsSync(options.escrowDirectory)).toBe(false);
    expect(fs.existsSync(options.receiptFile)).toBe(false);
    await expectHandlesClosed(handles);
  });

  it("closes the held receipt authority when synchronous publication setup fails", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const handles = captureOpenedHandles();
    const originalRandomBytes = crypto.randomBytes.bind(crypto);
    let calls = 0;
    vi.spyOn(crypto, "randomBytes").mockImplementation(((size: number) => {
      calls += 1;
      if (calls === 2) throw new Error("forced-receipt-temp-name-failure");
      return originalRandomBytes(size);
    }) as typeof crypto.randomBytes);
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
    expect(fs.existsSync(options.receiptFile)).toBe(false);
    await expectHandlesClosed(handles);
  });

  it.each(["provision", "retire"] as const)(
    "zeros the already-read escrow URL when the %s intent read fails synchronously",
    async (operation) => {
      const root = temporaryDirectory();
      const provision = provisionOptions(root);
      const database = new FakePostgres();
      const provisioned = await managePostgresLogicalBackupLogin(
        provision,
        dependencies(provision, database),
      );
      const urlPath = path.join(
        provision.escrowDirectory,
        POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
      );
      const intentPath = path.join(
        provision.escrowDirectory,
        POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE,
      );
      const captured = captureUrlReadAndFailIntentOpen(urlPath, intentPath);
      const requested = operation === "provision"
        ? provision
        : retireOptions(provision, provisioned.receiptSha256);
      const expectedCode = operation === "provision"
        ? "unsafe_admin_connection_file"
        : "escrow_invalid";
      await expect(managePostgresLogicalBackupLogin(
        requested,
        dependencies(requested, database),
      )).rejects.toMatchObject({ code: expectedCode });
      const urlBuffer = captured();
      expect(urlBuffer).not.toBeNull();
      expect([...(urlBuffer ?? Buffer.alloc(0))].every((value) => value === 0)).toBe(true);
      expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
    },
  );

  it("closes every normal-success file and directory handle", async () => {
    const root = temporaryDirectory();
    const provision = provisionOptions(root);
    const database = new FakePostgres();
    const handles = captureOpenedHandles();
    const provisioned = await managePostgresLogicalBackupLogin(
      provision,
      dependencies(provision, database),
    );
    const retirement = retireOptions(provision, provisioned.receiptSha256);
    await managePostgresLogicalBackupLogin(retirement, dependencies(retirement, database));
    await expectHandlesClosed(handles);
  });

  it("preserves a durably renamed escrow and reports cleanup_failed on rename ambiguity", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementationOnce(async (from, to) => {
      await originalRename(from, to);
      throw new Error("forced-after-rename");
    });
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(database.candidate.exists).toBe(false);
    expect(fs.statSync(options.escrowDirectory).mode & 0o7777).toBe(0o700);
    expect(fs.readdirSync(options.escrowDirectory).sort()).toEqual([
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_INTENT_FILE,
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
    ].sort());
    vi.restoreAllMocks();
    const resumed = await managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    );
    expect(resumed.receipt.status).toBe("provisioned");
  });

  it("preserves an exact receipt and reports cleanup_failed after an ambiguous hardlink publish", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const originalLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link").mockImplementationOnce(async (from, to) => {
      await originalLink(from, to);
      throw new Error("forced-after-link");
    });
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
    expect(fs.statSync(options.receiptFile).nlink).toBe(1);
    expect(fs.readdirSync(root).some((entry) => entry.startsWith(".pintpath-login-manager-")))
      .toBe(false);
    vi.restoreAllMocks();
    const reconciled = await managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    );
    expect(reconciled.receipt.status).toBe("provisioned");
  });

  it("reconciles only an exact marker-owned active role after an uncertain commit", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    database.failCommitNumber = 1;
    const result = await managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    );
    expect(result.receipt.status).toBe("provisioned");
    expect(database.candidate).toMatchObject({
      exists: true,
      canLogin: true,
      marker: result.receipt.marker,
    });
    expect(database.configs.filter((config) => config.user === "postgres").length)
      .toBeGreaterThanOrEqual(2);
    expect(database.boundVerifiers).toHaveLength(1);
  });

  it("leaves a failed fresh-auth canary forward-recoverable without a false receipt", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    database.canaryAuthenticationMethod = "other";
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "canary_failed" });
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
    expect(fs.existsSync(options.receiptFile)).toBe(false);
    database.canaryAuthenticationMethod = "scram-sha-256";
    const resumed = await managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    );
    expect(resumed.receipt.status).toBe("provisioned");
    expect(database.boundVerifiers).toHaveLength(1);
  });

  it("rejects incomplete policy/dependency authority before durable escrow or DDL", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    database.groupPolicyCount = 235;
    database.groupDependencyCount = 60;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "source_authority_invalid" });
    expect(database.candidate.exists).toBe(false);
    expect(fs.existsSync(options.escrowDirectory)).toBe(false);
    expect(database.statements.map((statement) => statement.text).join("\n"))
      .not.toContain("backup-login:create-candidate");
  });

  it("treats the portable-policy-only state as inert rather than provisionable", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    database.groupExists = false;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "source_authority_invalid" });
    expect(database.candidate.exists).toBe(false);
    expect(fs.existsSync(options.escrowDirectory)).toBe(false);
  });

  it("stops retirement on an extra cluster dependency without disabling the login", async () => {
    const root = temporaryDirectory();
    const provision = provisionOptions(root);
    const database = new FakePostgres();
    const provisioned = await managePostgresLogicalBackupLogin(
      provision,
      dependencies(provision, database),
    );
    database.candidateExtraDependencyCount = 1;
    const retirement = retireOptions(provision, provisioned.receiptSha256);
    await expect(managePostgresLogicalBackupLogin(
      retirement,
      dependencies(retirement, database),
    )).rejects.toMatchObject({ code: "mutation_ambiguous" });
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
    expect(fs.existsSync(path.join(
      provision.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
    ))).toBe(false);
  });

  it("rejects disabled-without-intent and absent-without-checkpoint retirement states", async () => {
    const disabledRoot = temporaryDirectory();
    const disabledProvision = provisionOptions(disabledRoot);
    const disabledDatabase = new FakePostgres();
    const disabledReceipt = await managePostgresLogicalBackupLogin(
      disabledProvision,
      dependencies(disabledProvision, disabledDatabase),
    );
    disabledDatabase.candidate.canLogin = false;
    disabledDatabase.candidate.hasPassword = false;
    disabledDatabase.candidate.membership = false;
    disabledDatabase.candidate.databasePrivilege = false;
    disabledDatabase.candidate.functionPrivilege = false;
    const disabledRetire = retireOptions(disabledProvision, disabledReceipt.receiptSha256);
    const disabledStart = disabledDatabase.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      disabledRetire,
      dependencies(disabledRetire, disabledDatabase),
    )).rejects.toMatchObject({ code: "mutation_ambiguous" });
    expect(fs.existsSync(path.join(
      disabledProvision.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
    ))).toBe(false);
    expect(disabledDatabase.statements.slice(disabledStart).map((entry) => entry.text).join("\n"))
      .not.toContain("backup-login:terminate-sessions");

    const absentRoot = temporaryDirectory();
    const absentProvision = provisionOptions(absentRoot);
    const absentDatabase = new FakePostgres();
    const absentReceipt = await managePostgresLogicalBackupLogin(
      absentProvision,
      dependencies(absentProvision, absentDatabase),
    );
    absentDatabase.candidate.exists = false;
    const absentRetire = retireOptions(absentProvision, absentReceipt.receiptSha256);
    const absentStart = absentDatabase.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      absentRetire,
      dependencies(absentRetire, absentDatabase),
    )).rejects.toMatchObject({ code: "mutation_ambiguous" });
    expect(fs.existsSync(path.join(
      absentProvision.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_RETIRE_INTENT_FILE,
    ))).toBe(false);
    expect(absentDatabase.statements.slice(absentStart).map((entry) => entry.text).join("\n"))
      .not.toMatch(/ALTER ROLE|DROP ROLE|terminate-sessions/);
  });

  it("rejects an active role paired with a forward disabled checkpoint before writes", async () => {
    const root = temporaryDirectory();
    const provision = provisionOptions(root);
    const database = new FakePostgres();
    const provisioned = await managePostgresLogicalBackupLogin(
      provision,
      dependencies(provision, database),
    );
    const retirement = retireOptions(provision, provisioned.receiptSha256);
    await managePostgresLogicalBackupLogin(retirement, dependencies(retirement, database));
    fs.unlinkSync(retirement.receiptFile);
    database.candidate = {
      exists: true,
      oid: provisioned.receipt.loginRoleOid,
      marker: provisioned.receipt.marker,
      canLogin: true,
      hasPassword: true,
      membership: true,
      databasePrivilege: true,
      functionPrivilege: true,
      validUntilIsNull: true,
    };
    const before = database.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      retirement,
      dependencies(retirement, database),
    )).rejects.toMatchObject({ code: "mutation_ambiguous" });
    expect(database.statements.slice(before).map((entry) => entry.text).join("\n"))
      .not.toMatch(/ALTER ROLE|DROP ROLE|terminate-sessions/);
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
  });

  it("detects an escrow hardlink replacement before any resumed mutation", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    await managePostgresLogicalBackupLogin(options, dependencies(options, database));
    const urlFile = path.join(
      options.escrowDirectory,
      POSTGRES_LOGICAL_BACKUP_LOGIN_ESCROW_URL_FILE,
    );
    fs.linkSync(urlFile, path.join(root, "retained-url-hardlink"));
    const before = database.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "unsafe_admin_connection_file" });
    expect(database.statements.slice(before).map((statement) => statement.text).join("\n"))
      .not.toContain("backup-login:bind-verifier");
    expect(database.candidate).toMatchObject({ exists: true, canLogin: true });
  });

  it.each([
    ["world-readable file", 0o644, adminUrl, "unsafe_admin_connection_file"],
    [
      "non-verifying TLS URL",
      0o600,
      adminUrl.replace("verify-full", "require"),
      "unsafe_admin_connection_url",
    ],
    [
      "pooler endpoint",
      0o600,
      adminUrl.replace("db.example.invalid", "pooler.example.invalid"),
      "unsafe_admin_connection_url",
    ],
  ])("rejects an unsafe admin authority: %s", async (_name, mode, url, code) => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    fs.writeFileSync(options.adminConnectionFile, `${url}\n`, { mode });
    fs.chmodSync(options.adminConnectionFile, mode);
    const adjusted = { ...options, expectedAdminUrlSha256: sha256(url) };
    const database = new FakePostgres();
    await expect(managePostgresLogicalBackupLogin(
      adjusted,
      dependencies(adjusted, database),
    )).rejects.toMatchObject({ code });
    expect(database.candidate.exists).toBe(false);
  });

  it("fails closed on a logger or catalog drift before role DDL", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    database.pgauditInstalled = true;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "logger_guard_failed" });
    expect(database.candidate.exists).toBe(false);
    expect(fs.existsSync(options.escrowDirectory)).toBe(false);

    database.pgauditInstalled = false;
    await managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    );
    database.candidate.validUntilIsNull = false;
    const before = database.statements.length;
    await expect(managePostgresLogicalBackupLogin(
      options,
      dependencies(options, database),
    )).rejects.toMatchObject({ code: "mutation_ambiguous" });
    expect(database.statements.slice(before).map((entry) => entry.text).join("\n"))
      .not.toContain("backup-login:bind-verifier");
  });

  it("emits only fixed canonical CLI fields and never an underlying error", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const parsed = parsePostgresLogicalBackupLoginOptions(
      "provision",
      optionArguments(options),
    );
    expect(parsed).toEqual(options);
    let output = "";
    const status = await runPostgresLogicalBackupLoginCli([
      "provision",
      ...optionArguments(options),
    ], {
      manage: async () => {
        throw new Error(`credential ${adminUrl}`);
      },
      writeOutput: (value) => { output += value; },
    });
    expect(status).toBe(1);
    expect(JSON.parse(output)).toEqual({
      failureCode: "mutation_ambiguous",
      ok: false,
      schemaVersion: 1,
    });
    expect(output).not.toContain(adminPassword);
    expect(output).not.toContain(adminUrl);
    expect(output).not.toContain(options.rootCaFile);
    expect(output).not.toContain(rootCaPem);
  });

  it("contains a production client socket failure behind one canonical CLI failure", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    const database = new FakePostgres();
    const base = dependencies(options, database);
    const { connect: _unusedConnect, ...productionDependencies } = base;
    const socketSecret = `backend lost ${adminUrl}`;
    const connectSpy = vi.spyOn(Client.prototype, "connect")
      .mockResolvedValue(undefined);
    const querySpy = vi.spyOn(Client.prototype, "query")
      .mockImplementation(function (this: Client) {
        this.emit("error", new Error(socketSecret));
        return Promise.reject(new Error(socketSecret));
      } as typeof Client.prototype.query);
    const endSpy = vi.spyOn(Client.prototype, "end").mockResolvedValue(undefined);
    let output = "";
    const status = await runPostgresLogicalBackupLoginCli([
      "provision",
      ...optionArguments(options),
    ], {
      manage: (parsed) => managePostgresLogicalBackupLogin(parsed, productionDependencies),
      writeOutput: (value) => { output += value; },
    });
    expect(status).toBe(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output)).toEqual({
      failureCode: "source_authority_invalid",
      ok: false,
      schemaVersion: 1,
    });
    expect(output).not.toContain(socketSecret);
    expect(output).not.toContain(adminPassword);
    expect(output).not.toContain(adminUrl);
    expect(fs.existsSync(options.escrowDirectory)).toBe(false);
    expect(fs.existsSync(options.receiptFile)).toBe(false);
    expect(fs.readdirSync(root).some((entry) => entry.startsWith(".pintpath"))).toBe(false);
  });

  it("derives an exact arm without reading the connection file", async () => {
    const root = temporaryDirectory();
    const options = provisionOptions(root);
    fs.unlinkSync(options.adminConnectionFile);
    fs.unlinkSync(options.rootCaFile);
    let output = "";
    const status = await runPostgresLogicalBackupLoginCli([
      "arm",
      "provision",
      ...optionArguments(options),
    ], { writeOutput: (value) => { output += value; } });
    expect(status).toBe(0);
    const receipt = JSON.parse(output) as Record<string, unknown>;
    expect(receipt).toEqual({
      mutationArm: postgresLogicalBackupLoginMutationArm(options),
      mutationEnvironment: POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION_ENV,
      ok: true,
      operation: "provision",
      schemaVersion: 1,
    });
    expect(output).not.toContain(adminPassword);
    expect(output).not.toContain(options.rootCaFile);
    expect(postgresLogicalBackupLoginMutationArm({
      ...options,
      rootCaFile: path.join(root, "different-root-ca.pem"),
    })).not.toBe(receipt.mutationArm);
    expect(postgresLogicalBackupLoginMutationArm({
      ...options,
      expectedRootCaDerSha256: "d".repeat(64),
    })).not.toBe(receipt.mutationArm);
  });
});
