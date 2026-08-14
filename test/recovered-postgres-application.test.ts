import childProcess from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  assertAuthenticatedAccountBoundary,
  assertDisposableSupabaseAccessTokenIdentity,
  assertRecoveryIdentityBoundary,
  closeRecoveryAuthoritiesBoundedly,
  createReviewedRuntimeStageBoundary,
  hashCompiledApplicationArtifact,
  hashRuntimeDependencyArtifact,
  proveCrossProjectTokenRejectedLocally,
  recoveryCandidateBindingsExact,
  signInDisposableSupabase,
  terminateRecoveredApplicationChild,
  verifyRecoveredPostgresApplication,
  waitForRecoveryProbe,
  type ManagedRecoveryChild,
  type RecoveryIdentityBoundaryInput,
} from "../scripts/verify-recovered-postgres-application.js";
import {
  TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
  TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
} from "./postgres-railway-stock-localhost-ca.fixtures.js";

const CANDIDATE = "a".repeat(40);
const NOW = new Date("2026-08-14T06:00:00.000Z");
const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const roots: string[] = [];

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function uuid(digit: string): string {
  return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
}

function identityFixture(
  overrides: Partial<RecoveryIdentityBoundaryInput> = {},
): RecoveryIdentityBoundaryInput {
  const runtimeUrl =
    "postgresql://runtime:runtime-password@postgres-recovery.railway.internal:5432/pintpath?sslmode=verify-full";
  const maintenanceUrl =
    "postgresql://maintenance:maintenance-password@postgres-recovery.railway.internal:5432/pintpath?sslmode=verify-full";
  const redisUrl =
    "redis://default:redis-password@redis-recovery.railway.internal:6379";
  const targetEnvironment = uuid("2");
  const productionEnvironment = uuid("5");
  const stagingEnvironment = uuid("8");
  const publishableHash = hash(`sb_publishable_${"r".repeat(32)}`);
  return {
    candidateSha: CANDIDATE,
    runtimeUrl,
    runtimeUrlSha256: hash(runtimeUrl),
    maintenanceUrl,
    maintenanceUrlSha256: hash(maintenanceUrl),
    redisUrl,
    redisUrlSha256: hash(redisUrl),
    supabaseUrl: SUPABASE_URL,
    supabaseOriginSha256: hash(SUPABASE_URL),
    supabasePublishableKeySha256: publishableHash,
    expectedSupabasePublishableKeySha256: publishableHash,
    productionSupabasePublishableKeySha256: hash("production-publishable"),
    permanentStagingSupabasePublishableKeySha256: hash("staging-publishable"),
    railwayProjectId: uuid("1"),
    railwayEnvironmentId: targetEnvironment,
    railwayServiceId: uuid("3"),
    productionRailwayProjectId: uuid("4"),
    productionRailwayEnvironmentId: productionEnvironment,
    productionRailwayServiceId: uuid("6"),
    permanentStagingRailwayProjectId: uuid("7"),
    permanentStagingRailwayEnvironmentId: stagingEnvironment,
    permanentStagingRailwayServiceId: uuid("9"),
    databaseResourceId: `railway:${targetEnvironment}:${uuid("a")}`,
    productionDatabaseResourceId: `railway:${productionEnvironment}:${uuid("b")}`,
    permanentStagingDatabaseResourceId: `railway:${stagingEnvironment}:${uuid("c")}`,
    productionDatabaseUrlSha256: hash("production-database"),
    permanentStagingDatabaseUrlSha256: hash("staging-database"),
    redisResourceId: `railway:${targetEnvironment}:${uuid("d")}`,
    productionRedisResourceId: `railway:${productionEnvironment}:${uuid("e")}`,
    permanentStagingRedisResourceId: `railway:${stagingEnvironment}:${uuid("f")}`,
    productionRedisUrlSha256: hash("production-redis"),
    permanentStagingRedisUrlSha256: hash("staging-redis"),
    ...overrides,
  };
}

