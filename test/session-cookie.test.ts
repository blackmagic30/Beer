import { describe, expect, it } from "vitest";

import { getSessionAuthorization, SESSION_COOKIE_NAME } from "../src/lib/session-cookie.js";

function requestWithHeaders(headers: Record<string, string>) {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );

  return {
    header(name: string) {
      return normalized.get(name.toLowerCase());
    },
  } as never;
}

describe("session authorization", () => {
  it("falls back to the app session cookie when HTTP Basic auth is present", () => {
    const request = requestWithHeaders({
      authorization: "Basic cmVzdG9yZTp0ZXN0",
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent("valid-session-token")}`,
    });

    expect(getSessionAuthorization(request)).toBe("Bearer valid-session-token");
  });

  it("continues to prefer an explicit Bearer authorization header", () => {
    const request = requestWithHeaders({
      authorization: "Bearer explicit-token",
      cookie: `${SESSION_COOKIE_NAME}=cookie-token`,
    });

    expect(getSessionAuthorization(request)).toBe("Bearer explicit-token");
  });

  it("does not treat another authorization scheme as an app session", () => {
    const request = requestWithHeaders({ authorization: "Basic cmVzdG9yZTp0ZXN0" });

    expect(getSessionAuthorization(request)).toBeUndefined();
  });
});
