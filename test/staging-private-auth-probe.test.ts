import fs from "node:fs";
import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STAGING_PRIVATE_AUTH_PROBE_LOCK,
  buildPsqlEnvironment,
  classifyPostgresPsqlResult,
  classifyStructuredPostgresAttempt,
  closePostgresClientBounded,
  createCandidateHandoffMarker,
  createCandidateOwnerMarker,
  createScramSha256Verifier,
  probeRedisProtocol,
  runStagingPrivateAuthProbe,
  stagingPrivateAuthProbeInternals,
  type CapturedProcessResult,
  type ProvisionLifecycleLock,
  type StagingPrivateAuthProbeDependencies,
  type StagingPrivateAuthProbeReceipt,
} from "../scripts/staging-private-auth-probe.js";

const deploymentId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";
const probeServiceId = "848491bf-6ff5-4765-bfaa-dad75178f345";
const adminUrl =
  "postgresql://postgres:fixture_admin_password@postgres-staging.railway.internal:5432/railway?uselibpqcompat=true&sslmode=require";
const oldRuntimeUrl =
  "postgresql://pintpath_staging_runtime_login:fixture_runtime_password@postgres-staging.railway.internal:5432/pintpath_staging?uselibpqcompat=true&sslmode=require";
const candidateLogin = "pintpath_staging_runtime_login_20260809a";
const candidatePassword = "Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEFG";
const candidateOwnerSecret =
  "Ownership_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdef";
const currentRuntimeUrl = oldRuntimeUrl.replace(
  "pintpath_staging_runtime_login:fixture_runtime_password",
  `${candidateLogin}:${candidatePassword}`,
);
const redisUrl =
  "redis://default:fixture_redis_password@redis.railway.internal:6379";

function validEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    RAILWAY_PROJECT_ID: STAGING_PRIVATE_AUTH_PROBE_LOCK.projectId,
    RAILWAY_ENVIRONMENT_ID: STAGING_PRIVATE_AUTH_PROBE_LOCK.environmentId,
    RAILWAY_SERVICE_ID: probeServiceId,
    RAILWAY_DEPLOYMENT_ID: deploymentId,
    STAGING_AUTH_PROBE_EXPECTED_SERVICE_ID: probeServiceId,
    STAGING_AUTH_PROBE_POSTGRES_RESOURCE_ID:
      STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresResourceId,
    STAGING_AUTH_PROBE_REDIS_RESOURCE_ID:
      STAGING_PRIVATE_AUTH_PROBE_LOCK.redisResourceId,
    STAGING_AUTH_PROBE_POSTGRES_ADMIN_URL: adminUrl,
    STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: oldRuntimeUrl,
    STAGING_AUTH_PROBE_REDIS_URL: redisUrl,
    STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_LOGIN: candidateLogin,
    STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_PASSWORD: candidatePassword,
    STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_OWNER_SECRET: candidateOwnerSecret,
    STAGING_AUTH_PROBE_RUNTIME_IDENTITY: "predecessor",
    ...overrides,
  };
}

interface HarnessOptions {
  env?: Record<string, string>;
  postgresAttempt?: StagingPrivateAuthProbeDependencies["attemptPostgres"];
  redisAttempt?: StagingPrivateAuthProbeDependencies["attemptRedis"];
  readiness?: StagingPrivateAuthProbeDependencies["checkRuntimeReadiness"];
  provision?: StagingPrivateAuthProbeDependencies["provisionRuntimeRole"];
  inspect?: StagingPrivateAuthProbeDependencies["inspectRuntimeRoleOwnership"];
  finalize?: StagingPrivateAuthProbeDependencies["finalizeRuntimeRoleOwnership"];
  inspectHandoff?: StagingPrivateAuthProbeDependencies["inspectRuntimeRoleHandoff"];
  cleanup?: StagingPrivateAuthProbeDependencies["cleanupRuntimeRole"];
  acquireLifecycleLock?: StagingPrivateAuthProbeDependencies["acquireProvisionLifecycleLock"];
  lifecycleLock?: ProvisionLifecycleLock;
  retire?: StagingPrivateAuthProbeDependencies["retireRuntimeRole"];
  validatePostgresClient?: StagingPrivateAuthProbeDependencies["validatePostgresClient"];
  sleepAdvanceMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
  let clock = 10_000;
  const output: string[] = [];
  const lifecycleLock = options.lifecycleLock ?? {
    verify: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
  const dependencies: Partial<StagingPrivateAuthProbeDependencies> = {
    env: options.env ?? validEnvironment(),
    now: () => new Date("2026-08-09T10:11:12.000Z"),
    monotonicNow: () => clock,
    sleep: vi.fn(async (milliseconds: number) => {
      clock += options.sleepAdvanceMs ?? milliseconds;
    }),
    randomBytes: () => Buffer.alloc(16, 7),
    validatePostgresClient:
      options.validatePostgresClient ?? vi.fn(async () => true),
    attemptPostgres: options.postgresAttempt ?? vi.fn(async () => "accepted"),
    attemptRedis: options.redisAttempt ?? vi.fn(async () => "accepted"),
    checkRuntimeReadiness: options.readiness ?? vi.fn(async () => "ready"),
    provisionRuntimeRole: options.provision ?? vi.fn(async () => "created"),
    inspectRuntimeRoleOwnership: options.inspect ?? vi.fn(async () => "owned"),
    finalizeRuntimeRoleOwnership:
      options.finalize ?? vi.fn(async () => "handed-off"),
    inspectRuntimeRoleHandoff:
      options.inspectHandoff ?? vi.fn(async () => "handed-off"),
    cleanupRuntimeRole: options.cleanup ?? vi.fn(async () => "cleaned"),
    acquireProvisionLifecycleLock:
      options.acquireLifecycleLock ?? vi.fn(async () => lifecycleLock),
    retireRuntimeRole: options.retire ?? vi.fn(async () => true),
    writeOutput: (value) => output.push(value),
  };
  return { dependencies, lifecycleLock, output };
}

function onlyReceipt(output: string[]): StagingPrivateAuthProbeReceipt {
  expect(output).toHaveLength(1);
  expect(output[0]!.endsWith("\n")).toBe(true);
  return JSON.parse(output[0]!) as StagingPrivateAuthProbeReceipt;
}

function processResult(
  overrides: Partial<CapturedProcessResult> = {},
): CapturedProcessResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnFailed: false,
    outputOverflow: false,
    ...overrides,
  };
}

function respCommand(parts: readonly string[]): string {
  return `*${parts.length}\r\n${parts
    .map((part) => `$${Buffer.byteLength(part, "utf8")}\r\n${part}\r\n`)
    .join("")}`;
}

