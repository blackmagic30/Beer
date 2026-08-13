import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const SUPABASE_URL = "https://auth.pintpath.au";
const PUBLISHABLE_KEY = `sb_publishable_${"A".repeat(20)}`;

function legacySupabaseJwt(role: "anon" | "service_role", signatureByte: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ role }), "utf8").toString("base64url"),
    Buffer.alloc(32, signatureByte).toString("base64url"),
  ].join(".");
}

const LEGACY_ANON_KEY = legacySupabaseJwt("anon", 1);
const LEGACY_SERVICE_ROLE_KEY = legacySupabaseJwt("service_role", 2);

class BrowserStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface CapturedRequest {
  body: string | null;
  headers: Headers;
  method: string;
  redirect: RequestRedirect | undefined;
  url: string;
}

interface BrowserSupabaseApi {
  getSupabaseConfig(): { url: string | null; anonKey: string | null };
  getSupabaseClient(): BrowserSupabaseClient | null;
  getSupabaseOAuthClient(): BrowserSupabaseClient | null;
  getCanonicalBaseUrl(): string;
  getAuthCallbackUrl(): string;
  signInWithOAuth(provider: string, options?: { returnTo?: string }): Promise<void>;
}

interface ClientOptions {
  auth?: { flowType?: string };
  global?: { fetch?: typeof globalThis.fetch };
}

interface BrowserSupabaseClient {
  auth: {
    getSession: () => Promise<unknown>;
    signInWithOAuth: (input: unknown) => Promise<unknown>;
    signInWithPassword: (credentials: {
      email: string;
      password: string;
    }) => Promise<unknown>;
  };
  from(table: string): {
    select(columns: string): Promise<unknown>;
  };
}

interface SupabaseBrowserBundle {
  createClient(url: string, apiKey: string, options: ClientOptions): BrowserSupabaseClient;
}

function businessSource(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.js"), "utf8");
}

function supabaseBrowserBundleSource(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), "node_modules/@supabase/supabase-js/dist/umd/supabase.js"),
    "utf8",
  );
}

function requestHeaders(input: URL | RequestInfo, init?: RequestInit): Headers {
  if (init?.headers) return new Headers(init.headers);
  return input instanceof Request ? new Headers(input.headers) : new Headers();
}

function loadBrowserSupabase(key: unknown, options: {
  supabaseUrl?: unknown;
  viewerConfig?: Record<string, unknown>;
  viewerOrigin?: string;
} = {}) {
  const requests: CapturedRequest[] = [];
  const clientOptions: ClientOptions[] = [];
  const viewerOrigin = options.viewerOrigin ?? "https://pintpath.au";
  const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      body: typeof init?.body === "string" ? init.body : null,
      headers: requestHeaders(input, init),
      method: init?.method || (input instanceof Request ? input.method : "GET"),
      redirect: init?.redirect,
      url: input instanceof Request ? input.url : String(input),
    });
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const windowObject: Record<string, unknown> = {
    MELB_BEER_BOT_VIEWER_CONFIG: options.viewerConfig ?? {
      supabaseUrl: options.supabaseUrl ?? SUPABASE_URL,
      supabaseAnonKey: key,
    },
    location: {
      origin: viewerOrigin,
      hostname: new URL(viewerOrigin).hostname,
      pathname: "/account.html",
      search: "",
      hash: "",
    },
    localStorage: new BrowserStorage(),
    sessionStorage: new BrowserStorage(),
    addEventListener: vi.fn(),
  };
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    DOMException,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    clearInterval,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
    fetch: fetchImplementation,
    setInterval,
    setTimeout,
    WebSocket: class {},
    window: windowObject,
  });
  vm.runInContext(supabaseBrowserBundleSource(), context, {
    filename: "node_modules/@supabase/supabase-js/dist/umd/supabase.js",
  });
  const pinnedBrowserSdk = context.supabase as SupabaseBrowserBundle;
  windowObject.supabase = {
    createClient(url: string, apiKey: string, options: ClientOptions) {
      clientOptions.push(options);
      return pinnedBrowserSdk.createClient(url, apiKey, options);
    },
  };
  vm.runInContext(businessSource(), context, { filename: "viewer/business.js" });

  return {
    api: windowObject.MelbBeerBusiness as BrowserSupabaseApi,
    clientOptions,
    fetchImplementation,
    requests,
  };
}

