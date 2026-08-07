import { describe, expect, it } from "vitest";

import {
  buildCanonicalHostRedirectUrl,
  shouldRedirectToCanonicalHost,
} from "../src/lib/canonical-redirect.js";

describe("canonical host redirects", () => {
  it.each([
    "www.pintpath.au",
    "pintpath.com.au",
    "www.pintpath.com.au",
    "WWW.PINTPATH.COM.AU",
  ])("redirects the production www and legacy host %s", (requestHostname) => {
    expect(shouldRedirectToCanonicalHost("pintpath.au", requestHostname)).toBe(true);
  });

  it.each([
    "pintpath.au",
    "attacker.example",
    "pintpath.au.attacker.example",
    "www.pintpath.com.au.attacker.example",
  ])("does not redirect the canonical or untrusted host %s", (requestHostname) => {
    expect(shouldRedirectToCanonicalHost("pintpath.au", requestHostname)).toBe(false);
  });

  it("does not apply Pint Path production aliases to an isolated staging origin", () => {
    expect(shouldRedirectToCanonicalHost(
      "beer-staging.up.railway.app",
      "www.beer-staging.up.railway.app",
    )).toBe(true);
    expect(shouldRedirectToCanonicalHost(
      "beer-staging.up.railway.app",
      "www.pintpath.com.au",
    )).toBe(false);
  });

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
