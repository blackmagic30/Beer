import { describe, expect, it } from "vitest";

import { normalizeAustralianPhoneToE164 } from "../src/lib/phone.js";

describe("normalizeAustralianPhoneToE164", () => {
  it("normalizes Melbourne landlines to E.164", () => {
    expect(normalizeAustralianPhoneToE164("(03) 9810 0066")).toBe("+61398100066");
  });

  it("normalizes mobile numbers to E.164", () => {
    expect(normalizeAustralianPhoneToE164("0412 345 678")).toBe("+61412345678");
  });

  it("returns null for unsupported numbers", () => {
    expect(normalizeAustralianPhoneToE164("1300 123 456")).toBeNull();
  });
});
