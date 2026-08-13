import { describe, expect, it } from "vitest";

import {
  redactKnownSecretValues,
  redactSecrets,
  redactString,
} from "../src/lib/redact.js";
import { hasExactLegacySupabaseRoleJwt } from "../src/lib/supabase-key-format.js";

describe("secret redaction object safety", () => {
  it("drops prototype-mutating keys from parsed untrusted objects", () => {
    const input = JSON.parse(
      '{"safe":"visible","__proto__":{"polluted":true},"prototype":"blocked","constructor":"blocked"}',
    ) as Record<string, unknown>;

    const output = redactSecrets(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(Object.keys(output)).toEqual(["safe"]);
    expect(output.safe).toBe("visible");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("redacts exact opaque Supabase keys from free-form provider errors", () => {
    const secret = `sb_secret_${"x".repeat(32)}`;
    const publishable = `sb_publishable_${"y".repeat(32)}`;
    const output = redactString(
      `provider echoed ${secret}; browser config echoed (${publishable})`,
    );

    expect(output).toBe("provider echoed [REDACTED]; browser config echoed ([REDACTED])");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(publishable);
  });

  it("redacts embedded and overlong key-shaped substrings without leaving a partial value", () => {
    const embedded = `prefixsb_secret_${"x".repeat(32)}`;
    const overlong = `sb_secret_${"y".repeat(221)}`;

    expect(redactString(embedded)).toBe("prefix[REDACTED]");
    expect(redactString(overlong)).toBe("[REDACTED]");
  });

  it("redacts opaque Supabase keys nested in untrusted error carriers", () => {
    const secret = `sb_secret_${"z".repeat(32)}`;
    const output = redactSecrets({ error: { message: `request failed for ${secret}` } });

    expect(output).toEqual({ error: { message: "request failed for [REDACTED]" } });
  });

  it("scrubs an exact loaded credential even when adjacent bytes defeat pattern boundaries", () => {
    const secret = `sb_secret_${"q".repeat(220)}`;
    const output = redactKnownSecretValues(
      `provider echoed ${secret}x beside an error`,
      [secret],
    );

    expect(output).toBe("provider echoed [REDACTED]x beside an error");
    expect(output).not.toContain(secret);
  });

  it("redacts an embedded legacy Supabase JWT without relying on word boundaries", () => {
    const legacyServiceRoleJwt = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url"),
      Buffer.alloc(32, 7).toString("base64url"),
    ].join(".");
    const output = redactString(
      `provider echoed prefix${legacyServiceRoleJwt}suffix`,
    );

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(legacyServiceRoleJwt);
  });

  it("redacts every accepted non-eyJ legacy key shape used by the server slot", () => {
    const legacyServiceRoleJwt = [
      Buffer.from(`  ${JSON.stringify({ typ: "JWT", alg: "HS256" })}`).toString("base64url"),
      Buffer.from(`  ${JSON.stringify({ role: "service_role" })}`).toString("base64url"),
      Buffer.alloc(32, 9).toString("base64url"),
    ].join(".");
    expect(legacyServiceRoleJwt.startsWith("eyJ")).toBe(false);
    expect(hasExactLegacySupabaseRoleJwt(legacyServiceRoleJwt, "service_role"))
      .toBe(true);

    const output = redactString(`provider echoed prefix${legacyServiceRoleJwt}suffix`);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(legacyServiceRoleJwt);
  });
});