function jwt(
  input: { readonly issuer?: string; readonly subject?: string } = {},
): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(NOW.getTime() / 1_000);
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: input.issuer ?? `${SUPABASE_URL}/auth/v1`,
    sub: input.subject ?? uuid("1"),
    session_id: uuid("2"),
    aud: "authenticated",
    role: "authenticated",
    iat: now,
    exp: now + 3_600,
  })}.signature`;
}

function probePayload(route: "startup" | "ready") {
  const common = {
    ok: true,
    data: {
      service: "pint-path",
      status: route === "startup" ? "startup_ready" : "ready",
      deployment: { commitSha: CANDIDATE, environment: "production" },
      postgresRecoveryRehearsal: {
        enabled: true,
        candidateSha: CANDIDATE,
        loopbackOnly: true,
        postgresRuntime: true,
        automaticMaintenanceEnabled: false,
        externalWritesAllowed: false,
        providerSchedulersEnabled: false,
      },
      dependencies: {
        database: { status: "ok" },
        accountDeletionNotifications: {
          required: false,
          status: "disabled_for_restore_rehearsal",
        },
      } as Record<string, unknown>,
    },
  };
  if (route === "ready") {
    Object.assign(common.data.dependencies, {
      supabaseAuth: { status: "ok", liveProbe: true },
      supabaseDatabase: { status: "disabled_for_postgres_recovery_rehearsal" },
      supabaseEvidenceStorage: {
        status: "disabled_for_postgres_recovery_rehearsal",
      },
      billingProvider: { status: "disabled_for_restore_rehearsal" },
      venueLookupProvider: { status: "disabled_for_restore_rehearsal" },
      menuExtractionProvider: { status: "disabled_for_restore_rehearsal" },
      reportDelivery: { status: "disabled", scheduled: false },
      postgresRecoveryRehearsal: {
        externalWritesAllowed: false,
        automaticMaintenanceEnabled: false,
        providerSchedulersEnabled: false,
      },
      rateLimiterRedis: {
        status: "ok",
        ready: true,
        identity: { verified: true },
      },
      offsiteBackup: { status: "ok", required: false, liveProbe: false },
    });
  }
  return common;
}

class ChildFixture extends EventEmitter implements ManagedRecoveryChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = null;
  readonly stderr = null;

  constructor(readonly onKill: (signal?: NodeJS.Signals | number) => void) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.onKill(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

class CleanupReplacingChild
  extends EventEmitter
  implements ManagedRecoveryChild
{
  readonly stdout = new EventEmitter() as NodeJS.ReadableStream;
  readonly stderr = new EventEmitter() as NodeJS.ReadableStream;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stagedContainer: string | null = null;
  replacementContainer: string | null = null;

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (signal !== "SIGTERM" || !this.stagedContainer) return false;
    const displaced = `${this.stagedContainer}-held-original`;
    fs.renameSync(this.stagedContainer, displaced);
    fs.mkdirSync(this.stagedContainer, { mode: 0o700 });
    fs.writeFileSync(
      path.join(this.stagedContainer, "do-not-delete"),
      "replacement\n",
    );
    this.replacementContainer = this.stagedContainer;
    this.stagedContainer = displaced;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
    });
    return true;
  }
}

function writePrivate(filename: string, value: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, value, { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function createCompiledArtifact(root: string): string {
  const dist = path.join(root, "dist");
  for (const filename of [
    "src/app.js",
    "src/config/env.js",
    "src/db/postgres-schema.sql",
    "src/db/schema.sql",
    "src/server.js",
    "viewer/index.html",
  ]) {
    const absolute = path.join(dist, filename);
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o755 });
    fs.writeFileSync(absolute, `${filename}\n`, { mode: 0o644 });
  }
  const runtimePackage = path.join(root, "node_modules", "fixture-runtime");
  fs.mkdirSync(runtimePackage, { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    path.join(runtimePackage, "package.json"),
    `${JSON.stringify({ name: "fixture-runtime", version: "1.0.0", type: "module" })}\n`,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(runtimePackage, "index.js"),
    'export const runtimeFixture = "reviewed";\n',
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({
      name: "pintpath-recovered-app-test",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "pintpath-recovered-app-test",
          version: "1.0.0",
          dependencies: { "fixture-runtime": "1.0.0" },
        },
        "node_modules/fixture-runtime": {
          version: "1.0.0",
          integrity: `sha512-${"A".repeat(88)}`,
        },
      },
    })}\n`,
    { mode: 0o644 },
  );
  return dist;
}

function replayReceipt(input: {
  readonly first: boolean;
  readonly targetIdentitySha256: string;
}) {
  const digest = (digit: string) => digit.repeat(64);
  return {
    kind: "pintpath-postgres-account-deletion-tombstone-replay",
    version: 2,
    status: "verified",
    replayedAt: input.first
      ? "2026-08-14T05:00:00.000Z"
      : "2026-08-14T05:01:00.000Z",
    targetIdentitySha256: input.targetIdentitySha256,
    targetClass: "disposable-rehearsal",
    serverVersionNum: "170000",
    replayRoleRestricted: true,
    replayEffectiveRole: "pintpath_maintenance",
    transportProfile: "railway-stock-localhost-ca-v1",
    transportRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
    restoreLockKeySha256: digest("1"),
    baseRestoreReceiptSha256: digest("2"),
    migrationCandidateSha: CANDIDATE,
    migrationManifestSha256: digest("3"),
    migrationRunSha256: digest("4"),
    sourceSnapshotSha256: digest("5"),
    backupManifestSha256: digest("6"),
    backupArchiveSha256: digest("7"),
    sourceStateReceiptSha256: digest("8"),
    sourceSnapshotBindingSha256: digest("9"),
    expectedSourceOverallStateSha256: digest("a"),
    restoredOverallStateSha256: digest("a"),
    ledgerCurrentSha256: digest("b"),
    ledgerGenesisSha256: digest("c"),
    ledgerCheckpointSha256: digest("d"),
    ledgerImmutableSetSha256: digest("e"),
    ledgerTombstoneCount: 1,
    counts: {
      seen: 1,
      newlyApplied: input.first ? 1 : 0,
      alreadyApplied: input.first ? 0 : 1,
      missing: 0,
      failed: 0,
    },
    recipientSecretPhysicalCheckpointVerified: true,
    semanticProjectionSha256: digest("f"),
    idempotency: "exact-semantic-projection",
  } as const;
}