describe("browser Supabase publishable-key compatibility", () => {
  it.each([
    "https://attacker.invalid",
    "HTTPS://PINTPATH.AU",
    "https://pintpath.au/",
    "https://user@pintpath.au",
  ])("binds production OAuth and email callbacks to the viewer origin despite publicBaseUrl %s", async (publicBaseUrl) => {
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      viewerConfig: {
        publicBaseUrl,
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: PUBLISHABLE_KEY,
      },
    });
    const client = harness.api.getSupabaseOAuthClient();
    expect(client).not.toBeNull();
    const signInWithOAuth = vi.fn(async () => ({ data: {}, error: null }));
    client!.auth.signInWithOAuth = signInWithOAuth;

    expect(harness.api.getCanonicalBaseUrl()).toBe("https://pintpath.au");
    expect(harness.api.getAuthCallbackUrl()).toBe("https://pintpath.au/auth/callback");
    await harness.api.signInWithOAuth("google");
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "https://pintpath.au/auth/callback",
        scopes: "email profile",
      },
    });
    expect(JSON.stringify(signInWithOAuth.mock.calls)).not.toContain("attacker.invalid");
  });

  it("binds permanent-staging OAuth callbacks to the viewer instead of a configured hostile origin", async () => {
    const viewerOrigin = "https://permanent-staging.pintpath.au";
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      viewerOrigin,
      viewerConfig: {
        publicBaseUrl: "https://attacker.invalid",
        supabaseUrl: "https://bbfibbadwjxzrcdncavy.supabase.co",
        supabaseAnonKey: PUBLISHABLE_KEY,
      },
    });
    const client = harness.api.getSupabaseOAuthClient();
    expect(client).not.toBeNull();
    const signInWithOAuth = vi.fn(async () => ({ data: {}, error: null }));
    client!.auth.signInWithOAuth = signInWithOAuth;

    expect(harness.api.getCanonicalBaseUrl()).toBe(viewerOrigin);
    expect(harness.api.getAuthCallbackUrl()).toBe(`${viewerOrigin}/auth/callback`);
    await harness.api.signInWithOAuth("google");
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: `${viewerOrigin}/auth/callback`,
        scopes: "email profile",
      },
    });
    expect(JSON.stringify(signInWithOAuth.mock.calls)).not.toContain("attacker.invalid");
  });

  it("keeps exactly the implicit and PKCE SDK creation sites on the shared key-aware fetch path", async () => {
    const source = businessSource();
    const packageMetadata = JSON.parse(fs.readFileSync(
      path.resolve(process.cwd(), "node_modules/@supabase/supabase-js/package.json"),
      "utf8",
    )) as { version?: string };
    expect(packageMetadata.version).toBe("2.112.3");
    expect(source.match(/window\.supabase\.createClient\(/g)).toHaveLength(2);
    expect(source.match(/fetch: createBrowserSupabaseFetch\(config\.anonKey\)/g)).toHaveLength(2);

    const harness = loadBrowserSupabase(PUBLISHABLE_KEY);
    const implicitClient = harness.api.getSupabaseClient();
    const pkceClient = harness.api.getSupabaseOAuthClient();

    expect(implicitClient).not.toBeNull();
    expect(pkceClient).not.toBeNull();
    expect(harness.clientOptions).toHaveLength(2);
    expect(harness.clientOptions.map((options) => options.auth?.flowType)).toEqual([
      "implicit",
      "pkce",
    ]);
    expect(harness.clientOptions.every((options) => typeof options.global?.fetch === "function"))
      .toBe(true);

    await implicitClient!.from("venues").select("id");
    await pkceClient!.from("venues").select("id");
    expect(harness.requests).toHaveLength(2);
    for (const request of harness.requests) {
      expect(request.url).toBe(`${SUPABASE_URL}/rest/v1/venues?select=id`);
      expect(request.headers.get("apikey")).toBe(PUBLISHABLE_KEY);
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.redirect).toBe("error");
    }
  });

  it("keeps a distinct authenticated-user bearer on an actual pinned SDK request", async () => {
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY);
    const client = harness.api.getSupabaseClient();
    expect(client).not.toBeNull();
    client!.auth.getSession = vi.fn(async () => ({
      data: { session: { access_token: "fixture-user-session-jwt" } },
      error: null,
    })) as typeof client.auth.getSession;

    await client!.from("venues").select("id");

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.headers.get("apikey")).toBe(PUBLISHABLE_KEY);
    expect(harness.requests[0]?.headers.get("authorization"))
      .toBe("Bearer fixture-user-session-jwt");
    expect(harness.requests[0]?.redirect).toBe("error");
  });

  it("keeps pinned browser password authentication apikey-only", async () => {
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY);
    const client = harness.api.getSupabaseClient();
    expect(client).not.toBeNull();

    await client!.auth.signInWithPassword({
      email: "browser-user@example.test",
      password: "synthetic-browser-password",
    });

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.url)
      .toBe(`${SUPABASE_URL}/auth/v1/token?grant_type=password`);
    expect(harness.requests[0]?.method).toBe("POST");
    expect(harness.requests[0]?.headers.get("apikey")).toBe(PUBLISHABLE_KEY);
    expect(harness.requests[0]?.headers.has("authorization")).toBe(false);
    expect(harness.requests[0]?.redirect).toBe("error");
    expect(JSON.parse(harness.requests[0]?.body || "null")).toMatchObject({
      email: "browser-user@example.test",
      password: "synthetic-browser-password",
    });
  });

  it("preserves the legacy anon JWT transport for rollback", async () => {
    const harness = loadBrowserSupabase(LEGACY_ANON_KEY);
    const client = harness.api.getSupabaseClient();
    expect(client).not.toBeNull();

    await client!.from("venues").select("id");

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.headers.get("apikey")).toBe(LEGACY_ANON_KEY);
    expect(harness.requests[0]?.headers.get("authorization")).toBe(`Bearer ${LEGACY_ANON_KEY}`);
    expect(harness.requests[0]?.redirect).toBe("error");
  });

  it.each([
    "https://attacker.invalid",
    "http://auth.pintpath.au",
    "https://auth.pintpath.au/",
    "https://user@auth.pintpath.au",
    "https://auth.pintpath.au:443",
    ` ${SUPABASE_URL}`,
  ])("rejects production browser Auth origin %s before SDK creation", (supabaseUrl) => {
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, { supabaseUrl });

    expect(harness.api.getSupabaseConfig()).toEqual({ url: null, anonKey: null });
    expect(harness.api.getSupabaseClient()).toBeNull();
    expect(harness.api.getSupabaseOAuthClient()).toBeNull();
    expect(harness.clientOptions).toHaveLength(0);
    expect(harness.fetchImplementation).not.toHaveBeenCalled();
  });

  it("allows an exact alternate HTTPS origin only outside the production viewer", () => {
    const stagingOrigin = "https://staging-project.supabase.co";
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      supabaseUrl: stagingOrigin,
      viewerOrigin: "https://staging.pintpath.au",
    });

    expect(harness.api.getSupabaseConfig()).toEqual({
      url: stagingOrigin,
      anonKey: PUBLISHABLE_KEY,
    });
    expect(harness.api.getSupabaseClient()).not.toBeNull();
  });

  it("rejects a remote cleartext Auth origin even from a local viewer", () => {
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      supabaseUrl: "http://attacker.invalid",
      viewerOrigin: "http://127.0.0.1:3000",
    });

    expect(harness.api.getSupabaseConfig()).toEqual({ url: null, anonKey: null });
    expect(harness.api.getSupabaseClient()).toBeNull();
    expect(harness.fetchImplementation).not.toHaveBeenCalled();
  });

  it("does not combine a partial standalone pair with hosted top-level config", () => {
    for (const business of [
      { supabaseUrl: "https://staging-project.supabase.co" },
      { supabaseAnonKey: PUBLISHABLE_KEY },
    ]) {
      const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
        viewerConfig: {
          supabaseUrl: SUPABASE_URL,
          supabaseAnonKey: PUBLISHABLE_KEY,
          business,
        },
      });
      expect(harness.api.getSupabaseConfig()).toEqual({ url: null, anonKey: null });
      expect(harness.api.getSupabaseClient()).toBeNull();
    }
  });

  it.each([
    ["new secret key", `sb_secret_${"S".repeat(20)}`],
    ["short publishable key", `sb_publishable_${"A".repeat(19)}`],
    ["long publishable key", `sb_publishable_${"A".repeat(221)}`],
    ["publishable key with punctuation", `sb_publishable_${"A".repeat(19)}!`],
    ["publishable key with surrounding whitespace", ` ${PUBLISHABLE_KEY} `],
    ["malformed opaque key", `sb_other_${"A".repeat(20)}`],
    ["legacy service-role JWT", LEGACY_SERVICE_ROLE_KEY],
    ["legacy JWT with a non-HS256 header", LEGACY_ANON_KEY.replace("UzI1Ni", "UzUxMi")],
    ["legacy JWT with a short signature", LEGACY_ANON_KEY.replace(/\.[^.]+$/, ".eA")],
    ["legacy token with two segments", "header.payload"],
    ["legacy token with undecodable payload", "header.A.signature"],
    ["arbitrary historical fixture", "anon-key"],
  ])("rejects a %s before direct browser SDK creation", (_label, key) => {
    const harness = loadBrowserSupabase(key);

    expect(harness.api.getSupabaseConfig()).toEqual({ url: null, anonKey: null });
    expect(harness.api.getSupabaseClient()).toBeNull();
    expect(harness.api.getSupabaseOAuthClient()).toBeNull();
    expect(harness.clientOptions).toHaveLength(0);
    expect(harness.fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    `sb_publishable_${"A".repeat(20)}`,
    `sb_publishable_${"z".repeat(220)}`,
    LEGACY_ANON_KEY,
  ])("accepts the exact supported browser-key boundary for %s", (key) => {
    const harness = loadBrowserSupabase(key);
    expect(harness.api.getSupabaseConfig()).toEqual({ url: SUPABASE_URL, anonKey: key });
  });
});
