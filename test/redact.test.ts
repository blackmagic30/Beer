import { describe, expect, it } from "vitest";

import { redactSecrets } from "../src/lib/redact.js";

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
});
