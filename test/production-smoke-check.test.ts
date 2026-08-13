import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface SmokeSummary {
  ok: boolean;
  summary: { passed: number; failed: number; skipped: number };
  checks: Array<{ id: string; status: string; detail: string }>;
}

const validPublishableKey = `sb_publishable_${"0".repeat(32)}`;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function runSmoke(baseUrl: string, args: string[], environment: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.resolve(process.cwd(), "scripts/production-smoke-check.mjs"),
      ...args,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PINTPATH_SMOKE_BASE_URL: baseUrl,
        PINTPATH_SMOKE_ALLOW_LOOPBACK_FOR_TESTS: "true",
        PINTPATH_SMOKE_USER_TOKEN: "",
        PINTPATH_SMOKE_VENUE_TOKEN: "",
        PINTPATH_SMOKE_ADMIN_TOKEN: "",
        PINTPATH_SMOKE_USER_EMAIL: "",
        PINTPATH_SMOKE_USER_PASSWORD: "",
        PINTPATH_SMOKE_VENUE_EMAIL: "",
        PINTPATH_SMOKE_VENUE_PASSWORD: "",
        PINTPATH_SMOKE_ADMIN_EMAIL: "",
        PINTPATH_SMOKE_ADMIN_PASSWORD: "",
        PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "false",
        SUPABASE_URL: baseUrl,
        SUPABASE_ANON_KEY: validPublishableKey,
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("production smoke runtime authentication", () => {
  let baseUrl = "";
  let publishedSupabaseUrl = "";
  let publishedSupabaseAnonKey = validPublishableKey;
  let publicConfigRequests = 0;
  let adminProtectedRequests = 0;
  let providerPasswordRequests = 0;
  let providerPasswordAuthorizationHeaders: Array<string | undefined> = [];
  let providerSignIns: string[] = [];
  let providerSignOuts: string[] = [];
  let revokedTokens: string[] = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", baseUrl);

    if (request.method === "GET" && url.pathname === "/api/business/config") {
      publicConfigRequests += 1;
      sendJson(response, 200, {
        ok: true,
        data: { pricing: {}, supabaseUrl: publishedSupabaseUrl, supabaseAnonKey: publishedSupabaseAnonKey },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/v1/token") {
      providerPasswordRequests += 1;
      providerPasswordAuthorizationHeaders.push(request.headers.authorization);
      const body = await requestJson(request);
      const email = String(body.email || "");
      const password = String(body.password || "");
      const role = email.startsWith("user-") ? "user" : email.startsWith("venue-") ? "venue" : "unknown";
      providerSignIns.push(role);
      if (
        url.searchParams.get("grant_type") !== "password"
        || request.headers.apikey !== publishedSupabaseAnonKey
        || request.headers.authorization !== undefined
        || role === "unknown"
        || password !== `${role}-secret`
      ) {
        sendJson(response, 401, { message: "invalid credentials" });
        return;
      }
      sendJson(response, 200, { access_token: `provider-${role}` });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/business/auth/supabase-session") {
      const body = await requestJson(request);
      const accessToken = String(body.accessToken || "");
      const role = accessToken.replace(/^provider-/, "");
      if (role !== "user" && role !== "venue") {
        sendJson(response, 401, { ok: false });
        return;
      }
      sendJson(response, 200, { ok: true, data: { token: `app-${role}` } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/logout") {
      providerSignOuts.push((request.headers.authorization || "").replace(/^Bearer /, ""));
      response.writeHead(204);
      response.end();
      return;
    }

    const authorization = request.headers.authorization || "";
    if (request.method === "GET" && url.pathname === "/api/business/account" && authorization === "Bearer app-user") {
      sendJson(response, 200, { ok: true, data: { account: { id: "user" } } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/business/venue-portal" && authorization === "Bearer app-venue") {
      sendJson(response, 200, { ok: true, data: { selectedVenue: { id: "venue" } } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/business/admin/queues") {
      adminProtectedRequests += 1;
      if (authorization === "Bearer app-admin") {
        sendJson(response, 200, {
          ok: true,
          data: { feedback: [], wrongPriceReports: [], venueRequests: [], pagination: {}, totals: {} },
        });
      } else {
        sendJson(response, 401, { ok: false });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/business/auth/logout") {
      const token = authorization.replace(/^Bearer /, "");
      revokedTokens.push(token);
      sendJson(response, 200, { ok: true, data: { revoked: true } });
      return;
    }

    sendJson(response, 404, { ok: false });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    publishedSupabaseUrl = baseUrl;
  });

  beforeEach(() => {
    providerSignIns = [];
    providerSignOuts = [];
    revokedTokens = [];
    publishedSupabaseUrl = baseUrl;
    publishedSupabaseAnonKey = validPublishableKey;
    publicConfigRequests = 0;
    adminProtectedRequests = 0;
    providerPasswordRequests = 0;
    providerPasswordAuthorizationHeaders = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it.each([
    "https://attacker.invalid",
    " https://pintpath.au",
    "https://pintpath.au ",
    "HTTPS://PINTPATH.AU",
    "https://pintpath.au/",
    "https://pintpath.au:443",
    "https://pintpath.au/path",
    "https://user:password@pintpath.au",
  ])("rejects an unapproved smoke target before using any credential: %s", async (target) => {
    const adminToken = "must-not-leak-admin-token";
    const userPassword = "must-not-leak-user-password";
    const result = await runSmoke(target, [
      "--strict-auth",
      "--auth-only",
      "--roles=user,admin",
    ], {
      SUPABASE_URL: "https://auth.pintpath.au",
      PINTPATH_SMOKE_ADMIN_TOKEN: adminToken,
      PINTPATH_SMOKE_USER_EMAIL: "private-user@example.test",
      PINTPATH_SMOKE_USER_PASSWORD: userPassword,
    });

    expect(result.code).toBe(1);
    expect(publicConfigRequests).toBe(0);
    expect(adminProtectedRequests).toBe(0);
    expect(providerPasswordRequests).toBe(0);
    expect(result.stdout).not.toContain(adminToken);
    expect(result.stderr).not.toContain(adminToken);
    expect(result.stdout).not.toContain(userPassword);
    expect(result.stderr).not.toContain(userPassword);
    expect(result.stderr).not.toContain(target);
  });

  it("rejects loopback without explicit test-only authority", async () => {
    const result = await runSmoke(baseUrl, [
      "--strict-auth",
      "--auth-only",
      "--roles=admin",
    ], {
      PINTPATH_SMOKE_ALLOW_LOOPBACK_FOR_TESTS: "false",
      PINTPATH_SMOKE_ADMIN_TOKEN: "must-not-leak-admin-token",
    });
    expect(result.code).toBe(1);
    expect(publicConfigRequests).toBe(0);
    expect(adminProtectedRequests).toBe(0);
    expect(result.stdout).not.toContain("must-not-leak-admin-token");
    expect(result.stderr).not.toContain("must-not-leak-admin-token");
  });

  it("rejects loopback in production even when the test-only switch is present", async () => {
    const result = await runSmoke(baseUrl, [
      "--strict-auth",
      "--auth-only",
      "--roles=admin",
    ], {
      NODE_ENV: "production",
      PINTPATH_SMOKE_ALLOW_LOOPBACK_FOR_TESTS: "true",
      PINTPATH_SMOKE_ADMIN_TOKEN: "must-not-leak-production-admin-token",
    });
    expect(result.code).toBe(1);
    expect(publicConfigRequests).toBe(0);
    expect(adminProtectedRequests).toBe(0);
    expect(providerPasswordRequests).toBe(0);
    expect(result.stdout).not.toContain("must-not-leak-production-admin-token");
    expect(result.stderr).not.toContain("must-not-leak-production-admin-token");
  });

  it("creates and revokes disposable user and venue sessions from password secrets", async () => {
    const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=user,venue"], {
      PINTPATH_SMOKE_USER_EMAIL: "user-smoke@example.test",
      PINTPATH_SMOKE_USER_PASSWORD: "user-secret",
      PINTPATH_SMOKE_VENUE_EMAIL: "venue-smoke@example.test",
      PINTPATH_SMOKE_VENUE_PASSWORD: "venue-secret",
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const summary = JSON.parse(result.stdout) as SmokeSummary;
    expect(summary.ok).toBe(true);
    expect(summary.summary).toEqual({ passed: 6, failed: 0, skipped: 0 });
    expect(summary.checks.map((check) => check.id)).toEqual([
      "user_account",
      "user_account_session_cleanup",
      "user_account_provider_session_cleanup",
      "venue_manager_portal",
      "venue_manager_portal_session_cleanup",
      "venue_manager_portal_provider_session_cleanup",
    ]);
    expect(providerSignIns).toEqual(["user", "venue"]);
    expect(providerPasswordRequests).toBe(2);
    expect(providerPasswordAuthorizationHeaders).toEqual([undefined, undefined]);
    expect(providerSignOuts).toEqual(["provider-user", "provider-venue"]);
    expect(revokedTokens).toEqual(["app-user", "app-venue"]);
    expect(result.stdout).not.toContain("user-secret");
    expect(result.stdout).not.toContain("venue-secret");
  });

  it("uses and revokes the manually supplied MFA admin session without automating MFA", async () => {
    const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=admin"], {
      PINTPATH_SMOKE_ADMIN_TOKEN: "app-admin",
      PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "true",
    });

    expect(result.code, result.stderr || result.stdout).toBe(0);
    const summary = JSON.parse(result.stdout) as SmokeSummary;
    expect(summary.summary).toEqual({ passed: 2, failed: 0, skipped: 0 });
    expect(publicConfigRequests).toBe(1);
    expect(adminProtectedRequests).toBe(1);
    expect(providerSignIns).toEqual([]);
    expect(providerPasswordRequests).toBe(0);
    expect(providerSignOuts).toEqual([]);
    expect(revokedTokens).toEqual(["app-admin"]);
    expect(result.stdout).not.toContain("app-admin");
  });

  it("requires a manual MFA/AAL2 admin session instead of accepting admin password automation", async () => {
    const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=admin"], {
      PINTPATH_SMOKE_ADMIN_EMAIL: "admin-smoke@example.test",
      PINTPATH_SMOKE_ADMIN_PASSWORD: "admin-password-must-not-be-used",
    });

    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stdout) as SmokeSummary;
    expect(summary.checks).toEqual([
      expect.objectContaining({
        id: "admin_queues",
        status: "fail",
        detail: "Set PINTPATH_SMOKE_ADMIN_TOKEN to a fresh MFA/AAL2 Pint Path session",
      }),
    ]);
    expect(providerSignIns).toEqual([]);
    expect(providerPasswordRequests).toBe(0);
    expect(providerSignOuts).toEqual([]);
    expect(revokedTokens).toEqual([]);
    expect(result.stdout).not.toContain("admin-password-must-not-be-used");
  });

  it("fails closed without leaking rejected credentials", async () => {
    const rejectedPassword = "do-not-print-this-password";
    const rejectedEmail = "private-account@example.test";
    const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=user"], {
      PINTPATH_SMOKE_USER_EMAIL: rejectedEmail,
      PINTPATH_SMOKE_USER_PASSWORD: rejectedPassword,
    });

    expect(result.code).toBe(1);
    const summary = JSON.parse(result.stdout) as SmokeSummary;
    expect(summary.ok).toBe(false);
    expect(summary.checks).toEqual([
      expect.objectContaining({ id: "user_account", status: "fail", detail: "User smoke account provider sign-in failed (HTTP 401)" }),
    ]);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(rejectedPassword);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(rejectedEmail);
    expect(revokedTokens).toEqual([]);
    expect(providerSignOuts).toEqual([]);
    expect(providerPasswordRequests).toBe(1);
  });

  it("never sends passwords when public Supabase configuration differs from protected pins", async () => {
    const credentials = {
      PINTPATH_SMOKE_USER_EMAIL: "user-smoke@example.test",
      PINTPATH_SMOKE_USER_PASSWORD: "user-secret",
    };

    publishedSupabaseUrl = "https://attacker.invalid";
    const originMismatch = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=user"], credentials);
    expect(originMismatch.code).toBe(1);
    expect((JSON.parse(originMismatch.stdout) as SmokeSummary).checks).toEqual([
      expect.objectContaining({ detail: "Public Supabase URL does not match protected SUPABASE_URL" }),
    ]);
    expect(providerSignIns).toEqual([]);
    expect(providerPasswordRequests).toBe(0);

    publishedSupabaseUrl = baseUrl;
    publishedSupabaseAnonKey = `sb_publishable_${"1".repeat(32)}`;
    const keyMismatch = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=user"], credentials);
    expect(keyMismatch.code).toBe(1);
    expect((JSON.parse(keyMismatch.stdout) as SmokeSummary).checks).toEqual([
      expect.objectContaining({ detail: "Public Supabase key does not match protected SUPABASE_ANON_KEY" }),
    ]);
    expect(providerSignIns).toEqual([]);
    expect(providerPasswordRequests).toBe(0);
  });

  it("rejects normalized protected or published provider URLs before any password request", async () => {
    const credentials = {
      PINTPATH_SMOKE_USER_EMAIL: "user-smoke@example.test",
      PINTPATH_SMOKE_USER_PASSWORD: "user-secret",
    };
    const normalizedVariants = [
      ` ${baseUrl}`,
      `${baseUrl}/`,
      `${baseUrl}/auth`,
      baseUrl.replace("http://", "HTTP://"),
    ];

    for (const candidate of normalizedVariants) {
      const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=user"], {
        ...credentials,
        SUPABASE_URL: candidate,
      });
      expect(result.code).toBe(1);
      expect((JSON.parse(result.stdout) as SmokeSummary).checks).toEqual([
        expect.objectContaining({
          detail: "Protected SUPABASE_URL must be an exact unnormalized provider origin for local smoke authentication",
        }),
      ]);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(candidate);
    }
    expect(publicConfigRequests).toBe(0);
    expect(providerPasswordRequests).toBe(0);

    for (const candidate of normalizedVariants) {
      publishedSupabaseUrl = candidate;
      const result = await runSmoke(
        baseUrl,
        ["--strict-auth", "--auth-only", "--roles=user"],
        credentials,
      );
      expect(result.code).toBe(1);
      expect((JSON.parse(result.stdout) as SmokeSummary).checks).toEqual([
        expect.objectContaining({
          detail: "Public Supabase URL does not match protected SUPABASE_URL",
        }),
      ]);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(candidate);
    }
    expect(publicConfigRequests).toBe(normalizedVariants.length);
    expect(providerPasswordRequests).toBe(0);
  });

  it("rejects legacy, secret, malformed, and oversized protected keys before password auth", async () => {
    const legacyAnonJwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url"),
      "signature",
    ].join(".");
    const rejectedKeys = [
      "",
      `sb_secret_${"s".repeat(32)}`,
      legacyAnonJwt,
      `sb_publishable_${"a".repeat(19)}`,
      `sb_publishable_${"a".repeat(221)}`,
      `sb_publishable_${"a".repeat(20)}!`,
      ` ${validPublishableKey}`,
    ];

    for (const rejectedKey of rejectedKeys) {
      const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=user"], {
        SUPABASE_ANON_KEY: rejectedKey,
        PINTPATH_SMOKE_USER_EMAIL: "user-smoke@example.test",
        PINTPATH_SMOKE_USER_PASSWORD: "user-secret",
      });

      expect(result.code).toBe(1);
      expect((JSON.parse(result.stdout) as SmokeSummary).checks).toEqual([
        expect.objectContaining({
          id: "user_account",
          status: "fail",
          detail: "Protected SUPABASE_ANON_KEY must be an sb_publishable_ key with 20 to 220 URL-safe characters.",
        }),
      ]);
      if (rejectedKey) expect(`${result.stdout}\n${result.stderr}`).not.toContain(rejectedKey);
    }

    expect(providerPasswordRequests).toBe(0);
    expect(providerSignIns).toEqual([]);
  });

  it("requires a publishable key even when strict auth uses a direct admin session", async () => {
    const rejectedKey = `sb_secret_${"s".repeat(32)}`;
    const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=admin"], {
      SUPABASE_ANON_KEY: rejectedKey,
      PINTPATH_SMOKE_ADMIN_TOKEN: "app-admin",
      PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "true",
    });

    expect(result.code).toBe(1);
    expect((JSON.parse(result.stdout) as SmokeSummary).checks).toEqual([
      expect.objectContaining({
        id: "admin_queues",
        status: "fail",
        detail: "Protected SUPABASE_ANON_KEY must be an sb_publishable_ key with 20 to 220 URL-safe characters.",
      }),
    ]);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(rejectedKey);
    expect(publicConfigRequests).toBe(0);
    expect(adminProtectedRequests).toBe(0);
    expect(providerPasswordRequests).toBe(0);
    expect(revokedTokens).toEqual([]);
  });

  it("rejects a deployed key mismatch before using a direct admin session", async () => {
    const deployedKey = `sb_publishable_${"m".repeat(32)}`;
    publishedSupabaseAnonKey = deployedKey;
    const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=admin"], {
      PINTPATH_SMOKE_ADMIN_TOKEN: "app-admin",
      PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "true",
    });

    expect(result.code).toBe(1);
    expect((JSON.parse(result.stdout) as SmokeSummary).checks).toEqual([
      expect.objectContaining({
        id: "admin_queues",
        status: "fail",
        detail: "Public Supabase key does not match protected SUPABASE_ANON_KEY",
      }),
    ]);
    expect(publicConfigRequests).toBe(1);
    expect(adminProtectedRequests).toBe(0);
    expect(providerPasswordRequests).toBe(0);
    expect(revokedTokens).toEqual([]);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("app-admin");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(deployedKey);
  });

  it("accepts the exact lower and upper publishable-key suffix bounds", async () => {
    for (const suffixLength of [20, 220]) {
      const boundaryKey = `sb_publishable_${"b".repeat(suffixLength)}`;
      publishedSupabaseAnonKey = boundaryKey;
      const result = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=user"], {
        SUPABASE_ANON_KEY: boundaryKey,
        PINTPATH_SMOKE_USER_EMAIL: "user-smoke@example.test",
        PINTPATH_SMOKE_USER_PASSWORD: "user-secret",
      });

      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).not.toContain(boundaryKey);
    }

    expect(providerPasswordRequests).toBe(2);
    expect(providerPasswordAuthorizationHeaders).toEqual([undefined, undefined]);
  });
});
