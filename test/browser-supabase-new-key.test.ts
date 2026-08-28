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

function providerSessionJwt(input: { subject: string; sessionId: string; aal: "aal1" | "aal2" }): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({
      sub: input.subject,
      session_id: input.sessionId,
      aal: input.aal,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }), "utf8").toString("base64url"),
    Buffer.alloc(32, input.aal === "aal2" ? 4 : 3).toString("base64url"),
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

interface CapturedBroadcastMessage {
  channel: string;
  data: unknown;
}

interface CapturedBroadcastChannel {
  name: string;
  emit(data: unknown): Promise<void>;
}

interface BrowserSupabaseApi {
  getSupabaseConfig(): { url: string | null; anonKey: string | null };
  getSupabaseClient(): BrowserSupabaseClient | null;
  getSupabaseOAuthClient(): BrowserSupabaseClient | null;
  getCanonicalBaseUrl(): string;
  getAuthCallbackUrl(): string;
  signInWithOAuth(
    provider: string,
    options?: { returnTo?: string; reauthPurpose?: string },
  ): Promise<void>;
  signInWithOAuthPopup(
    provider: string,
    options?: {
      preferTopLevel?: boolean;
      purpose?: string;
      requirePopup?: boolean;
      returnTo?: string;
    },
  ): Promise<{ popup: boolean; redirected?: boolean }>;
  storeOAuthPopupLaunch(input: {
    channelId: string;
    provider: string;
    purpose: string;
    returnTo: string;
  }): Record<string, unknown> | null;
  consumeOAuthPopupLaunch(input: {
    channelId: string;
    provider: string;
    purpose: string;
    returnTo: string;
  }): Record<string, unknown> | null;
  getLiveSupabaseProviderSession(
    initialSession?: { access_token: string; refresh_token: string } | null,
    client?: BrowserSupabaseClient | null,
  ): Promise<{ access_token: string; refresh_token: string }>;
}

interface ClientOptions {
  auth?: {
    flowType?: string;
    persistSession?: boolean;
    storage?: BrowserStorageFixture;
    storageKey?: string;
  };
  global?: { fetch?: typeof globalThis.fetch };
}