async function probeFakeRedis(
  behavior: "accepted" | "wrongpass" | "noauth" | "timeout" | "close",
): Promise<{ result: string; received: string }> {
  let received = "";
  const server = net.createServer((socket) => {
    let authenticationHandled = false;
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (!authenticationHandled) {
        authenticationHandled = true;
        if (behavior === "wrongpass")
          socket.write("-WRONGPASS invalid credentials\r\n");
        else if (behavior === "noauth")
          socket.write("-NOAUTH Authentication required\r\n");
        else if (behavior === "close") socket.destroy();
        else if (behavior === "accepted") socket.write("+OK\r\n");
        return;
      }
      if (behavior === "accepted") socket.write("+PONG\r\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fake Redis did not bind TCP.");
  try {
    const result = await probeRedisProtocol(
      {
        hostname: "127.0.0.1",
        port: address.port,
        username: "default",
        password: candidatePassword,
      },
      behavior === "timeout" ? 1_000 : 500,
    );
    return { result, received };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("staging private authentication probe", () => {
  it("uses psql only for PG17 require_auth acceptance and never parses startup prose", () => {
    expect(classifyPostgresPsqlResult(processResult({ exitCode: 0 }))).toBe(
      "accepted",
    );
    expect(
      classifyPostgresPsqlResult(
        processResult({ stderr: "psql: error: 28P01\n" }),
      ),
    ).toBe("inconclusive");
    expect(
      classifyPostgresPsqlResult(processResult({ stderr: "FATAL: 28000\n" })),
    ).toBe("inconclusive");
    expect(
      classifyPostgresPsqlResult(
        processResult({
          stderr: "password authentication failed",
        }),
      ),
    ).toBe("inconclusive");
    expect(
      classifyPostgresPsqlResult(processResult({ stderr: "NOAUTH 28P0X" })),
    ).toBe("inconclusive");
    expect(
      classifyPostgresPsqlResult(
        processResult({
          stderr: "28P01",
          timedOut: true,
        }),
      ),
    ).toBe("inconclusive");
    expect(
      classifyPostgresPsqlResult(
        processResult({
          stderr: "28P01",
          outputOverflow: true,
        }),
      ),
    ).toBe("inconclusive");
  });

  it("uses structured PG errors for rejection and refuses trust-auth acceptance", () => {
    expect(
      classifyStructuredPostgresAttempt({
        connected: true,
        saslObserved: true,
        errorCode: "",
      }),
    ).toBe("accepted");
    expect(
      classifyStructuredPostgresAttempt({
        connected: true,
        saslObserved: false,
        errorCode: "",
      }),
    ).toBe("inconclusive");
    expect(
      classifyStructuredPostgresAttempt({
        connected: false,
        saslObserved: true,
        errorCode: "28P01",
      }),
    ).toBe("rejected");
    expect(
      classifyStructuredPostgresAttempt({
        connected: false,
        saslObserved: false,
        errorCode: "28000",
      }),
    ).toBe("rejected");
    expect(
      classifyStructuredPostgresAttempt({
        connected: false,
        saslObserved: false,
        errorCode: "ECONNREFUSED",
      }),
    ).toBe("inconclusive");
  });

  it("requires every least-privilege login-role attribute", () => {
    const restricted = {
      canLogin: true,
      inheritsMembership: true,
      isSuperuser: false,
      canCreateDatabase: false,
      canCreateRole: false,
      canReplicate: false,
      canBypassRls: false,
    };

    expect(
      stagingPrivateAuthProbeInternals.runtimeRoleIsRestricted(restricted),
    ).toBe(true);
    for (const unsafe of [
      { canLogin: false },
      { inheritsMembership: false },
      { isSuperuser: true },
      { canCreateDatabase: true },
      { canCreateRole: true },
      { canReplicate: true },
      { canBypassRls: true },
    ]) {
      expect(
        stagingPrivateAuthProbeInternals.runtimeRoleIsRestricted({
          ...restricted,
          ...unsafe,
        }),
      ).toBe(false);
    }
  });

  it("keeps transient runtime catalog failures inconclusive", () => {
    expect(
      stagingPrivateAuthProbeInternals.classifyRuntimeReadinessResult({
        ready: false,
        failures: ["catalog_check_failed"],
      }),
    ).toBe("inconclusive");
    expect(
      stagingPrivateAuthProbeInternals.classifyRuntimeReadinessResult({
        ready: false,
        failures: ["runtime_role_unsafe"],
      }),
    ).toBe("not-ready");
    expect(
      stagingPrivateAuthProbeInternals.classifyRuntimeReadinessResult({
        ready: true,
        failures: [],
      }),
    ).toBe("ready");
  });

  it("bounds structured PG client shutdown and force-destroys a stalled stream", async () => {
    const destroy = vi.fn();
    const stalledEnd = vi.fn(() => new Promise<void>(() => undefined));

    await closePostgresClientBounded(
      {
        end: stalledEnd,
        connection: { stream: { destroy } },
      },
      5,
    );

    expect(stalledEnd).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);

    const cleanDestroy = vi.fn();
    await closePostgresClientBounded(
      {
        end: vi.fn(async () => undefined),
        connection: { stream: { destroy: cleanDestroy } },
      },
      50,
    );
    expect(cleanDestroy).not.toHaveBeenCalled();

    const rejectedDestroy = vi.fn();
    await closePostgresClientBounded(
      {
        end: vi.fn(async () => {
          throw new Error("closed transport");
        }),
        connection: { stream: { destroy: rejectedDestroy } },
      },
      50,
    );
    expect(rejectedDestroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the readiness URL out of child arguments and accepts only fixed worker status", async () => {
    const runner = vi.fn(async () =>
      processResult({ exitCode: 0, stdout: "ready\n" }),
    );

    await expect(
      stagingPrivateAuthProbeInternals.checkRuntimeReadiness(
        oldRuntimeUrl,
        15_000,
        runner,
      ),
    ).resolves.toBe("ready");
    const request = runner.mock.calls[0]![0];
    expect(request.arguments.join(" ")).not.toContain(
      "fixture_runtime_password",
    );
    expect(request.arguments.join(" ")).not.toContain(oldRuntimeUrl);
    expect(Object.values(request.environment)).toContain(oldRuntimeUrl);
    expect(request.environment).not.toHaveProperty("DEBUG");
    expect(request.environment).not.toHaveProperty("NODE_OPTIONS");

    runner.mockResolvedValueOnce(
      processResult({ exitCode: 0, stdout: "ready\n", stderr: "warning\n" }),
    );
    await expect(
      stagingPrivateAuthProbeInternals.checkRuntimeReadiness(
        oldRuntimeUrl,
        15_000,
        runner,
      ),
    ).resolves.toBe("inconclusive");
  });

  it("selects an explicit source or compiled readiness-worker execution path", () => {
    const source = stagingPrivateAuthProbeInternals.readinessWorkerInvocation(
      "/workspace/scripts/staging-private-auth-probe.ts",
    );
    expect(source).toEqual({
      command: process.execPath,
      arguments: [
        "/workspace/node_modules/tsx/dist/cli.mjs",
        "/workspace/scripts/lib/staging-private-auth-readiness-worker.ts",
      ],
    });

    const compiled = stagingPrivateAuthProbeInternals.readinessWorkerInvocation(
      "/workspace/dist/scripts/staging-private-auth-probe.js",
    );
    expect(compiled).toEqual({
      command: process.execPath,
      arguments: [
        "/workspace/dist/scripts/lib/staging-private-auth-readiness-worker.js",
      ],
    });
    expect(compiled?.arguments.join(" ")).not.toContain("node_modules");
    expect(compiled?.arguments.join(" ")).not.toContain(".ts");
    expect(
      stagingPrivateAuthProbeInternals.readinessWorkerInvocation(
        "/workspace/scripts/staging-private-auth-probe.mjs",
      ),
    ).toBeNull();
  });

  it("hard-kills an isolated child whose established socket never completes", async () => {
    let accepted = false;
    let closed = false;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      accepted = true;
      sockets.add(socket);
      socket.once("close", () => {
        closed = true;
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Stalled readiness server did not bind TCP.");
    }

    try {
      const result = await stagingPrivateAuthProbeInternals.runCapturedProcess({
        command: process.execPath,
        arguments: [
          "-e",
          `const net=require("node:net");const socket=net.createConnection({host:"127.0.0.1",port:${address.port}});socket.on("error",()=>{});setInterval(()=>{},1000);`,
        ],
        environment: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
        },
        stdin: "",
        timeoutMs: 1_000,
      });

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(accepted).toBe(true);
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1_000 });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("classifies real bounded RESP AUTH replies without leaking the password", async () => {
    vi.stubEnv("DEBUG", "ioredis:*");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    for (const [behavior, expected] of [
      ["accepted", "accepted"],
      ["wrongpass", "rejected"],
      ["noauth", "inconclusive"],
      ["timeout", "inconclusive"],
      ["close", "inconclusive"],
    ] as const) {
      const probe = await probeFakeRedis(behavior);
      expect(probe.result).toBe(expected);
      const authentication = respCommand([
        "AUTH",
        "default",
        candidatePassword,
      ]);
      const ping = respCommand(["PING"]);
      expect(probe.received).toBe(
        behavior === "accepted" ? authentication + ping : authentication,
      );
    }

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("builds a narrowed PG17 libpq environment without placing credentials in arguments", () => {
    const environment = buildPsqlEnvironment(oldRuntimeUrl, {
      STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
    });

    expect(environment).toMatchObject({
      PGHOST: STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresPrivateHost,
      PGPORT: "5432",
      PGDATABASE: "pintpath_staging",
      PGREQUIREAUTH: "scram-sha-256",
      PGSSLMODE: "require",
      STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
    });
    expect(environment?.PGPASSWORD).toBe("fixture_runtime_password");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("RAILWAY_PROJECT_ID");
    expect(
      buildPsqlEnvironment(oldRuntimeUrl, { PGPASSWORD: "fixture_override" }),
    ).toBeNull();
  });

  it("derives a valid SCRAM verifier locally without embedding the password", () => {
    const verifier = createScramSha256Verifier(
      candidatePassword,
      Buffer.alloc(16, 3),
    );

    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/,
    );
    expect(verifier).not.toContain(candidatePassword);
    expect(createScramSha256Verifier("short", Buffer.alloc(16))).toBeNull();
  });

  it("derives a stable marker from an independent owner secret for crash recovery", () => {
    const first = createCandidateOwnerMarker(
      candidateOwnerSecret,
      candidateLogin,
    );
    const retry = createCandidateOwnerMarker(
      candidateOwnerSecret,
      candidateLogin,
    );
    const otherOwnerSecret = createCandidateOwnerMarker(
      `${candidateOwnerSecret.slice(0, -1)}Z`,
      candidateLogin,
    );
    const otherLogin = createCandidateOwnerMarker(
      candidateOwnerSecret,
      `${candidateLogin}b`,
    );
    const handoff = createCandidateHandoffMarker(
      candidateOwnerSecret,
      candidateLogin,
    );

    expect(first).toMatch(/^pintpath-staging-auth-probe:v1:[A-Za-z0-9_-]{43}$/);
    expect(retry).toBe(first);
    expect(otherOwnerSecret).not.toBe(first);
    expect(otherLogin).not.toBe(first);
    expect(handoff).toMatch(
      /^pintpath-staging-auth-probe:handoff-v1:[A-Za-z0-9_-]{43}$/,
    );
    expect(handoff).not.toBe(first);
    expect(first).not.toContain(candidateOwnerSecret);
    expect(first).not.toContain(candidatePassword);
  });

  it("requires an independent strong owner secret before provisioning I/O", async () => {
    for (const invalidOwnerSecret of [
      "",
      "short",
      candidatePassword,
      "fixture_admin_password",
      "fixture_runtime_password",
      "fixture_redis_password",
    ]) {
      const attempt = vi.fn(async () => "accepted" as const);
      const provision = vi.fn(async () => "created" as const);
      const harness = createHarness({
        env: validEnvironment({
          STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_OWNER_SECRET: invalidOwnerSecret,
        }),
        postgresAttempt: attempt,
        provision,
      });

      await expect(
        runStagingPrivateAuthProbe(
          "provision-runtime-candidate",
          "postgres-runtime",
          harness.dependencies,
        ),
      ).resolves.toBe(1);
      expect(
        onlyReceipt(harness.output).identity.runtimeCandidateOwnerSecretValid,
      ).toBe(false);
      expect(attempt).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      if (invalidOwnerSecret)
        expect(harness.output[0]).not.toContain(invalidOwnerSecret);
    }

    for (const [urlName, originalSecret, reusedSecret] of [
      [
        "STAGING_AUTH_PROBE_POSTGRES_ADMIN_URL",
        "fixture_admin_password",
        "AdminCredential_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdef",
      ],
      [
        "STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL",
        "fixture_runtime_password",
        "RuntimeCredential_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdef",
      ],
      [
        "STAGING_AUTH_PROBE_REDIS_URL",
        "fixture_redis_password",
        "RedisCredential_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdef",
      ],
    ] as const) {
      const baseUrl = validEnvironment()[urlName]!;
      const attempt = vi.fn(async () => "accepted" as const);
      const harness = createHarness({
        env: validEnvironment({
          [urlName]: baseUrl.replace(originalSecret, reusedSecret),
          STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_OWNER_SECRET: reusedSecret,
        }),
        postgresAttempt: attempt,
      });
      await expect(
        runStagingPrivateAuthProbe(
          "provision-runtime-candidate",
          "postgres-runtime",
          harness.dependencies,
        ),
      ).resolves.toBe(1);
      expect(
        onlyReceipt(harness.output).identity.runtimeCandidateOwnerSecretValid,
      ).toBe(false);
      expect(attempt).not.toHaveBeenCalled();
      expect(harness.output[0]).not.toContain(reusedSecret);
    }
  });

  it("provisions with a verifier-only SQL seam and never hands plaintext to the mutation", async () => {
    const runner = vi.fn(async () =>
      processResult({ exitCode: 0, stdout: "created\n" }),
    );
    const verifier = createScramSha256Verifier(
      candidatePassword,
      Buffer.alloc(16, 4),
    )!;

    const result = await stagingPrivateAuthProbeInternals.provisionRuntimeRole(
      {
        adminUrl,
        login: candidateLogin,
        ownerMarker: "fixture-owner-marker",
        verifier,
        psqlPath: "psql",
        timeoutMs: 15_000,
      },
      runner,
    );

    expect(result).toBe("created");
    expect(runner).toHaveBeenCalledTimes(1);
    const request = runner.mock.calls[0]![0];
    expect(request.additionalEnvironment).toEqual({
      STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
      STAGING_AUTH_PROBE_CANDIDATE_OWNER: "fixture-owner-marker",
      STAGING_AUTH_PROBE_CANDIDATE_VERIFIER: verifier,
    });
    expect(request.stdin).not.toContain(candidatePassword);
    expect(JSON.stringify(request.additionalEnvironment)).not.toContain(
      candidatePassword,
    );
    expect(stagingPrivateAuthProbeInternals.scripts.provision).not.toMatch(
      /candidate_password/i,
    );
    expect(stagingPrivateAuthProbeInternals.scripts.provision).toContain(
      "IN DATABASE pintpath_staging",
    );
    expect(stagingPrivateAuthProbeInternals.scripts.provision).not.toContain(
      "current_database()",
    );
    expect(stagingPrivateAuthProbeInternals.scripts.provision).toContain(
      "existing-owned",
    );
  });

  it("allows only the two reviewed admin databases while runtime remains exact", () => {
    const adminOnRuntimeDatabase = adminUrl.replace(
      "/railway?",
      "/pintpath_staging?",
    );
    const unknownAdminDatabase = adminUrl.replace(
      "/railway?",
      "/other_database?",
    );

    expect(buildPsqlEnvironment(adminUrl)).toMatchObject({
      PGDATABASE: "railway",
    });
    expect(buildPsqlEnvironment(adminOnRuntimeDatabase)).toMatchObject({
      PGDATABASE: "pintpath_staging",
    });
    expect(buildPsqlEnvironment(unknownAdminDatabase)).toBeNull();
    expect(
      stagingPrivateAuthProbeInternals.parsePostgresTarget(oldRuntimeUrl, true),
    ).not.toBeNull();
    expect(
      stagingPrivateAuthProbeInternals.parsePostgresTarget(
        oldRuntimeUrl.replace("/pintpath_staging?", "/railway?"),
        true,
      ),
    ).toBeNull();
  });

  it("cleans only a candidate carrying the exact stable owner marker", async () => {
    const ownerMarker = "fixture-owner-marker";
    const input = {
      adminUrl,
      login: candidateLogin,
      ownerMarker,
      psqlPath: "psql",
      timeoutMs: 15_000,
    };
    const outcomes: Array<[Partial<CapturedProcessResult>, string]> = [
      [{ exitCode: 0, stdout: "cleaned\n" }, "cleaned"],
      [{ exitCode: 0, stdout: "absent\n" }, "absent"],
      [{ exitCode: 0, stdout: "unowned\n" }, "unowned"],
      [{ exitCode: 0, stdout: "survivors\n" }, "inconclusive"],
      [{ exitCode: 0, stdout: "unexpected\n" }, "inconclusive"],
      [{ exitCode: 1, stdout: "cleaned\n" }, "inconclusive"],
    ];

    for (const [result, expected] of outcomes) {
      const runner = vi.fn(async () => processResult(result));
      await expect(
        stagingPrivateAuthProbeInternals.cleanupRuntimeRole(input, runner),
      ).resolves.toBe(expected);
      const request = runner.mock.calls[0]![0];
      expect(request.additionalEnvironment).toEqual({
        STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
        STAGING_AUTH_PROBE_CANDIDATE_OWNER: ownerMarker,
      });
    }

    const script = stagingPrivateAuthProbeInternals.scripts.cleanup;
    expect(script).toContain("shobj_description");
    expect(script.indexOf("candidate_owned")).toBeLessThan(
      script.indexOf("ALTER ROLE %I NOLOGIN"),
    );
    expect(script).toContain("SELECT 'unowned'");
    expect(script.indexOf("candidate_sessions_gone")).toBeLessThan(
      script.indexOf("DROP ROLE %I"),
    );
  });

  it("promotes the exact owner marker to durable handoff state under the candidate lock", async () => {
    const input = {
      adminUrl,
      handoffMarker: "fixture-handoff-marker",
      login: candidateLogin,
      ownerMarker: "fixture-owner-marker",
      psqlPath: "psql",
      timeoutMs: 15_000,
    };
    for (const [stdout, expected] of [
      ["handed-off\n", "handed-off"],
      ["absent\n", "absent"],
      ["unsafe\n", "unsafe"],
      ["unowned\n", "unowned"],
      ["unexpected\n", "inconclusive"],
    ] as const) {
      const runner = vi.fn(async () => processResult({ exitCode: 0, stdout }));
      await expect(
        stagingPrivateAuthProbeInternals.finalizeRuntimeRoleOwnership(
          input,
          runner,
        ),
      ).resolves.toBe(expected);
      expect(runner.mock.calls[0]![0].additionalEnvironment).toEqual({
        STAGING_AUTH_PROBE_CANDIDATE_HANDOFF: "fixture-handoff-marker",
        STAGING_AUTH_PROBE_CANDIDATE_LOGIN: candidateLogin,
        STAGING_AUTH_PROBE_CANDIDATE_OWNER: "fixture-owner-marker",
      });
    }

    const script = stagingPrivateAuthProbeInternals.scripts.finalizeOwnership;
    expect(script).toContain("pg_advisory_xact_lock");
    expect(script).toContain("COMMENT ON ROLE %I IS %L");
    expect(script).toContain(":'candidate_handoff'");
    expect(script).toContain("shobj_description");
    for (const requiredSafetyCheck of [
      "candidate_role.rolcanlogin",
      "candidate_role.rolinherit",
      "NOT candidate_role.rolsuper",
      "NOT candidate_role.rolcreatedb",
      "NOT candidate_role.rolcreaterole",
      "NOT candidate_role.rolreplication",
      "NOT candidate_role.rolbypassrls",
      "pg_catalog.pg_auth_members",
      "granted_role.rolname = 'pintpath_runtime'",
    ]) {
      expect(script).toContain(requiredSafetyCheck);
      expect(script.indexOf(requiredSafetyCheck)).toBeLessThan(
        script.indexOf("COMMENT ON ROLE %I IS %L"),
      );
    }
    expect(script.indexOf("COMMIT;")).toBeLessThan(
      script.indexOf("SELECT 'handed-off'"),
    );

    const inspectRunner = vi.fn(async () =>
      processResult({ exitCode: 0, stdout: "handed-off\n" }),
    );
    await expect(
      stagingPrivateAuthProbeInternals.inspectRuntimeRoleHandoff(
        {
          adminUrl,
          handoffMarker: "fixture-handoff-marker",
          login: candidateLogin,
          psqlPath: "psql",
          timeoutMs: 15_000,
        },
        inspectRunner,
      ),
    ).resolves.toBe("handed-off");
    expect(stagingPrivateAuthProbeInternals.scripts.inspectHandoff).toContain(
      "pg_advisory_xact_lock",
    );
  });

  it("accepts only the exact fixed retirement status from psql", async () => {
    const input = {
      adminUrl,
      login: STAGING_PRIVATE_AUTH_PROBE_LOCK.postgresPredecessorRuntimeLogin,
      psqlPath: "psql",
      timeoutMs: 15_000,
    };

    for (const [result, expected] of [
      [processResult({ exitCode: 0, stdout: "retired\n" }), true],
      [processResult({ exitCode: 0, stdout: "absent\n" }), false],
      [processResult({ exitCode: 0, stdout: "survivors\n" }), false],
      [processResult({ exitCode: 1, stdout: "retired\n" }), false],
    ] as const) {
      const runner = vi.fn(async () => result);
      await expect(
        stagingPrivateAuthProbeInternals.retireRuntimeRole(input, runner),
      ).resolves.toBe(expected);
    }
  });

  it("requires exact locked private targets and does not connect after identity mismatch", async () => {
    const postgresAttempt = vi.fn(async () => "accepted" as const);
    const redisAttempt = vi.fn(async () => "accepted" as const);
    const harness = createHarness({
      env: validEnvironment({
        RAILWAY_ENVIRONMENT_ID: "13dab015-df74-45c6-b26f-69323daea99a",
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL:
          "postgresql://fixture:fixture@public.example.invalid:5432/pintpath_staging?sslmode=require",
      }),
      postgresAttempt,
      redisAttempt,
    });

    const exitCode = await runStagingPrivateAuthProbe(
      "verify-current",
      "all",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(1);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.identity.environment).toBe(false);
    expect(receipt.identity.postgresRuntimeTarget).toBe(false);
    expect(postgresAttempt).not.toHaveBeenCalled();
    expect(redisAttempt).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain("public.example.invalid");
  });

  it.each([
    [
      "probe service",
      { RAILWAY_SERVICE_ID: "49de7806-f442-465d-8cd4-034c47299f39" },
    ],
    [
      "admin login",
      {
        STAGING_AUTH_PROBE_POSTGRES_ADMIN_URL: adminUrl.replace(
          "postgres:fixture_admin_password@",
          "other_admin:fixture_admin_password@",
        ),
      },
    ],
    [
      "predecessor runtime login",
      {
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: oldRuntimeUrl.replace(
          "pintpath_staging_runtime_login:",
          `${candidateLogin}:`,
        ),
      },
    ],
    [
      "Redis login",
      {
        STAGING_AUTH_PROBE_REDIS_URL: redisUrl.replace(
          "default:",
          "other_user:",
        ),
      },
    ],
  ])(
    "rejects a mismatched exact %s before secret-bearing I/O",
    async (_label, overrides) => {
      const postgresAttempt = vi.fn(async () => "accepted" as const);
      const redisAttempt = vi.fn(async () => "accepted" as const);
      const harness = createHarness({
        env: validEnvironment(overrides),
        postgresAttempt,
        redisAttempt,
      });

      const exitCode = await runStagingPrivateAuthProbe(
        "watch-old-rejection",
        "all",
        harness.dependencies,
      );

      expect(exitCode).toBe(1);
      expect(onlyReceipt(harness.output).outcome).toBe("failed");
      expect(postgresAttempt).not.toHaveBeenCalled();
      expect(redisAttempt).not.toHaveBeenCalled();
    },
  );

  it("rejects candidate password reuse and every nonempty debug switch before mutation", async () => {
    const provision = vi.fn(async () => "created" as const);
    const postgresAttempt = vi.fn(async () => "accepted" as const);
    const reused = oldRuntimeUrl.replace(
      "fixture_runtime_password",
      candidatePassword,
    );
    const reusedHarness = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: reused,
      }),
      provision,
      postgresAttempt,
    });

    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        reusedHarness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(
      onlyReceipt(reusedHarness.output).identity.runtimeCandidateSecretDistinct,
    ).toBe(false);
    expect(postgresAttempt).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();

    for (const [debugName, debugValue] of [
      ["DEBUG", "protocol:*"],
      ["DEBUG", " "],
      ["DEBUG", "x".repeat(8_193)],
      ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
    ]) {
      const debugRedisAttempt = vi.fn(async () => "accepted" as const);
      const debugHarness = createHarness({
        env: validEnvironment({ [debugName]: debugValue }),
        redisAttempt: debugRedisAttempt,
      });
      await expect(
        runStagingPrivateAuthProbe(
          "verify-current",
          "redis",
          debugHarness.dependencies,
        ),
      ).resolves.toBe(1);
      expect(
        onlyReceipt(debugHarness.output).identity.debugLoggingDisabled,
      ).toBe(false);
      expect(debugRedisAttempt).not.toHaveBeenCalled();
    }
  });

  it("rejects cross-provider secret reuse before authentication or mutation", async () => {
    for (const reusedPassword of [
      "fixture_admin_password",
      "fixture_runtime_password",
    ]) {
      const postgresAttempt = vi.fn(async () => "accepted" as const);
      const redisAttempt = vi.fn(async () => "accepted" as const);
      const harness = createHarness({
        env: validEnvironment({
          STAGING_AUTH_PROBE_REDIS_URL: redisUrl.replace(
            "fixture_redis_password",
            reusedPassword,
          ),
        }),
        postgresAttempt,
        redisAttempt,
      });

      await expect(
        runStagingPrivateAuthProbe(
          "verify-current",
          "all",
          harness.dependencies,
        ),
      ).resolves.toBe(1);
      expect(
        onlyReceipt(harness.output).identity.providerCredentialsDistinct,
      ).toBe(false);
      expect(postgresAttempt).not.toHaveBeenCalled();
      expect(redisAttempt).not.toHaveBeenCalled();

      const mutationAttempt = vi.fn(async () => "accepted" as const);
      const mutation = vi.fn(async () => "created" as const);
      const mutationHarness = createHarness({
        env: validEnvironment({
          STAGING_AUTH_PROBE_REDIS_URL: redisUrl.replace(
            "fixture_redis_password",
            reusedPassword,
          ),
        }),
        postgresAttempt: mutationAttempt,
        provision: mutation,
      });
      await expect(
        runStagingPrivateAuthProbe(
          "provision-runtime-candidate",
          "postgres-runtime",
          mutationHarness.dependencies,
        ),
      ).resolves.toBe(1);
      expect(
        onlyReceipt(mutationHarness.output).identity
          .providerCredentialsDistinct,
      ).toBe(false);
      expect(mutationAttempt).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    }

    const provision = vi.fn(async () => "created" as const);
    const provisionAttempt = vi.fn(async () => "accepted" as const);
    const provisionHarness = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_REDIS_URL: redisUrl.replace(
          "fixture_redis_password",
          candidatePassword,
        ),
      }),
      postgresAttempt: provisionAttempt,
      provision,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        provisionHarness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(
      onlyReceipt(provisionHarness.output).identity
        .runtimeCandidateSecretDistinct,
    ).toBe(false);
    expect(provisionAttempt).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();

    const retire = vi.fn(async () => true);
    const retireAttempt = vi.fn(async () => "accepted" as const);
    const retireHarness = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl,
        STAGING_AUTH_PROBE_REDIS_URL: redisUrl.replace(
          "fixture_redis_password",
          candidatePassword,
        ),
      }),
      postgresAttempt: retireAttempt,
      retire,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "retire-old-runtime",
        "postgres-runtime",
        retireHarness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(
      onlyReceipt(retireHarness.output).identity.runtimeCandidateSecretDistinct,
    ).toBe(false);
    expect(retireAttempt).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();

    const adminReuseRetire = vi.fn(async () => true);
    const adminReuseAttempt = vi.fn(async () => "accepted" as const);
    const adminReuseHarness = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl,
        STAGING_AUTH_PROBE_REDIS_URL: redisUrl.replace(
          "fixture_redis_password",
          "fixture_admin_password",
        ),
      }),
      postgresAttempt: adminReuseAttempt,
      retire: adminReuseRetire,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "retire-old-runtime",
        "postgres-runtime",
        adminReuseHarness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(
      onlyReceipt(adminReuseHarness.output).identity
        .providerCredentialsDistinct,
    ).toBe(false);
    expect(adminReuseAttempt).not.toHaveBeenCalled();
    expect(adminReuseRetire).not.toHaveBeenCalled();
  });

  it("watches fresh connections until every old credential transitions from accepted to rejected", async () => {
    const postgresStates = new Map([
      [adminUrl, ["accepted", "rejected"] as const],
      [oldRuntimeUrl, ["accepted", "rejected"] as const],
    ]);
    const postgresIndexes = new Map<string, number>();
    const postgresAttempt = vi.fn(async (url: string) => {
      const index = postgresIndexes.get(url) ?? 0;
      postgresIndexes.set(url, index + 1);
      return postgresStates.get(url)?.[Math.min(index, 1)] ?? "inconclusive";
    });
    let redisIndex = 0;
    const redisAttempt = vi.fn(async () =>
      redisIndex++ === 0 ? ("accepted" as const) : ("rejected" as const),
    );
    const harness = createHarness({ postgresAttempt, redisAttempt });

    const exitCode = await runStagingPrivateAuthProbe(
      "watch-old-rejection",
      "all",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(0);
    expect(receipt.outcome).toBe("passed");
    expect(receipt.checks).toMatchObject({
      postgresAdminAuth: "rejected",
      postgresRuntimeAuth: "rejected",
      redisAuth: "rejected",
      postgresAdminTransition: "observed",
      postgresRuntimeTransition: "observed",
      redisTransition: "observed",
    });
    expect(postgresAttempt).toHaveBeenCalledTimes(4);
    expect(redisAttempt).toHaveBeenCalledTimes(2);
    expect(harness.output[0]).not.toContain("fixture_admin_password");
    expect(harness.output[0]).not.toContain("fixture_runtime_password");
    expect(harness.output[0]).not.toContain("fixture_redis_password");
  });

  it("does not accept an already-rejected credential as an observed transition", async () => {
    const redisAttempt = vi.fn(async () => "rejected" as const);
    const harness = createHarness({
      redisAttempt,
      sleepAdvanceMs: STAGING_PRIVATE_AUTH_PROBE_LOCK.maximumDurationMs,
    });

    const exitCode = await runStagingPrivateAuthProbe(
      "watch-old-rejection",
      "redis",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(1);
    expect(receipt.outcome).toBe("inconclusive");
    expect(receipt.checks.redisAuth).toBe("rejected");
    expect(receipt.checks.redisTransition).toBe("not-observed");
    expect(redisAttempt).toHaveBeenCalledTimes(1);
  });

  it("verifies admin, runtime readiness, and Redis in one bounded all-target run", async () => {
    const postgresAttempt = vi.fn(async () => "accepted" as const);
    const redisAttempt = vi.fn(async () => "accepted" as const);
    const readiness = vi.fn(async () => "ready" as const);
    const harness = createHarness({ postgresAttempt, redisAttempt, readiness });

    const exitCode = await runStagingPrivateAuthProbe(
      "verify-current",
      "all",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(0);
    expect(receipt.outcome).toBe("passed");
    expect(receipt.checks).toMatchObject({
      postgresAdminAuth: "accepted",
      postgresRuntimeAuth: "accepted",
      redisAuth: "accepted",
      runtimeReadiness: "ready",
    });
    expect(postgresAttempt).toHaveBeenCalledTimes(2);
    expect(redisAttempt).toHaveBeenCalledTimes(1);
    expect(readiness).toHaveBeenCalledTimes(1);
    expect(
      Object.values(receipt.identity).every(
        (value) => typeof value === "boolean",
      ),
    ).toBe(true);
  });

  it("provisions, freshly authenticates, and checks least privilege readiness", async () => {
    const provision = vi.fn(async () => "created" as const);
    const finalize = vi.fn(async () => "handed-off" as const);
    const postgresAttempt = vi.fn(async () => "accepted" as const);
    const readiness = vi.fn(async () => "ready" as const);
    const harness = createHarness({
      provision,
      finalize,
      postgresAttempt,
      readiness,
    });

    const exitCode = await runStagingPrivateAuthProbe(
      "provision-runtime-candidate",
      "postgres-runtime",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(0);
    expect(receipt.outcome).toBe("passed");
    expect(receipt.checks).toMatchObject({
      postgresAdminAuth: "accepted",
      postgresRuntimeAuth: "accepted",
      runtimeHandoff: "observed",
      runtimeReadiness: "ready",
      runtimeMutation: "completed",
    });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    const mutationInput = provision.mock.calls[0]![0];
    expect(mutationInput).not.toHaveProperty("password");
    expect(mutationInput.verifier).toMatch(/^SCRAM-SHA-256\$/);
    expect(JSON.stringify(mutationInput)).not.toContain(candidatePassword);
    expect(JSON.stringify(mutationInput)).not.toContain(candidateOwnerSecret);
    const handoffInput = finalize.mock.calls[0]![0];
    expect(handoffInput.handoffMarker).toMatch(
      /^pintpath-staging-auth-probe:handoff-v1:/,
    );
    expect(handoffInput.handoffMarker).not.toBe(mutationInput.ownerMarker);
    expect(JSON.stringify(handoffInput)).not.toContain(candidateOwnerSecret);
    expect(postgresAttempt).toHaveBeenCalledTimes(3);
    expect(postgresAttempt.mock.calls[1]![0]).toContain(candidateLogin);
    expect(postgresAttempt.mock.calls[1]![0]).toContain(candidatePassword);
    expect(postgresAttempt.mock.calls[2]![0]).toContain(candidateLogin);
    expect(readiness).toHaveBeenCalledWith(
      expect.stringContaining(candidateLogin),
      expect.any(Number),
    );
    expect(readiness).toHaveBeenCalledTimes(2);
    expect(harness.output[0]).not.toContain(candidatePassword);
    expect(harness.output[0]).not.toContain(candidateOwnerSecret);
    expect(harness.output[0]).not.toMatch(/[a-f0-9]{64}/);
    expect(harness.lifecycleLock.verify).toHaveBeenCalledTimes(5);
    expect(harness.lifecycleLock.release).toHaveBeenCalledTimes(1);
  });

  it("pins the lifecycle lock to the runtime database and a distinct key space", () => {
    const lockUrl =
      stagingPrivateAuthProbeInternals.lifecycleLockConnectionUrl(adminUrl);
    expect(lockUrl).not.toBeNull();
    expect(new URL(lockUrl!).pathname).toBe("/pintpath_staging");
    expect(new URL(lockUrl!).searchParams.get("uselibpqcompat")).toBe("true");
    expect(
      stagingPrivateAuthProbeInternals.queries.acquireProvisionLifecycleLock,
    ).toContain("pg_try_advisory_lock($1::integer, $2::integer)");
    expect(
      stagingPrivateAuthProbeInternals.queries.verifyProvisionLifecycleLock,
    ).toContain("pg_locks");
    expect(stagingPrivateAuthProbeInternals.scripts.provision).toContain(
      "hashtextextended(:'candidate_login', 0)",
    );
  });

  it("requires exact ownership handoff and a still-held lifecycle lock before green", async () => {
    const cleanup = vi.fn(async () => "cleaned" as const);
    const refusedHandoff = createHarness({
      finalize: vi.fn(async () => "unowned"),
      cleanup,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        refusedHandoff.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(refusedHandoff.output)).toMatchObject({
      outcome: "failed",
      checks: {
        runtimeHandoff: "not-observed",
        runtimeMutation: "inconclusive",
      },
    });
    expect(cleanup).not.toHaveBeenCalled();

    const verify = vi
      .fn<ProvisionLifecycleLock["verify"]>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const finalize = vi.fn(async () => "handed-off" as const);
    const lostAfterHandoff = createHarness({
      finalize,
      lifecycleLock: {
        verify,
        release: vi.fn(async () => undefined),
      },
    });
    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        lostAfterHandoff.dependencies,
      ),
    ).resolves.toBe(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(onlyReceipt(lostAfterHandoff.output)).toMatchObject({
      outcome: "inconclusive",
      checks: { runtimeMutation: "inconclusive" },
    });
  });

  it("refuses handoff for an owner-marked role already invalidated by cleanup", async () => {
    const cleanup = vi.fn(async () => "cleaned" as const);
    const finalize = vi.fn(async () => "unsafe" as const);
    const harness = createHarness({ cleanup, finalize });

    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(harness.output)).toMatchObject({
      outcome: "failed",
      checks: {
        runtimeHandoff: "not-observed",
        runtimeMutation: "inconclusive",
      },
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("requires a fresh candidate authentication proof after durable handoff", async () => {
    let attempt = 0;
    const cleanup = vi.fn(async () => "cleaned" as const);
    const harness = createHarness({
      cleanup,
      postgresAttempt: vi.fn(async () => {
        attempt += 1;
        return attempt < 3 ? ("accepted" as const) : ("rejected" as const);
      }),
    });

    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(harness.output)).toMatchObject({
      outcome: "failed",
      checks: {
        postgresRuntimeAuth: "rejected",
        runtimeHandoff: "observed",
        runtimeMutation: "inconclusive",
      },
    });
    expect(attempt).toBe(3);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("never starts provisioning without the full-lifecycle session lock", async () => {
    const provision = vi.fn(async () => "created" as const);
    const harness = createHarness({
      acquireLifecycleLock: vi.fn(async () => null),
      provision,
    });

    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(harness.output).outcome).toBe("inconclusive");
    expect(provision).not.toHaveBeenCalled();
  });

  it("serializes overlapping provision proofs through final handoff", async () => {
    let held = false;
    const acquireLifecycleLock = vi.fn(async () => {
      if (held) return null;
      held = true;
      return {
        verify: vi.fn(async () => held),
        release: vi.fn(async () => {
          held = false;
        }),
      } satisfies ProvisionLifecycleLock;
    });
    let finishReadiness: ((value: "ready") => void) | undefined;
    let readinessCalls = 0;
    const readiness = vi.fn(async () => {
      readinessCalls += 1;
      if (readinessCalls > 1) return "ready" as const;
      return new Promise<"ready">((resolve) => {
        finishReadiness = resolve;
      });
    });
    const firstProvision = vi.fn(async () => "created" as const);
    const first = createHarness({
      acquireLifecycleLock,
      provision: firstProvision,
      readiness,
    });
    const firstRun = runStagingPrivateAuthProbe(
      "provision-runtime-candidate",
      "postgres-runtime",
      first.dependencies,
    );
    await vi.waitFor(() => expect(readiness).toHaveBeenCalledTimes(1));

    const secondProvision = vi.fn(async () => "created" as const);
    const second = createHarness({
      acquireLifecycleLock,
      provision: secondProvision,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        second.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(second.output).outcome).toBe("inconclusive");
    expect(secondProvision).not.toHaveBeenCalled();

    finishReadiness?.("ready");
    await expect(firstRun).resolves.toBe(0);
    expect(onlyReceipt(first.output).outcome).toBe("passed");
    expect(firstProvision).toHaveBeenCalledTimes(1);
    expect(acquireLifecycleLock).toHaveBeenCalledTimes(2);
  });

  it("prevents retirement from overlapping a pre-handoff provision lifecycle", async () => {
    let held = false;
    const acquireLifecycleLock = vi.fn(async () => {
      if (held) return null;
      held = true;
      return {
        verify: vi.fn(async () => held),
        release: vi.fn(async () => {
          held = false;
        }),
      } satisfies ProvisionLifecycleLock;
    });
    let finishProvisionReadiness: ((value: "ready") => void) | undefined;
    let provisionReadinessCalls = 0;
    const provisionReadiness = vi.fn(async () => {
      provisionReadinessCalls += 1;
      if (provisionReadinessCalls > 1) return "ready" as const;
      return new Promise<"ready">((resolve) => {
        finishProvisionReadiness = resolve;
      });
    });
    const provision = createHarness({
      acquireLifecycleLock,
      readiness: provisionReadiness,
    });
    const provisionRun = runStagingPrivateAuthProbe(
      "provision-runtime-candidate",
      "postgres-runtime",
      provision.dependencies,
    );
    await vi.waitFor(() => expect(provisionReadiness).toHaveBeenCalledTimes(1));

    const overlappingRetireMutation = vi.fn(async () => true);
    const overlappingRetire = createHarness({
      acquireLifecycleLock,
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl,
      }),
      retire: overlappingRetireMutation,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "retire-old-runtime",
        "postgres-runtime",
        overlappingRetire.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(overlappingRetire.output).outcome).toBe("inconclusive");
    expect(overlappingRetireMutation).not.toHaveBeenCalled();

    finishProvisionReadiness?.("ready");
    await expect(provisionRun).resolves.toBe(0);
    expect(onlyReceipt(provision.output).checks.runtimeMutation).toBe(
      "completed",
    );

    const postHandoffRetireMutation = vi.fn(async () => true);
    const postHandoffRetire = createHarness({
      acquireLifecycleLock,
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl,
      }),
      inspectHandoff: vi.fn(async () => "handed-off"),
      retire: postHandoffRetireMutation,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "retire-old-runtime",
        "postgres-runtime",
        postHandoffRetire.dependencies,
      ),
    ).resolves.toBe(0);
    expect(onlyReceipt(postHandoffRetire.output).checks.runtimeHandoff).toBe(
      "observed",
    );
    expect(postHandoffRetireMutation).toHaveBeenCalledTimes(1);
  });

  it("rolls the candidate role back when readiness is not green", async () => {
    const cleanup = vi.fn(async () => "cleaned" as const);
    const harness = createHarness({
      readiness: vi.fn(async () => "not-ready"),
      cleanup,
    });

    const exitCode = await runStagingPrivateAuthProbe(
      "provision-runtime-candidate",
      "postgres-runtime",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(1);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks.runtimeMutation).toBe("rolled-back");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses the same owner marker to inspect an ambiguous CREATE without touching an unowned role", async () => {
    const provision = vi.fn(async () => "inconclusive" as const);
    const inspect = vi.fn(async () => "unowned" as const);
    const cleanup = vi.fn(async () => "cleaned" as const);
    const harness = createHarness({ provision, inspect, cleanup });

    const exitCode = await runStagingPrivateAuthProbe(
      "provision-runtime-candidate",
      "postgres-runtime",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(1);
    expect(receipt.outcome).toBe("inconclusive");
    expect(receipt.checks.runtimeMutation).toBe("inconclusive");
    expect(provision).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(inspect.mock.calls[0]![0].ownerMarker).toBe(
      provision.mock.calls[0]![0].ownerMarker,
    );
  });

  it("resumes an exact owned candidate after an ambiguous crash and across deployment retry", async () => {
    const firstProvision = vi.fn(async () => "inconclusive" as const);
    const inspect = vi.fn(async () => "owned" as const);
    const firstCleanup = vi.fn(async () => "cleaned" as const);
    const first = createHarness({
      provision: firstProvision,
      inspect,
      cleanup: firstCleanup,
      readiness: vi.fn(async () => "inconclusive"),
    });

    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        first.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(first.output).checks.runtimeMutation).toBe(
      "inconclusive",
    );
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(firstCleanup).not.toHaveBeenCalled();

    const retryProvision = vi.fn(async () => "existing-owned" as const);
    const retryCleanup = vi.fn(async () => "cleaned" as const);
    const retry = createHarness({
      env: validEnvironment({
        RAILWAY_DEPLOYMENT_ID: "77b0d060-8438-47bd-97ed-068416afc81e",
      }),
      provision: retryProvision,
      cleanup: retryCleanup,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        retry.dependencies,
      ),
    ).resolves.toBe(0);

    expect(firstProvision.mock.calls[0]![0].ownerMarker).toBe(
      inspect.mock.calls[0]![0].ownerMarker,
    );
    expect(retryProvision.mock.calls[0]![0].ownerMarker).toBe(
      firstProvision.mock.calls[0]![0].ownerMarker,
    );
    expect(retryCleanup).not.toHaveBeenCalled();

    const handedOffProvision = vi.fn(async () => "unowned" as const);
    const handedOffCleanup = vi.fn(async () => "cleaned" as const);
    const handedOffRetry = createHarness({
      provision: handedOffProvision,
      cleanup: handedOffCleanup,
    });
    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        handedOffRetry.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(handedOffRetry.output).outcome).toBe("inconclusive");
    expect(handedOffCleanup).not.toHaveBeenCalled();
  });

  it("does not delete an existing owned candidate after an inconclusive benign rerun", async () => {
    let attemptCount = 0;
    const cleanup = vi.fn(async () => "cleaned" as const);
    const harness = createHarness({
      provision: vi.fn(async () => "existing-owned" as const),
      postgresAttempt: vi.fn(async () =>
        attemptCount++ === 0
          ? ("accepted" as const)
          : ("inconclusive" as const),
      ),
      cleanup,
    });

    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);
    const receipt = onlyReceipt(harness.output);
    expect(receipt.outcome).toBe("inconclusive");
    expect(receipt.checks.runtimeMutation).toBe("inconclusive");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("preserves transient existing-owned state but rolls back deterministic unsafe readiness", async () => {
    for (const readinessResult of ["inconclusive", "not-ready"] as const) {
      const cleanup = vi.fn(async () => "cleaned" as const);
      const harness = createHarness({
        provision: vi.fn(async () => "existing-owned"),
        readiness: vi.fn(async () => readinessResult),
        cleanup,
      });

      await expect(
        runStagingPrivateAuthProbe(
          "provision-runtime-candidate",
          "postgres-runtime",
          harness.dependencies,
        ),
      ).resolves.toBe(1);
      expect(onlyReceipt(harness.output)).toMatchObject({
        outcome: readinessResult === "not-ready" ? "failed" : "inconclusive",
        checks: {
          runtimeReadiness: readinessResult,
          runtimeMutation:
            readinessResult === "not-ready" ? "rolled-back" : "inconclusive",
        },
      });
      if (readinessResult === "not-ready")
        expect(cleanup).toHaveBeenCalledTimes(1);
      else expect(cleanup).not.toHaveBeenCalled();
    }
  });

  it("rolls back an exact existing-owned role after deterministic auth rejection", async () => {
    let attempts = 0;
    const cleanup = vi.fn(async () => "cleaned" as const);
    const harness = createHarness({
      provision: vi.fn(async () => "existing-owned"),
      postgresAttempt: vi.fn(async () =>
        attempts++ === 0 ? ("accepted" as const) : ("rejected" as const),
      ),
      cleanup,
    });

    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(harness.output)).toMatchObject({
      outcome: "failed",
      checks: {
        postgresRuntimeAuth: "rejected",
        runtimeMutation: "rolled-back",
      },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("owner-checks cleanup after every post-provision exception", async () => {
    const provision = vi.fn(async () => "created" as const);
    const cleanup = vi.fn(async () => "cleaned" as const);
    const harness = createHarness({
      provision,
      cleanup,
      readiness: vi.fn(async () => {
        throw new Error(`do not emit ${candidatePassword}`);
      }),
    });

    const exitCode = await runStagingPrivateAuthProbe(
      "provision-runtime-candidate",
      "postgres-runtime",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(1);
    expect(receipt.outcome).toBe("inconclusive");
    expect(receipt.checks.runtimeMutation).toBe("rolled-back");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0]![0].ownerMarker).toBe(
      provision.mock.calls[0]![0].ownerMarker,
    );
    expect(harness.output[0]).not.toContain(candidatePassword);
  });

  it("reserves cleanup budget and never begins a late credential mutation", async () => {
    let clock = 0;
    const provision = vi.fn(async () => "created" as const);
    const output: string[] = [];
    const harness = createHarness({ provision });
    harness.dependencies.monotonicNow = () => clock;
    harness.dependencies.attemptPostgres = vi.fn(async () => {
      clock =
        STAGING_PRIVATE_AUTH_PROBE_LOCK.maximumDurationMs -
        STAGING_PRIVATE_AUTH_PROBE_LOCK.attemptTimeoutMs * 3;
      return "accepted";
    });
    harness.dependencies.writeOutput = (value) => output.push(value);

    await expect(
      runStagingPrivateAuthProbe(
        "provision-runtime-candidate",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);

    expect(provision).not.toHaveBeenCalled();
    expect(onlyReceipt(output).outcome).toBe("inconclusive");
  });

  it("never emits a green receipt after the monotonic deadline", async () => {
    let verifyClock = 0;
    const verify = createHarness({
      redisAttempt: vi.fn(async () => {
        verifyClock = STAGING_PRIVATE_AUTH_PROBE_LOCK.maximumDurationMs;
        return "accepted" as const;
      }),
    });
    verify.dependencies.monotonicNow = () => verifyClock;
    await expect(
      runStagingPrivateAuthProbe(
        "verify-current",
        "redis",
        verify.dependencies,
      ),
    ).resolves.toBe(1);
    expect(onlyReceipt(verify.output).outcome).toBe("inconclusive");

    let retireClock = 0;
    let readinessCount = 0;
    const retire = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl,
      }),
      readiness: vi.fn(async () => {
        readinessCount += 1;
        if (readinessCount === 2) {
          retireClock = STAGING_PRIVATE_AUTH_PROBE_LOCK.maximumDurationMs;
        }
        return "ready" as const;
      }),
    });
    retire.dependencies.monotonicNow = () => retireClock;
    await expect(
      runStagingPrivateAuthProbe(
        "retire-old-runtime",
        "postgres-runtime",
        retire.dependencies,
      ),
    ).resolves.toBe(1);
    const retireReceipt = onlyReceipt(retire.output);
    expect(retireReceipt.outcome).toBe("inconclusive");
    expect(retireReceipt.checks.runtimeMutation).toBe("completed");
  });

  it("retires only a distinct predecessor after two current-runtime proofs", async () => {
    const postgresAttempt = vi.fn(async () => "accepted" as const);
    const readiness = vi.fn(async () => "ready" as const);
    const retire = vi.fn(async () => true);
    const harness = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl,
      }),
      postgresAttempt,
      readiness,
      retire,
    });

    const exitCode = await runStagingPrivateAuthProbe(
      "retire-old-runtime",
      "postgres-runtime",
      harness.dependencies,
    );
    const receipt = onlyReceipt(harness.output);

    expect(exitCode).toBe(0);
    expect(receipt.outcome).toBe("passed");
    expect(receipt.identity.retiredRuntimeDistinct).toBe(true);
    expect(receipt.checks.runtimeMutation).toBe("completed");
    expect(receipt.checks.runtimeHandoff).toBe("observed");
    expect(postgresAttempt).toHaveBeenCalledTimes(3);
    expect(readiness).toHaveBeenCalledTimes(2);
    expect(retire).toHaveBeenCalledWith(
      expect.objectContaining({
        login: "pintpath_staging_runtime_login",
      }),
    );
    expect(harness.lifecycleLock.verify).toHaveBeenCalledTimes(5);
    expect(harness.lifecycleLock.release).toHaveBeenCalledTimes(1);
    expect(harness.output[0]).not.toContain("pintpath_staging_runtime_login");
  });

  it("refuses predecessor retirement until the candidate has exact durable handoff state", async () => {
    const retire = vi.fn(async () => true);
    const inspectHandoff = vi.fn(async () => "unowned" as const);
    const harness = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl,
      }),
      inspectHandoff,
      retire,
    });

    await expect(
      runStagingPrivateAuthProbe(
        "retire-old-runtime",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);
    const receipt = onlyReceipt(harness.output);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks.runtimeHandoff).toBe("not-observed");
    expect(receipt.checks.runtimeMutation).toBe("not-run");
    expect(inspectHandoff).toHaveBeenCalledTimes(1);
    expect(retire).not.toHaveBeenCalled();
    expect(harness.lifecycleLock.release).toHaveBeenCalledTimes(1);
  });

  it("requires the independent owner secret for retirement attestation", async () => {
    const attempt = vi.fn(async () => "accepted" as const);
    const retire = vi.fn(async () => true);
    const harness = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl,
        STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_OWNER_SECRET: "",
      }),
      postgresAttempt: attempt,
      retire,
    });

    await expect(
      runStagingPrivateAuthProbe(
        "retire-old-runtime",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);
    expect(
      onlyReceipt(harness.output).identity.runtimeCandidateOwnerSecretValid,
    ).toBe(false);
    expect(attempt).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });

  it("refuses to retire the predecessor for a weak candidate credential", async () => {
    const weakPassword = "x";
    const postgresAttempt = vi.fn(async () => "accepted" as const);
    const retire = vi.fn(async () => true);
    const harness = createHarness({
      env: validEnvironment({
        STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL: currentRuntimeUrl.replace(
          candidatePassword,
          weakPassword,
        ),
        STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_PASSWORD: weakPassword,
      }),
      postgresAttempt,
      retire,
    });

    await expect(
      runStagingPrivateAuthProbe(
        "retire-old-runtime",
        "postgres-runtime",
        harness.dependencies,
      ),
    ).resolves.toBe(1);

    expect(onlyReceipt(harness.output).identity.postgresRuntimeLogin).toBe(
      false,
    );
    expect(postgresAttempt).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });

  it("commits predecessor credential invalidation before terminating sessions", () => {
    const script = stagingPrivateAuthProbeInternals.scripts.retire;

    expect(script.indexOf("COMMIT;")).toBeGreaterThan(
      script.indexOf("PASSWORD NULL"),
    );
    expect(script.indexOf("COMMIT;")).toBeLessThan(
      script.indexOf("pg_terminate_backend"),
    );
    expect(script.indexOf("retired_sessions_gone")).toBeLessThan(
      script.indexOf("SELECT 'retired'"),
    );
  });

  it("keeps the executable output surface to one allowlisted JSON receipt", () => {
    const source = fs.readFileSync(
      "scripts/staging-private-auth-probe.ts",
      "utf8",
    );
    const executableBranch = source.slice(
      source.indexOf("if (invokedPath ==="),
    );

    expect(source).not.toContain("console.log");
    expect(source).not.toContain("console.error");
    expect(source).not.toContain("ioredis");
    expect(source).not.toContain("writePinFile");
    expect(source).not.toContain('stdio: "inherit"');
    expect(executableBranch).not.toContain(
      "process.env.STAGING_AUTH_PROBE_POSTGRES_ADMIN_URL",
    );
    expect(executableBranch).not.toContain(
      "process.env.STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL",
    );
    expect(executableBranch).not.toContain(
      "process.env.STAGING_AUTH_PROBE_REDIS_URL",
    );
  });
});
