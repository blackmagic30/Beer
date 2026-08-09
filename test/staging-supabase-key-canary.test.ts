import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  STAGING_SUPABASE_KEY_CANARY_LOCK,
  STAGING_SUPABASE_KEY_CANARY_MAX_RESPONSE_BYTES,
  STAGING_SUPABASE_KEY_CANARY_SCHEMA,
  STAGING_SUPABASE_KEY_CANARY_SCOPE,
  runStagingSupabaseKeyCanary,
} from "../scripts/staging-supabase-key-canary.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const deploymentId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";
const publishableKey = `sb_publishable_${"a".repeat(32)}`;
const stagingSecretKey = `sb_secret_${"b".repeat(32)}`;
const offsiteSecretKey = `sb_secret_${"c".repeat(32)}`;
const stagingAllowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
];
const offsiteAllowedMimeTypes = [
  "application/json",
  "application/octet-stream",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

function environment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    RAILWAY_PROJECT_ID: STAGING_SUPABASE_KEY_CANARY_LOCK.projectId,
    RAILWAY_ENVIRONMENT_ID: STAGING_SUPABASE_KEY_CANARY_LOCK.environmentId,
    RAILWAY_SERVICE_ID: STAGING_SUPABASE_KEY_CANARY_LOCK.serviceId,
    RAILWAY_DEPLOYMENT_ID: deploymentId,
    STAGING_SUPABASE_KEY_CANARY_RAILWAY_CONFIG_PATH:
      STAGING_SUPABASE_KEY_CANARY_LOCK.railwayConfigPath,
    SUPABASE_URL: STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin,
    SUPABASE_ANON_KEY: publishableKey,
    SUPABASE_SERVICE_ROLE_KEY: stagingSecretKey,
    OFFSITE_BACKUP_SUPABASE_URL:
      STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteOrigin,
    OFFSITE_BACKUP_SERVICE_ROLE_KEY: offsiteSecretKey,
    OFFSITE_BACKUP_BUCKET: STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteBucketId,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authSettings(): Record<string, unknown> {
  return {
    external: { email: true, phone: false, google: true, apple: false },
    disable_signup: false,
    mailer_autoconfirm: false,
  };
}

function stagingBucket(): Record<string, unknown> {
  return {
    id: STAGING_SUPABASE_KEY_CANARY_LOCK.stagingBucketId,
    name: STAGING_SUPABASE_KEY_CANARY_LOCK.stagingBucketId,
    public: false,
    file_size_limit: 8 * 1_024 * 1_024,
    allowed_mime_types: stagingAllowedMimeTypes,
    created_at: "2026-08-09T00:00:00.000Z",
  };
}

function offsiteBucket(): Record<string, unknown> {
  return {
    id: STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteBucketId,
    name: STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteBucketId,
    public: false,
    file_size_limit: null,
    allowed_mime_types: offsiteAllowedMimeTypes,
    created_at: "2026-08-09T00:00:00.000Z",
  };
}

function successfulFetch(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/settings")) return jsonResponse(authSettings());
    if (url.includes("/auth/v1/admin/users?page=1&per_page=1")) {
      return jsonResponse({ users: [] });
    }
    if (url.includes(STAGING_SUPABASE_KEY_CANARY_LOCK.stagingBucketId)) {
      return jsonResponse(stagingBucket());
    }
    if (url.includes(STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteBucketId)) {
      return jsonResponse(offsiteBucket());
    }
    return jsonResponse({ message: "unexpected" }, 404);
  }) as typeof fetch;
}

function parseOnlyReceipt(output: string[]): Record<string, unknown> {
  expect(output).toHaveLength(1);
  expect(output[0]!.endsWith("\n")).toBe(true);
  expect(output[0]!.slice(0, -1)).not.toContain("\n");
  const parsed = JSON.parse(output[0]!) as Record<string, unknown>;
  expect(`${JSON.stringify(parsed)}\n`).toBe(output[0]);
  return parsed;
}

