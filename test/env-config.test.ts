import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const productionRequiredEnv = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://pintpath.au",
  ADMIN_EMAILS: "admin@example.com",
  GOOGLE_MAPS_API_KEY: "test-browser-maps-key",
  GOOGLE_MAPS_MAP_ID: "test-vector-map-id",
  SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
  REDIS_URL: "redis://localhost:6379",
  ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
};

function stubProductionEnv(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...productionRequiredEnv, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

async function loadEnv() {
  vi.resetModules();
  return import("../src/config/env.js");
}

describe("environment safety defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults demo billing off in production when the variable is not explicitly set", async () => {
    stubProductionEnv({ DEMO_BILLING_MODE: "" });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.DEMO_BILLING_MODE).toBe(false);
  });

  it("does not block public production boot while the official admin email is pending", async () => {
    stubProductionEnv({ ADMIN_EMAILS: "", DEMO_BILLING_MODE: "" });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.ADMIN_EMAILS).toBeUndefined();
  });

  it("requires source evidence signing in production so review links do not fail later", async () => {
    stubProductionEnv({
      ADMIN_EMAILS: "",
      DEMO_BILLING_MODE: "",
      SOURCE_EVIDENCE_SIGNING_SECRET: "",
    });

    await expect(loadEnv()).rejects.toThrow(
      "SOURCE_EVIDENCE_SIGNING_SECRET is required in production",
    );
  });

  it("still lets production boot without Redis unless in-memory fallback is explicitly enabled", async () => {
    stubProductionEnv({
      ADMIN_EMAILS: "",
      DEMO_BILLING_MODE: "",
      REDIS_URL: "",
    });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION).toBe(false);
  });

  it("still blocks explicit production demo billing without the override", async () => {
    stubProductionEnv({ DEMO_BILLING_MODE: "true" });

    await expect(loadEnv()).rejects.toThrow(
      "DEMO_BILLING_MODE cannot be true in production unless ALLOW_DEMO_BILLING_IN_PRODUCTION=true.",
    );
  });

  it("allows admin MFA to be temporarily disabled for owner-led production field testing", async () => {
    stubProductionEnv({
      DEMO_BILLING_MODE: "",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: "false",
    });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.REQUIRE_ADMIN_MFA_IN_PRODUCTION).toBe(false);
  });

  it("rejects Railway preview domains as the canonical production public URL", async () => {
    stubProductionEnv({ PUBLIC_BASE_URL: "https://beer-production-aad4.up.railway.app" });

    await expect(loadEnv()).rejects.toThrow(
      "PUBLIC_BASE_URL must be https://pintpath.au in production",
    );
  });

  it("checks all paid-plan and POS launch variables in provider readiness", () => {
    const readinessScript = fs.readFileSync(path.resolve(process.cwd(), "scripts/provider-readiness-check.ts"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(readinessScript).toContain('checkRequired("STRIPE_PRICE_MONTHLY"');
    expect(readinessScript).toContain('checkRequired("STRIPE_PRICE_YEARLY"');
    expect(readinessScript).toContain('checkRequired("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"');
    expect(readinessScript).toContain('checkRequired("GOOGLE_PLACES_API_KEY"');
    expect(readinessScript).toContain('checkRequired("OPENAI_API_KEY"');
    expect(readinessScript).toContain('checkRequired("POS_WEBHOOK_SIGNING_SECRET"');
    expect(readinessScript).toContain("SUPABASE_PROVIDER_CALLBACK_URL");
    expect(readinessScript).toContain("/auth/v1/callback");
    expect(readinessScript).toContain("ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION");
    expect(readinessScript).toContain("LAUNCH_READINESS_STRICT");
    expect(readinessScript).toContain("blockingWarnings");
    expect(packageJson.scripts["readiness:launch"]).toContain("LAUNCH_READINESS_STRICT=true NODE_ENV=production");
  });
});
