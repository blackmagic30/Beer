import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBoundedSupabaseFetch,
  createServerSupabaseClient,
  createSupabaseApiKeyAwareFetch,
} from "../src/lib/supabase-client.js";

const secretApiKey = `sb_secret_${"s".repeat(32)}`;
const publishableApiKey = `sb_publishable_${"p".repeat(32)}`;
const legacyApiKey = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url"),
  "synthetic-signature",
].join(".");

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded Supabase fetch", () => {
  it("settles on its deadline even if the underlying fetch ignores abort signals", async () => {
    const underlyingFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const boundedFetch = createBoundedSupabaseFetch({
      timeoutMs: 10,
      fetchImplementation: underlyingFetch,
    });

    await expect(boundedFetch("https://project.supabase.co/storage/v1/bucket"))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(underlyingFetch).toHaveBeenCalledTimes(1);
    expect(underlyingFetch.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
  });

  it.each([secretApiKey, publishableApiKey])(
    "removes only the duplicated opaque API-key bearer for %s",
    async (apiKey) => {
      let receivedHeaders: Headers | null = null;
      const originalHeaders = new Headers({
        apikey: apiKey,
        authorization: `Bearer ${apiKey}`,
        "x-request-marker": "fixture",
      });
      const underlyingFetch = vi.fn(async (_input, init) => {
        receivedHeaders = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const awareFetch = createSupabaseApiKeyAwareFetch(apiKey, underlyingFetch);

      await awareFetch("https://project.supabase.co/rest/v1/venues", {
        headers: originalHeaders,
      });

      expect(receivedHeaders!.get("apikey")).toBe(apiKey);
      expect(receivedHeaders!.has("authorization")).toBe(false);
      expect(receivedHeaders!.get("x-request-marker")).toBe("fixture");
      expect(originalHeaders.get("authorization")).toBe(`Bearer ${apiKey}`);
    },
  );

  it("preserves a distinct user-session bearer for opaque API keys", async () => {
    const sessionJwt = "user-session-jwt";
    let receivedHeaders: Headers | null = null;
    const underlyingFetch = vi.fn(async (_input, init) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const awareFetch = createSupabaseApiKeyAwareFetch(
      publishableApiKey,
      underlyingFetch,
    );

    await awareFetch("https://project.supabase.co/rest/v1/venues", {
      headers: {
        apikey: publishableApiKey,
        authorization: `Bearer ${sessionJwt}`,
      },
    });

    expect(receivedHeaders!.get("apikey")).toBe(publishableApiKey);
    expect(receivedHeaders!.get("authorization")).toBe(`Bearer ${sessionJwt}`);
  });

  it("preserves legacy JWT API-key bearer behavior", async () => {
    let receivedHeaders: Headers | null = null;
    const underlyingFetch = vi.fn(async (_input, init) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const awareFetch = createSupabaseApiKeyAwareFetch(
      legacyApiKey,
      underlyingFetch,
    );

    await awareFetch("https://project.supabase.co/storage/v1/bucket", {
      headers: {
        apikey: legacyApiKey,
        authorization: `Bearer ${legacyApiKey}`,
      },
    });

    expect(receivedHeaders!.get("apikey")).toBe(legacyApiKey);
    expect(receivedHeaders!.get("authorization")).toBe(
      `Bearer ${legacyApiKey}`,
    );
  });

  it("applies opaque-key stripping to Request headers without mutating the Request", async () => {
    let receivedHeaders: Headers | null = null;
    const request = new Request(
      "https://project.supabase.co/auth/v1/settings",
      {
        headers: {
          apikey: publishableApiKey,
          authorization: `Bearer ${publishableApiKey}`,
        },
      },
    );
    const underlyingFetch = vi.fn(async (_input, init) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const awareFetch = createSupabaseApiKeyAwareFetch(
      publishableApiKey,
      underlyingFetch,
    );

    await awareFetch(request);

    expect(receivedHeaders!.get("apikey")).toBe(publishableApiKey);
    expect(receivedHeaders!.has("authorization")).toBe(false);
    expect(request.headers.get("authorization")).toBe(
      `Bearer ${publishableApiKey}`,
    );
  });

  it("uses apikey-only opaque-key authentication across REST, Auth admin, and Storage", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const underlyingFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.includes("/rest/v1/")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/auth/v1/admin/users")) {
        return new Response(JSON.stringify({ users: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/storage/v1/bucket/")) {
        return new Response(JSON.stringify({
          id: "fixture",
          name: "fixture",
          public: false,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createServerSupabaseClient(
      "https://project.supabase.co",
      secretApiKey,
      { fetchImplementation: underlyingFetch, timeoutMs: 1_000 },
    );

    await client.from("venues").select("id").limit(1);
    await client.auth.admin.listUsers({ page: 1, perPage: 1 });
    await client.storage.getBucket("fixture");

    expect(calls).toHaveLength(3);
    expect(calls.some((call) => call.url.includes("/rest/v1/venues"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/auth/v1/admin/users"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/storage/v1/bucket/fixture"))).toBe(true);
    for (const call of calls) {
      expect(call.headers.get("apikey")).toBe(secretApiKey);
      expect(call.headers.has("authorization")).toBe(false);
    }
  });

  it("preserves a caller abort reason while composing it with the deadline", async () => {
    let receivedSignal: AbortSignal | null = null;
    const underlyingFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      receivedSignal = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    });
    const boundedFetch = createBoundedSupabaseFetch({
      timeoutMs: 30_000,
      fetchImplementation: underlyingFetch,
    });
    const controller = new AbortController();
    const callerReason = new Error("caller cancelled request");
    const request = boundedFetch("https://project.supabase.co/rest/v1/venues", {
      signal: controller.signal,
    });
    const assertion = expect(request).rejects.toBe(callerReason);

    controller.abort(callerReason);

    await assertion;
    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal).toMatchObject({ aborted: true, reason: callerReason });
  });

  it("keeps every server-side Supabase client behind the bounded factory", () => {
    const collect = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const absolutePath = path.join(directory, entry.name);
        return entry.isDirectory() ? collect(absolutePath) : entry.name.endsWith(".ts") ? [absolutePath] : [];
      });
    const helperPath = path.resolve(process.cwd(), "src/lib/supabase-client.ts");
    const directClients = ["src", "scripts"]
      .flatMap((directory) => collect(path.resolve(process.cwd(), directory)))
      .filter((filename) => filename !== helperPath)
      .filter((filename) => /\bcreateClient\s*\(/.test(fs.readFileSync(filename, "utf8")))
      .map((filename) => path.relative(process.cwd(), filename));

    expect(directClients).toEqual([]);
  });
});