function topLevelFixture(input: { readonly readyStatus?: number } = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-recovered-application-top-level-"),
    ),
  );
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const dist = createCompiledArtifact(root);
  const identities = identityFixture();
  const targetIdentitySha256 = hash("disposable-target");
  const authSubject = uuid("1");
  const authEmail = "recovery-user@example.invalid";
  const authPassword = "disposable-auth-password-32-bytes";
  const publishableKey = `sb_publishable_${"r".repeat(32)}`;
  const appToken = "app-session-token-that-is-long-and-disposable-only";
  const providerToken = jwt({ subject: authSubject });
  const privateRoot = path.join(root, "private");
  const runtimeStageRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-recovered-stage-root-")),
  );
  fs.chmodSync(runtimeStageRoot, 0o700);
  roots.push(runtimeStageRoot);
  fs.mkdirSync(privateRoot, { mode: 0o700 });
  const files = {
    runtime: path.join(privateRoot, "runtime.url"),
    maintenance: path.join(privateRoot, "maintenance.url"),
    redis: path.join(privateRoot, "redis.url"),
    rootCa: path.join(privateRoot, "root-ca.pem"),
    publishable: path.join(privateRoot, "publishable.key"),
    email: path.join(privateRoot, "auth.email"),
    password: path.join(privateRoot, "auth.password"),
    sentinel: path.join(privateRoot, "redis.sentinel"),
    evidenceSecret: path.join(privateRoot, "evidence.secret"),
    firstReplay: path.join(privateRoot, "first-replay.json"),
    secondReplay: path.join(privateRoot, "second-replay.json"),
  };
  writePrivate(files.runtime, identities.runtimeUrl);
  writePrivate(files.maintenance, identities.maintenanceUrl);
  writePrivate(files.redis, identities.redisUrl);
  writePrivate(files.rootCa, TEST_POSTGRES_RAILWAY_ROOT_CA_PEM);
  writePrivate(files.publishable, publishableKey);
  writePrivate(files.email, authEmail);
  writePrivate(files.password, authPassword);
  writePrivate(files.sentinel, "disposable-redis-sentinel-secret-32-bytes");
  writePrivate(
    files.evidenceSecret,
    "disposable-evidence-signing-secret-32-bytes",
  );
  writePrivate(
    files.firstReplay,
    canonicalPostgresBackupJson(
      replayReceipt({
        first: true,
        targetIdentitySha256,
      }),
    ),
  );
  writePrivate(
    files.secondReplay,
    canonicalPostgresBackupJson(
      replayReceipt({
        first: false,
        targetIdentitySha256,
      }),
    ),
  );
  const compiledArtifactSha256 = hashCompiledApplicationArtifact(dist);
  const compiledEntrypointSha256 = hash(
    fs.readFileSync(path.join(dist, "src", "server.js")),
  );
  const runtimeDependencyArtifactSha256 = hashRuntimeDependencyArtifact(dist);
  const values: Record<string, string> = {
    "--app-port": "43117",
    "--auth-email-file": files.email,
    "--auth-password-file": files.password,
    "--candidate-sha": CANDIDATE,
    "--close-timeout-ms": "1000",
    "--compiled-artifact-root": dist,
    "--database-resource-id": identities.databaseResourceId,
    "--expected-auth-email-sha256": hash(authEmail),
    "--expected-auth-subject-sha256": hash(authSubject),
    "--expected-compiled-artifact-sha256": compiledArtifactSha256,
    "--expected-compiled-entrypoint-sha256": compiledEntrypointSha256,
    "--expected-runtime-dependency-artifact-sha256":
      runtimeDependencyArtifactSha256,
    "--expected-maintenance-url-sha256": identities.maintenanceUrlSha256,
    "--expected-redis-url-sha256": identities.redisUrlSha256,
    "--expected-root-ca-der-sha256": TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
    "--expected-runtime-url-sha256": identities.runtimeUrlSha256,
    "--expected-supabase-origin-sha256": identities.supabaseOriginSha256,
    "--expected-supabase-publishable-key-sha256": hash(publishableKey),
    "--expected-target-identity-sha256": targetIdentitySha256,
    "--first-replay-receipt": files.firstReplay,
    "--maintenance-url-file": files.maintenance,
    "--output-limit-bytes": "8192",
    "--permanent-staging-database-resource-id":
      identities.permanentStagingDatabaseResourceId,
    "--permanent-staging-database-url-sha256":
      identities.permanentStagingDatabaseUrlSha256,
    "--permanent-staging-railway-environment-id":
      identities.permanentStagingRailwayEnvironmentId,
    "--permanent-staging-railway-project-id":
      identities.permanentStagingRailwayProjectId,
    "--permanent-staging-railway-service-id":
      identities.permanentStagingRailwayServiceId,
    "--permanent-staging-redis-resource-id":
      identities.permanentStagingRedisResourceId,
    "--permanent-staging-redis-url-sha256":
      identities.permanentStagingRedisUrlSha256,
    "--permanent-staging-supabase-publishable-key-sha256":
      identities.permanentStagingSupabasePublishableKeySha256,
    "--production-database-resource-id":
      identities.productionDatabaseResourceId,
    "--production-database-url-sha256": identities.productionDatabaseUrlSha256,
    "--production-railway-environment-id":
      identities.productionRailwayEnvironmentId,
    "--production-railway-project-id": identities.productionRailwayProjectId,
    "--production-railway-service-id": identities.productionRailwayServiceId,
    "--production-redis-resource-id": identities.productionRedisResourceId,
    "--production-redis-url-sha256": identities.productionRedisUrlSha256,
    "--production-supabase-publishable-key-sha256":
      identities.productionSupabasePublishableKeySha256,
    "--railway-environment-id": identities.railwayEnvironmentId,
    "--railway-project-id": identities.railwayProjectId,
    "--railway-service-id": identities.railwayServiceId,
    "--redis-resource-id": identities.redisResourceId,
    "--redis-sentinel-file": files.sentinel,
    "--redis-url-file": files.redis,
    "--request-timeout-ms": "1000",
    "--runtime-stage-root": runtimeStageRoot,
    "--root-ca-file": files.rootCa,
    "--runtime-url-file": files.runtime,
    "--second-replay-receipt": files.secondReplay,
    "--shutdown-timeout-ms": "12000",
    "--source-evidence-signing-secret-file": files.evidenceSecret,
    "--startup-timeout-ms": "2000",
    "--supabase-publishable-key-file": files.publishable,
    "--supabase-url": identities.supabaseUrl,
  };

  const runtimeEnd = vi.fn(async () => undefined);
  const maintenanceEnd = vi.fn(async () => undefined);
  const runtimePool = {
    end: runtimeEnd,
    query: vi.fn(async (sql: string) => {
      if (sql.includes(":smoke */"))
        return {
          rows: [
            {
              effectiveRole: "pintpath_runtime",
              targetClass: "disposable-rehearsal",
              schemaVersion: "1",
              migrationState: "ready",
              authoritativeTables: "56",
              runtimeOperationsUsage: false,
              maintenanceApplicationUsage: true,
              maintenanceOperationsUsage: false,
              maintenanceUnexpectedMembership: false,
              replayedRequestCount: "1",
              replayedCompletedCount: "1",
              replayedSuppressedCount: "1",
              replayedRecipientSecretCount: "0",
              replayedAuthSessionCount: "0",
              replayedActiveEvidenceCount: "0",
            },
          ],
        };
      if (sql.includes(":auth-account */"))
        return {
          rows: [
            {
              id: authSubject,
              supabaseUserId: authSubject,
              email: authEmail,
              role: "user",
              subscriptionStatus: "free",
              status: "active",
              authProvider: "supabase",
              legalAcceptanceCurrent: true,
              privacySettingsPresent: true,
              activeVenueAssignmentCount: "0",
            },
          ],
        };
      if (sql.includes(":email-leakage */")) {
        return { rows: [{ otherAccountEmailPresent: false }] };
      }
      if (sql.includes(":session-cleanup */"))
        return {
          rows: [
            {
              userId: authSubject,
              providerSessionIdHash: hash(`supabase-session:${uuid("2")}`),
              revoked: true,
            },
          ],
        };
      throw new Error("unexpected runtime query");
    }),
  };
  const maintenancePool = {
    end: maintenanceEnd,
    query: vi.fn(async () => ({
      rows: [
        {
          effectiveRole: "pintpath_maintenance",
          applicationUsage: true,
          operationsUsage: false,
          runtimeMembership: false,
          unexpectedMembership: false,
        },
      ],
    })),
  };
  const transportClose = vi.fn(async () => undefined);
  const transportAssert = vi.fn(async () => undefined);
  const transport = {
    profile: "railway-stock-localhost-ca-v1",
    rootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
    sourceUrlAuthority: {
      hostname: "postgres-recovery.railway.internal",
      port: 5432,
    },
    resolvedAddress: "fd00::1",
    temporaryDirectory: root,
    passwordFileDirectory: root,
    passwordFileHost: "localhost",
    nodeConnection: {
      host: "::1",
      port: 5432,
      ssl: {
        ca: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
        servername: "localhost",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        checkServerIdentity: () => undefined,
      },
    },
    libpqEnvironment: {
      PGHOST: "localhost",
      PGHOSTADDR: "::1",
      PGPORT: "5432",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: files.rootCa,
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    },
    assertExact: transportAssert,
    close: transportClose,
  } as const;
  let child!: ChildFixture;
  child = new ChildFixture(() => queueMicrotask(() => child.exit(0, null)));
  let loggedOut = false;
  const fetchImpl = vi.fn(
    async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      const method = init?.method ?? "GET";
      if (url.endsWith("/startup")) {
        return new Response(JSON.stringify(probePayload("startup")), {
          status: 200,
        });
      }
      if (url.endsWith("/ready")) {
        return new Response(
          input.readyStatus === undefined
            ? JSON.stringify(probePayload("ready"))
            : "not ready",
          { status: input.readyStatus ?? 200 },
        );
      }
      if (url.includes("/auth/v1/token?grant_type=password")) {
        return new Response(
          JSON.stringify({
            access_token: providerToken,
            user: { id: authSubject, email: authEmail },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/business/auth/supabase-session")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              token: appToken,
              account: { id: authSubject, role: "user" },
              counterStaffAssignments: [],
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/business/account") && method === "GET") {
        if (loggedOut) return new Response("unauthorized", { status: 401 });
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              account: {
                id: authSubject,
                email: authEmail,
                role: "user",
                subscriptionStatus: "free",
                status: "active",
                authProvider: "supabase",
                legalAcceptanceCurrent: true,
              },
              access: {
                isAuthenticated: true,
                accountRole: "user",
                isAdminAccount: false,
                isAdmin: false,
                status: "free",
              },
              billing: null,
              counterStaffAssignments: [],
              counterStaffInvitations: [],
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/admin/status"))
        return new Response("forbidden", { status: 403 });
      if (url.endsWith("/api/business/account/delete-request")) {
        return new Response("writes disabled", { status: 503 });
      }
      if (url.endsWith("/api/business/auth/logout")) {
        loggedOut = true;
        return new Response(
          JSON.stringify({
            ok: true,
            data: { revoked: true, revokedDiscountPasses: 0 },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/auth/v1/logout?scope=local")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    },
  );
  let poolCount = 0;
  const childDirectories: string[] = [];
  const dependencies = {
    createPool: () => (poolCount++ === 0 ? runtimePool : maintenancePool),
    fetch: fetchImpl as typeof fetch,
    now: () => NOW,
    sleep: async () => undefined,
    spawn: vi.fn(() => child),
    openTransport: vi.fn(async () => transport) as never,
    createRuntimeStageBoundary: (
      _compiledArtifactRoot: string,
      stageRoot: string,
    ) => {
      const directory = fs.realpathSync(
        fs.mkdtempSync(path.join(stageRoot, "child-")),
      );
      childDirectories.push(directory);
      return {
        directory,
        nodeModulesRoot: path.join(root, "node_modules"),
        packageLockFile: path.join(root, "package-lock.json"),
        assertExact: () => undefined,
        close: () => undefined,
      };
    },
    removeTemporaryDirectory: (directory: string) => fs.rmdirSync(directory),
  };
  return {
    argv: Object.entries(values).flatMap(([flag, value]) => [flag, value]),
    dependencies,
    child,
    runtimeEnd,
    maintenanceEnd,
    transportClose,
    transportAssert,
    dist,
    childDirectories,
    compiledArtifactSha256,
    targetIdentitySha256,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (fs.existsSync(root)) {
      for (const directory of fs.globSync("**/", { cwd: root })) {
        fs.chmodSync(path.join(root, directory), 0o700);
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("recovered PostgreSQL application verifier", () => {
  it("rejects workspace dependency fallback outside the isolated stage", () => {
    const runtimeStageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-recovered-stage-root-")),
    );
    fs.chmodSync(runtimeStageRoot, 0o700);
    roots.push(runtimeStageRoot);
    const boundary = createReviewedRuntimeStageBoundary(
      path.join(fs.realpathSync(process.cwd()), "dist"),
      runtimeStageRoot,
    );
    const stagedDist = path.join(boundary.directory, "dist");
    const entrypoint = path.join(stagedDist, "dependency-probe.mjs");
    try {
      fs.mkdirSync(stagedDist, { mode: 0o700 });
      fs.writeFileSync(
        entrypoint,
        'import { z } from "zod"; process.stdout.write(z.string().parse("resolved"));\n',
        { mode: 0o400 },
      );
      boundary.assertExact();
      const result = childProcess.spawnSync(
        process.execPath,
        ["--frozen-intrinsics", "--disable-proto=throw", entrypoint],
        {
          cwd: boundary.directory,
          encoding: "utf8",
          env: { PATH: process.env.PATH },
          timeout: 10_000,
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
      boundary.assertExact();
    } finally {
      boundary.close();
      if (fs.existsSync(entrypoint)) fs.unlinkSync(entrypoint);
      if (fs.existsSync(stagedDist)) fs.rmdirSync(stagedDist);
      if (fs.existsSync(boundary.directory)) fs.rmdirSync(boundary.directory);
    }
  });

  it("runs the complete compiled-app ceremony and returns one canonical self-hashed receipt", async () => {
    const fixture = topLevelFixture();
    const receipt = await verifyRecoveredPostgresApplication(
      fixture.argv,
      fixture.dependencies,
    );
    const { receiptSha256, ...withoutHash } = receipt;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: "pintpath-recovered-postgres-application-smoke",
      status: "verified",
      ok: true,
      candidateSha: CANDIDATE,
      targetIdentitySha256: fixture.targetIdentitySha256,
      compiledArtifactSha256: fixture.compiledArtifactSha256,
      compiledArtifactExact: true,
      runtimeDependencyBoundaryExact: true,
      runtimeDependencyPackageCount: 1,
      runtimeDependencyFileCount: 2,
      startupProbeExact: true,
      readyProbeExact: true,
      authenticatedBoundaryExact: true,
      authSubjectSha256: hash(uuid("1")),
      authEmailSha256: hash("recovery-user@example.invalid"),
      supabasePublishableKeySha256: hash(`sb_publishable_${"r".repeat(32)}`),
      noPrivateDataLeakageExact: true,
      deletionMutationDeniedExact: true,
      crossProjectTokenParserRejectedLocallyExact: true,
      childTerminatedExact: true,
      databaseAuthoritiesClosedExact: true,
      transportClosedExact: true,
    });
    expect(receiptSha256).toBe(hash(canonicalPostgresBackupJson(withoutHash)));
    expect(Date.parse(String(receipt.completedAt))).toBeGreaterThan(
      Date.parse(String(receipt.applicationReadyAt)),
    );
    expect(fixture.child.exitCode).toBe(0);
    expect(fixture.runtimeEnd).toHaveBeenCalledOnce();
    expect(fixture.maintenanceEnd).toHaveBeenCalledOnce();
    expect(fixture.transportClose).toHaveBeenCalledOnce();
    expect(fixture.transportAssert).toHaveBeenCalled();
  });

  it("terminates the child and closes every authority when readiness fails after spawn", async () => {
    const fixture = topLevelFixture({ readyStatus: 500 });
    await expect(
      verifyRecoveredPostgresApplication(fixture.argv, fixture.dependencies),
    ).rejects.toThrow("ready_non_2xx");
    expect(fixture.child.exitCode).toBe(0);
    expect(fixture.runtimeEnd).toHaveBeenCalledOnce();
    expect(fixture.maintenanceEnd).toHaveBeenCalledOnce();
    expect(fixture.transportClose).toHaveBeenCalledOnce();
  });

  it("removes the empty private stage after a pre-copy source failure", async () => {
    const fixture = topLevelFixture();
    const displaced = `${fixture.dist}-missing`;
    fs.renameSync(fixture.dist, displaced);
    await expect(
      verifyRecoveredPostgresApplication(fixture.argv, fixture.dependencies),
    ).rejects.toThrow();
    expect(fixture.childDirectories).toHaveLength(1);
    expect(fs.existsSync(fixture.childDirectories[0]!)).toBe(false);
  });

  it("removes a partially copied stage after a mid-copy source failure", async () => {
    const fixture = topLevelFixture();
    fs.chmodSync(path.join(fixture.dist, "viewer", "index.html"), 0o666);
    await expect(
      verifyRecoveredPostgresApplication(fixture.argv, fixture.dependencies),
    ).rejects.toThrow("compiled_artifact_unsafe");
    expect(fixture.childDirectories).toHaveLength(1);
    expect(fs.existsSync(fixture.childDirectories[0]!)).toBe(false);
  });

  it("boots the held private artifact snapshot when the source is replaced after staging", async () => {
    const fixture = topLevelFixture();
    const originalSpawn = fixture.dependencies.spawn;
    const sourceEntrypoint = path.join(fixture.dist, "src", "server.js");
    fixture.dependencies.spawn = vi.fn((executable, args, options) => {
      fs.writeFileSync(sourceEntrypoint, "replacement-after-staging\n", {
        mode: 0o644,
      });
      const stagedEntrypoint = String(args[0]);
      expect(stagedEntrypoint).not.toBe(sourceEntrypoint);
      expect(stagedEntrypoint).toContain(`${path.sep}child-`);
      expect(fs.readFileSync(stagedEntrypoint, "utf8")).toBe("src/server.js\n");
      return originalSpawn(executable, args, options);
    });
    const receipt = await verifyRecoveredPostgresApplication(
      fixture.argv,
      fixture.dependencies,
    );
    expect(receipt).toMatchObject({
      compiledArtifactExact: true,
      candidateArtifactBindingExact: true,
      childTerminatedExact: true,
    });
  });

  it("boots only the staged dependency snapshot when a source dependency is changed after staging", async () => {
    const fixture = topLevelFixture();
    const originalSpawn = fixture.dependencies.spawn;
    const expectedDependencyArtifactSha256 = hashRuntimeDependencyArtifact(
      fixture.dist,
    );
    const sourceDependency = path.join(
      path.dirname(fixture.dist),
      "node_modules",
      "fixture-runtime",
      "index.js",
    );
    fixture.dependencies.spawn = vi.fn((executable, args, options) => {
      fs.writeFileSync(
        sourceDependency,
        'export const runtimeFixture = "substituted";\n',
        { mode: 0o644 },
      );
      const stagedEntrypoint = String(args[0]);
      const stagedDependency = path.join(
        path.dirname(path.dirname(stagedEntrypoint)),
        "node_modules",
        "fixture-runtime",
        "index.js",
      );
      expect(stagedDependency).not.toBe(sourceDependency);
      expect(fs.readFileSync(stagedDependency, "utf8")).toBe(
        'export const runtimeFixture = "reviewed";\n',
      );
      return originalSpawn(executable, args, options);
    });
    const receipt = await verifyRecoveredPostgresApplication(
      fixture.argv,
      fixture.dependencies,
    );
    expect(receipt).toMatchObject({
      runtimeDependencyArtifactSha256: expectedDependencyArtifactSha256,
      runtimeDependencyBoundaryExact: true,
      childTerminatedExact: true,
    });
  });

  it("retains and fails closed when the held staged container is substituted before cleanup", async () => {
    const fixture = topLevelFixture();
    const replacingChild = new CleanupReplacingChild();
    fixture.dependencies.spawn = vi.fn((_executable, args) => {
      replacingChild.stagedContainer = path.dirname(
        path.dirname(path.dirname(String(args[0]))),
      );
      return replacingChild;
    });
    await expect(
      verifyRecoveredPostgresApplication(fixture.argv, fixture.dependencies),
    ).rejects.toThrow("cleanup_failed");
    expect(replacingChild.replacementContainer).not.toBeNull();
    expect(
      fs.readFileSync(
        path.join(replacingChild.replacementContainer!, "do-not-delete"),
        "utf8",
      ),
    ).toBe("replacement\n");
    expect(replacingChild.stagedContainer).not.toBeNull();
    expect(
      fs.existsSync(
        path.join(replacingChild.stagedContainer!, "dist", "src", "server.js"),
      ),
    ).toBe(true);
    expect(fixture.runtimeEnd).toHaveBeenCalledOnce();
    expect(fixture.maintenanceEnd).toHaveBeenCalledOnce();
    expect(fixture.transportClose).toHaveBeenCalledOnce();
  });

  it("accepts only distinct disposable provider and role identities", () => {
    expect(() =>
      assertRecoveryIdentityBoundary(identityFixture()),
    ).not.toThrow();

    const productionCredential =
      identityFixture().productionSupabasePublishableKeySha256;
    expect(() =>
      assertRecoveryIdentityBoundary(
        identityFixture({
          supabasePublishableKeySha256: productionCredential,
          expectedSupabasePublishableKeySha256: productionCredential,
        }),
      ),
    ).toThrow("supabase_credential_reused");

    const fixture = identityFixture();
    expect(() =>
      assertRecoveryIdentityBoundary({
        ...fixture,
        maintenanceUrl: fixture.runtimeUrl,
        maintenanceUrlSha256: fixture.runtimeUrlSha256,
      }),
    ).toThrow("database_identity_reused");

    expect(() =>
      assertRecoveryIdentityBoundary(
        identityFixture({
          productionRailwayProjectId: identityFixture().railwayProjectId,
        }),
      ),
    ).toThrow("railway_identity_reused");
  });

  it("binds every replay and runtime claim to the exact candidate", () => {
    expect(
      recoveryCandidateBindingsExact(CANDIDATE, [CANDIDATE, CANDIDATE]),
    ).toBe(true);
    expect(
      recoveryCandidateBindingsExact(CANDIDATE, [CANDIDATE, "b".repeat(40)]),
    ).toBe(false);
  });

  it("rejects cross-project access tokens locally", () => {
    const parsed = assertDisposableSupabaseAccessTokenIdentity(
      jwt(),
      SUPABASE_URL,
      NOW,
    );
    expect(parsed.subject).toBe(uuid("1"));
    expect(proveCrossProjectTokenRejectedLocally(SUPABASE_URL, NOW)).toBe(true);
    expect(() =>
      assertDisposableSupabaseAccessTokenIdentity(
        jwt({
          issuer: "https://zyxwvutsrqponmlkjihg.supabase.co/auth/v1",
        }),
        SUPABASE_URL,
        NOW,
      ),
    ).toThrow("auth_token_identity_mismatch");
  });

  it("treats disposable Supabase authentication failure as terminal", async () => {
    await expect(
      signInDisposableSupabase({
        fetch: async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
          }),
        supabaseUrl: SUPABASE_URL,
        publishableKey: `sb_publishable_${"r".repeat(32)}`,
        email: "recovery-user@example.invalid",
        password: "disposable-password",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("supabase_auth_failed");
  });

  it("keeps the request deadline through response-body consumption and cancels a stalled body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"access_token":"partial'),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const startedAt = Date.now();
    await expect(
      signInDisposableSupabase({
        fetch: async () => new Response(body, { status: 200 }),
        supabaseUrl: SUPABASE_URL,
        publishableKey: `sb_publishable_${"r".repeat(32)}`,
        email: "recovery-user@example.invalid",
        password: "disposable-password",
        timeoutMs: 20,
      }),
    ).rejects.toThrow("supabase_auth_failed");
    expect(cancelled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("accepts exact startup and ready probes and rejects non-2xx or timeouts", async () => {
    await expect(
      waitForRecoveryProbe({
        fetch: async () =>
          new Response(JSON.stringify(probePayload("startup")), {
            status: 200,
          }),
        url: "http://127.0.0.1:3001/startup",
        route: "startup",
        candidateSha: CANDIDATE,
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 100,
        now: () => NOW,
        sleep: async () => undefined,
        childExited: () => false,
        outputExceeded: () => false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      waitForRecoveryProbe({
        fetch: async () =>
          new Response(JSON.stringify(probePayload("ready")), { status: 200 }),
        url: "http://127.0.0.1:3001/ready",
        route: "ready",
        candidateSha: CANDIDATE,
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 100,
        now: () => NOW,
        sleep: async () => undefined,
        childExited: () => false,
        outputExceeded: () => false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      waitForRecoveryProbe({
        fetch: async () => new Response("denied", { status: 401 }),
        url: "http://127.0.0.1:3001/startup",
        route: "startup",
        candidateSha: CANDIDATE,
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 100,
        now: () => NOW,
        sleep: async () => undefined,
        childExited: () => false,
        outputExceeded: () => false,
      }),
    ).rejects.toThrow("startup_non_2xx");

    await expect(
      waitForRecoveryProbe({
        fetch: async () => new Response("not ready", { status: 500 }),
        url: "http://127.0.0.1:3001/ready",
        route: "ready",
        candidateSha: CANDIDATE,
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 100,
        now: () => NOW,
        sleep: async () => undefined,
        childExited: () => false,
        outputExceeded: () => false,
      }),
    ).rejects.toThrow("ready_non_2xx");

    let nowMs = NOW.getTime();
    await expect(
      waitForRecoveryProbe({
        fetch: async () => {
          throw new Error("offline");
        },
        url: "http://127.0.0.1:3001/ready",
        route: "ready",
        candidateSha: CANDIDATE,
        startupTimeoutMs: 10,
        requestTimeoutMs: 5,
        now: () => new Date(nowMs),
        sleep: async (milliseconds) => {
          nowMs += milliseconds;
        },
        childExited: () => false,
        outputExceeded: () => false,
      }),
    ).rejects.toThrow("ready_timeout");

    nowMs = NOW.getTime();
    await expect(
      waitForRecoveryProbe({
        fetch: async () => new Response("warming", { status: 503 }),
        url: "http://127.0.0.1:3001/startup",
        route: "startup",
        candidateSha: CANDIDATE,
        startupTimeoutMs: 10,
        requestTimeoutMs: 5,
        now: () => new Date(nowMs),
        sleep: async (milliseconds) => {
          nowMs += milliseconds;
        },
        childExited: () => false,
        outputExceeded: () => false,
      }),
    ).rejects.toThrow("startup_timeout");
  });

  it("requires the exact restored user boundary without admin, venue, or private leakage", () => {
    const subject = uuid("1");
    const email = "recovery-user@example.invalid";
    const payload = {
      ok: true,
      data: {
        account: {
          id: subject,
          email,
          role: "user",
          subscriptionStatus: "free",
          status: "active",
          authProvider: "supabase",
          legalAcceptanceCurrent: true,
        },
        access: {
          isAuthenticated: true,
          accountRole: "user",
          isAdminAccount: false,
          isAdmin: false,
          status: "free",
        },
        billing: null,
        counterStaffAssignments: [],
        counterStaffInvitations: [],
      },
    };
    expect(() =>
      assertAuthenticatedAccountBoundary({
        payload,
        expectedSubject: subject,
        expectedEmail: email,
        forbiddenValues: ["provider-secret"],
      }),
    ).not.toThrow();
    expect(() =>
      assertAuthenticatedAccountBoundary({
        payload: {
          ...payload,
          data: { ...payload.data, passwordHash: "private" },
        },
        expectedSubject: subject,
        expectedEmail: email,
        forbiddenValues: [],
      }),
    ).toThrow("authenticated_boundary_invalid");
  });

  it("terminates the child gracefully and treats termination timeout as failure", async () => {
    let graceful!: ChildFixture;
    graceful = new ChildFixture((signal) => {
      expect(signal).toBe("SIGTERM");
      queueMicrotask(() => graceful.exit(0, null));
    });
    await expect(
      terminateRecoveredApplicationChild(graceful, 100),
    ).resolves.toBe(true);

    const stalled = new ChildFixture(() => undefined);
    await expect(
      terminateRecoveredApplicationChild(stalled, 5),
    ).rejects.toThrow("child_termination_timeout");
  });

  it("makes pool and transport close rejection or stalls failure-dominant", async () => {
    await expect(
      closeRecoveryAuthoritiesBoundedly({
        pools: [
          { query: async () => ({ rows: [] }), end: async () => undefined },
        ],
        transport: { close: async () => undefined },
        timeoutMs: 50,
      }),
    ).resolves.toBe(true);
    await expect(
      closeRecoveryAuthoritiesBoundedly({
        pools: [
          {
            query: async () => ({ rows: [] }),
            end: async () => {
              throw new Error("close rejected");
            },
          },
        ],
        transport: { close: async () => undefined },
        timeoutMs: 50,
      }),
    ).rejects.toThrow("authority_close_failed");
    await expect(
      closeRecoveryAuthoritiesBoundedly({
        pools: [
          {
            query: async () => ({ rows: [] }),
            end: async () => new Promise<void>(() => undefined),
          },
        ],
        transport: { close: async () => undefined },
        timeoutMs: 5,
      }),
    ).rejects.toThrow("authority_close_failed");
  });

  it("hashes the complete compiled artifact deterministically", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-artifact-test-")),
    );
    roots.push(root);
    const dist = path.join(root, "dist");
    for (const filename of [
      "src/app.js",
      "src/config/env.js",
      "src/db/postgres-schema.sql",
      "src/db/schema.sql",
      "src/server.js",
      "viewer/index.html",
    ]) {
      const absolute = path.join(dist, filename);
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o755 });
      fs.writeFileSync(absolute, `${filename}\n`, { mode: 0o644 });
    }
    const first = hashCompiledApplicationArtifact(dist);
    expect(hashCompiledApplicationArtifact(dist)).toBe(first);
    fs.appendFileSync(path.join(dist, "src", "app.js"), "changed\n");
    expect(hashCompiledApplicationArtifact(dist)).not.toBe(first);
  });
});