interface BrowserStorageFixture {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

interface BrowserSupabaseClient {
  auth: {
    exchangeCodeForSession: (
      authCode: string,
      options?: { flowId?: string },
    ) => Promise<{
      data: { session?: { access_token?: string; refresh_token?: string } | null };
      error: { message?: string } | null;
    }>;
    getSession: () => Promise<unknown>;
    signInWithOAuth: (input: unknown) => Promise<{
      data?: { flowId?: string | null; url?: string | null };
      error?: { message?: string } | null;
    }>;
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
  enableBroadcastChannel?: boolean;
  enableDocument?: boolean;
  nowMs?: number;
  initialLocalStorage?: Record<string, string>;
  initialSessionStorage?: Record<string, string>;
  responseForRequest?: (
    request: CapturedRequest,
  ) => Response | null | Promise<Response | null>;
  supabaseUrl?: unknown;
  viewerConfig?: Record<string, unknown>;
  viewerOrigin?: string;
  locationAssign?: (url: string) => void;
  windowOpen?: (...args: string[]) => unknown;
} = {}) {
  const requests: CapturedRequest[] = [];
  const broadcastChannels: string[] = [];
  const broadcastChannelInstances: CapturedBroadcastChannel[] = [];
  const broadcastMessages: CapturedBroadcastMessage[] = [];
  const clientOptions: ClientOptions[] = [];
  const viewerOrigin = options.viewerOrigin ?? "https://pintpath.au";
  const locationAssignments: string[] = [];
  const localStorage = new BrowserStorage();
  const sessionStorage = new BrowserStorage();
  Object.entries(options.initialLocalStorage ?? {}).forEach(([storageKey, value]) => {
    localStorage.setItem(storageKey, value);
  });
  Object.entries(options.initialSessionStorage ?? {}).forEach(([storageKey, value]) => {
    sessionStorage.setItem(storageKey, value);
  });
  const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const capturedRequest = {
      body: typeof init?.body === "string" ? init.body : null,
      headers: requestHeaders(input, init),
      method: init?.method || (input instanceof Request ? input.method : "GET"),
      redirect: init?.redirect,
      url: input instanceof Request ? input.url : String(input),
    };
    requests.push(capturedRequest);
    const configuredResponse = await options.responseForRequest?.(capturedRequest);
    if (configuredResponse) return configuredResponse;
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  class CapturingBroadcastChannel {
    readonly name: string;
    onmessage: ((event: { data: unknown }) => void | Promise<void>) | null = null;

    constructor(name: string) {
      this.name = String(name);
      broadcastChannels.push(this.name);
      broadcastChannelInstances.push(this);
    }

    addEventListener(): void {}

    close(): void {}

    postMessage(data: unknown): void {
      broadcastMessages.push({ channel: this.name, data });
    }

    async emit(data: unknown): Promise<void> {
      await this.onmessage?.({ data });
    }
  }
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
      href: `${viewerOrigin}/account.html`,
      assign(url: string) {
        const normalizedUrl = String(url);
        locationAssignments.push(normalizedUrl);
        options.locationAssign?.(normalizedUrl);
      },
    },
    localStorage,
    sessionStorage,
    addEventListener: vi.fn(),
  };
  const documentObject = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
  };
  if (options.enableDocument) {
    windowObject.document = documentObject;
  }
  if (options.enableBroadcastChannel) {
    windowObject.BroadcastChannel = CapturingBroadcastChannel;
  }
  if (options.windowOpen) {
    windowObject.open = options.windowOpen;
  }
  const browserGlobals: Record<string, unknown> = {
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
  };
  if (options.enableDocument) {
    browserGlobals.document = documentObject;
  }
  if (options.enableBroadcastChannel) {
    browserGlobals.BroadcastChannel = CapturingBroadcastChannel;
  }
  const context = vm.createContext(browserGlobals);
  if (options.nowMs !== undefined) {
    const setBrowserNow = vm.runInContext(
      "(value) => { Date.now = () => value; }",
      context,
    ) as (value: number) => void;
    setBrowserNow(options.nowMs);
  }
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
    broadcastChannelInstances,
    broadcastChannels,
    broadcastMessages,
    clientOptions,
    fetchImplementation,
    locationAssignments,
    localStorage,
    requests,
    sessionStorage,
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

  it("uses the top-level PKCE path for ordinary OAuth login without opening a popup channel", async () => {
    const windowOpen = vi.fn(() => {
      throw new Error("window.open must not be called for a preferred top-level flow");
    });
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      enableBroadcastChannel: true,
      enableDocument: true,
      windowOpen,
    });

    await expect(harness.api.signInWithOAuthPopup("google", {
      preferTopLevel: true,
      purpose: "login",
      returnTo: "/account.html?from=map",
    })).resolves.toMatchObject({
      popup: false,
      redirected: true,
    });

    expect(harness.locationAssignments).toHaveLength(1);
    const authorizeUrl = new URL(harness.locationAssignments[0]!);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${SUPABASE_URL}/auth/v1/authorize`);
    expect(authorizeUrl.searchParams.get("provider")).toBe("google");
    expect(authorizeUrl.searchParams.get("scopes")).toBe("email profile");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("s256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const callbackUrl = new URL(authorizeUrl.searchParams.get("redirect_to")!);
    expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe("https://pintpath.au/auth/callback");
    expect(callbackUrl.search).toBe("");
    const pendingFlows = JSON.parse(
      harness.sessionStorage.getItem("pintPathSupabaseOAuth-flows-code-verifier") || "null",
    ) as unknown;
    expect(pendingFlows).toEqual([expect.stringMatching(/^[A-Za-z0-9_-]{8,160}$/)]);
    const [flowId] = pendingFlows as string[];
    expect(flowId).toMatch(/^[A-Za-z0-9_-]{8,160}$/);

    expect(harness.localStorage.getItem("pintPathAuthReturnTo")).toBe("/account.html?from=map");
    expect(JSON.parse(harness.localStorage.getItem("pintPathAuthFlow") || "null")).toMatchObject({
      kind: "oauth",
      reauthPurpose: null,
      returnTo: "/account.html?from=map",
    });
    const verifierKeys = Array.from(
      { length: harness.sessionStorage.length },
      (_, index) => harness.sessionStorage.key(index),
    ).filter((storageKey): storageKey is string => Boolean(storageKey));
    expect(verifierKeys).toEqual(expect.arrayContaining([
      "pintPathSupabaseOAuth-code-verifier",
      "pintPathSupabaseOAuth-flows-code-verifier",
      `pintPathSupabaseOAuth-flow-${flowId}-code-verifier`,
    ]));
    const browserStorage = [harness.localStorage, harness.sessionStorage].flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const storageKey = storage.key(index);
        return storageKey ? storage.getItem(storageKey) : null;
      }));
    expect(JSON.stringify(browserStorage)).not.toMatch(/access_token|refresh_token/i);
    expect(windowOpen).not.toHaveBeenCalled();
    expect(harness.broadcastChannels).not.toContainEqual(
      expect.stringMatching(/^pintpath:oauth:/),
    );
  });

  it("keeps top-level preference fail-closed for invalid and popup-required OAuth requests", async () => {
    const windowOpen = vi.fn();
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      enableBroadcastChannel: true,
      windowOpen,
    });

    await expect(harness.api.signInWithOAuthPopup("apple", {
      preferTopLevel: true,
      purpose: "login",
    })).rejects.toThrow("not enabled");
    await expect(harness.api.signInWithOAuthPopup("google", {
      preferTopLevel: true,
      purpose: "unsupported",
    })).rejects.toThrow("purpose is not supported");
    await expect(harness.api.signInWithOAuthPopup("google", {
      preferTopLevel: true,
      purpose: "account_export",
      requirePopup: true,
    })).rejects.toThrow("needs a secure sign-in popup");

    expect(windowOpen).not.toHaveBeenCalled();
    expect(harness.broadcastChannels).not.toContainEqual(
      expect.stringMatching(/^pintpath:oauth:/),
    );
  });

  it("requires an exact one-time tab-bound launch record before a popup callback can start OAuth", () => {
    const nowMs = Date.parse("2026-08-27T08:10:00.000Z");
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, { nowMs });
    const launch = {
      channelId: "launch_channel_1234567890",
      provider: "google",
      purpose: "account_export",
      returnTo: "/account.html?settings=privacy",
    };
    const launchKey = `pintPathSupabaseOAuthPopupLaunch:${launch.channelId}`;

    expect(harness.api.storeOAuthPopupLaunch(launch)).toMatchObject(launch);
    expect(harness.sessionStorage.getItem(launchKey)).not.toBeNull();
    expect(harness.api.consumeOAuthPopupLaunch({
      ...launch,
      channelId: "attacker_channel_1234567890",
    })).toBeNull();
    expect(harness.sessionStorage.getItem(launchKey)).not.toBeNull();
    expect(harness.api.consumeOAuthPopupLaunch({ ...launch, purpose: "logout_all" })).toBeNull();
    expect(harness.sessionStorage.getItem(launchKey)).toBeNull();

    expect(harness.api.storeOAuthPopupLaunch(launch)).toMatchObject(launch);
    expect(harness.api.consumeOAuthPopupLaunch(launch)).toMatchObject(launch);
    expect(harness.api.consumeOAuthPopupLaunch(launch)).toBeNull();

    harness.sessionStorage.setItem(
      launchKey,
      JSON.stringify({ ...launch, createdAt: nowMs - 60_001 }),
    );
    expect(harness.api.consumeOAuthPopupLaunch(launch)).toBeNull();
    harness.sessionStorage.setItem(
      launchKey,
      JSON.stringify({ ...launch, createdAt: nowMs + 5_001 }),
    );
    expect(harness.api.consumeOAuthPopupLaunch(launch)).toBeNull();
    harness.sessionStorage.setItem(
      launchKey,
      JSON.stringify({ ...launch, createdAt: nowMs, bearer: "not-allowed" }),
    );
    expect(harness.api.consumeOAuthPopupLaunch(launch)).toBeNull();
    harness.sessionStorage.setItem(launchKey, "{malformed");
    expect(harness.api.consumeOAuthPopupLaunch(launch)).toBeNull();
    expect(harness.sessionStorage.getItem(launchKey)).toBeNull();

    expect(harness.api.storeOAuthPopupLaunch(launch)).toMatchObject(launch);
    const removeItem = harness.sessionStorage.removeItem.bind(harness.sessionStorage);
    harness.sessionStorage.removeItem = () => { throw new Error("storage locked"); };
    expect(harness.api.consumeOAuthPopupLaunch(launch)).toBeNull();
    harness.sessionStorage.removeItem = removeItem;
    harness.sessionStorage.removeItem(launchKey);
  });

  it("leaves the popup clone as the only launch capability after window.open returns", async () => {
    let clonedLaunch: { key: string; value: string } | null = null;
    let popupUrl = "";
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      enableBroadcastChannel: true,
      windowOpen(url) {
        popupUrl = url;
        const key = Array.from(
          { length: harness.sessionStorage.length },
          (_, index) => harness.sessionStorage.key(index),
        ).find((candidate) => candidate?.startsWith("pintPathSupabaseOAuthPopupLaunch:"));
        if (key) clonedLaunch = { key, value: harness.sessionStorage.getItem(key)! };
        return { close: vi.fn() };
      },
    });

    const pending = harness.api.signInWithOAuthPopup("google", {
      purpose: "login",
      returnTo: "/account.html?from=map",
    });
    expect(clonedLaunch).not.toBeNull();
    expect(JSON.parse(clonedLaunch!.value)).toMatchObject({
      provider: "google",
      purpose: "login",
      returnTo: "/account.html?from=map",
    });
    expect(harness.sessionStorage.getItem(clonedLaunch!.key)).toBeNull();

    const channelId = new URL(popupUrl).searchParams.get("popupChannel");
    const channel = harness.broadcastChannelInstances.find(
      (candidate) => candidate.name === `pintpath:oauth:${channelId}`,
    );
    expect(channel).toBeDefined();
    await channel!.emit({
      type: "pintpath:oauth-error",
      channelId,
      message: "Provider cancelled",
    });
    await expect(pending).rejects.toThrow("Provider cancelled");
  });

  it.each([
    ["blocked", () => null],
    ["throws", () => { throw new Error("blocked"); }],
  ])("removes the one-time popup launch when window.open %s", async (_case, windowOpen) => {
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      enableBroadcastChannel: true,
      enableDocument: true,
      windowOpen,
    });

    await expect(harness.api.signInWithOAuthPopup("google", {
      purpose: "login",
      returnTo: "/account.html",
    })).resolves.toMatchObject({ popup: false, redirected: true });
    const keys = Array.from(
      { length: harness.sessionStorage.length },
      (_, index) => harness.sessionStorage.key(index),
    ).filter(Boolean);
    expect(keys).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^pintPathSupabaseOAuthPopupLaunch:/),
    ]));
    expect(harness.locationAssignments).toHaveLength(1);
  });

  it("fails closed before window.open when the launch capability cannot be stored", async () => {
    const windowOpen = vi.fn();
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      enableBroadcastChannel: true,
      windowOpen,
    });
    harness.sessionStorage.setItem = () => { throw new Error("storage disabled"); };

    await expect(harness.api.signInWithOAuthPopup("google", {
      purpose: "login",
      returnTo: "/account.html",
    })).rejects.toThrow("launch could not be bound");
    expect(windowOpen).not.toHaveBeenCalled();
    expect(harness.locationAssignments).toHaveLength(0);
  });

  it("closes the popup and fails closed when the parent launch capability cannot be removed", async () => {
    const popupClose = vi.fn();
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      enableBroadcastChannel: true,
      windowOpen() {
        harness.sessionStorage.removeItem = () => { throw new Error("storage locked"); };
        return { close: popupClose };
      },
    });

    await expect(harness.api.signInWithOAuthPopup("google", {
      purpose: "login",
      returnTo: "/account.html",
    })).rejects.toThrow("launch could not be cleared safely");
    expect(popupClose).toHaveBeenCalledTimes(1);
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
    expect(harness.clientOptions[0]?.auth?.persistSession).toBe(false);
    expect(harness.clientOptions[1]?.auth?.persistSession).toBe(true);
    expect(harness.clientOptions[1]?.auth?.storageKey).toBe("");
    expect(harness.clientOptions[1]?.auth?.storage).toBeDefined();
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

  it("keeps provider sessions in memory, migrates only PKCE verifiers, and purges legacy browser bearers", async () => {
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY);
    const verifierKey = "pintPathSupabaseOAuth-code-verifier";
    harness.localStorage.setItem("sb-auth-auth-token", JSON.stringify({ access_token: "legacy-main" }));
    harness.localStorage.setItem("pintPathSupabaseOAuth", JSON.stringify({ refresh_token: "legacy-oauth" }));
    harness.localStorage.setItem(verifierKey, "legacy-verifier/recovery");

    harness.api.getSupabaseClient();
    harness.api.getSupabaseOAuthClient();

    expect(harness.localStorage.getItem("sb-auth-auth-token")).toBeNull();
    expect(harness.localStorage.getItem("pintPathSupabaseOAuth")).toBeNull();
    const splitStorage = harness.clientOptions[1]?.auth?.storage;
    expect(splitStorage).toBeDefined();
    expect(await splitStorage!.getItem(verifierKey)).toBe("legacy-verifier/recovery");
    expect(harness.localStorage.getItem(verifierKey)).toBeNull();
    expect(harness.sessionStorage.getItem(verifierKey)).toBe("legacy-verifier/recovery");

    await splitStorage!.setItem("pintPathSupabaseOAuth", JSON.stringify({ access_token: "memory-only" }));
    expect(harness.localStorage.getItem("pintPathSupabaseOAuth")).toBeNull();
    expect(harness.sessionStorage.getItem("pintPathSupabaseOAuth")).toBeNull();
    expect(await splitStorage!.getItem("pintPathSupabaseOAuth")).toContain("memory-only");
  });

  it("preserves PKCE across a callback without auth-js broadcasting the provider session", async () => {
    const initialHarness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      enableBroadcastChannel: true,
    });
    const initialClient = initialHarness.api.getSupabaseOAuthClient();
    expect(initialClient).not.toBeNull();

    const started = await initialClient!.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: "https://pintpath.au/auth/callback",
        skipBrowserRedirect: true,
      },
    });
    expect(started.error).toBeNull();
    expect(started.data?.flowId).toMatch(/^[A-Za-z0-9_-]{8,160}$/);
    expect(initialHarness.broadcastChannels).not.toContain("pintPathSupabaseOAuth");
    expect(initialHarness.broadcastMessages).toEqual([]);

    const verifierStorage: Record<string, string> = {};
    for (let index = 0; index < initialHarness.sessionStorage.length; index += 1) {
      const storageKey = initialHarness.sessionStorage.key(index);
      if (!storageKey) continue;
      const value = initialHarness.sessionStorage.getItem(storageKey);
      if (value !== null) verifierStorage[storageKey] = value;
    }
    expect(Object.keys(verifierStorage)).toEqual(expect.arrayContaining([
      "pintPathSupabaseOAuth-code-verifier",
      "pintPathSupabaseOAuth-flows-code-verifier",
      `pintPathSupabaseOAuth-flow-${started.data?.flowId}-code-verifier`,
    ]));
    expect(JSON.stringify(verifierStorage)).not.toMatch(/access_token|refresh_token/i);
    expect(initialHarness.localStorage.getItem("pintPathSupabaseOAuth-code-verifier")).toBeNull();

    const providerAccessToken = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: "browser-user-id",
      }), "utf8").toString("base64url"),
      Buffer.alloc(32, 3).toString("base64url"),
    ].join(".");
    const providerRefreshToken = "fixture-provider-refresh-token";
    const callbackHarness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      enableBroadcastChannel: true,
      initialSessionStorage: verifierStorage,
      responseForRequest(request) {
        if (request.url !== `${SUPABASE_URL}/auth/v1/token?grant_type=pkce`) return null;
        return new Response(JSON.stringify({
          access_token: providerAccessToken,
          expires_in: 3600,
          refresh_token: providerRefreshToken,
          token_type: "bearer",
          user: {
            id: "browser-user-id",
            email: "browser-user@example.test",
            app_metadata: { provider: "google" },
            user_metadata: {},
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const callbackClient = callbackHarness.api.getSupabaseOAuthClient();
    expect(callbackClient).not.toBeNull();

    // Production callbacks omit sb_flow_id unless that SDK option is enabled,
    // so exercise the fixed verifier fallback used by callback.html.
    const exchanged = await callbackClient!.auth.exchangeCodeForSession("fixture-auth-code");
    expect(exchanged.error).toBeNull();
    expect(exchanged.data.session).toMatchObject({
      access_token: providerAccessToken,
      refresh_token: providerRefreshToken,
    });
    expect(callbackHarness.broadcastChannels).not.toContain("pintPathSupabaseOAuth");
    expect(callbackHarness.broadcastMessages).toEqual([]);
    expect(callbackHarness.sessionStorage.getItem("pintPathSupabaseOAuth-code-verifier")).toBeNull();
    const remainingBrowserStorage = [
      callbackHarness.localStorage,
      callbackHarness.sessionStorage,
    ].flatMap((storage) => Array.from({ length: storage.length }, (_, index) => {
      const storageKey = storage.key(index);
      return storageKey ? storage.getItem(storageKey) : null;
    }));
    expect(JSON.stringify(remainingBrowserStorage)).not.toContain(providerAccessToken);
    expect(JSON.stringify(remainingBrowserStorage)).not.toContain(providerRefreshToken);

    const splitStorage = callbackHarness.clientOptions[0]?.auth?.storage;
    expect(await splitStorage?.getItem("")).toContain(providerAccessToken);
    expect(await splitStorage?.getItem("")).toContain(providerRefreshToken);
  });

  it("bridges only the live post-MFA token pair from the same provider session", async () => {
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY);
    const client = harness.api.getSupabaseClient();
    expect(client).not.toBeNull();
    const initialAccessToken = providerSessionJwt({
      subject: "browser-user-id",
      sessionId: "browser-provider-session",
      aal: "aal1",
    });
    const liveAccessToken = providerSessionJwt({
      subject: "browser-user-id",
      sessionId: "browser-provider-session",
      aal: "aal2",
    });
    client!.auth.getSession = vi.fn(async () => ({
      data: {
        session: {
          access_token: liveAccessToken,
          refresh_token: "rotated-post-mfa-refresh-token",
        },
      },
      error: null,
    })) as BrowserSupabaseClient["auth"]["getSession"];

    await expect(harness.api.getLiveSupabaseProviderSession({
      access_token: initialAccessToken,
      refresh_token: "pre-mfa-refresh-token",
    }, client)).resolves.toEqual({
      access_token: liveAccessToken,
      refresh_token: "rotated-post-mfa-refresh-token",
    });

    await expect(harness.api.getLiveSupabaseProviderSession({
      access_token: providerSessionJwt({
        subject: "browser-user-id",
        sessionId: "different-provider-session",
        aal: "aal1",
      }),
      refresh_token: "pre-mfa-refresh-token",
    }, client)).rejects.toThrow("provider session changed");
    expect(JSON.stringify(await harness.api.getLiveSupabaseProviderSession({
      access_token: initialAccessToken,
      refresh_token: "pre-mfa-refresh-token",
    }, client))).not.toContain("pre-mfa-refresh-token");
  });

  it("purges former persistent provider bearers before a public page initializes any Supabase client", () => {
    const verifierKey = "pintPathSupabaseOAuth-code-verifier";
    const harness = loadBrowserSupabase(PUBLISHABLE_KEY, {
      initialLocalStorage: {
        "sb-auth-auth-token": JSON.stringify({ access_token: "legacy-main" }),
        pintPathSupabaseOAuth: JSON.stringify({ refresh_token: "legacy-oauth" }),
        [verifierKey]: "legacy-verifier/recovery",
      },
      initialSessionStorage: {
        "sb-secondary-auth-token": JSON.stringify({ access_token: "legacy-session" }),
      },
    });

    expect(harness.clientOptions).toHaveLength(0);
    expect(harness.localStorage.getItem("sb-auth-auth-token")).toBeNull();
    expect(harness.localStorage.getItem("pintPathSupabaseOAuth")).toBeNull();
    expect(harness.sessionStorage.getItem("sb-secondary-auth-token")).toBeNull();
    expect(harness.localStorage.getItem(verifierKey)).toBe("legacy-verifier/recovery");
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
