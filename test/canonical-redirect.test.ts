import { describe, expect, it } from "vitest";

import { buildCanonicalHostRedirectUrl } from "../src/lib/canonical-redirect.js";

describe("canonical host redirects", () => {
  it("preserves local callback paths and query strings", () => {
    expect(buildCanonicalHostRedirectUrl(
      "https://pintpath.au",
      "/auth/callback?code=oauth-code",
    )).toBe("https://pintpath.au/auth/callback?code=oauth-code");
  });

  it.each([
    "//attacker.example/steal?code=oauth-code",
    "\\\\attacker.example\\steal?code=oauth-code",
  ])("keeps network-path references on the canonical origin", (requestTarget) => {
    const redirect = buildCanonicalHostRedirectUrl(
      "https://pintpath.au",
      requestTarget,
    );

    expect(new URL(redirect).origin).toBe("https://pintpath.au");
    expect(redirect).toBe(
      "https://pintpath.au/attacker.example/steal?code=oauth-code",
    );
  });
});
