import { afterEach, describe, expect, it, vi } from "vitest";

const productionRequiredEnv = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://beer.splitseconds.app",
  ADMIN_EMAILS: "admin@example.com",
  GOOGLE_MAPS_API_KEY: "test-browser-maps-key",
  SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
  REDIS_URL: "redis://localhost:6379",
  TWILIO_VALIDATE_SIGNATURES: "true",
  ELEVENLABS_WEBHOOK_SECRET: "test-elevenlabs-webhook-secret",
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

  it("lets public production boot while provider-only secrets are pending and fails closed in feature code", async () => {
    stubProductionEnv({
      ADMIN_EMAILS: "",
      DEMO_BILLING_MODE: "",
      SOURCE_EVIDENCE_SIGNING_SECRET: "",
      REDIS_URL: "",
      TWILIO_VALIDATE_SIGNATURES: "",
      ELEVENLABS_WEBHOOK_SECRET: "",
    });

    const { env } = await loadEnv();

    expect(env.NODE_ENV).toBe("production");
    expect(env.SOURCE_EVIDENCE_SIGNING_SECRET).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.TWILIO_VALIDATE_SIGNATURES).toBe(true);
    expect(env.ELEVENLABS_WEBHOOK_SECRET).toBeUndefined();
  });

  it("still blocks explicit production demo billing without the override", async () => {
    stubProductionEnv({ DEMO_BILLING_MODE: "true" });

    await expect(loadEnv()).rejects.toThrow(
      "DEMO_BILLING_MODE cannot be true in production unless ALLOW_DEMO_BILLING_IN_PRODUCTION=true.",
    );
  });
});