describe("staging Supabase replacement-key canary", () => {
  it("uses an isolated one-shot Railway lifecycle", () => {
    const dedicated = fs.readFileSync(
      path.join(
        projectRoot,
        STAGING_SUPABASE_KEY_CANARY_LOCK.railwayConfigPath.slice(1),
      ),
      "utf8",
    );
    const application = fs.readFileSync(
      path.join(projectRoot, "railway.toml"),
      "utf8",
    );

    expect(dedicated).toContain('[build]\nbuilder = "RAILPACK"');
    expect(dedicated).toContain('buildCommand = "npm run build"');
    expect(dedicated).toContain(
      'startCommand = "node dist/scripts/staging-supabase-key-canary.js"',
    );
    expect(dedicated).toContain('restartPolicyType = "NEVER"');
    expect(dedicated).toContain("restartPolicyMaxRetries = 1");
    expect(dedicated).toContain("overlapSeconds = 0");
    expect(dedicated).toContain("drainingSeconds = 0");
    expect(dedicated).not.toMatch(
      /preDeployCommand|healthcheck|ON_FAILURE|dist\/src\/server\.js/,
    );
    expect(
      fs.readFileSync(
        path.join(projectRoot, "scripts/staging-supabase-key-canary.ts"),
        "utf8",
      ),
    ).not.toContain(".unref()");

    expect(application).toContain("preDeployCommand");
    expect(application).toContain("healthcheckPath");
    expect(application).not.toContain("staging-supabase-key-canary");
  });

  it("passes only the exact locked identity and four read-only provider canaries", async () => {
    const output: string[] = [];
    const fetchImpl = successfulFetch();
    const exitCode = await runStagingSupabaseKeyCanary({
      argv: [],
      env: environment(),
      fetchImpl,
      requestTimeoutMs: 100,
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `${STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin}/auth/v1/settings`,
      expect.objectContaining({
        method: "GET",
        headers: { apikey: publishableKey },
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin}/auth/v1/admin/users?page=1&per_page=1`,
      expect.objectContaining({ headers: { apikey: stagingSecretKey } }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      `${STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin}/storage/v1/bucket/${STAGING_SUPABASE_KEY_CANARY_LOCK.stagingBucketId}`,
      expect.objectContaining({ headers: { apikey: stagingSecretKey } }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      `${STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteOrigin}/storage/v1/bucket/${STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteBucketId}`,
      expect.objectContaining({ headers: { apikey: offsiteSecretKey } }),
    );
    for (const call of vi.mocked(fetchImpl).mock.calls) {
      const init = call[1] as RequestInit;
      expect(Object.keys(init.headers as Record<string, string>)).toEqual([
        "apikey",
      ]);
      expect(JSON.stringify(init)).not.toMatch(/authorization|bearer/i);
    }

    const receipt = parseOnlyReceipt(output);
    expect(Object.keys(receipt)).toEqual([
      "schemaVersion",
      "scope",
      "outcome",
      "deploymentId",
      "identity",
      "checks",
    ]);
    expect(Object.keys(receipt.identity as Record<string, unknown>)).toEqual([
      "railwayProject",
      "railwayEnvironment",
      "railwayService",
      "railwayDeployment",
      "dedicatedRailwayConfig",
      "debugAndProxyLoggingDisabled",
      "stagingOrigin",
      "offsiteOrigin",
      "originsDistinct",
      "bucketIdsExact",
      "replacementKeyShapes",
      "replacementKeysDistinct",
    ]);
    expect(Object.keys(receipt.checks as Record<string, unknown>)).toEqual([
      "stagingAuthSettings",
      "stagingAuthAdmin",
      "stagingPrivateStorage",
      "offsitePrivateStorage",
    ]);
    expect(receipt).toEqual({
      schemaVersion: STAGING_SUPABASE_KEY_CANARY_SCHEMA,
      scope: STAGING_SUPABASE_KEY_CANARY_SCOPE,
      outcome: "passed",
      deploymentId,
      identity: {
        railwayProject: true,
        railwayEnvironment: true,
        railwayService: true,
        railwayDeployment: true,
        dedicatedRailwayConfig: true,
        debugAndProxyLoggingDisabled: true,
        stagingOrigin: true,
        offsiteOrigin: true,
        originsDistinct: true,
        bucketIdsExact: true,
        replacementKeyShapes: true,
        replacementKeysDistinct: true,
      },
      checks: {
        stagingAuthSettings: true,
        stagingAuthAdmin: true,
        stagingPrivateStorage: true,
        offsitePrivateStorage: true,
      },
    });
    expect(output[0]).not.toContain(publishableKey);
    expect(output[0]).not.toContain(stagingSecretKey);
    expect(output[0]).not.toContain(offsiteSecretKey);
    expect(output[0]).not.toContain("supabase.co");
  });

  it.each([
    ["project", { RAILWAY_PROJECT_ID: "00000000-0000-4000-8000-000000000000" }],
    ["environment", { RAILWAY_ENVIRONMENT_ID: "00000000-0000-4000-8000-000000000000" }],
    ["service", { RAILWAY_SERVICE_ID: "00000000-0000-4000-8000-000000000000" }],
    ["deployment", { RAILWAY_DEPLOYMENT_ID: "not-a-deployment" }],
    ["config", { STAGING_SUPABASE_KEY_CANARY_RAILWAY_CONFIG_PATH: "/railway.toml" }],
    ["debug", { NODE_DEBUG: "http" }],
    ["proxy", { HTTPS_PROXY: "https://proxy.invalid" }],
    ["staging origin", { SUPABASE_URL: "https://wrong.supabase.co" }],
    ["offsite origin", { OFFSITE_BACKUP_SUPABASE_URL: "https://wrong.supabase.co" }],
    ["bucket", { OFFSITE_BACKUP_BUCKET: "wrong-bucket" }],
  ])("fails before network on %s identity drift", async (label, overrides) => {
    const output: string[] = [];
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const exitCode = await runStagingSupabaseKeyCanary({
      argv: [],
      env: environment(overrides),
      fetchImpl,
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    const receipt = parseOnlyReceipt(output);
    expect(receipt.outcome).toBe("failed");
    if (label === "deployment") expect(receipt.deploymentId).toBeNull();
    expect(output[0]).not.toContain(String(Object.values(overrides)[0]));
  });

  it("rejects arguments, legacy keys, reused keys, and surrounding whitespace before network", async () => {
    const cases: Array<{
      argv?: string[];
      overrides?: Record<string, string>;
    }> = [
      { argv: ["--unexpected"] },
      { overrides: { SUPABASE_ANON_KEY: "legacy-anon-jwt" } },
      { overrides: { SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role-jwt" } },
      { overrides: { OFFSITE_BACKUP_SERVICE_ROLE_KEY: stagingSecretKey } },
      { overrides: { SUPABASE_ANON_KEY: ` ${publishableKey}` } },
    ];

    for (const testCase of cases) {
      const output: string[] = [];
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const exitCode = await runStagingSupabaseKeyCanary({
        argv: testCase.argv ?? [],
        env: environment(testCase.overrides),
        fetchImpl,
        writeOutput: (value) => output.push(value),
      });
      expect(exitCode).toBe(1);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(parseOnlyReceipt(output).outcome).toBe("failed");
    }
  });

  it("fails closed on non-success statuses without exposing status or body", async () => {
    const rawBody = "provider-private-diagnostic-body";
    const output: string[] = [];
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: rawBody }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const exitCode = await runStagingSupabaseKeyCanary({
      argv: [],
      env: environment(),
      fetchImpl,
      requestTimeoutMs: 100,
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(parseOnlyReceipt(output).checks).toEqual({
      stagingAuthSettings: false,
      stagingAuthAdmin: false,
      stagingPrivateStorage: false,
      offsitePrivateStorage: false,
    });
    expect(output[0]).not.toContain(rawBody);
    expect(output[0]).not.toContain("503");
  });

  it("bounds provider bodies and rejects malformed or mislabeled JSON", async () => {
    const bodies = [
      () => new Response("x".repeat(STAGING_SUPABASE_KEY_CANARY_MAX_RESPONSE_BYTES + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      () => new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      () => new Response(JSON.stringify(authSettings()), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ];

    for (const response of bodies) {
      const output: string[] = [];
      const fetchImpl = vi.fn(async () => response()) as typeof fetch;
      const exitCode = await runStagingSupabaseKeyCanary({
        argv: [],
        env: environment(),
        fetchImpl,
        requestTimeoutMs: 100,
        writeOutput: (value) => output.push(value),
      });
      expect(exitCode).toBe(1);
      expect(parseOnlyReceipt(output).outcome).toBe("failed");
    }
  });

  it("applies an outer timeout even when the injected fetch ignores abort", async () => {
    const output: string[] = [];
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    const startedAt = Date.now();
    const exitCode = await runStagingSupabaseKeyCanary({
      argv: [],
      env: environment(),
      fetchImpl,
      requestTimeoutMs: 5,
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(parseOnlyReceipt(output).outcome).toBe("failed");
  });

  it("keeps the same deadline active while a provider body is stalled", async () => {
    const output: string[] = [];
    const fetchImpl = vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const startedAt = Date.now();
    const exitCode = await runStagingSupabaseKeyCanary({
      argv: [],
      env: environment(),
      fetchImpl,
      requestTimeoutMs: 5,
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(parseOnlyReceipt(output).outcome).toBe("failed");
  });

  it("requires the exact private bucket identities and policies", async () => {
    const invalidFixtures = [
      { ...stagingBucket(), public: true },
      { ...stagingBucket(), file_size_limit: 6 * 1_024 * 1_024 },
      { ...stagingBucket(), allowed_mime_types: ["image/jpeg"] },
      { ...offsiteBucket(), id: "lookalike" },
      { ...offsiteBucket(), file_size_limit: 1 },
      {
        ...offsiteBucket(),
        allowed_mime_types: [...offsiteAllowedMimeTypes, "text/plain"],
      },
    ];

    for (const invalid of invalidFixtures) {
      const output: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/auth/v1/settings")) {
          return jsonResponse(authSettings());
        }
        if (url.includes("/auth/v1/admin/users")) {
          return jsonResponse({ users: [] });
        }
        return jsonResponse(invalid);
      }) as typeof fetch;
      const exitCode = await runStagingSupabaseKeyCanary({
        argv: [],
        env: environment(),
        fetchImpl,
        requestTimeoutMs: 100,
        writeOutput: (value) => output.push(value),
      });
      expect(exitCode).toBe(1);
      expect(parseOnlyReceipt(output).outcome).toBe("failed");
    }
  });

  it("never emits credentials, origins, provider bodies, or thrown errors", async () => {
    const rawError = "raw-provider-error-containing-private-context";
    const output: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error(rawError);
    }) as typeof fetch;
    const exitCode = await runStagingSupabaseKeyCanary({
      argv: [],
      env: environment(),
      fetchImpl,
      requestTimeoutMs: 100,
      writeOutput: (value) => output.push(value),
    });
    const receipt = parseOnlyReceipt(output);

    expect(exitCode).toBe(1);
    expect(Object.keys(receipt)).toEqual([
      "schemaVersion",
      "scope",
      "outcome",
      "deploymentId",
      "identity",
      "checks",
    ]);
    for (const forbidden of [
      publishableKey,
      stagingSecretKey,
      offsiteSecretKey,
      STAGING_SUPABASE_KEY_CANARY_LOCK.stagingOrigin,
      STAGING_SUPABASE_KEY_CANARY_LOCK.offsiteOrigin,
      rawError,
    ]) {
      expect(output[0]).not.toContain(forbidden);
    }
  });
});
