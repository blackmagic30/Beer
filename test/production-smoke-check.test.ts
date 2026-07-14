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
        SUPABASE_ANON_KEY: "browser-safe-test-key",
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
  let publishedSupabaseAnonKey = "browser-safe-test-key";
  let providerSignIns: string[] = [];
  let providerSignOuts: string[] = [];
  let revokedTokens: string[] = [];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", baseUrl);

    if (request.method === "GET" && url.pathname === "/api/business/config") {
      sendJson(response, 200, {
        ok: true,
        data: { pricing: {}, supabaseUrl: publishedSupabaseUrl, supabaseAnonKey: publishedSupabaseAnonKey },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/v1/token") {
      const body = await requestJson(request);
      const email = String(body.email || "");
      const password = String(body.password || "");
      const role = email.startsWith("user-") ? "user" : email.startsWith("venue-") ? "venue" : "unknown";
      providerSignIns.push(role);
      if (
        url.searchParams.get("grant_type") !== "password"
        || request.headers.apikey !== "browser-safe-test-key"
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
    if (request.method === "GET" && url.pathname === "/api/business/admin/queues" && authorization === "Bearer app-admin") {
      sendJson(response, 200, {
        ok: true,
        data: { feedback: [], wrongPriceReports: [], venueRequests: [], pagination: {}, totals: {} },
      });
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
    publishedSupabaseAnonKey = "browser-safe-test-key";
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
    expect(providerSignIns).toEqual([]);
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

    publishedSupabaseUrl = baseUrl;
    publishedSupabaseAnonKey = "attacker-controlled-key";
    const keyMismatch = await runSmoke(baseUrl, ["--strict-auth", "--auth-only", "--roles=user"], credentials);
    expect(keyMismatch.code).toBe(1);
    expect((JSON.parse(keyMismatch.stdout) as SmokeSummary).checks).toEqual([
      expect.objectContaining({ detail: "Public Supabase key does not match protected SUPABASE_ANON_KEY" }),
    ]);
    expect(providerSignIns).toEqual([]);
  });
});
