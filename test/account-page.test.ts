import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

const LEGACY_SUPABASE_ANON_KEY_FIXTURE = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url"),
  Buffer.from(JSON.stringify({ role: "anon" }), "utf8").toString("base64url"),
  Buffer.alloc(32, 1).toString("base64url"),
].join(".");

function unsignedAccessToken(payload: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
    "test-signature",
  ].join(".");
}

function accountHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/account.html"), "utf8");
}

function mapHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");
}

function adminHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/admin.html"), "utf8");
}

function venuePortalHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/venue-portal.html"), "utf8");
}

function businessJs() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.js"), "utf8");
}

function appSource() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/app.ts"), "utf8");
}

interface BrowserStorageFixture {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
  key(index: number): string | null;
  readonly length: number;
}

interface BusinessHelperOptions {
  localStorage?: BrowserStorageFixture;
  cookieJar?: Map<string, string>;
  readCookies?: (cookieJar: Map<string, string>) => string;
  writeCookie?: (serialized: string, cookieJar: Map<string, string>) => unknown;
  fetchImpl?: typeof fetch;
}

function loadBusinessHelpers(options: BusinessHelperOptions = {}) {
  const localStorage = new Map<string, string>();
  const sessionStorage = new Map<string, string>();
  const cookieJar = options.cookieJar || new Map<string, string>();
  const localStorageFixture = options.localStorage || {
    getItem: (key: string) => localStorage.get(key) || null,
    setItem: (key: string, value: string) => localStorage.set(key, String(value)),
    removeItem: (key: string) => localStorage.delete(key),
    key: (index: number) => Array.from(localStorage.keys())[index] || null,
    get length() {
      return localStorage.size;
    },
  };
  const documentFixture = {
    get cookie() {
      if (options.readCookies) return options.readCookies(cookieJar);
      return Array.from(cookieJar, ([name, value]) => `${name}=${value}`).join("; ");
    },
    set cookie(serialized: string) {
      if (options.writeCookie) {
        options.writeCookie(serialized, cookieJar);
        return;
      }
      const pair = serialized.split(";", 1)[0] || "";
      const separator = pair.indexOf("=");
      if (separator < 1) return;
      cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
    },
  };
  const context = {
    AbortController,
    DOMException,
    atob,
    btoa,
    clearTimeout,
    setTimeout,
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => "test-uuid" },
    fetch: options.fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    window: {
      MELB_BEER_BOT_VIEWER_CONFIG: { business: { fieldTestMode: true } },
      location: { origin: "https://pintpath.au", protocol: "https:", search: "" },
      localStorage: localStorageFixture,
      sessionStorage: {
        getItem: (key: string) => sessionStorage.get(key) || null,
        setItem: (key: string, value: string) => sessionStorage.set(key, String(value)),
        removeItem: (key: string) => sessionStorage.delete(key),
      },
      addEventListener: () => undefined,
    },
    document: documentFixture,
  };
  vm.createContext(context);
  vm.runInContext(businessJs(), context);
  return (context.window as {
    MelbBeerBusiness: {
      renderNav: (active?: string) => string;
      setAccountContext: (account: Record<string, unknown> | null, access?: Record<string, unknown> | null) => void;
      getAccountScopedStorage: (key: string) => string | null;
      setAccountScopedStorage: (key: string, value: string) => string;
      getAccountScopedStorageKey: (key: string, accountId?: string) => string | null;
      clearLocalSubmissionDeviceData: (accountId?: string) => Promise<void>;
      isVenuePortalReturnPath: (value?: string | null) => boolean;
      storeSensitiveAuthReturnPath: (value?: string | null) => string | null;
      consumeSensitiveAuthReturnPath: () => string | null;
      getCookieConsentDecision: () => string | null;
      setCookieConsentDecision: (decision: string) => void;
      hasAnalyticsConsent: () => boolean;
      setPrivacyPreferenceCache: (
        settings: Record<string, unknown>,
        options?: { allowOptionalPromotion?: boolean },
      ) => void;
      trackEvent: (eventType: string, metadata?: Record<string, unknown>) => Promise<void>;
      reauthenticationPurposeForPath: (path: string) => string;
      browserReauthenticationExpiryForAccessToken: (token: string, now?: number) => number | null;
      getSupabaseReauthenticationProvider: () => string | null;
    };
  }).MelbBeerBusiness;
}

function loadApiFetchRedirectHarness(harnessOptions: {
  fetchImpl?: (input: string, options: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const localStorage = new Map<string, string>();
  const requests: Array<{
    path: string;
    options: Record<string, unknown>;
  }> = [];
  const context = {
    AbortController,
    DOMException,
    clearTimeout,
    setTimeout,
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => "test-uuid" },
    fetch: async (input: string, requestOptions: Record<string, unknown> = {}) => {
      requests.push({ path: String(input), options: requestOptions });
      if (harnessOptions.fetchImpl) {
        return harnessOptions.fetchImpl(String(input), requestOptions);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: {} }),
      };
    },
    window: {
      MELB_BEER_BOT_VIEWER_CONFIG: { business: { fieldTestMode: true } },
      location: {
        origin: "https://pintpath.au",
        hostname: "pintpath.au",
        pathname: "/account.html",
        search: "",
      },
      localStorage: {
        getItem: (key: string) => localStorage.get(key) || null,
        setItem: (key: string, value: string) => localStorage.set(key, String(value)),
        removeItem: (key: string) => localStorage.delete(key),
        key: (index: number) => Array.from(localStorage.keys())[index] || null,
        get length() {
          return localStorage.size;
        },
      },
      sessionStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
      addEventListener: () => undefined,
    },
  };
  vm.createContext(context);
  vm.runInContext(businessJs(), context);
  return {
    helpers: (context.window as unknown as {
      MelbBeerBusiness: {
        AUTH_TOKEN_KEY: string;
        apiFetch: (
          path: string,
          options?: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
    }).MelbBeerBusiness,
    requests,
    localStorage,
  };
}

function loadBusinessAuthHarness(options: {
  signupHasSession?: boolean;
  sessionEmail?: string;
  sessionProvider?: string;
  verifiedEmail?: string;
  verifiedProvider?: string;
  signupError?: string;
  oauthError?: string;
  otpError?: string;
  accessToken?: string;
  existingAppSession?: boolean;
} = {}) {
  const localStorage = new Map<string, string>();
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const signups: Array<Record<string, unknown>> = [];
  const oauthSignIns: Array<Record<string, unknown>> = [];
  const otpSignIns: Array<Record<string, unknown>> = [];
  const passwordSignIns: Array<Record<string, unknown>> = [];
  const createdClientOptions: Array<Record<string, unknown>> = [];
  const sessionProvider = options.sessionProvider || "email";
  const authSession = {
    access_token: options.accessToken || "provider-access-token",
    user: {
      email: options.sessionEmail || "new@example.com",
      app_metadata: { provider: sessionProvider },
      identities: [{ provider: sessionProvider }],
    },
  };
  const auth = {
    signUp: async (input: Record<string, unknown>) => {
      signups.push(input);
      if (options.signupError) {
        return { data: { session: null }, error: { message: options.signupError } };
      }
      return { data: { session: options.signupHasSession === false ? null : authSession }, error: null };
    },
    signInWithOAuth: async (input: Record<string, unknown>) => {
      oauthSignIns.push(input);
      return { data: null, error: options.oauthError ? { message: options.oauthError } : null };
    },
    signInWithOtp: async (input: Record<string, unknown>) => {
      otpSignIns.push(input);
      return { data: { user: null, session: null }, error: options.otpError ? { message: options.otpError } : null };
    },
    signInWithPassword: async (input: Record<string, unknown>) => {
      passwordSignIns.push(input);
      return { data: { session: authSession }, error: null };
    },
    getSession: async () => ({ data: { session: authSession }, error: null }),
    getUser: async () => ({
      data: {
        user: {
          email: options.verifiedEmail || options.sessionEmail || "new@example.com",
          app_metadata: { provider: options.verifiedProvider || sessionProvider },
          identities: [{ provider: options.verifiedProvider || sessionProvider }],
        },
      },
      error: null,
    }),
    signOut: async () => ({ error: null }),
  };
  const fetch = async (path: string, request: { body?: string } = {}) => {
    const body = request.body ? JSON.parse(request.body) as Record<string, unknown> : {};
    requests.push({ path, body });
    if (path === "/api/business/auth/session") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: { authenticated: options.existingAppSession !== false },
        }),
      };
    }
    if (path === "/api/business/auth/logout") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { revoked: false } }),
      };
    }
    if (path === "/api/business/auth/browser-email-reauthentication") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            email: options.verifiedEmail || options.sessionEmail || "new@example.com",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          token: "cookie-backed",
          account: {
            id: "account-1",
            authProvider: "supabase",
            role: "user",
            status: "active",
            termsAcceptedAt: "2026-07-14T00:00:00.000Z",
            privacyAcceptedAt: "2026-07-14T00:00:00.000Z",
            termsVersion: "2026-07-20",
            privacyVersion: "2026-07-20",
          },
        },
      }),
    };
  };
  const context = {
    AbortController,
    DOMException,
    clearTimeout,
    setTimeout,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    crypto: { randomUUID: () => "test-uuid" },
    fetch,
    window: {
      MELB_BEER_BOT_VIEWER_CONFIG: {
        supabaseUrl: "https://auth.pintpath.au",
        supabaseAnonKey: LEGACY_SUPABASE_ANON_KEY_FIXTURE,
        business: { legalPolicyVersion: "2026-07-20" },
      },
      location: {
        origin: "https://pintpath.au",
        hostname: "pintpath.au",
        pathname: "/account.html",
        search: "",
      },
      localStorage: {
        getItem: (key: string) => localStorage.get(key) || null,
        setItem: (key: string, value: string) => localStorage.set(key, String(value)),
        removeItem: (key: string) => localStorage.delete(key),
        key: (index: number) => Array.from(localStorage.keys())[index] || null,
        get length() {
          return localStorage.size;
        },
      },
      supabase: {
        createClient: (
          _url: string,
          _anonKey: string,
          clientOptions: Record<string, unknown>,
        ) => {
          createdClientOptions.push(clientOptions);
          return { auth };
        },
      },
      addEventListener: () => undefined,
    },
  };
  vm.createContext(context);
  vm.runInContext(businessJs(), context);
  return {
    helpers: (context.window as unknown as {
      MelbBeerBusiness: {
        signUpWithEmail: (...args: unknown[]) => Promise<Record<string, unknown>>;
        signInWithOAuth: (...args: unknown[]) => Promise<Record<string, unknown>>;
        signInWithEmail: (...args: unknown[]) => Promise<Record<string, unknown>>;
        syncSupabaseSession: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
        beginBrowserEmailReauthentication: (
          purpose: string,
          options?: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
        ensureSupabaseSessionForPurpose: (
          purpose: string,
          options?: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
        setAccountContext: (
          account: Record<string, unknown> | null,
          access?: Record<string, unknown> | null,
        ) => void;
        getAccountContext: () => Record<string, unknown> | null;
        setPendingLegalAcceptance: (input: Record<string, unknown>) => void;
        setPendingLegalAcceptanceForCurrentSession: (
          input: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => Promise<{ authFlowNonce: string }>;
      };
    }).MelbBeerBusiness,
    localStorage,
    requests,
    signups,
    oauthSignIns,
    otpSignIns,
    passwordSignIns,
    createdClientOptions,
  };
}

class TestBroadcastChannel {
  static readonly channels = new Map<string, Set<TestBroadcastChannel>>();
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(private readonly name: string) {
    const subscribers = TestBroadcastChannel.channels.get(name) || new Set<TestBroadcastChannel>();
    subscribers.add(this);
    TestBroadcastChannel.channels.set(name, subscribers);
  }

  postMessage(data: unknown) {
    TestBroadcastChannel.channels.get(this.name)?.forEach((subscriber) => {
      if (subscriber !== this) subscriber.onmessage?.({ data });
    });
  }

  close() {
    TestBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

function loadCrossTabAuthHarness(sharedLocalStorage: BrowserStorageFixture) {
  const sessionValues = new Map<string, string>();
  let authSession: Record<string, unknown> | null = null;
  let authListener: ((event: string, session: Record<string, unknown> | null) => void) | null = null;
  const signOutCalls: Array<Record<string, unknown>> = [];
  const auth = {
    onAuthStateChange: (listener: typeof authListener) => {
      authListener = listener;
      return { data: { subscription: { unsubscribe: () => undefined } } };
    },
    setSession: async (session: Record<string, unknown>) => {
      authSession = { ...session, user: { id: "account-1" } };
      authListener?.("SIGNED_IN", authSession);
      return { data: { session: authSession }, error: null };
    },
    getSession: async () => ({ data: { session: authSession }, error: null }),
    signOut: async (options: Record<string, unknown>) => {
      signOutCalls.push(options);
      authSession = null;
      authListener?.("SIGNED_OUT", null);
      return { error: null };
    },
  };
  const context = {
    AbortController,
    DOMException,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    clearTimeout,
    setTimeout,
    crypto: { randomUUID: () => "cross-tab-id" },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: {} }) }),
    window: {
      BroadcastChannel: TestBroadcastChannel,
      CustomEvent: class {
        constructor(public readonly type: string) {}
      },
      MELB_BEER_BOT_VIEWER_CONFIG: {
        supabaseUrl: "https://auth.pintpath.au",
        supabaseAnonKey: LEGACY_SUPABASE_ANON_KEY_FIXTURE,
        business: {},
      },
      location: {
        origin: "https://pintpath.au",
        hostname: "pintpath.au",
        pathname: "/account.html",
        search: "",
        hash: "",
      },
      localStorage: sharedLocalStorage,
      sessionStorage: {
        getItem: (key: string) => sessionValues.get(key) || null,
        setItem: (key: string, value: string) => sessionValues.set(key, String(value)),
        removeItem: (key: string) => sessionValues.delete(key),
        key: (index: number) => Array.from(sessionValues.keys())[index] || null,
        get length() {
          return sessionValues.size;
        },
      },
      supabase: { createClient: () => ({ auth }) },
      addEventListener: () => undefined,
      dispatchEvent: () => true,
    },
  };
  vm.createContext(context);
  vm.runInContext(businessJs(), context);
  return {
    auth,
    helpers: (context.window as unknown as {
      MelbBeerBusiness: {
        broadcastAuthInvalidation: (reason: string) => unknown;
        getAccountContext: () => Record<string, unknown> | null;
        setAccountContext: (account: Record<string, unknown>, access?: Record<string, unknown>) => void;
        setSupabaseMemorySession: (session: Record<string, unknown>) => Promise<unknown>;
      };
    }).MelbBeerBusiness,
    signOutCalls,
  };
}

function navLinkLabels(markup: string) {
  return Array.from(markup.matchAll(/href="[^"]+">([^<]+)<\/a>/g), (match) => match[1]);
}

function htmlBetween(html: string, start: string, end: string) {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex + start.length);
  expect(startIndex, start).toBeGreaterThanOrEqual(0);
  expect(endIndex, end).toBeGreaterThan(startIndex);
  return html.slice(startIndex, endIndex);
}

function businessCss() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.css"), "utf8");
}

function businessServiceTs() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/modules/business/business.service.ts"), "utf8");
}

function callbackHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/auth/callback.html"), "utf8");
}

function resetPasswordHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/reset-password.html"), "utf8");
}

function resendConfirmationHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/resend-confirmation.html"), "utf8");
}

function feedbackHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/feedback.html"), "utf8");
}

function termsHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/terms.html"), "utf8");
}

function privacyHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/privacy.html"), "utf8");
}

function trustHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/trust.html"), "utf8");
}

function communityHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/community.html"), "utf8");
}

function securityHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/security.html"), "utf8");
}

function statusHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/status.html"), "utf8");
}

function viewerHtmlFiles(directory = path.resolve(process.cwd(), "viewer")): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return viewerHtmlFiles(filePath);
    }
    return entry.isFile() && entry.name.endsWith(".html") ? [filePath] : [];
  });
}

describe("account page shell", () => {
  it("rejects redirects for legacy-session migration and password-bearing API requests", async () => {
    const harness = loadApiFetchRedirectHarness();
    harness.localStorage.set(harness.helpers.AUTH_TOKEN_KEY, "legacy-session-token");

    await expect(harness.helpers.apiFetch("/api/business/account/password", {
      method: "POST",
      headers: { "X-Pint-Path-Current-Password": "current-password-secret" },
      body: JSON.stringify({ password: "new-password-secret" }),
      redirect: "follow",
    })).resolves.toEqual({});

    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]).toMatchObject({
      path: "/api/business/auth/session-cookie",
      options: { redirect: "error" },
    });
    expect(harness.requests[1]).toMatchObject({
      path: "/api/business/account/password",
      options: {
        redirect: "error",
        headers: expect.objectContaining({
          "X-Pint-Path-Current-Password": "current-password-secret",
        }),
      },
    });
  });

  it("drops a rejected legacy bearer and retries the requested API through the valid HttpOnly cookie", async () => {
    const harness = loadApiFetchRedirectHarness({
      fetchImpl: async (input) => input === "/api/business/auth/session-cookie"
        ? {
            ok: false,
            status: 401,
            json: async () => ({ ok: false, error: { message: "Legacy session expired." } }),
          }
        : {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, data: { authenticated: true } }),
          },
    });
    harness.localStorage.set(harness.helpers.AUTH_TOKEN_KEY, "stale-legacy-session-token");

    await expect(harness.helpers.apiFetch("/api/business/auth/session"))
      .resolves.toEqual({ authenticated: true });

    expect(harness.localStorage.has(harness.helpers.AUTH_TOKEN_KEY)).toBe(false);
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[0]?.path).toBe("/api/business/auth/session-cookie");
    expect(harness.requests[1]?.path).toBe("/api/business/auth/session");
    expect((harness.requests[1]?.options.headers as Record<string, string>).Authorization)
      .toBeUndefined();
  });

  it("installs Pint Path logo assets and favicon metadata across every viewer page", () => {
    const script = businessJs();
    const css = businessCss();
    const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "viewer/site.webmanifest"), "utf8")) as {
      icons: Array<{ src: string; sizes: string; type: string }>;
    };
    const requiredAssets = [
      "viewer/favicon.ico",
      "viewer/favicon.png",
      "viewer/assets/pint-path-logo.png",
      "viewer/assets/pint-path-icon-192.png",
      "viewer/assets/pint-path-icon-512.png",
      "viewer/assets/pint-path-apple-touch-icon.png",
    ];

    requiredAssets.forEach((assetPath) => {
      expect(fs.existsSync(path.resolve(process.cwd(), assetPath))).toBe(true);
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/assets/pint-path-icon-192.png", sizes: "192x192", type: "image/png" }),
        expect.objectContaining({ src: "/assets/pint-path-icon-512.png", sizes: "512x512", type: "image/png" }),
      ]),
    );
    expect(script).toContain('class="brandLogo" src="/assets/pint-path-icon-192.png"');
    expect(mapHtml()).toContain('class="mapBrandLogo" src="/assets/pint-path-icon-192.png"');
    expect(css).toContain(".brandLogo");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.brandText\s*\{[\s\S]*display:\s*none;/);

    viewerHtmlFiles().forEach((filePath) => {
      const html = fs.readFileSync(filePath, "utf8");
      expect(html, filePath).toContain('href="/favicon.ico"');
      expect(html, filePath).toContain('href="/favicon.png"');
      expect(html, filePath).toContain('href="/assets/pint-path-icon-192.png"');
      expect(html, filePath).toContain('rel="apple-touch-icon"');
      expect(html, filePath).toContain('href="/site.webmanifest"');
      expect(html, filePath).toContain('property="og:image" content="https://pintpath.au/assets/pint-path-logo.png"');
    });
  });

  it("renders separate logged-out auth and logged-in dashboard states", () => {
    const html = accountHtml();
    const css = businessCss();
    const callback = callbackHtml();
    const business = businessJs();

    expect(html).toContain('id="loggedOutView"');
    expect(html).toContain('id="accountDashboard"');
    expect(html).toContain("Sign in to Pint Path");
    expect(html).not.toContain("Pint Path Contributor Account");
    expect(html).not.toContain("Contributor dashboard");
    expect(html).not.toContain("Quick beer price upload");
    expect(html).toContain("Manage your Pint Path account");
    expect(html).toContain('id="accountSettingsHub"');
    expect(html).not.toContain("Account active. Uploads and verification actions are tracked against your signed-in user.");
    expect(html).not.toContain('id="premiumMemberHub"');
    expect(html).not.toContain("renderPremiumMemberHub");
    expect(html).toContain("Submission history");
    expect(html).toContain('id="displayNameForm"');
    expect(html).toContain('id="settingsBetaTestingPanel"');
    expect(html).toContain('id="betaTestingNavButton"');
    expect(html).toContain("Choose another beta tool.");
    expect(html).toContain(">Beta tools</button>");
    expect(html).toContain("Choose one beta tool at a time");
    expect(html).toContain('aria-label="Beta tools menu"');
    expect(html).toContain('id="leaderboardPodium"');
    expect(html.indexOf('id="settingsStatsPanel"')).toBeLessThan(html.indexOf('id="betaFeatureLeaderboard"'));
    expect(html.indexOf('id="displayNameForm"')).toBeGreaterThan(html.indexOf('id="betaFeatureLeaderboard"'));
    expect(html.indexOf('id="displayNameForm"')).toBeLessThan(html.indexOf('id="leaderboardPodium"'));
    expect(html).toContain('id="rewardVoucherList"');
    expect(html).toContain('id="billingRecoveryPanel"');
    expect(html).toContain('id="openBillingRecoveryButton"');
    expect(html).toContain('id="billingRecoveryTargetSelect"');
    expect(html).toContain("/api/business/billing/recovery-portal");
    expect(html).toContain("billingRecoveryEligible");
    expect(html).toContain('error?.code === "ACCOUNT_SUSPENDED_BILLING_RECOVERY"');
    expect(html).toContain("Manage billing only");
    expect(html).toContain("body = { accessToken: data.session.access_token }");
    expect(html).toContain("body = { email: requestedEmail, password: requestedPassword }");
    expect(html).toContain('error?.code === "BILLING_RECOVERY_VENUE_SELECTION_REQUIRED"');
    expect(html).toContain("if (requestedVenueId) body.venueId = requestedVenueId");
    expect(html).toContain('new Option(`Venue: ${venue.venueName}`, venue.venueId)');
    expect(css).toContain(".billingRecoveryPanel");
    expect(business).toContain("function requestCurrentPassword()");
    expect(business).toContain('className = "reauthPasswordDialog panel"');
    expect(business).toContain('autocomplete="current-password"');
    expect(business).not.toContain("window.prompt(");
    expect(css).toContain(".reauthPasswordDialog");
    expect(callback).toContain("function needsBillingRecovery");
    expect(callback).toContain('error?.code === "ACCOUNT_SUSPENDED_BILLING_RECOVERY"');
    expect(callback).toContain('id="callbackBillingRecoveryPanel"');
    expect(callback).toContain("function handleCallbackBillingRecovery");
    expect(callback).toContain('type: "pintpath:oauth-billing-recovery"');
    expect(callback).toContain('MelbBeerBusiness.apiFetch("/api/business/billing/recovery-portal"');
    expect(callback).not.toContain('accountUrl.searchParams.set("billingRecovery", "1")');
    expect(callback).not.toContain('window.sessionStorage.setItem("pintPathBillingRecoveryOptions"');
    expect(html).toContain('id="pubGolfForm"');
    expect(html).toContain("This is a route planner, not a drinking challenge.");
    expect(html).toContain("You never need to buy or finish alcohol.");
    expect(html).toContain("follow every venue's RSA decisions, and never drive after drinking.");
    expect(html).toContain('data-beta-feature-target="can-i-drive"');
    expect(html).toContain('id="canIDriveForm"');
    expect(html).toContain("Ranks 4-50");
    expect(html).toContain("betaLeaderboardRow--me");
    expect(html).toContain("betaLeaderboardRow--outside");
    expect(html).toContain("Venue added to the public map");
    expect(html).toContain("submissionPendingNotice");
    expect(html).toContain('id="authStatus" class="notice" role="status" aria-live="polite" aria-atomic="true" hidden></div>');
    expect(html).toContain('id="dashboardStatus" class="notice" role="status" aria-live="polite" aria-atomic="true" hidden></div>');
    expect(html).toContain("function hideAccountStatus");
    expect(html).toContain("quietAuthMessages");
    expect(html).toContain('hideAccountStatus($("dashboardStatus"))');
    expect(html).not.toContain("How verification works");
    expect(html).toContain("Pint Path special");
    expect(html).not.toContain("Pint Path discount pass");
    expect(html).not.toContain('href="/stats.html"');
    expect(html).toContain('data-settings-target="stats"');
    expect(html).not.toContain("Current status");
  });

  it("hides the auth shell after a successful account fetch", () => {
    const html = accountHtml();

    expect(html).toContain('$("loggedOutView").hidden = true');
    expect(html).toContain('$("accountDashboard").hidden = false');
    expect(html).toContain('$("accountDashboard").classList.remove("is-hidden")');
    expect(html).toContain('$("loggedOutView").hidden = false');
    expect(html).toContain('$("accountDashboard").hidden = true');
    expect(html).toContain('$("accountDashboard").classList.add("is-hidden")');
  });

  it("keeps hidden account states visually hidden even when display utility classes are present", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain('id="accountDashboard" class="dashboardMain accountDashboard is-hidden" hidden');
    expect(html).toContain('id="accountEmail">Not signed in</strong>');
    expect(html).toContain('id="accountEmailHelper" class="accountEmailHelper" hidden');
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
  });

  it("keeps current-account identity and device logout available across every settings panel", () => {
    const html = accountHtml();
    const css = businessCss();
    const persistentHeader = htmlBetween(html, 'class="accountDashboardIntro sectionHeader"', 'id="dashboardStatus"');
    const settingsHub = htmlBetween(html, 'id="accountSettingsHub"', 'id="discountPassModal"');

    expect(persistentHeader).toContain('class="panel accountIdentityCard accountIdentityCard--compact accountIdentityBar"');
    expect(persistentHeader).toContain('aria-label="Current signed-in account"');
    expect(persistentHeader).toContain('id="accountEmail"');
    expect(persistentHeader).toContain('id="accessBadgeRow"');
    expect(persistentHeader).toContain('id="logoutButton"');
    expect(persistentHeader).toContain('aria-label="Log out this device"');
    expect(settingsHub).not.toContain('id="logoutButton"');
    expect(html.match(/id="logoutButton"/g)).toHaveLength(1);
    expect(html).toContain('$("logoutButton").addEventListener("click", async () => {');
    expect(css).toContain(".accountIdentityBar");
    expect(css).toContain(".accountIdentityBar__details");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.accountIdentityBar \.accountAccessBadgeRow\s*\{[\s\S]*grid-column:\s*1 \/ -1;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountIdentityBar > \.button\s*\{[\s\S]*min-height:\s*42px;/);
  });

  it("labels Apple Hide My Email relay addresses clearly", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain("function isApplePrivateRelayEmail");
    expect(html).toContain("@privaterelay\\.appleid\\.com");
    expect(html).toContain("Apple private email");
    expect(html).toContain("Apple is forwarding Pint Path emails through Hide My Email.");
    expect(html).toContain("renderAccountEmail(account)");
    expect(css).toContain(".accountEmailHelper");
  });

  it("does not show logged-out confirmation when no session existed", () => {
    const html = accountHtml();

    expect(html).toContain("const hadApiSession = MelbBeerBusiness.hasAuthenticatedSessionHint()");
    expect(html).toContain("hadApiSession || hadSupabaseSession ? \"You have been logged out.\" : \"Enter your details to continue.\"");
  });

  it("can resume premium checkout after account session refresh", () => {
    const html = accountHtml();

    expect(html).toContain("function pendingCheckoutPlan");
    expect(html).toContain("function pendingStripeCheckoutSessionId");
    expect(html).toContain('plan === "monthly" || plan === "yearly"');
    expect(html).toContain("checkoutResumeStarted");
    expect(html).toContain("checkoutReconcileStarted");
    expect(html).toContain("async function resumeCheckoutIfRequested");
    expect(html).toContain("async function reconcileCheckoutReturnIfNeeded");
    expect(html).toContain("if (!CONSUMER_PAID_ENROLLMENT_ENABLED)");
    expect(html).toContain("Paid subscriptions are not available in the current Free release.");
    expect(html).not.toContain("Existing subscriptions can still be managed or cancelled from Account.");
    expect(html).toContain('MelbBeerBusiness.apiFetch("/api/business/billing/checkout"');
    expect(html).toContain('MelbBeerBusiness.apiFetch("/api/business/billing/checkout/reconcile"');
    expect(html).toContain("Confirm you are 18+ on this account before starting checkout.");
    expect(html).toContain("Opening ${plan} checkout");
    expect(html).toContain("Confirming your Stripe checkout");
    expect(html).toContain("session_id");
    expect(html).toContain("await resumeCheckoutIfRequested(result)");
    expect(html).toContain("await reconcileCheckoutReturnIfNeeded()");
  });

  it("keeps contributor evidence copy private and reviewer-focused", () => {
    const html = accountHtml();
    const trust = trustHtml();

    expect(html).toContain("Private evidence");
    expect(html).toContain("Submitted data stays pending until verified or approved.");
    expect(trust).toContain("Source photos, receipts, upload-location proof, OCR evidence, and reviewer notes are private review material.");
  });

  it("keeps contact on a dedicated page instead of clustering the account dashboard", () => {
    const html = accountHtml();
    const feedback = feedbackHtml();
    const script = businessJs();
    const css = businessCss();

    expect(html).not.toContain('id="feedbackForm"');
    expect(html).toContain('href="/feedback.html"');
    expect(feedback).toContain('id="feedbackForm"');
    expect(feedback).toContain("Tell us what you need, or ask about joining as a venue.");
    expect(feedback).toContain("venue_partner_interest");
    expect(feedback).toContain("Schedule deletion from your account.");
    expect(feedback).toContain("Messages enter the private admin support queue with assignment and resolution tracking.");
    expect(feedback).toContain("Do not include passwords, card numbers, private keys, or ID documents");
    expect(feedback).toContain('MelbBeerBusiness.renderNav(isVenueSupport ? "venue-support" : "feedback")');
    expect(feedback).toContain("Ask Pint Path about your venue account.");
    expect(feedback).toContain("Venue support messages are saved into the Pint Path admin support inbox.");
    expect(feedback).toContain('MelbBeerBusiness.apiFetch("/api/business/feedback"');
    expect(feedback).toContain("Keep this reference for follow-up.");
    expect(feedback).toContain("feedbackGrid.prepend(feedbackForm)");
    expect(feedback).toContain("feedbackGrid.after(supportInfo)");
    expect(feedback).toContain("supportInfo.after(feedbackPromise)");
    expect(businessCss()).toContain(".feedbackPage #feedbackSupportInfo + .feedbackPromise");
    expect(css).toContain("margin-top: clamp(14px, 2.2vw, 24px);");
    expect(script).toContain('{ key: "feedback", href: venueManagerNav ? "/feedback.html?audience=bars" : "/feedback.html", label: "Contact us" }');
    expect(script).not.toContain('href="/account.html#feedbackForm"');
    expect(script).not.toContain("fieldTestFeedbackButton");
    expect(script).not.toContain("floatingFeedback");
  });

  it("moves account actions into submit flows and a settings hub", () => {
    const html = accountHtml();

    expect(html).not.toContain('class="accountActionsGrid"');
    expect(html).not.toContain('href="/submit.html?type=photo_upload"');
    expect(html).not.toContain('href="#recentSubmissionsSection"');
    expect(html).not.toContain('href="/stats.html"');
    expect(html).not.toContain('href="/submit.html">Open Submit');
    expect(html).toContain('data-settings-target="submissions"');
    expect(html).toContain('data-settings-target="stats"');
    expect(html.indexOf('data-settings-target="stats"')).toBeLessThan(html.indexOf('data-settings-target="submissions"'));
    expect(html).toContain('data-settings-target="saved"');
    expect(html).toContain('data-settings-target="preferences"');
    expect(html).not.toContain('data-settings-target="watchlist"');
    expect(html).toContain('data-settings-target="privacy"');
    expect(html).toContain('data-settings-target="support"');
    expect(html).toContain('data-settings-target="security"');
    expect(html).toContain('class="panel form accountSupportPanel"');
    expect(html).toContain('class="accountSupportIntro"');
    expect(html).toContain('class="accountSupportFields"');
    expect(html).not.toContain("Suggested missions");
    expect(html).not.toContain('id="suggestedMissions"');
    expect(html).not.toContain("function missionSubmitHref");
    expect(html).not.toContain('id="quickVenueSelect"');
    expect(html).not.toContain("function clearQuickVenue");
    expect(html).not.toContain("submitQuickUpload");
    expect(html).toContain("const detailedSubmissionHistory");
    expect(html).toContain("result.submissionHistory");
  });

  it("keeps account hero cards only inside My Stats", () => {
    const html = accountHtml();
    const css = businessCss();
    const submissionsPanel = htmlBetween(html, 'id="settingsSubmissionsPanel"', 'id="settingsStatsPanel"');
    const statsPanel = htmlBetween(html, 'id="settingsStatsPanel"', 'id="settingsBetaTestingPanel"');
    const betaTestingPanel = htmlBetween(html, 'id="settingsBetaTestingPanel"', 'id="settingsPrivacyPanel"');
    const privacyPanel = htmlBetween(html, 'id="settingsPrivacyPanel"', 'id="settingsSupportPanel"');
    const supportPanel = htmlBetween(html, 'id="settingsSupportPanel"', 'id="settingsSecurityPanel"');
    const securityPanel = html.slice(html.indexOf('id="settingsSecurityPanel"'), html.indexOf("</section>", html.indexOf('id="settingsSecurityPanel"')));

    expect(html).toContain('class="accountHighlightsGrid"');
    expect(html).not.toContain("Start here");
    expect(html).not.toContain("accountQuickStart");
    expect(css).not.toContain("accountQuickStart");
    expect(html).not.toContain('id="accountIdMetric"');
    expect(html).toContain('id="savingsMetric"');
    expect(html).toContain('id="refreshDiscountPassButton"');
    expect(html).toContain('id="discountPassModal"');
    expect(html).toContain('data-close-discount-pass-modal');
    expect(html).toContain("Pint Path special");
    expect(html).toContain("openDiscountPassModal()");
    expect(html).toContain("closeDiscountPassModal({ quiet: true })");
    expect(html).not.toContain('id="totalUploadsMetric"');
    expect(html).not.toContain('id="pendingMetric"');
    expect(html).not.toContain('id="leaderboardMetric"');
    expect(html).toContain('id="settingsStatsPanel"');
    expect(html).toContain('id="accountStatsGrid"');
    expect(html).toContain("function renderAccountStatsPanel");
    expect(html).toContain("renderAccountStatsPanel(result)");
    expect(html).toContain("accountStatsProgressCard");
    expect(html).toContain("same premium map access as a paid user");
    expect(html).toContain("const billingManagementAvailable = billing.managementAvailable === true");
    expect(html).toContain("This access is not linked to a paid Stripe subscription");
    expect(html).toContain('data-billing-status role="status" aria-live="polite"');
    expect(html).toContain("Stripe did not return a billing portal address");
    expect(html).toContain('portalUrl.hostname === "billing.stripe.com"');
    expect(html).toContain('button.textContent = "Manage billing"');
    expect(html).toContain("billingStatus?.scrollIntoView");
    expect(html).toContain("Account ID");
    expect(html).toContain("accountStatCard--");
    expect(html).toContain('class="accountDashboardIntro sectionHeader"');
    expect(html.indexOf('id="accountDashboardTitle"')).toBeLessThan(html.indexOf('id="accountSettingsHub"'));
    expect(html.indexOf('class="settingsNav"')).toBeLessThan(html.indexOf('class="accountHighlightsGrid"'));
    expect(statsPanel).toContain('class="accountHighlightsGrid"');
    [submissionsPanel, betaTestingPanel, privacyPanel, supportPanel, securityPanel].forEach((panel) => {
      expect(panel).not.toContain('class="accountHighlightsGrid"');
      expect(panel).not.toContain("accountHeroMetric--savings");
      expect(panel).not.toContain("accountHeroMetric--special");
    });
    expect(html).toContain("accountHeroMetric--savings");
    expect(html).toContain("accountHeroMetric--special");
    expect(html.indexOf('label: "Total saved"')).toBeLessThan(html.indexOf('label: "Total uploads"'));
    expect(html.indexOf('label: "Total uploads"')).toBeLessThan(html.indexOf('label: "Verified"'));
    expect(html.indexOf('label: "Verified"')).toBeLessThan(html.indexOf('label: "Pending review"'));
    expect(html.indexOf('label: "Rejected"')).toBeLessThan(html.indexOf('label: "Trust score"'));
    expect(css).toContain(".accountHighlightsGrid");
    expect(css).toContain("margin: clamp(14px, 1.8vw, 20px) 0;");
    expect(css).toContain(".accountDashboardIntro");
    expect(css).toContain(".accountHeroMetric--savings");
    expect(css).toContain(".accountHeroMetric--special");
    expect(css).toContain(".accountAccessBadge--monthly");
    expect(css).toContain(".accountAccessBadge--yearly");
    expect(css).toContain(".accountAccessBadge--freemium");
    expect(css).toContain(".accountStatsGrid");
    expect(css).toContain("display: grid;");
    expect(css).toContain(".accountStatsProgressCard");
    expect(css).toContain(".membershipBillingStatus");
    expect(css).toContain(".accountStatCard .helperCopy");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.accountStatsGrid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.accountStatCard \.helperCopy\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.settingsNav\s*\{[\s\S]*overflow-x:\s*auto;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.accountHighlightsGrid\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountStatsGrid \.metricCard\s*\{[\s\S]*min-height:\s*104px;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountDiscountFeature \.sectionHeader p,[\s\S]*\.accountDiscountFeature > \.helperCopy\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountDashboardIntro \.button\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountIdentityCard--compact strong\s*\{[\s\S]*white-space:\s*nowrap;[\s\S]*text-overflow:\s*ellipsis;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountAccessBadgeRow\s*\{[\s\S]*flex-wrap:\s*nowrap;[\s\S]*overflow-x:\s*auto;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountAccessBadge\s*\{[\s\S]*font-size:\s*0\.56rem;/);
    expect(css).not.toMatch(/\.accountAccessBadgeRow \.accountAccessBadge:not\(:first-child\)\s*\{[\s\S]*display:\s*none;/);
    expect(css).toContain(".accountDiscountFeature");
    expect(css).toContain(".discountPassModal");
    expect(css).toContain(".discountPassModalClose");
    expect(css).toContain(".nameRuleHint");
    expect(css).toContain(".betaFeatureHint");
    expect(css).toContain(".betaTestingPanel");
    expect(css).toContain(".leaderboardPodium");
    expect(css).toContain(".podiumCard--rank3");
    expect(css).toContain(".betaLeaderboardRow--me");
    expect(css).toContain(".accountSupportPanel");
    expect(css).toContain(".accountSupportFields");
    expect(css).toContain(".rewardVoucherCard");
    expect(html).toContain('data-copy-voucher-reference');
    expect(html).toContain("claimReference");
    expect(html).toContain("voucher.instructions");
    expect(html).toContain("voucher.expiresAt");
    expect(html).toContain('href="/feedback.html?type=billing_support">Contact support</a>');
    expect(css).toContain(".rewardVoucherReference");
    expect(css).toContain("user-select: all;");
    expect(css).toContain(".pubGolfDrinkGrid");
    expect(css).toContain(".canIDrivePanel");
  });

  it("provides a standard-drink log without estimating BAC or giving driving clearance", () => {
    const html = accountHtml();
    const css = businessCss();
    const service = businessServiceTs();

    expect(html).toContain('id="betaFeatureCanIDrive"');
    expect(html).toContain('data-beta-feature-panel="can-i-drive"');
    expect(html).toContain("Standard drink log");
    expect(html).toContain("Unknown drinks stay unknown.");
    expect(html).toContain("This is not a BAC estimate, breath test, driving clearance, legal advice, or medical advice.");
    expect(html).toContain("Do not drive after drinking.");
    expect(html).not.toContain('name="heightCm"');
    expect(html).not.toContain('name="weightKg"');
    expect(html).toContain('name="extraStandardDrinks"');
    expect(html).toContain("CAN_I_DRIVE_PROFILE_KEY");
    expect(html).toContain("AU_STANDARD_DRINK_GRAMS");
    expect(html).not.toContain("BAC_ELIMINATION_PER_HOUR");
    expect(html).toContain("function recordStandardDrinksPerUnit");
    expect(html).toContain("function estimateStandardDrinksForRecord");
    expect(html).not.toContain("function calculateEstimatedBac");
    expect(html).toContain("function calculateCanIDriveEstimate");
    expect(html).toContain("renderCanIDrivePanel(result)");
    expect(html).toContain("renderCanIDriveEstimate(estimate)");
    expect(html).toContain("It does not calculate BAC.");
    expect(html).toContain("calculated only from stored serving volume and ABV");
    expect(html).not.toContain("Safe to drive");

    expect(css).toContain(".canIDriveWarningStack");
    expect(css).toContain(".canIDriveMetricGrid");
    expect(css).toContain(".canIDriveDrinkRow");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.canIDriveMetricGrid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.canIDriveMetricGrid\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
    expect(service).toContain("listPintPointDrinkRecordsForUser(account.id, 25)");
    expect(service).toContain("canIDrive");
    expect(service).toContain("Pint Path does not estimate BAC or provide driving clearance.");
  });

  it("opens account settings sections on demand instead of rendering every panel open", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain('id="settingsEmptyPanel"');
    expect(html).toContain('data-settings-target="submissions" aria-controls="settingsSubmissionsPanel"');
    expect(html).toContain('data-settings-target="stats" aria-controls="settingsStatsPanel"');
    expect(html).not.toContain('href="#recentSubmissionsSection"');
    expect(html).not.toContain('href="/stats.html"');
    expect(html).toContain('data-settings-panel="submissions" role="tabpanel" aria-labelledby="settingsSubmissionsTab" hidden');
    expect(html).toContain('data-settings-panel="stats" role="tabpanel" aria-labelledby="settingsStatsTab" hidden');
    expect(html).toContain('data-settings-panel="saved" role="tabpanel" aria-labelledby="settingsSavedTab" hidden');
    expect(html).toContain('data-settings-panel="preferences" role="tabpanel" aria-labelledby="settingsPreferencesTab" hidden');
    expect(html).not.toContain('data-settings-panel="watchlist" role="tabpanel" hidden');
    expect(html).toContain('data-settings-panel="privacy" role="tabpanel" aria-labelledby="settingsPrivacyTab" hidden');
    expect(html).toContain('data-settings-panel="support" role="tabpanel" aria-labelledby="settingsSupportTab" hidden');
    expect(html).toContain('data-settings-panel="security" role="tabpanel" aria-labelledby="settingsSecurityTab" hidden');
    expect(html).toContain('id="betaTestingNavButton"');
    expect(html).toContain('data-settings-target="beta-testing"');
    expect(html).toContain('aria-controls="settingsBetaTestingPanel"');
    expect(html).toContain('data-settings-panel="beta-testing" role="tabpanel" aria-labelledby="betaTestingNavButton" data-commercial-surface hidden');
    expect(html).toContain("function showAccountSettingsPanel");
    expect(html).toContain('document.querySelectorAll("[data-settings-target]")');
    expect(html).toContain("showAccountSettingsPanel(button.dataset.settingsTarget)");
    expect(html).toContain("function requestedSettingsPanel");
    expect(html).toContain("showAccountSettingsPanel(requestedSettingsPanel())");
    expect(html).toContain("renderBetaTestingPanel(result)");
    expect(html).toContain('id="counterStaffInvitations"');
    expect(html).toContain("renderCounterStaffInvitations(result.counterStaffInvitations || [])");
    expect(html).toContain('id="counterStaffAccess"');
    expect(html).toContain("renderCounterStaffAssignments(result.counterStaffAssignments || [])");
    expect(html).toContain("/counter-staff-invitations/");
    expect(html).toContain('MelbBeerBusiness.apiFetch("/api/business/beta/pub-golf/plan"');
    expect(html).not.toContain('id="privacyControlsSection"');
    expect(html).toContain('id="accountSessionPager"');
    expect(html).toContain("/api/business/account/sessions?limit=${ACCOUNT_SESSION_PAGE_SIZE}&offset=${requestedOffset}");
    expect(html).toContain("state.accountSessionOffset += ACCOUNT_SESSION_PAGE_SIZE");
    expect(html).toContain('id="submissionHistoryPager"');
    expect(html).toContain("const SUBMISSION_HISTORY_PAGE_SIZE = 25");
    expect(html).toContain("/api/business/submissions?mine=true&includeReviewData=true&limit=${SUBMISSION_HISTORY_PAGE_SIZE}&offset=${requestedOffset}");
    expect(html).toContain("state.submissionHistoryOffset += SUBMISSION_HISTORY_PAGE_SIZE");
    expect(html).toContain("state.submissionHistoryTotal = Number(result.dashboardStats?.totalUploads");
    expect(css).toContain(".settingsNavButton");
    expect(css).toContain(".settingsPanel");
    expect(css).toContain(".settingsEmptyPanel");
    expect(css).not.toContain(".accountDashboard #premiumMemberHub");
    expect(css).not.toContain(".premiumMemberHub");
    expect(css).toContain(".accountDashboard #accountSettingsHub");
    expect(css).toMatch(/\.accountDashboard \.accountDashboardIntro\s*\{[^}]*order:\s*1;/s);
    expect(css).toMatch(/\.accountDashboard #counterStaffInvitations,\s*\.accountDashboard #counterStaffAccess\s*\{[^}]*order:\s*3;/s);
    expect(css).toMatch(/\.accountDashboard #accountSettingsHub\s*\{[^}]*order:\s*4;/s);
    expect(css).not.toContain(".accountDashboard .accountHighlightsGrid");
    expect(css).not.toContain(".accountDashboard .accountPrimaryGrid");
  });

  it("keeps password reauthentication user-initiated and makes MFA provider-aware", () => {
    const html = accountHtml();
    const settingsSwitcher = htmlBetween(html, "function showAccountSettingsPanel", "function setMfaStatus");
    const dashboardRenderer = htmlBetween(html, "function renderDashboard", "async function resumeCheckoutIfRequested");
    const mfaLoader = htmlBetween(html, "async function loadMfaState", "async function beginMfaEnrollment");

    expect(html).toContain("Choose Refresh to confirm your identity and review signed-in sessions.");
    expect(html).toContain('$("refreshAccountSessionsButton").addEventListener("click", () => void loadAccountSessions())');
    expect(settingsSwitcher).toContain("showAccountSessionRefreshPrompt()");
    expect(settingsSwitcher).not.toContain("loadAccountSessions()");
    expect(dashboardRenderer).toContain("showAccountSessionRefreshPrompt()");
    expect(dashboardRenderer).not.toContain("loadAccountSessions()");

    expect(mfaLoader).toContain('const authProvider = String(state.accountData?.account?.authProvider || "").toLowerCase()');
    expect(mfaLoader).toContain('!["supabase", "google", "apple"].includes(authProvider)');
    expect(mfaLoader).toContain("This password-based account confirms the current password before sensitive actions.");
    expect(mfaLoader.indexOf("await client.auth.getSession()")).toBeLessThan(mfaLoader.indexOf("client.auth.mfa.listFactors()"));
    expect(mfaLoader).toContain("Reauthenticate with your sign-in provider before changing authenticator settings.");
    expect(mfaLoader).toContain('$("startMfaButton").dataset.reauthenticate = "true"');
    expect(mfaLoader).toContain("/auth session missing|session not found|not authenticated/i.test(message)");
    expect(mfaLoader).not.toContain('setMfaStatus(error.message || "Could not read authenticator status."');
    const firstFactorEnrollment = htmlBetween(
      html,
      '$("startMfaButton").addEventListener',
      '$("replaceMfaButton").addEventListener',
    );
    expect(firstFactorEnrollment).toContain("requireProviderSession: true");
    expect(firstFactorEnrollment).toContain("forceFresh: true");
    expect(firstFactorEnrollment).toContain('continuation: "mfa_management"');
    expect(firstFactorEnrollment.indexOf("ensureSupabaseSessionForPurpose")).toBeLessThan(
      firstFactorEnrollment.indexOf("beginMfaEnrollment()"),
    );
  });

  it("provides a privacy-safe, paginated community verification workflow", () => {
    const html = accountHtml();
    const submissionsPanel = htmlBetween(html, 'id="settingsSubmissionsPanel"', 'id="settingsStatsPanel"');

    expect(submissionsPanel).toContain('id="communityVerificationSection"');
    expect(submissionsPanel).toContain('id="communityVerificationList"');
    expect(submissionsPanel).toContain('id="communityVerificationPager"');
    expect(submissionsPanel).toContain("contributor's identity, notes, upload location, or private evidence");
    expect(html).toContain("/api/business/verification-candidates?limit=${VERIFICATION_CANDIDATE_PAGE_SIZE}&offset=${requestedOffset}");
    expect(html).toContain("/api/business/submissions/${encodeURIComponent(candidateId)}/verifications");
    expect(html).toContain('data-verification-result="confirmed"');
    expect(html).toContain('data-verification-result="disputed"');
    expect(html).toContain('data-verification-result="needs_more_evidence"');
    expect(html).toContain('result !== "confirmed" && notes.length < 3');
    expect(html).not.toContain("candidate.sourcePhotoUrl");
    expect(html).not.toContain("candidate.userId");
    expect(html).not.toContain("candidate.notes");
    expect(html).not.toContain("candidate.uploadLatitude");
  });

  it("keeps production web auth Google-only while retaining localhost email auth", () => {
    const html = accountHtml();
    const script = businessJs();

    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Apple");
    expect(html).not.toContain("Continue with Facebook");
    expect(html).toContain('const WEB_EMAIL_AUTH_ENABLED = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);');
    expect(html).toContain("const isLocalHost = WEB_EMAIL_AUTH_ENABLED;");
    expect(html).toContain('id="authTabs" class="authTabs" role="tablist" aria-label="Choose sign in or create account" data-local-email-auth hidden');
    expect(html).toContain('id="webEmailLoginFields" class="authFields" data-local-email-auth hidden');
    expect(html).toContain("Email/password access is reserved for the first iOS release.");
    expect(html).toContain("Email/password sign-in is available in the iOS app. Continue with Google on the website.");
    expect(html).toContain("MelbBeerBusiness.signUpWithEmail");
    expect(html).toContain("MelbBeerBusiness.signInWithEmail");
    expect(html).toContain('id="webEmailAuthUtilities" class="authUtilityGrid" aria-label="Account recovery links" data-local-email-auth hidden');
    expect(html).toContain('id="passwordResetLink" class="authUtilityCard" href="/reset-password.html"');
    expect(html).toContain('id="resendConfirmationLink" class="authUtilityCard" href="/resend-confirmation.html"');
    expect(html).toContain('authUtilityLink("/reset-password.html")');
    expect(html).toContain('authUtilityLink("/resend-confirmation.html")');
    expect(html).toContain('authUtilityLink("/resend-confirmation.html", body.email)');
    expect(html).toContain("If no link arrives within a minute, use Resend confirmation.");
    expect(html).toContain("No Supabase confirmation email was sent.");
    expect(html).not.toContain('id="oauthTermsAccepted"');
    expect(html).not.toContain('id="oauthPrivacyAccepted"');
    expect(html).not.toContain("before using social login");
    expect(html).not.toContain('id="oauthConsent"');
    expect(html).not.toContain('name="oauthAgeConfirmed"');
    expect(html).not.toContain('name="oauthTermsAccepted"');
    expect(html).not.toContain('name="oauthPrivacyAccepted"');
    expect(html).not.toContain("legalAcceptance,");
    expect(html).toContain("first verifies your identity");
    expect(html).toContain("asked for 18+ and current Terms/Privacy acceptance only after that verification");
    expect(script).toContain("signInWithOAuth({");
    expect(script).toContain('provider,');
    expect(script).toContain("signInWithPassword");
    expect(script).toContain("signUp({");
    expect(script).toContain("resendSignupConfirmation");
    expect(script).toContain("auth.resend({");
    expect(script).toContain('type: "signup"');
    expect(script).toContain("/auth/callback");
    expect(script).toContain('/reset-password.html?mode=update');
    expect(script).toContain("updateUser({ password })");
    expect(script).not.toContain("terms_accepted:");
    expect(script).not.toContain("privacy_accepted:");
    expect(script).toContain("window.MELB_BEER_BOT_VIEWER_CONFIG?.business?.legalPolicyVersion");
    expect(script).not.toContain("before continuing with social sign-in");
    expect(script).toContain('|| "2026-08-03"');
    expect(script).toContain("options.applyPendingLegalAcceptance ? getPendingLegalAcceptance() : null");
    expect(script).toContain('consentSource: "web_oauth"');
    expect(script).toContain("LEGAL_ACCEPTANCE_MAX_AGE_MS");
    expect(script).toContain("expectedEmail: String(email || \"\").trim().toLowerCase()");
    expect(script).toContain('expectedProvider: "email"');
    expect(script).toContain("syncSupabaseSession({ applyPendingLegalAcceptance: true, authFlowNonce })");
  });

  it("provides dedicated confirmation resend and password reset pages", () => {
    const reset = resetPasswordHtml();
    const resend = resendConfirmationHtml();
    const script = businessJs();

    expect(resend).toContain("Resend your confirmation email");
    expect(resend).toContain('id="resendConfirmationForm"');
    expect(resend).toContain('id="confirmationEmail"');
    expect(resend).toContain("MelbBeerBusiness.resendSignupConfirmation");
    expect(resend).toContain("If a Supabase signup exists for that email, a confirmation email has been sent.");
    expect(reset).toContain("Reset your Pint Path password");
    expect(reset).toContain('id="requestResetForm"');
    expect(reset).toContain('id="updatePasswordForm"');
    expect(reset).toContain("MelbBeerBusiness.requestPasswordReset");
    expect(reset).toContain("MelbBeerBusiness.updatePassword");
    expect(reset).toContain('params.get("mode") === "update"');
    expect(reset).toContain("MelbBeerBusiness.validatePasswordRecoverySession()");
    expect(reset).toContain("This memory-only recovery session is missing, expired, refreshed, or was already used.");
    expect(reset).toContain('id="signInAfterReset"');
    expect(reset).toContain("Every session was signed out; sign in again with your new password.");
    expect(script).toContain('/api/business/auth/password-reset-complete');
    expect(script).toContain('signOut({ scope: "global" })');
    expect(script).not.toContain("await syncSupabaseSession().catch(() => null);");
  });

  it("keeps recovery notices out of view until there is a result and provides a dedicated venue login", () => {
    const reset = resetPasswordHtml();
    const resend = resendConfirmationHtml();
    const venueLogin = fs.readFileSync(path.resolve(process.cwd(), "viewer/venue-login.html"), "utf8");

    expect(reset).toContain('id="resetStatus" class="notice" role="status" aria-live="polite" aria-atomic="true" hidden');
    expect(resend).toContain('id="resendStatus" class="notice" role="status" aria-live="polite" aria-atomic="true" hidden');
    expect(venueLogin).toContain("Continue to your venue");
    expect(venueLogin).toContain('id="venueGoogleLoginLink"');
    expect(venueLogin).toContain("Continue with Google");
    expect(venueLogin).not.toContain("MelbBeerBusiness.signInWithEmail");
    expect(venueLogin).not.toContain('MelbBeerBusiness.apiFetch("/api/business/auth/login"');
    expect(venueLogin).toContain("MelbBeerBusiness.isVenuePortalReturnPath(requested)");
  });

  it("accepts canonical and legacy venue portal return paths without accepting lookalikes", () => {
    const helpers = loadBusinessHelpers();
    const validPaths = [
      "/venue-portal",
      "/venue-portal?venueId=venue-1",
      "/venue-portal#redemption",
      "/venue-portal.html",
      "/venue-portal.html?venueId=venue-1",
      "/venue-portal.html#redemption",
    ];
    const invalidPaths = [
      "/venue-portal-archive",
      "/venue-portal.html.evil",
      "/venue-portal/extra",
      "//venue-portal",
      "/account.html",
    ];

    validPaths.forEach((returnPath) => expect(helpers.isVenuePortalReturnPath(returnPath)).toBe(true));
    invalidPaths.forEach((returnPath) => expect(helpers.isVenuePortalReturnPath(returnPath)).toBe(false));

    const extensionlessReturnPath = "/venue-portal?venueId=venue-1&tab=redemption";
    expect(helpers.storeSensitiveAuthReturnPath(extensionlessReturnPath)).toBe(extensionlessReturnPath);
    expect(helpers.consumeSensitiveAuthReturnPath()).toBe(extensionlessReturnPath);
    expect(helpers.storeSensitiveAuthReturnPath("/venue-portal-archive")).toBeNull();

    const script = businessJs();
    expect(script).toContain("if (!isVenuePortalReturnPath(safePath)) return null;");
    expect(accountHtml()).toContain("MelbBeerBusiness.isVenuePortalReturnPath(venueReturnPath)");
    expect(callbackHtml()).toContain("MelbBeerBusiness.isVenuePortalReturnPath(venueReturnPath)");
  });

  it("keeps the primary nav consistent and gives privileged accounts dashboard/admin links", () => {
    const html = mapHtml();
    const script = businessJs();

    expect(script).toContain("function hasAuthenticatedSessionHint");
    expect(script).not.toContain('"X-Pint-Path-Reauth-Token"');
    expect(script).toContain("const credentialCeremony = options.credentialCeremony == null");
    expect(script).toContain('? "browser_memory_v1"');
    expect(script).toContain("credentialCeremony,");
    expect(script).toContain("function reauthenticationPurposeForPath");
    expect(script).toContain('"X-Pint-Path-Current-Password"');
    expect(script).toContain("requestError?.details?.reauthenticationRequired");
    expect(appSource()).toContain("X-Pint-Path-Reauth-Token,X-Pint-Path-Current-Password");
    expect(script).toContain("function hasCachedSupabaseSession");
    expect(script).toContain("function isVenueManagerContext");
    expect(script).toContain("function isAdminContext");
    expect(script).toContain("function isAdminAccountContext");
    expect(script).toContain("function canUseVenuePortalContext");
    expect(script).toContain("function installNavigationChrome");
    expect(script).toContain("subscriptionStatus: account.subscriptionStatus || null");
    expect(script).not.toContain("email: account.email || null");
    expect(script).not.toContain("email: session?.user?.email");
    const helpers = loadBusinessHelpers();
    const publicNavLabels = ["Map", "Submit", "Missions", "Pricing", "FAQ", "Account", "Contact us"];

    ["", "account", "bar-faq", "faq", "feedback", "missions", "pricing", "submit", "trust", "venue-support"].forEach((active) => {
      expect(navLinkLabels(helpers.renderNav(active))).toEqual(publicNavLabels);
    });
    expect(navLinkLabels(helpers.renderNav("venue-portal"))).toEqual(publicNavLabels);
    expect(script).toContain('const counterPortalPath = accountContext?.authorityVerified === true');
    expect(script).toContain('isVenueManagerContext() || Boolean(counterPortalPath)');
    expect(script).toContain("const venuePortalNav = canUseVenuePortalContext()");
    expect(script).toContain('const adminNav = active === "admin" || isAdminAccountContext()');
    expect(script).toContain('{ key: "map", href: "/", label: "Map" }');
    expect(script).toContain('{ key: "submit", href: "/submit.html", label: "Submit" }');
    expect(script).toContain('{ key: "missions", href: "/missions.html", label: "Missions" }');
    expect(script.indexOf('{ key: "submit", href: "/submit.html", label: "Submit" }')).toBeLessThan(
      script.indexOf('{ key: "missions", href: "/missions.html", label: "Missions" }'),
    );
    expect(script).toContain('{ key: "admin", href: "/admin.html", label: "Admin" }');
    expect(script).toContain('{ key: "pricing", href: "/pricing.html", label: "Pricing" }');
    expect(script).toContain('const counterOnlyPortalPath = isVenueManagerContext() || isAdminContext()');
    expect(script).toContain('{ key: "venue-portal", href: counterOnlyPortalPath || "/venue-portal.html", label: counterOnlyPortalPath ? "Counter" : "Dashboard" }');
    expect(script).toContain('{ key: "faq", href: venueManagerNav ? "/trust.html?audience=bars" : "/trust.html", label: "FAQ" }');
    expect(script).toContain('{ key: "feedback", href: venueManagerNav ? "/feedback.html?audience=bars" : "/feedback.html", label: "Contact us" }');
    expect(script).toContain('aria-controls="primaryNavLinks" data-mobile-nav-toggle');
    expect(script).toContain('id="primaryNavLinks" class="navLinks" data-mobile-nav-panel');
    expect(script).not.toContain("const authenticatedLinks");
    expect(html).toContain('id="venueDashboardLink" href="/venue-portal.html" hidden>Dashboard');
    expect(html).toContain('href="/submit.html">Submit');
    expect(html).toContain('href="/missions.html">Missions');
    expect(html.indexOf('href="/submit.html">Submit')).toBeLessThan(
      html.indexOf('href="/missions.html">Missions'),
    );
    expect(html).toContain('href="/trust.html" id="venueFaqLink">FAQ');
    expect(html).toContain('href="/feedback.html" id="topbarFeedbackLink">Contact us');
    expect(html).not.toContain("data-venue-hidden");
    expect(html).not.toContain('href="/missions.html" data-auth-required');
    expect(html).not.toContain('href="/submit.html" data-auth-required');
    expect(html).not.toContain('href="/submit.html" class="primary" data-auth-required');
    expect(html).toContain("function syncAuthenticatedNavLinks");
    expect(html).toContain("const counterOnlyPortalPath = isVenueManager || isAdmin ? null : counterPortalPath");
    expect(html).toContain('venueDashboardLinkEl.href = counterOnlyPortalPath || "/venue-portal.html"');
    expect(html).toContain('venueDashboardLinkEl.textContent = counterOnlyPortalPath ? "Counter" : "Dashboard"');
    expect(html).toContain("const venueAudience = isVenueManager || Boolean(counterPortalPath)");
    expect(script).toContain("async function clearLocalSubmissionDeviceData");
    expect(script).toContain("submission?.ownerAccountId === normalizedAccountId");
    expect(accountHtml()).toContain("await MelbBeerBusiness.clearLocalSubmissionDeviceData(deletionAccountId)");
    expect(accountHtml()).toContain("Private submission drafts, exact location proof, and queued evidence will be cleared from this device now");
    expect(html).toContain("window.MelbBeerBusiness?.isVenueManagerContext?.()");
    expect(html).toContain("window.MelbBeerBusiness?.canUseVenuePortalContext?.()");
    expect(html).toContain('document.querySelectorAll("[data-auth-required]")');
  });

  it("maps every browser-sensitive endpoint to an exact purpose-bound cookie ceremony", () => {
    const helpers = loadBusinessHelpers();
    expect(helpers.reauthenticationPurposeForPath("/api/business/account/export")).toBe("account_export");
    expect(helpers.reauthenticationPurposeForPath("/api/business/account/sessions?limit=25")).toBe("session_management");
    expect(helpers.reauthenticationPurposeForPath("/api/business/account/sessions/session-1")).toBe("session_management");
    expect(helpers.reauthenticationPurposeForPath("/api/business/account/delete-request/deletion-1")).toBe("account_deletion");
    expect(helpers.reauthenticationPurposeForPath("/api/business/billing/portal")).toBe("billing_portal");
    expect(helpers.reauthenticationPurposeForPath("/api/business/venue-portal/venue-1/billing/portal")).toBe("venue_billing_portal");
    expect(helpers.reauthenticationPurposeForPath("/api/business/auth/logout-all")).toBe("logout_all");
    expect(venuePortalHtml()).toContain(
      "MelbBeerBusiness.sensitiveApiFetch(`/api/business/venue-portal/${encodeURIComponent(selectedVenueId())}/billing/portal`",
    );
    const venueLogout = htmlBetween(
      venuePortalHtml(),
      'venueLogoutButton.addEventListener("click"',
      'venueSelect.addEventListener("change"',
    );
    expect(venueLogout.indexOf('/api/business/auth/logout')).toBeLessThan(
      venueLogout.indexOf('broadcastAuthInvalidation("venue_logout")'),
    );
    expect(venueLogout).toContain('MelbBeerBusiness.broadcastAuthInvalidation("venue_logout")');
    expect(venueLogout.indexOf('broadcastAuthInvalidation("venue_logout")')).toBeLessThan(
      venueLogout.indexOf('window.location.assign("/account.html")'),
    );
    expect(venueLogout).toContain("venueLogoutButton.disabled = false");
    expect(venueLogout).toContain("This venue session may still be active");
    expect(venueLogout).not.toContain("finally");
    expect(() => helpers.reauthenticationPurposeForPath("/api/business/account/preferences"))
      .toThrow("missing an approved reauthentication purpose");
  });

  it("never substitutes an OAuth provider for remembered Supabase email reauthentication", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext(
      { id: "account-email", authProvider: "supabase" },
      { authIdentityProvider: "email" },
    );

    expect(helpers.getSupabaseReauthenticationProvider()).toBe("email");
    expect(businessJs()).toContain("const credentials = await requestProviderEmailPassword(purpose);");
    expect(businessJs()).toContain("signInWithEmail(credentials.email, credentials.password, { reauthPurpose: purpose })");
    expect(businessJs()).not.toContain("return enabledProviders.length === 1 ? enabledProviders[0] : null;");
  });

  it("sends provider-password reauthentication only to Supabase and purpose-syncs without the password", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const harness = loadBusinessAuthHarness({
      sessionEmail: "member@example.com",
      sessionProvider: "email",
      accessToken: unsignedAccessToken({
        amr: [{ method: "password", timestamp: nowSeconds }],
        auth_time: nowSeconds,
      }),
    });

    await harness.helpers.signInWithEmail("member@example.com", "provider-only-password", {
      reauthPurpose: "account_export",
    });

    expect(harness.passwordSignIns).toEqual([{
      email: "member@example.com",
      password: "provider-only-password",
    }]);
    expect(harness.requests.find((request) => request.path === "/api/business/auth/supabase-session")?.body)
      .toMatchObject({
        credentialCeremony: "browser_memory_v1",
        reauthPurpose: "account_export",
      });
    expect(JSON.stringify(harness.requests)).not.toContain("provider-only-password");
  });

  it("uses a server-bound, non-signup email OTP for hosted OAuth sensitive reauthentication", async () => {
    const harness = loadBusinessAuthHarness({
      sessionEmail: "oauth-member@example.com",
      sessionProvider: "google",
    });
    harness.helpers.setAccountContext(
      {
        id: "account-1",
        email: "oauth-member@example.com",
        authProvider: "supabase",
        role: "user",
        status: "active",
      },
      { authIdentityProvider: "google" },
    );

    await expect(harness.helpers.ensureSupabaseSessionForPurpose("account_export", {
      forceFresh: true,
    })).rejects.toMatchObject({
      code: "EMAIL_REAUTHENTICATION_SENT",
      reauthenticationPending: true,
    });

    expect(harness.requests.find((request) => (
      request.path === "/api/business/auth/browser-email-reauthentication"
    ))?.body).toEqual({ purpose: "account_export" });
    expect(harness.otpSignIns).toEqual([{
      email: "oauth-member@example.com",
      options: {
        emailRedirectTo: "https://pintpath.au/auth/callback",
        shouldCreateUser: false,
      },
    }]);
    expect(harness.oauthSignIns).toEqual([]);
    expect(JSON.parse(harness.localStorage.get("pintPathAuthFlow") || "{}"))
      .toMatchObject({
        kind: "browser_email_reauthentication",
        reauthPurpose: "account_export",
        returnTo: "/account.html",
      });
    expect(harness.localStorage.get("pintPathAuthFlow")).not.toContain("oauth-member@example.com");
    expect(harness.localStorage.get("pintPathAuthFlow")).not.toContain("provider-access-token");
    expect(businessJs()).toContain("clearOAuthPopupState();\n  storeAuthFlowState({");
  });

  it("binds callback-local MFA management separately from ordinary session management", async () => {
    const harness = loadBusinessAuthHarness({
      sessionEmail: "oauth-member@example.com",
      sessionProvider: "google",
    });
    harness.helpers.setAccountContext(
      {
        id: "account-1",
        email: "oauth-member@example.com",
        authProvider: "supabase",
        role: "user",
        status: "active",
      },
      { authIdentityProvider: "google" },
    );

    await harness.helpers.beginBrowserEmailReauthentication("session_management");
    expect(JSON.parse(harness.localStorage.get("pintPathAuthFlow") || "{}"))
      .toMatchObject({ reauthPurpose: "session_management", continuation: null });

    await harness.helpers.beginBrowserEmailReauthentication("session_management", {
      continuation: "mfa_management",
    });
    expect(JSON.parse(harness.localStorage.get("pintPathAuthFlow") || "{}"))
      .toMatchObject({
        reauthPurpose: "session_management",
        continuation: "mfa_management",
      });

    await expect(harness.helpers.beginBrowserEmailReauthentication("account_export", {
      continuation: "mfa_management",
    })).rejects.toThrow("continuation is not supported");
  });

  it("purpose-syncs an email OTP without replacing the account's durable OAuth login method", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const harness = loadBusinessAuthHarness({
      sessionEmail: "oauth-member@example.com",
      sessionProvider: "email",
      accessToken: unsignedAccessToken({
        sub: "provider-user-1",
        session_id: "email-otp-session",
        amr: [{ method: "otp", timestamp: nowSeconds }],
        auth_time: nowSeconds,
      }),
    });
    harness.helpers.setAccountContext(
      {
        id: "account-1",
        email: "oauth-member@example.com",
        authProvider: "supabase",
        role: "user",
        status: "active",
      },
      { authIdentityProvider: "google" },
    );

    await harness.helpers.syncSupabaseSession({
      credentialCeremony: "browser_email_otp_v1",
      reauthPurpose: "account_export",
    });

    expect(harness.requests.find((request) => request.path === "/api/business/auth/supabase-session")?.body)
      .toMatchObject({
        credentialCeremony: "browser_email_otp_v1",
        reauthPurpose: "account_export",
      });
    expect(harness.helpers.getAccountContext()?.authIdentityProvider).toBe("google");
    expect(harness.passwordSignIns).toEqual([]);
    expect(harness.oauthSignIns).toEqual([]);

    await harness.helpers.syncSupabaseSession({
      reauthPurpose: "session_management",
      preserveAuthIdentityProvider: true,
    });
    expect(harness.helpers.getAccountContext()?.authIdentityProvider).toBe("google");
  });

  it("clears an unauthenticated stale app cookie before normal provider sync but never before purpose sync", async () => {
    const normalHarness = loadBusinessAuthHarness({ existingAppSession: false });
    await normalHarness.helpers.syncSupabaseSession();
    expect(normalHarness.requests.map((request) => request.path)).toEqual([
      "/api/business/auth/session",
      "/api/business/auth/logout",
      "/api/business/auth/supabase-session",
    ]);

    const purposeHarness = loadBusinessAuthHarness({ existingAppSession: false });
    await purposeHarness.helpers.syncSupabaseSession({ reauthPurpose: "account_export" });
    expect(purposeHarness.requests.map((request) => request.path)).toEqual([
      "/api/business/auth/supabase-session",
    ]);
  });

  it("never caches a purpose-bound browser cookie beyond the provider AMR ceremony", () => {
    const helpers = loadBusinessHelpers();
    const now = Date.UTC(2026, 7, 15, 0, 0, 0);
    const credentialTimeSeconds = Math.floor((now - 5 * 60_000) / 1000);
    const token = unsignedAccessToken({
      amr: [{ method: "password", timestamp: credentialTimeSeconds }],
    });

    expect(helpers.browserReauthenticationExpiryForAccessToken(token, now)).toBe(
      credentialTimeSeconds * 1000 + 14 * 60_000,
    );
    expect(helpers.browserReauthenticationExpiryForAccessToken(unsignedAccessToken({
      amr: ["oauth"],
      auth_time: credentialTimeSeconds,
    }), now)).toBe(credentialTimeSeconds * 1000 + 14 * 60_000);
    expect(helpers.browserReauthenticationExpiryForAccessToken("not-a-jwt", now)).toBeNull();
  });

  it("invalidates memory-only provider sessions across tabs on logout generation broadcasts", async () => {
    TestBroadcastChannel.channels.clear();
    const values = new Map<string, string>();
    const sharedLocalStorage: BrowserStorageFixture = {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      key: (index) => Array.from(values.keys())[index] || null,
      get length() {
        return values.size;
      },
    };
    const firstTab = loadCrossTabAuthHarness(sharedLocalStorage);
    const secondTab = loadCrossTabAuthHarness(sharedLocalStorage);
    firstTab.helpers.setAccountContext({ id: "account-1", authProvider: "supabase" });
    secondTab.helpers.setAccountContext({ id: "account-1", authProvider: "supabase" });
    await firstTab.helpers.setSupabaseMemorySession({ access_token: "access-a", refresh_token: "refresh-a" });
    await secondTab.helpers.setSupabaseMemorySession({ access_token: "access-b", refresh_token: "refresh-b" });

    firstTab.helpers.broadcastAuthInvalidation("logout");

    expect(secondTab.helpers.getAccountContext()).toBeNull();
    expect(secondTab.signOutCalls).toContainEqual({ scope: "local" });
    await expect(secondTab.auth.getSession()).resolves.toMatchObject({ data: { session: null } });
    expect(JSON.parse(values.get("pintPathAuthInvalidationGeneration") || "{}")).toMatchObject({
      id: "cross-tab-id",
      reason: "logout",
    });
  });

  it("isolates private browser storage when accounts change on a shared device", () => {
    const helpers = loadBusinessHelpers();

    helpers.setAccountContext({ id: "account-a", role: "user", status: "active" });
    expect(helpers.setAccountScopedStorage("pintPathDraft", "draft-a")).toBe("pintPathDraft:account:account-a");
    expect(helpers.getAccountScopedStorage("pintPathDraft")).toBe("draft-a");

    helpers.setAccountContext({ id: "account-b", role: "user", status: "active" });
    expect(helpers.getAccountScopedStorage("pintPathDraft")).toBeNull();
    helpers.setAccountScopedStorage("pintPathDraft", "draft-b");
    expect(helpers.getAccountScopedStorageKey("pintPathDraft", "account-a")).toBe("pintPathDraft:account:account-a");

    helpers.setAccountContext({ id: "account-a", role: "user", status: "active" });
    expect(helpers.getAccountScopedStorage("pintPathDraft")).toBe("draft-a");
  });

  it("clears account-scoped private submission data when deletion is requested", async () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({ id: "account-delete", role: "user", status: "active" });
    helpers.setAccountScopedStorage("pintPathUploadLocationProof", "exact-location");
    helpers.setAccountScopedStorage("pintPathSubmitDraft", "private-draft");
    helpers.setAccountScopedStorage("pintPathQueuedSubmissions", "private-evidence");

    await helpers.clearLocalSubmissionDeviceData("account-delete");

    expect(helpers.getAccountScopedStorage("pintPathUploadLocationProof")).toBeNull();
    expect(helpers.getAccountScopedStorage("pintPathSubmitDraft")).toBeNull();
    expect(helpers.getAccountScopedStorage("pintPathQueuedSubmissions")).toBeNull();
  });

  it("keeps normal logout device-local while preserving explicit all-device revocation", () => {
    const html = accountHtml();
    const business = businessJs();

    expect(html).toContain('getSupabaseClient()?.auth.signOut({ scope: "local" })');
    expect(html).not.toContain("getSupabaseClient()?.auth.signOut();");
    expect(business).toContain('client.auth.signOut({ scope: "global" })');
  });

  it("keeps privacy controls truthful and prevents contradictory venue-insight consent", () => {
    const html = accountHtml();

    expect(html).toContain("function syncVenueReportConsentDependency");
    expect(html).toContain("form.venueReportInclusionEnabled.checked = false");
    expect(html).toContain("form.venueReportInclusionEnabled.disabled = !optionalAnalyticsEnabled");
    expect(html).toContain("venueReportInclusionEnabled: optionalAnalyticsEnabled &&");
    expect(html).not.toContain('name="productResearchEnabled"');
    expect(html).not.toContain('name="emailUpdatesEnabled"');
    expect(html).toContain("does not currently use account feedback for a separate research programme or send marketing/product-update email");
  });

  it("keeps venue-manager navigation in the same order with venue links added", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({
      id: "venue-user-1",
      role: "venue_manager",
      status: "active",
      email: "venue@example.com",
    }, { isAdmin: false, accountRole: "venue_manager" });
    const nav = helpers.renderNav("account");

    expect(navLinkLabels(nav)).toEqual(["Map", "Dashboard", "Submit", "Missions", "Pricing", "FAQ", "Account", "Contact us"]);
    expect(navLinkLabels(helpers.renderNav("venue-portal"))).toEqual(navLinkLabels(nav));
    expect(navLinkLabels(helpers.renderNav("venue-support"))).toEqual(navLinkLabels(nav));
    expect(nav).toContain('class="pill" aria-current="page" href="/account.html">Account</a>');
  });

  it("keeps active counter staff able to return to their scoped venue tools", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({ id: "counter-1", role: "user", status: "active" }, {
      isAdmin: false,
      accountRole: "user",
      counterStaffAssignments: [{
        venueId: "venue-1",
        venueName: "Test Pub",
        portalPath: "/venue-portal.html?venueId=venue-1&tab=redemption",
        capabilities: { openCounter: true },
      }],
    });

    const nav = helpers.renderNav("account");
    expect(navLinkLabels(nav)).toContain("Counter");
    expect(nav).toContain('href="/venue-portal.html?venueId=venue-1&amp;tab=redemption"');
  });

  it("keeps mixed manager and counter accounts on the full venue dashboard", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({ id: "mixed-manager-1", role: "venue_manager", status: "active" }, {
      isAdmin: false,
      accountRole: "venue_manager",
      counterStaffAssignments: [{
        venueId: "counter-venue-1",
        venueName: "Counter Venue",
        portalPath: "/venue-portal.html?venueId=counter-venue-1&tab=redemption",
        capabilities: { openCounter: true },
      }],
    });

    const nav = helpers.renderNav("account");
    expect(navLinkLabels(nav)).toContain("Dashboard");
    expect(navLinkLabels(nav)).not.toContain("Counter");
    expect(nav).toContain('href="/venue-portal.html">Dashboard</a>');
  });

  it("keeps mixed admin and counter accounts on the full venue dashboard", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({ id: "mixed-admin-1", role: "admin", status: "active" }, {
      isAdmin: true,
      isAdminAccount: true,
      accountRole: "admin",
      counterStaffAssignments: [{
        venueId: "counter-venue-1",
        venueName: "Counter Venue",
        portalPath: "/venue-portal.html?venueId=counter-venue-1&tab=redemption",
        capabilities: { openCounter: true },
      }],
    });

    const nav = helpers.renderNav("account");
    expect(navLinkLabels(nav)).toContain("Dashboard");
    expect(navLinkLabels(nav)).not.toContain("Counter");
    expect(nav).toContain('href="/venue-portal.html">Dashboard</a>');
  });

  it("keeps the admin page in the same nav with Admin highlighted", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext(
      { id: "admin-user-1", role: "admin", status: "active" },
      { isAdmin: true, isAdminAccount: true },
    );
    const nav = helpers.renderNav("admin");

    expect(navLinkLabels(nav)).toEqual(["Map", "Dashboard", "Submit", "Missions", "Admin", "Pricing", "FAQ", "Account", "Contact us"]);
    expect(nav).toContain('class="pill" aria-current="page" href="/admin.html">Admin</a>');
  });

  it("identifies the current admin page before account authority hydrates", () => {
    const helpers = loadBusinessHelpers();
    const nav = helpers.renderNav("admin");

    expect(navLinkLabels(nav)).toEqual(["Map", "Submit", "Missions", "Admin", "Pricing", "FAQ", "Account", "Contact us"]);
    expect(nav).toContain('class="pill" aria-current="page" href="/admin.html">Admin</a>');
    expect(navLinkLabels(helpers.renderNav("account"))).not.toContain("Admin");
  });

  it("shows the venue dashboard link to admins without changing bar-audience labels", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({
      id: "admin-user-1",
      role: "admin",
      status: "active",
      subscriptionStatus: "admin",
    }, { isAdmin: true, isAdminAccount: true, accountRole: "admin" });
    const nav = helpers.renderNav("account");

    expect(navLinkLabels(nav)).toEqual(["Map", "Dashboard", "Submit", "Missions", "Admin", "Pricing", "FAQ", "Account", "Contact us"]);
    expect(nav).toContain('href="/venue-portal.html">Dashboard</a>');
    expect(nav).toContain('href="/trust.html">FAQ</a>');
    expect(nav).toContain('href="/feedback.html">Contact us</a>');
  });

  it("keeps Admin in the quick bar when an admin account needs authority step-up", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({
      id: "admin-step-up-1",
      role: "admin",
      status: "active",
      subscriptionStatus: "admin",
    }, {
      accountRole: "admin",
      isAdminAccount: true,
      isAdmin: false,
    });

    const nav = helpers.renderNav("account");
    expect(navLinkLabels(nav)).toContain("Admin");
    expect(nav).toContain('href="/admin.html">Admin</a>');
    expect(navLinkLabels(nav)).not.toContain("Dashboard");
  });

  it("never grants stale persisted authority while keeping the current admin page identifiable", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({
      id: "stale-admin",
      role: "admin",
      status: "active",
      subscriptionStatus: "admin",
    });
    expect(navLinkLabels(helpers.renderNav("account"))).not.toContain("Admin");
    expect(navLinkLabels(helpers.renderNav("account"))).not.toContain("Dashboard");

    helpers.setAccountContext({
      id: "stale-admin",
      role: "admin",
      status: "active",
      subscriptionStatus: "admin",
    }, { isAdmin: false, accountRole: "admin" });
    const currentAdminNav = helpers.renderNav("admin");
    expect(navLinkLabels(currentAdminNav)).toContain("Admin");
    expect(currentAdminNav).toContain('aria-current="page" href="/admin.html">Admin</a>');
    expect(navLinkLabels(helpers.renderNav("venue-portal"))).not.toContain("Dashboard");

    helpers.setAccountContext({
      id: "stale-admin",
      role: "admin",
      status: "active",
      subscriptionStatus: "admin",
    }, { isAdmin: true, accountRole: "admin" });
    expect(navLinkLabels(helpers.renderNav("account"))).toEqual(expect.arrayContaining(["Dashboard", "Admin"]));
  });

  it("keeps potential partner leads compact on the admin page", () => {
    const html = adminHtml();
    const css = businessCss();

    expect(html).toContain('id="partnerLeads" class="list partnerLeadList"');
    expect(html).toContain('class="listItem partnerLeadList__item"');
    expect(css).toContain("max-height: calc((var(--partner-lead-row-height) * 5) + (12px * 4));");
    expect(css).toContain("overflow-y: auto;");
    expect(css).toContain("overscroll-behavior: contain;");
  });

  it("labels mixed package availability as cans or bottles in admin review", () => {
    const html = adminHtml();

    expect(html).toContain('<option value="cans_or_bottles">Cans or bottles</option>');
    expect(html).toContain('unavailableReason: "cans_or_bottles"');
  });

  it("groups the admin page into clear workflow sections without removing tools", () => {
    const html = adminHtml();
    const css = businessCss();
    const sectionOrder = [
      'id="adminReview"',
      'id="adminCapture"',
      'id="adminPartners"',
      'id="adminLeaderboard"',
      'id="adminAnalytics"',
    ];
    const requiredAdminControls = [
      'id="adminTodayQueue"',
      'id="adminActiveSectionLabel"',
      'id="adminLoadSummary"',
      'id="refreshAdminPageButton"',
      'id="adminFocusRail"',
      'id="adminHealthPanel"',
      'id="pendingSubmissions"',
      'id="pendingBarChanges"',
      'id="reviewQueues"',
      'id="adminCaptureMetrics"',
      'id="adminVenueSearch"',
      'id="adminCreateVenueForm"',
      'id="adminSourceQueueForm"',
      'id="adminIngestionQueue"',
      'id="adminIngestionPager"',
      'id="adminIngestionPrevPage"',
      'id="adminIngestionPageStatus"',
      'id="adminIngestionNextPage"',
      'id="venueInterestRequests"',
      'id="venueManagerAssignments"',
      'id="managerAssignForm"',
      'id="outreachForm"',
      'id="pitchReadinessPanel"',
      'id="pitchReadinessList"',
      'id="outreachPipelineSummary"',
      'id="outreachPipelineBoard"',
      'id="venueOutreachList"',
      'id="leaderboardPrizeForm"',
      'id="adminLeaderboardPodium"',
      'id="adminLeaderboardEntries"',
      'id="adminLeaderboardAwards"',
      'id="adminLeaderboardVouchers"',
      'id="headlineMetrics"',
      'id="retentionCohorts"',
      'id="coverageDashboard"',
      'id="demandSignals"',
      'id="partnerLeads"',
      'id="reviewDecisionDialog"',
    ];
    expect(html).toContain("Restore rehearsal");
    expect(html).toContain("Private evidence opens as a secure download for review.");
    expect(html).toContain("Open or download PDF menu");
    expect(html).not.toContain('<iframe src="${signedUrl}"');
    expect(css).toContain(".adminSubmissionEvidencePreview__pdfTile");
    expect(html).toContain('operationalStatus("job:restore_rehearsal"');

    expect(html).toContain('class="adminJumpNav" role="tablist" aria-label="Admin workflow sections"');
    expect(html).toContain('data-admin-tab-target="review" aria-controls="adminReview" aria-selected="false"');
    expect(html).toContain('data-admin-tab-target="capture" aria-controls="adminCapture" aria-selected="false"');
    expect(html).toContain('data-admin-tab-target="partners" aria-controls="adminPartners" aria-selected="false"');
    expect(html).toContain('data-admin-tab-target="leaderboard" aria-controls="adminLeaderboard" aria-selected="false"');
    expect(html).toContain('data-admin-tab-target="analytics" aria-controls="adminAnalytics" aria-selected="false"');
    expect(html).toContain('data-admin-tab-panel="review" role="tabpanel" hidden');
    expect(html).toContain('data-admin-tab-panel="capture" role="tabpanel" hidden');
    expect(html).toContain('data-admin-tab-panel="partners" role="tabpanel" hidden');
    expect(html).toContain('data-admin-tab-panel="leaderboard" role="tabpanel" hidden');
    expect(html).toContain('data-admin-tab-panel="analytics" role="tabpanel" hidden');
    expect(html).toContain("function showAdminTab");
    expect(html).toContain("function renderAdminFocusRail");
    expect(html).toContain("function adminJumpAttributes");
    expect(html).toContain("function refreshAdminPage");
    expect(html).toContain('data-transition-reward-voucher="fulfill"');
    expect(html).toContain('data-transition-reward-voucher="void"');
    expect(html).toContain('data-copy-voucher-reference="${escapeHtml(voucher.claimReference)}"');
    expect(html).toContain("/api/business/admin/reward-vouchers/${encodeURIComponent(voucherId)}/transition");
    expect(html).toContain("function openReviewDecision");
    expect(html).toContain("function promptSubmissionReview");
    expect(html).toContain("function isPhotoEvidenceOnlySubmission");
    expect(html).toContain("Approve evidence only");
    expect(html).toContain("will not publish live beer prices");
    expect(html).toContain("Evidence-only upload approved; no live beer rows were published.");
    expect(html).toContain("function promptQueuedIngestionReview");
    expect(html).toContain("function renderCrawlerDetails");
    expect(html).toContain("function crawlerFeedbackPill");
    expect(html).toContain("function copyTextToClipboard");
    expect(html).toContain('data-source-url-value');
    expect(html).toContain('data-copy-source-url');
    expect(html).toContain("ADMIN_INGESTION_PAGE_SIZE = 12");
    expect(html).toContain("offset: String(adminIngestionOffset)");
    expect(html).toContain("showing ${pageStart}-${pageEnd} of ${adminIngestionTotal}");
    expect(html).toContain("function moveAdminIngestionPage");
    expect(html).toContain('<option value="pending_review">Pending</option>');
    expect(html).toContain('params.set("status", adminIngestionStatus.value);');
    expect(html).toContain("Source ingestion published. ${mapRows} live map row");
    expect(html).toContain('adminIngestionStatus.value = "pending_review";');
    expect(html).toContain("await loadAdminIngestionQueue({ resetPage: true });");
    expect(html).toContain("Load next 12");
    expect(html).toContain("function prefillOutreachFromLead");
    expect(html).toContain("function renderOutreachPipeline");
    expect(html).toContain("function updateOutreachStage");
    expect(html).toContain("function renderPitchReadiness");
    expect(html).toContain("function renderAdminLeaderboardPrizes");
    expect(html).toContain("function handleLeaderboardPrizeFinalize");
    expect(html).toContain("function openLeadCapture");
    expect(html).toContain('class="adminSourceReviewLayout"');
    expect(html).toContain('class="adminCrawlerRewardHint"');
    expect(html).toContain('data-prefill-lead');
    expect(html).toContain('data-prep-pitch');
    expect(html).toContain('data-capture-lead');
    expect(html).toContain('name="tierFit"');
    expect(html).toContain('name="nextAction"');
    expect(html).toContain('name="lastContactedAt"');
    expect(html).toContain('document.querySelectorAll("[data-admin-tab-target]")');
    expect(html).toContain('metricCard${options.target ? " metricCard--button" : ""}');
    expect(html).toContain('renderMetric("Pending approvals", metrics.totalPendingSubmissions, { target: "review", selector: "#pendingSubmissions"');
    expect(html).toContain('renderMetric("Submissions today", metrics.totalSubmissionCompletions || 0, { target: "review", selector: "#pendingSubmissions"');
    expect(html).toContain('label: "Source queue",');
    expect(html).toContain('selector: "#adminIngestionQueue"');
    expect(html).toContain('wireAdminJumpActions(panel);');
    sectionOrder.forEach((section, index) => {
      expect(html).toContain(section);
      if (index > 0) {
        expect(html.indexOf(sectionOrder[index - 1])).toBeLessThan(html.indexOf(section));
      }
    });
    requiredAdminControls.forEach((control) => expect(html).toContain(control));
    expect(css).toContain(".adminWorkbench");
    expect(css).toContain(".adminUtilityBar");
    expect(css).toContain(".adminFocusRail");
    expect(css).toContain(".adminSection");
    expect(css).toContain(".adminJumpNav");
    expect(css).toContain(".adminTabButton");
    expect(css).toContain(".adminGrid--two");
    expect(css).toContain(".adminCommandCard");
    expect(css).toContain(".metricCard--button");
    expect(css).toContain(".adminReviewActionBar");
    expect(css).toContain(".adminCrawlerDetails");
    expect(css).toContain(".adminCrawlerRewardHint");
    expect(css).toContain(".adminSourceReviewLayout");
    expect(css).toContain(".adminSourceEvidence__urlField");
    expect(css).toContain(".adminSourceEvidence__urlInput");
    expect(css).toContain(".adminSourceEvidence__actions");
    expect(css).toContain(".adminQueueBeerRows .adminBeerRow");
    expect(css).toContain(".adminIngestionPager");
    expect(css).toContain(".pitchReadinessGrid");
    expect(css).toContain(".pitchReadinessChecklist");
    expect(css).toContain(".outreachPipelineBoard");
    expect(css).toContain(".outreachPipelineLane");
    expect(css).toContain(".outreachPipelineCard");
    expect(css).toContain(".reviewDecisionDialog");
  });

  it("requires confirm password and keeps signup consent text readable", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain("Confirm password");
    expect(html).toContain('name="confirmPassword"');
    expect(html).toContain('name="termsAccepted"');
    expect(html).toContain('name="privacyAccepted"');
    expect(html).toContain("Terms and Conditions");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Passwords do not match.");
    expect(html).toContain("Confirm you are 18+ and accept the Terms and Privacy Policy to create an account.");
    expect(html).toContain("Unique public name.");
    expect(html).toContain("No disrespectful, racist, hateful, rude");
    expect(html).toContain("validateDisplayNameClient(body.displayName)");
    expect(html).toContain('id="signupPanel" class="authPanelStack"');
    expect(html).toContain('class="authFields"');
    expect(html).toContain('class="field consentField" role="group" aria-label="Account consent"');
    expect(html).toContain('<label class="consentLine"><input name="ageConfirmed"');
    expect(html).toContain('<label class="consentLine"><input name="termsAccepted"');
    expect(html).toContain('<label class="consentLine"><input name="privacyAccepted"');
    expect(html).toContain('authParams.get("supabaseAuth") !== "1"');
    expect(css).toContain('.field input[type="checkbox"]');
    expect(css).toContain(".authPanelStack");
    expect(css).toContain(".authFields");
    expect(css).toContain(".authActions");
    expect(css).toContain("padding-right: 86px");
    expect(css).toContain("position: absolute");
    expect(css).toContain("grid-template-columns: 18px minmax(0, 1fr)");
    expect(css).toContain("font-size: clamp(42px, 5vw, 64px)");
  });

  it("keeps signup telemetry and post-signup sync failures from trapping users on Load failed", () => {
    const html = accountHtml();
    const script = businessJs();

    expect(html).toContain('trackEvent("signup_started", { source: "account_page" }).catch(() => null)');
    expect(html).toContain("We could not finish account creation.");
    expect(html).toContain("result.message ||");
    expect(script).toContain("Account created and confirmation requested.");
    expect(script).toContain("}).catch(() => null)");
  });

  it("resets OAuth loading buttons when a provider flow is cancelled", () => {
    const html = accountHtml();

    expect(html).toContain("oauthLoginOpening: false");
    expect(html).toContain("oauthPopupActive: false");
    expect(html).toContain("function setOauthButtonsLoading");
    expect(html).toContain("function resetCancelledOauth");
    expect(html).toContain("if (!state.oauthLoginOpening || state.oauthPopupActive)");
    expect(html).toContain("state.oauthPopupActive = true;");
    expect(html).toContain("state.oauthPopupActive = false;");
    expect(html).toContain("MelbBeerBusiness.clearPendingLegalAcceptance();");
    expect(html).toContain("Secure Google login was cancelled. Try again when you are ready.");
    expect(html).toContain('window.addEventListener("pageshow", () => resetCancelledOauth())');
    expect(html).toContain('window.addEventListener("focus", () => resetCancelledOauth())');
  });

  it("has a dedicated Supabase auth callback that exchanges the session and redirects safely", () => {
    const html = callbackHtml();

    expect(html).toContain("Finishing your Pint Path login");
    expect(html.match(/exchangeCodeForSession\(/g)).toHaveLength(1);
    expect(html).toContain("callbackFlowState = MelbBeerBusiness.peekAuthFlowState()");
    expect(html).toContain('callbackFlowState?.kind !== "oauth"');
    expect(html).toContain("callbackFlowNonce = callbackFlowState?.nonce || MelbBeerBusiness.createAuthFlowNonce()");
    expect(html).not.toContain("callbackFlowNonce = isRecoveryResult");
    expect(html).toContain("MelbBeerBusiness.setSupabaseMemorySession(");
    expect(html).toContain("data.session.refresh_token");
    expect(html).toContain("authFlowNonce: callbackAuthFlowNonce()");
    expect(html).toContain("authFlowNonce,");
    expect(html).toContain("MelbBeerBusiness.clearPendingLegalAcceptance()");
    expect(html).toContain("MelbBeerBusiness.getSafeReturnPath");
    expect(html).toContain('id="callbackAcceptanceForm"');
    expect(html).toContain('id="callbackCancelButton"');
    expect(html).toContain('auth.signOut({ scope: "local" })');
    expect(html).toContain('MelbBeerBusiness.apiFetch("/api/business/auth/logout"');
    expect(html).toContain("MelbBeerBusiness.setAccountContext(null)");
    expect(html).toContain("Sign-in cancelled. No policy choices were saved.");
    expect(html).toContain("function showCallbackSessionClearFailure");
    expect(html).toContain("could not confirm that the browser session cookie was cleared");
    expect(html).not.toContain('}).catch(() => null);\n      const clients = [');
    expect(html).toContain("function needsFirstAccountAcceptance");
    expect(html).toContain("showCallbackAcceptance();");
    expect(html).toContain("MelbBeerBusiness.setPendingLegalAcceptanceForCurrentSession({");
    expect(html).toContain("error?.legalAcceptanceMismatch === true");
    expect(html).toContain("editable provider profile metadata as consent");
    expect(html).toContain('returnPath.startsWith("/reset-password.html")');
    expect(html).toContain('result.account?.role === "venue_manager"');
    expect(html).toContain("MelbBeerBusiness.isVenuePortalReturnPath(venueReturnPath)");
    expect(html).toContain("MelbBeerBusiness.consumeSensitiveAuthReturnPath()");
    expect(html).toContain("function scrubCallbackCredentials");
    expect(html).toContain("pintpath:oauth-session");
    expect(html).toContain('callbackFlowState?.kind === "browser_email_reauthentication"');
    expect(html).toContain('credentialCeremony: "browser_email_otp_v1"');
    expect(html).toContain('["magiclink", "email"].includes(callbackType)');
    expect(html).toContain("await MelbBeerBusiness.setSupabaseMemorySession(callbackProviderSession)");
    const liveCallbackSession = htmlBetween(
      html,
      "async function currentCallbackProviderSession",
      "function setCallbackBillingRecoveryTargets",
    );
    expect(liveCallbackSession).toContain("MelbBeerBusiness.getLiveSupabaseProviderSession(");
    expect(liveCallbackSession).not.toContain("return callbackProviderSession");
    const popupCompletion = htmlBetween(
      html,
      "async function finishCallbackLogin",
      'window.addEventListener("DOMContentLoaded"',
    );
    expect(popupCompletion).toContain("const liveProviderSession = await currentCallbackProviderSession()");
    expect(popupCompletion).toContain("accessToken: liveProviderSession.access_token");
    expect(popupCompletion).toContain("refreshToken: liveProviderSession.refresh_token");
    expect(popupCompletion).not.toContain("accessToken: callbackProviderSession.access_token");
    expect(html).toContain('id="callbackPasswordRecoveryForm"');
    expect(html).toContain('window.history.replaceState({}, "", "/reset-password.html?mode=update")');
    expect(html).not.toContain("If this takes more than a moment");
    expect(html).not.toContain("service_role");

    const callbackCleanupIndex = html.lastIndexOf("MelbBeerBusiness.clearSupabaseOAuthFlowStorage();");
    expect(callbackCleanupIndex).toBeGreaterThan(
      html.indexOf('throw new Error("No secure sign-in result was returned.'),
    );
    expect(callbackCleanupIndex).toBeLessThan(html.lastIndexOf("await finishCallbackLogin(callbackAuthFlowNonce())"));
  });

  it("finishes email-OTP logout-all in the callback without a redirect or provider-session leak", () => {
    const html = callbackHtml();
    const logoutContinuation = htmlBetween(
      html,
      "async function continueCallbackLogoutAll",
      "async function confirmCallbackMfaEnrollment",
    );

    expect(logoutContinuation).toContain("const liveProviderSession = await currentCallbackProviderSession()");
    expect(logoutContinuation).toContain('MelbBeerBusiness.apiFetch("/api/business/auth/logout-all"');
    expect(logoutContinuation).toContain("{ accessToken: liveProviderSession.access_token }");
    expect(logoutContinuation).not.toContain("sensitiveApiFetch");
    expect(logoutContinuation).toContain("result?.providerSessionsRevoked === false");
    expect(logoutContinuation).toContain("await clearCallbackProviderMemoryAfterLogout()");
    expect(htmlBetween(
      html,
      "async function clearCallbackProviderMemoryAfterLogout",
      "async function continueCallbackLogoutAll",
    )).toContain('broadcastAuthInvalidation?.("logout_all")');
    expect(logoutContinuation).toContain("Retry log out all sessions");
    expect(logoutContinuation).not.toContain("replaceWithSafeReturnPath");
    expect(logoutContinuation).not.toContain("window.location");
    expect(html).toContain('const hasCallbackLocalContinuation = sensitiveEmailPurpose === "logout_all"');
  });

  it("keeps first-factor authenticator enrollment in the email callback and never broadcasts its provider token", () => {
    const html = callbackHtml();
    const sessionContinuation = htmlBetween(
      html,
      "async function continueCallbackSessionManagement",
      "function showSensitiveEmailContinuationFailure",
    );
    const enrollmentVerification = htmlBetween(
      html,
      "async function confirmCallbackMfaEnrollment",
      "async function continueCallbackSessionManagement",
    );
    const callbackCompletion = htmlBetween(
      html,
      "async function finishCallbackLogin",
      'window.addEventListener("DOMContentLoaded"',
    );

    expect(sessionContinuation).toContain("await currentCallbackProviderSession()");
    expect(sessionContinuation).toContain("client.auth.mfa.listFactors()");
    expect(sessionContinuation).toContain("client.auth.mfa.unenroll({ factorId: factor.id })");
    expect(sessionContinuation).toContain("client.auth.mfa.enroll({");
    expect(sessionContinuation).toContain('factorType: "totp"');
    expect(sessionContinuation).toContain("callbackMfaEnrollmentFactorId = enrollment.id");
    expect(sessionContinuation).toContain("no authenticator change was made");
    expect(sessionContinuation).not.toContain("replaceWithSafeReturnPath");
    expect(enrollmentVerification).toContain("client.auth.mfa.challengeAndVerify({ factorId, code })");
    expect(enrollmentVerification).toContain('reauthPurpose: "session_management"');
    expect(enrollmentVerification).toContain("preserveAuthIdentityProvider: true");
    expect(enrollmentVerification).toContain("await currentCallbackProviderSession()");
    expect(enrollmentVerification).not.toContain("sendPopupBridgeMessage");
    expect(enrollmentVerification).not.toContain("BroadcastChannel");
    expect(callbackCompletion.indexOf('emailReauthenticationPurpose === "session_management"'))
      .toBeLessThan(callbackCompletion.indexOf("if (callbackPopupState)"));
    expect(callbackCompletion).toContain('callbackFlowState?.continuation === "mfa_management"');
    expect(callbackCompletion).not.toContain('if (emailReauthenticationPurpose === "session_management") {');
    expect(html).toContain('{ reauthPurpose: callbackPopupState.purpose }');
    expect(html).toContain('callbackFlowState?.kind === "browser_email_reauthentication"\n        ? null');
  });

  it("keeps email signup acceptance through immediate, confirmed-email, and cross-device flows", () => {
    const script = businessJs();
    const callback = callbackHtml();

    expect(script.indexOf("expectedEmail: String(email || \"\").trim().toLowerCase()")).toBeLessThan(script.indexOf("client.auth.signUp({"));
    expect(script).toContain("const synced = await syncSupabaseSession({ applyPendingLegalAcceptance: true, authFlowNonce });");
    expect(script).toContain("needsEmailConfirmation: true");
    expect(script).toContain("Date.now() - createdAt > LEGAL_ACCEPTANCE_MAX_AGE_MS");
    expect(script).toContain("Signup acceptance did not match this signed-in identity.");
    expect(callback).toContain("Your signup acceptance was missing or expired on this device.");
    expect(callback).toContain("[403, 409].includes(Number(error?.status))");
    expect(callback).toContain("callbackFlowState?.nonce");
    expect(callback).toContain("MelbBeerBusiness.peekAuthFlowState()");
    expect(callback).toContain("Accept and finish account");
  });

  it("sends server-verified legal acceptance on immediate Supabase email signup", async () => {
    const harness = loadBusinessAuthHarness();
    const result = await harness.helpers.signUpWithEmail(
      "new@example.com",
      "safe-password",
      true,
      true,
      true,
      "New User",
    );

    expect(result.needsEmailConfirmation).toBe(false);
    const syncRequest = harness.requests.find((request) => request.path === "/api/business/auth/supabase-session");
    expect(syncRequest?.body).toMatchObject({
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "2026-07-20",
      privacyVersion: "2026-07-20",
    });
    expect(harness.signups[0]).not.toHaveProperty("options.data.age_confirmed");
    expect(harness.signups[0]).not.toHaveProperty("options.data.terms_accepted");
    expect(harness.signups[0]).toHaveProperty(
      "options.emailRedirectTo",
      "https://pintpath.au/auth/callback",
    );
    expect(harness.localStorage.has("pintPathLegalAcceptance")).toBe(false);
  });

  it("starts provider OAuth with one exact PKCE callback and browser-bound return state", async () => {
    const harness = loadBusinessAuthHarness();
    await harness.helpers.signInWithOAuth("google", { returnTo: "/submit.html" });

    expect(harness.oauthSignIns).toHaveLength(1);
    expect(harness.oauthSignIns[0]).toMatchObject({
      provider: "google",
      options: {
        redirectTo: "https://pintpath.au/auth/callback",
        scopes: "email profile",
      },
    });
    expect(harness.createdClientOptions).toHaveLength(1);
    expect(harness.createdClientOptions[0]).toMatchObject({
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: "",
      },
    });
    expect(harness.createdClientOptions[0]).toHaveProperty("auth.storage.getItem", expect.any(Function));
    expect(harness.createdClientOptions[0]).toHaveProperty("auth.storage.setItem", expect.any(Function));
    expect(JSON.parse(harness.localStorage.get("pintPathAuthFlow") || "{}")).toMatchObject({
      nonce: "test-uuid",
      returnTo: "/submit.html",
      kind: "oauth",
    });
    expect(JSON.parse(harness.localStorage.get("pintPathAuthFlow") || "{}")).not.toHaveProperty("provider");

    await harness.helpers.signInWithOAuth("google", {
      returnTo: "/account.html",
      reauthPurpose: "billing_portal",
    });
    expect(JSON.parse(harness.localStorage.get("pintPathAuthFlow") || "{}")).toMatchObject({
      kind: "oauth",
      reauthPurpose: "billing_portal",
    });
    expect(callbackHtml()).toContain("callbackFlowState?.reauthPurpose");
    expect(businessJs()).toContain("!accessToken && !hasCurrentBrowserReauthenticationPurpose(purpose)");
  });

  it("clears consent when Supabase rejects email signup or OAuth before redirect", async () => {
    const signupHarness = loadBusinessAuthHarness({ signupError: "Signup rejected" });
    await expect(signupHarness.helpers.signUpWithEmail(
      "new@example.com",
      "safe-password",
      true,
      true,
      true,
      null,
    )).rejects.toThrow("Signup rejected");
    expect(signupHarness.localStorage.has("pintPathLegalAcceptance")).toBe(false);

    const oauthHarness = loadBusinessAuthHarness({ oauthError: "Provider rejected" });
    await expect(oauthHarness.helpers.signInWithOAuth("google", {
      returnTo: "/account.html",
      legalAcceptance: { ageConfirmed: true, termsAccepted: true, privacyAccepted: true },
    })).rejects.toThrow("Provider rejected");
    expect(oauthHarness.localStorage.has("pintPathLegalAcceptance")).toBe(false);
    expect(oauthHarness.localStorage.has("pintPathAuthFlow")).toBe(false);
  });

  it("does not persist auth return state when signup consent is incomplete", async () => {
    const harness = loadBusinessAuthHarness();

    await expect(harness.helpers.signUpWithEmail(
      "new@example.com",
      "safe-password",
      false,
      true,
      true,
    )).rejects.toThrow("Confirm you are 18+");

    expect(harness.localStorage.has("pintPathAuthFlow")).toBe(false);
    expect(harness.localStorage.has("pintPathAuthReturnTo")).toBe(false);
  });

  it("canonicalises the www host before origin-bound PKCE state can be created", () => {
    const source = appSource();

    expect(source).toContain("shouldRedirectToCanonicalHost(canonicalHost, requestHost)");
    expect(source).toContain("buildCanonicalHostRedirectUrl(publicBaseUrl.origin, req.originalUrl)");
    expect(source.indexOf("shouldRedirectToCanonicalHost(canonicalHost, requestHost)")).toBeLessThan(
      source.indexOf("res.locals.cspNonce"),
    );
  });

  it("rejects crossed email, callback nonce, and provider consent before any server sync", async () => {
    const cases = [
      {
        name: "email",
        harness: loadBusinessAuthHarness({ sessionEmail: "other@example.com", sessionProvider: "email" }),
        acceptance: { expectedEmail: "victim@example.com", expectedProvider: "email", authFlowNonce: "flow-a" },
        callbackNonce: "flow-a",
      },
      {
        name: "callback",
        harness: loadBusinessAuthHarness({ sessionEmail: "victim@example.com", sessionProvider: "email" }),
        acceptance: { expectedEmail: "victim@example.com", expectedProvider: "email", authFlowNonce: "flow-a" },
        callbackNonce: "flow-b",
      },
      {
        name: "provider",
        harness: loadBusinessAuthHarness({ sessionEmail: "victim@example.com", sessionProvider: "apple" }),
        acceptance: { expectedEmail: "victim@example.com", expectedProvider: "google", authFlowNonce: "flow-a" },
        callbackNonce: "flow-a",
      },
    ];

    for (const testCase of cases) {
      testCase.harness.helpers.setPendingLegalAcceptance({
        ageConfirmed: true,
        termsAccepted: true,
        privacyAccepted: true,
        termsVersion: "2026-07-20",
        privacyVersion: "2026-07-20",
        ...testCase.acceptance,
      });
      await expect(testCase.harness.helpers.syncSupabaseSession({
        applyPendingLegalAcceptance: true,
        authFlowNonce: testCase.callbackNonce,
      }), testCase.name).rejects.toMatchObject({
        status: 409,
        legalAcceptanceMismatch: true,
      });
      expect(testCase.harness.requests, testCase.name).toHaveLength(0);
      expect(testCase.harness.localStorage.has("pintPathLegalAcceptance"), testCase.name).toBe(false);
    }
  });

  it("compares consent against the server-verified Supabase user, not stored session claims", async () => {
    const harness = loadBusinessAuthHarness({
      sessionEmail: "victim@example.com",
      verifiedEmail: "other@example.com",
      sessionProvider: "email",
    });
    harness.helpers.setPendingLegalAcceptance({
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "2026-07-20",
      privacyVersion: "2026-07-20",
      expectedEmail: "victim@example.com",
      expectedProvider: "email",
      authFlowNonce: "flow-a",
    });

    await expect(harness.helpers.syncSupabaseSession({
      applyPendingLegalAcceptance: true,
      authFlowNonce: "flow-a",
    })).rejects.toMatchObject({ legalAcceptanceMismatch: true });
    expect(harness.requests).toHaveLength(0);
    expect(harness.localStorage.has("pintPathLegalAcceptance")).toBe(false);
  });

  it("binds a fresh returning-policy acceptance to the authenticated Supabase identity", async () => {
    const harness = loadBusinessAuthHarness({ sessionEmail: "returning@example.com", sessionProvider: "google" });
    const binding = await harness.helpers.setPendingLegalAcceptanceForCurrentSession({
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "2026-07-20",
      privacyVersion: "2026-07-20",
    });

    const pending = JSON.parse(harness.localStorage.get("pintPathLegalAcceptance") || "{}") as Record<string, unknown>;
    expect(pending).toMatchObject({
      expectedEmail: "returning@example.com",
      expectedProvider: "google",
      authFlowNonce: binding.authFlowNonce,
    });

    await harness.helpers.syncSupabaseSession({
      applyPendingLegalAcceptance: true,
      authFlowNonce: binding.authFlowNonce,
    });
    expect(harness.requests.find((request) => request.path === "/api/business/auth/supabase-session")?.body)
      .toMatchObject({ ageConfirmed: true, termsAccepted: true, privacyAccepted: true });
    expect(harness.localStorage.has("pintPathLegalAcceptance")).toBe(false);
  });

  it("retains pending acceptance for confirmed-email signup and omits expired consent", async () => {
    const confirmationHarness = loadBusinessAuthHarness({ signupHasSession: false });
    const result = await confirmationHarness.helpers.signUpWithEmail(
      "confirm@example.com",
      "safe-password",
      true,
      true,
      true,
      null,
    );
    expect(result.needsEmailConfirmation).toBe(true);
    expect(confirmationHarness.localStorage.has("pintPathLegalAcceptance")).toBe(true);
    expect(confirmationHarness.requests).toHaveLength(0);

    const returningHarness = loadBusinessAuthHarness();
    returningHarness.localStorage.set("pintPathLegalAcceptance", JSON.stringify({
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: "2026-07-20",
      privacyVersion: "2026-07-20",
      createdAt: "2000-01-01T00:00:00.000Z",
    }));
    await returningHarness.helpers.syncSupabaseSession({ applyPendingLegalAcceptance: true });
    const syncRequest = returningHarness.requests.find((request) => request.path === "/api/business/auth/supabase-session");
    expect(syncRequest?.body).toEqual({
      accessToken: "provider-access-token",
      credentialCeremony: "browser_memory_v1",
    });
    expect(returningHarness.localStorage.has("pintPathLegalAcceptance")).toBe(false);
  });

  it("requires a fresh identity-bound acceptance when a returning login has stale policies", () => {
    const html = accountHtml();

    expect(html).toContain('id="returningLegalAcceptanceForm"');
    expect(html).toContain('aria-labelledby="returningLegalAcceptanceTitle"');
    expect(html).toContain('id="cancelReturningLegalAcceptanceButton"');
    expect(html).toContain("Your identity is confirmed. Review and accept the current policies below");
    expect(html).toContain("showReturningLegalAcceptance();");
    expect(html).toContain('$("authTabs").hidden = true;');
    expect(html).toContain('auth.signOut({ scope: "local" })');
    expect(html).toContain("Sign-in cancelled. No policy choices were saved.");
    expect(html).toContain("MelbBeerBusiness.setPendingLegalAcceptanceForCurrentSession({");
    expect(html).toContain("authFlowNonce: binding.authFlowNonce");
  });

  it("sources the browser legal-policy version from the server config", () => {
    const script = businessJs();
    const app = fs.readFileSync(path.resolve(process.cwd(), "src/app.ts"), "utf8");

    expect(app).toContain("legalPolicyVersion: publicConfig.legalPolicyVersion");
    expect(script).toContain("window.MELB_BEER_BOT_VIEWER_CONFIG?.business?.legalPolicyVersion");
    expect(script).toContain('|| "2026-08-03"');
  });

  it("hydrates HttpOnly sessions once and clears revoked provider sessions locally", () => {
    const script = businessJs();

    expect(script).toContain('apiFetch("/api/business/auth/session")');
    expect(script).toContain("let authSessionHydrationPromise = null;");
    expect(script).toContain("void hydrateAuthSessionNavigation();");
    expect(script).toContain("provider session (?:was revoked|is missing its session identifier)");
    expect(script).toContain('client.auth.signOut({ scope: "local" })');
  });

  it("publishes stronger beta Terms and Privacy pages for account consent", () => {
    const terms = termsHtml();
    const privacy = privacyHtml();
    const feedback = feedbackHtml();
    const account = accountHtml();
    const script = businessJs();
    const app = fs.readFileSync(path.resolve(process.cwd(), "src/app.ts"), "utf8");

    expect(terms).toContain("Terms and Conditions");
    expect(terms).toContain("warn, restrict, suspend, or permanently ban accounts");
    expect(terms).toContain("exploit the points system");
    expect(terms).toContain("scrape protected data");
    expect(terms).toContain("Display names/usernames must be unique");
    expect(terms).toContain("We do not tolerate rude or discriminatory names");
    expect(terms).toContain("Last updated: 3 August 2026");
    expect(terms).toContain("Isaac William De Worsop");
    expect(terms).toContain("ABN 80 319 578 329");
    expect(terms).toContain("WOTSO, Level 3, 11–19 Bank Place, Melbourne VIC 3000, Australia");
    expect(terms).toContain('href="mailto:admin@pintpath.au"');
    expect(terms).toContain("Australian Consumer Law");
    expect(terms).toContain("Stripe billing management");
    expect(terms).toContain("Victoria, Australia");
    expect(terms).not.toContain("Beta legal-review notice");
    expect(terms).not.toContain("before launch");
    expect(privacy).toContain("Privacy Policy");
    expect(privacy).toContain("Last updated: 3 August 2026");
    expect(privacy).toContain("Plain-English beta summary");
    expect(privacy).toContain("Service providers and integrations");
    expect(privacy).toContain("Venue reports are aggregate-only");
    expect(privacy).toContain("We do not store raw ID documents");
    expect(privacy).toContain("one-time upload-location proof");
    expect(privacy).toContain("Account deletion and export");
    expect(privacy).toContain("Privacy, access, correction, export, deletion, and complaint requests");
    expect(privacy).toContain("Railway for application hosting");
    expect(privacy).toContain("provide a substantive response within 30 calendar days");
    expect(privacy).toContain("Office of the Australian Information Commissioner");
    expect(privacy).toContain("Isaac William De Worsop");
    expect(privacy).toContain("ABN 80 319 578 329");
    expect(privacy).toContain("WOTSO, Level 3, 11–19 Bank Place, Melbourne VIC 3000, Australia");
    expect(privacy).toContain('href="mailto:admin@pintpath.au"');
    expect(feedback).toContain("Isaac William De Worsop");
    expect(feedback).toContain("ABN 80 319 578 329");
    expect(feedback).toContain("WOTSO, Level 3, 11–19 Bank Place");
    expect(feedback).toContain('href="mailto:admin@pintpath.au"');
    expect(account).toContain("Pint Path updated these policies on 3 August 2026");
    expect(account).not.toContain("Pint Path updated these policies on 12 July 2026");
    expect(script).toContain("Pint Path · ABN 80 319 578 329");
    expect(script).toContain('href="mailto:admin@pintpath.au"');
    expect(app).toContain("Pint Path · ABN 80 319 578 329");
    expect(app).toContain('href="mailto:admin@pintpath.au"');
    expect(privacy).not.toContain("Final owner contact details should be published here");
    expect(privacy).not.toContain("[legal entity name]");
  });

  it("adds a FAQ with trust, community, security, privacy, and support paths", () => {
    const trust = trustHtml();
    const community = communityHtml();
    const security = securityHtml();
    const status = statusHtml();
    const feedback = feedbackHtml();
    const nav = businessJs();
    const css = businessCss();

    expect(nav).toContain('key: "faq", href: venueManagerNav ? "/trust.html?audience=bars" : "/trust.html"');
    expect(trust).toContain("FAQ | Pint Path");
    expect(trust).not.toContain("Where did the Trust Centre go?");
    expect(trust).not.toContain("Tap a question when you need detail.");
    expect(trust).toContain("What if a price is wrong?");
    expect(trust).toContain("How does full map access work?");
    expect(trust).toContain("Can bars edit the map directly?");
    expect(trust).toContain("How do I report a security or privacy concern?");
    expect(trust).toContain("How do I add a missing venue?");
    expect(trust).toContain('params.get("audience") === "bars"');
    expect(trust).toContain("Answers for venues using Pint Path.");
    expect(trust).toContain("What can my bar account manage?");
    expect(trust).toContain("What do venue reports show?");
    expect(trust).toContain("faqList");
    expect(trust).not.toContain("faqActionPanel");
    expect(trust).not.toContain("Need something else?");
    expect(css).toContain(".faqItem summary");
    expect(css).toContain(".faqItem[open]");
    expect(css).toContain(".faqItem summary::after");
    expect(css).not.toContain(".faqActionPanel");
    expect(trust).toContain("/security.html");
    expect(community).toContain("Submit what you actually saw at the venue.");
    expect(community).toContain("Spoofing location");
    expect(security).toContain("Security & privacy");
    expect(security).toContain("Log out all sessions");
    expect(security).toContain("Security report");
    expect(security).toContain("If you cannot sign in, use Contact us and include the account email");
    expect(trust).not.toContain('<a href="/status.html"');
    expect(security).not.toContain('<a href="/status.html"');
    expect(status).toContain("Pint Path status and incident reporting.");
    expect(status).toContain("The service result above is live.");
    expect(status).toContain("provider incidents still require their own dashboards and alerts");
    expect(status).toContain("Railway");
    expect(status).toContain("Supabase");
    expect(status).toContain("Resend");
    expect(feedback).toContain("privacy_request");
    expect(feedback).toContain("data_export_request");
    expect(feedback).toContain("account_deletion_request");
    expect(feedback).toContain("moderation_appeal");
    expect(feedback).toContain("security_report");
    expect(feedback).toContain("abuse_report");
    expect(feedback).toContain("billing_support");
    expect(feedback).toContain('params.get("type")');
    expect(feedback).toContain("Array.from(typeSelect.options)");
    expect(feedback).toContain("venue_partner_interest");
  });

  it("exposes signed-in privacy controls without clustering feedback back into account", () => {
    const html = accountHtml();
    const css = businessCss();
    const script = businessJs();

    expect(html).toContain('id="privacySettingsForm"');
    expect(html).toContain("Allow optional product analytics");
    expect(html).toContain("Include my aggregate activity in venue insights");
    expect(html).toContain('id="dataRequestForm"');
    expect(html).toContain('id="downloadAccountDataButton"');
    expect(html).toContain('id="requestAccountDeletionButton"');
    expect(html).toContain("Scheduling deletion starts a seven-day cancellation window.");
    expect(html).toContain("It includes exact upload coordinates while they remain inside the review and appeal retention window");
    expect(html).toContain("private evidence files are listed but not embedded");
    expect(html).not.toContain('id="requestForm"');
    expect(html).not.toContain('class="panel supportSubmitCard"');
    expect(html).not.toContain("Add venue data");
    expect(html).not.toContain("Open Trust Centre");
    expect(html).toContain("/api/business/account/export");
    expect(html).toContain("/api/business/account/delete-request");
    expect(html).toContain('id="accountDeletionStatus"');
    expect(html).toContain("function loadDeletionStatus");
    expect(html).toContain("let deletionStatusRequestId = 0");
    expect(html).toContain("const requestedAccountId = state.accountData?.account?.id || null;");
    expect(html).toContain("requestId !== deletionStatusRequestId");
    expect(html).toContain("requestedAccountId !== (state.accountData?.account?.id || null)");
    expect(html).toContain("isAccountUiContextCurrent(requestedContext)");
    expect(html).toContain("requestId === deletionStatusRequestId");
    const deletionLoader = htmlBetween(html, "async function loadDeletionStatus", "function renderAccountSessions");
    expect(deletionLoader.indexOf("requestId !== deletionStatusRequestId")).toBeLessThan(deletionLoader.indexOf("renderDeletionStatus(result.request || null)"));
    expect(html).toContain("data-cancel-deletion-request");
    expect(html).toContain('/api/business/account/delete-request/${encodeURIComponent(button.dataset.cancelDeletionRequest)}');
    expect(html).toContain("downloadJson");
    expect(html).toContain('id="logoutAllButton"');
    expect(html).toContain('id="accountSessionList"');
    expect(html).toContain("function loadAccountSessions");
    expect(html).toContain('/api/business/account/sessions/${encodeURIComponent(button.dataset.revokeAccountSession)}');
    expect(html).toContain('class="securityActionGrid"');
    expect(html).toContain('class="button button--danger securityLogoutAll"');
    expect(html).toContain('id="mfaSetup"');
    expect(html).toContain('id="mfaQrImage"');
    expect(html).toContain('id="verifyMfaButton"');
    expect(html).toContain('id="replaceMfaButton"');
    expect(html).toContain('id="removeMfaButton"');
    expect(html).toContain("client.auth.mfa.enroll");
    expect(html).toContain("client.auth.mfa.challengeAndVerify");
    expect(html).toContain('requestedMode === "remove"');
    expect(html).toContain('requestedMode === "replace-authorize"');
    expect(html).toContain("state.mfaReplacementOldFactorId");
    expect(html).toContain("await client.auth.mfa.unenroll({ factorId: oldFactorId })");
    expect(html).toContain("client.auth.mfa.listFactors");
    expect(html).toContain("await MelbBeerBusiness.syncSupabaseSession()");
    expect(html).toContain("/api/business/account/privacy-settings");
    expect(html).toContain("consentVersion: MelbBeerBusiness.LEGAL_POLICY_VERSION");
    expect(html).toContain("expectedUpdatedAt: state.accountData?.privacySettings?.consentedAt");
    expect(html).toContain("state.accountData.privacySettings = result.privacySettings || settings");
    expect(html).toContain("MelbBeerBusiness.setPrivacyPreferenceCache(privacySettings)");
    expect(html).toContain("{ allowOptionalPromotion: true }");
    expect(html).toContain("expectedUpdatedAt: state.accountData?.preferences?.updatedAt || null");
    expect(html).toContain("state.accountData.preferences = result.preferences || {}");
    const logoutAllHandler = htmlBetween(
      html,
      '$("logoutAllButton").addEventListener',
      '$("startMfaButton").addEventListener',
    );
    expect(logoutAllHandler).toContain("/api/business/auth/logout-all");
    expect(logoutAllHandler).toContain('ensureSupabaseSessionForPurpose("logout_all"');
    expect(logoutAllHandler).toContain("requireProviderSession: true");
    expect(logoutAllHandler).toContain("await supabaseClient?.auth.getSession()");
    expect(logoutAllHandler).toContain("{ accessToken: providerAccessToken }");
    expect(logoutAllHandler).not.toContain('body: "{}"');
    expect(html).toContain('auth.signOut({ scope: "local" })');
    expect(html).toContain("/community.html");
    expect(css).toContain(".accountSecurityPanel");
    expect(css).toContain(".securityActionGrid");
    expect(css).toContain(".securityLogoutAll");
    expect(css).toContain(".mfaSetup");
    expect(css).toContain(".mfaVerification");
    expect(css).toContain(".quickPrivacyActions");
    expect(css).toContain(".toggleLine");
    expect(script).toContain("setPrivacyPreferenceCache");
    expect(script).toContain("pintPathOptionalAnalyticsEnabled");
    expect(script).toContain("pintPathVenueReportsEnabled");
  });

  it("invalidates account-bound async responses across logout and identity changes", () => {
    const html = accountHtml();
    const invalidation = htmlBetween(html, "function invalidateAccountBoundUi", "function showLoggedOut");
    const logout = htmlBetween(html, '$("logoutButton").addEventListener', '$("confirmAgeButton").addEventListener');
    const sessionLoader = htmlBetween(html, "async function loadAccountSessions", "function syncLegalAcceptanceGate");
    const mfaLoader = htmlBetween(html, "async function loadMfaState", "async function beginMfaEnrollment");
    const accountLoader = htmlBetween(html, "async function refreshAccount", "async function handleAuth");

    expect(html).toContain("accountUiEpoch: 0");
    expect(html).toContain("authFlowEpoch: 0");
    expect(html).toContain("function captureAccountUiContext");
    expect(html).toContain("function isAccountUiContextCurrent");
    expect(invalidation).toContain("state.accountUiEpoch += 1");
    expect(invalidation).toContain("accountSessionsRequestId += 1");
    expect(invalidation).toContain('$("accountSessionList").replaceChildren()');
    expect(invalidation).toContain('$("discountPassQr").removeAttribute("src")');
    expect(invalidation).toContain('$("freePintRewardQr").removeAttribute("src")');
    expect(invalidation).toContain('$("pubGolfResult").replaceChildren()');
    expect(invalidation).toContain("delete canIDriveForm.dataset.profileLoaded");
    expect(invalidation).toContain('$("canIDriveDrinkList").replaceChildren()');
    expect(invalidation).toContain('$("dataRequestForm").reset()');
    expect(invalidation).toContain("state.pubGolfRenderEpoch += 1");
    expect(html).toContain("invalidateAccountBoundUi();\n      MelbBeerBusiness.setAccountContext(null)");
    expect(html).toContain("if (previousAccountId !== nextAccountId) {\n        invalidateAccountBoundUi();");
    expect(sessionLoader).toContain("const requestedContext = captureAccountUiContext()");
    expect(sessionLoader).toContain("!isAccountUiContextCurrent(requestedContext)");
    expect(mfaLoader).toContain("const requestedContext = captureAccountUiContext()");
    expect(mfaLoader).toContain("requestId !== mfaStateRequestId || !isAccountUiContextCurrent(requestedContext)");
    expect(accountLoader).toContain("requestId !== refreshAccountRequestId || !isAccountUiContextCurrent(requestedContext)");
    expect(logout).toContain('MelbBeerBusiness.setStatus($("dashboardStatus"), "Logging out securely...")');
    expect(logout.indexOf('/api/business/auth/logout')).toBeLessThan(
      logout.indexOf('broadcastAuthInvalidation("logout")'),
    );
    expect(logout).toContain("This device may still be signed in");
    expect(logout).toContain('$("logoutButton").disabled = false');
    expect(logout).toContain("if (!isAccountUiContextCurrent(requestedContext)) return;");
    expect(html).toContain("const authFlowId = ++state.authFlowEpoch;");
    expect(html).toContain("if (authFlowId !== state.authFlowEpoch) return;");
    expect(html).toContain('if (!$("settingsSecurityPanel").hidden)');
    expect(html).toContain("const requestedContext = captureAccountUiContext();\n        try {\n          setLoading(button, true, \"Generating...\")");
    expect(html).toContain("const requestedContext = captureAccountUiContext();\n        let createdRewardCode = false;");
    expect(html).toContain("function isPubGolfRenderCurrent(context)");
    expect(html).toContain("if (!isPubGolfRenderCurrent(renderContext)) return;");
    const billingRecovery = htmlBetween(html, "async function openBillingRecoveryPortal", "function showDashboard");
    expect(billingRecovery).toContain("const requestedContext = captureAccountUiContext()");
    expect(billingRecovery).toContain("const authFlowId = ++state.authFlowEpoch");
    expect(billingRecovery).toContain("if (!requestIsCurrent()) return;");
  });

  it("adds cookie consent and accessibility chrome around optional analytics", () => {
    const css = businessCss();
    const script = businessJs();
    const closeCookieDialog = htmlBetween(script, "const closeCookieDialog", "banner.querySelectorAll");

    expect(script).toContain("pintPathCookieConsent");
    expect(script).toContain('const CONSENT_STATE_ESSENTIAL = "v1.e"');
    expect(script).toContain('const CONSENT_STATE_OPTIONAL = "v1.o0"');
    expect(script).toContain('const CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS = "v1.o1"');
    expect(script).toContain("Path=/; SameSite=Lax; Max-Age=");
    expect(script).toContain('secure ? "; Secure" : ""');
    expect(script).not.toContain("; Domain=");
    expect(script).toContain("function installCookieConsent");
    expect(script).toContain("Essentials only");
    expect(script).toContain("Accept all");
    expect(script).toContain("Manage in account");
    expect(script).toContain('/account.html?settings=privacy');
    expect(script).toContain("inertedElements");
    expect(closeCookieDialog).toContain("try {");
    expect(closeCookieDialog).toContain("setCookieConsentDecision(choice)");
    expect(closeCookieDialog).toContain("} finally {");
    expect(closeCookieDialog).toContain("element.inert = false");
    expect(closeCookieDialog).toContain("backdrop.remove()");
    expect(closeCookieDialog).toContain("banner.remove()");
    expect(script).toContain("function hasAnalyticsConsent");
    expect(script).toContain("if (!hasAnalyticsConsent())");
    expect(script).toContain("if (hasVenueContext && !hasVenueReportConsent())");
    expect(script).toContain('aria-label="Primary"');
    expect(script).toContain("function installAccessibilityChrome");
    expect(script).toContain('main.id = "mainContent"');
    expect(script).toContain("Skip to main content");
    expect(script).toContain("function installLegalFooter");
    expect(script).toContain('aria-label="Legal, privacy, and help"');
    expect(css).toContain(".cookieConsent");
    expect(css).toContain(".skipLink");
    expect(css).toContain(":focus-visible");
  });

  it("keeps cookie consent preferences fail-closed when browser storage is unavailable", () => {
    const unavailableStorage: BrowserStorageFixture = {
      getItem: () => {
        throw new DOMException("Storage is unavailable.", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Storage quota exceeded.", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("Storage is unavailable.", "SecurityError");
      },
      key: () => null,
      length: 0,
    };
    const helpers = loadBusinessHelpers({
      localStorage: unavailableStorage,
      readCookies: () => {
        throw new DOMException("Cookies are unavailable.", "SecurityError");
      },
      writeCookie: () => {
        throw new DOMException("Cookies are unavailable.", "SecurityError");
      },
    });

    expect(helpers.getCookieConsentDecision()).toBeNull();
    expect(helpers.hasAnalyticsConsent()).toBe(false);

    expect(() => helpers.setCookieConsentDecision("essential")).not.toThrow();
    expect(helpers.getCookieConsentDecision()).toBe("essential");
    expect(helpers.hasAnalyticsConsent()).toBe(false);

    expect(() => helpers.setCookieConsentDecision("optional")).not.toThrow();
    expect(helpers.getCookieConsentDecision()).toBe("essential");
    expect(helpers.hasAnalyticsConsent()).toBe(false);

    expect(() => helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
    })).not.toThrow();
    expect(helpers.getCookieConsentDecision()).toBe("essential");
    expect(helpers.hasAnalyticsConsent()).toBe(false);
  });

  it("enables optional analytics only after exact V1 storage and host-cookie readback", async () => {
    const persisted = new Map<string, string>([
      ["pintPathCookieConsent", "optional"],
      ["pintPathOptionalAnalyticsEnabled", "true"],
      ["pintPathVenueReportsEnabled", "true"],
    ]);
    const cookieJar = new Map<string, string>();
    const cookieWrites: string[] = [];
    const eventRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const storage: BrowserStorageFixture = {
      getItem: (key) => persisted.get(key) ?? null,
      setItem: (key, value) => persisted.set(key, String(value)),
      removeItem: (key) => persisted.delete(key),
      key: (index) => Array.from(persisted.keys())[index] ?? null,
      get length() {
        return persisted.size;
      },
    };
    const writeCookie = (serialized: string, jar: Map<string, string>) => {
      cookieWrites.push(serialized);
      const [pair = ""] = serialized.split(";", 1);
      const separator = pair.indexOf("=");
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    };
    const helpers = loadBusinessHelpers({
      localStorage: storage,
      cookieJar,
      writeCookie,
      fetchImpl: async (input, request = {}) => {
        eventRequests.push({
          path: String(input),
          body: JSON.parse(String(request.body || "{}")) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    helpers.setCookieConsentDecision("optional");

    expect(persisted.get("pintPathConsentV1")).toBe("v1.o1");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.o1");
    expect(helpers.getCookieConsentDecision()).toBe("optional");
    expect(helpers.hasAnalyticsConsent()).toBe(true);
    expect(persisted.has("pintPathCookieConsent")).toBe(false);
    expect(persisted.has("pintPathOptionalAnalyticsEnabled")).toBe(false);
    expect(persisted.has("pintPathVenueReportsEnabled")).toBe(false);
    expect(cookieWrites[0]).toContain("pintPathConsentV1=v1.o1");
    expect(cookieWrites[0]).toContain("Path=/");
    expect(cookieWrites[0]).toContain("SameSite=Lax");
    expect(cookieWrites[0]).toMatch(/Max-Age=\d+/);
    expect(cookieWrites[0]).toContain("Secure");
    expect(cookieWrites[0]).not.toContain("Domain=");
    await helpers.trackEvent("venue_opened", { venueId: "venue-o1" });
    expect(eventRequests).toHaveLength(1);
    expect(eventRequests[0]).toMatchObject({
      path: "/api/business/events",
      body: { venueId: "venue-o1" },
    });

    helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: false,
    });
    expect(persisted.get("pintPathConsentV1")).toBe("v1.o0");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.o0");
    expect(helpers.hasAnalyticsConsent()).toBe(true);
    await helpers.trackEvent("venue_opened", { venueId: "venue-o0" });
    expect(eventRequests).toHaveLength(1);
    await helpers.trackEvent("map_opened");
    expect(eventRequests).toHaveLength(2);

    helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
    });
    expect(persisted.get("pintPathConsentV1")).toBe("v1.e");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.e");
    expect(helpers.getCookieConsentDecision()).toBe("essential");
    expect(helpers.hasAnalyticsConsent()).toBe(false);
  });

  it("does not resurrect a stale or malformed analytics opt-in after a failed opt-out", () => {
    const persisted = new Map<string, string>([
      ["pintPathCookieConsent", "optional"],
      ["pintPathOptionalAnalyticsEnabled", "true"],
      ["pintPathVenueReportsEnabled", "true"],
    ]);
    const readableButUnwritableStorage: BrowserStorageFixture = {
      getItem: (key) => persisted.get(key) ?? null,
      setItem: () => {
        throw new DOMException("Storage is read-only.", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("Storage is read-only.", "SecurityError");
      },
      key: (index) => Array.from(persisted.keys())[index] ?? null,
      get length() {
        return persisted.size;
      },
    };
    const cookieJar = new Map<string, string>();

    const legacyOptionalPage = loadBusinessHelpers({
      localStorage: readableButUnwritableStorage,
      cookieJar,
    });
    expect(legacyOptionalPage.getCookieConsentDecision()).toBeNull();
    expect(legacyOptionalPage.hasAnalyticsConsent()).toBe(false);

    const currentPage = loadBusinessHelpers({
      localStorage: readableButUnwritableStorage,
      cookieJar,
    });
    currentPage.setCookieConsentDecision("essential");
    expect(currentPage.getCookieConsentDecision()).toBe("essential");
    expect(currentPage.hasAnalyticsConsent()).toBe(false);
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.e");

    const reloadedPage = loadBusinessHelpers({
      localStorage: readableButUnwritableStorage,
      cookieJar,
    });
    expect(reloadedPage.getCookieConsentDecision()).not.toBe("optional");
    expect(reloadedPage.hasAnalyticsConsent()).toBe(false);

    cookieJar.clear();
    persisted.set("pintPathCookieConsent", "corrupt");
    persisted.set("pintPathOptionalAnalyticsEnabled", "corrupt");
    const malformedPage = loadBusinessHelpers({
      localStorage: readableButUnwritableStorage,
      cookieJar,
    });
    expect(malformedPage.getCookieConsentDecision()).toBeNull();
    expect(malformedPage.hasAnalyticsConsent()).toBe(false);
  });

  it("denies malformed, missing, partial, or mismatched V1 consent while either essential channel dominates", () => {
    const cases: Array<{
      name: string;
      local: string | null;
      cookie: string | null;
      cookieHeader?: string;
      decision: string | null;
      analytics: boolean;
    }> = [
      { name: "both optional analytics", local: "v1.o0", cookie: "v1.o0", decision: "optional", analytics: true },
      { name: "both optional venue reports", local: "v1.o1", cookie: "v1.o1", decision: "optional", analytics: true },
      { name: "missing cookie", local: "v1.o1", cookie: null, decision: null, analytics: false },
      { name: "missing storage", local: null, cookie: "v1.o1", decision: null, analytics: false },
      { name: "optional mismatch", local: "v1.o0", cookie: "v1.o1", decision: null, analytics: false },
      { name: "matching corruption", local: "corrupt", cookie: "corrupt", decision: null, analytics: false },
      {
        name: "duplicate consent cookie",
        local: "v1.o1",
        cookie: "v1.o1",
        cookieHeader: "pintPathConsentV1=v1.o1; pintPathConsentV1=v1.o1",
        decision: null,
        analytics: false,
      },
      { name: "storage essential", local: "v1.e", cookie: "v1.o1", decision: "essential", analytics: false },
      { name: "cookie essential", local: "v1.o1", cookie: "v1.e", decision: "essential", analytics: false },
    ];

    cases.forEach((testCase) => {
      const persisted = new Map<string, string>();
      if (testCase.local) persisted.set("pintPathConsentV1", testCase.local);
      const storage: BrowserStorageFixture = {
        getItem: (key) => persisted.get(key) ?? null,
        setItem: (key, value) => persisted.set(key, String(value)),
        removeItem: (key) => persisted.delete(key),
        key: (index) => Array.from(persisted.keys())[index] ?? null,
        get length() {
          return persisted.size;
        },
      };
      const cookieJar = new Map<string, string>();
      if (testCase.cookie) cookieJar.set("pintPathConsentV1", testCase.cookie);
      const helpers = loadBusinessHelpers({
        localStorage: storage,
        cookieJar,
        ...(testCase.cookieHeader ? { readCookies: () => testCase.cookieHeader || "" } : {}),
      });

      expect(helpers.getCookieConsentDecision(), testCase.name).toBe(testCase.decision);
      expect(helpers.hasAnalyticsConsent(), testCase.name).toBe(testCase.analytics);
    });
  });

  it("rolls partial, silent, and channel-specific optional-write failures back to essential", () => {
    const scenarios = [
      { name: "storage silent no-op", storageMode: "noop", cookieMode: "write" },
      { name: "storage throws", storageMode: "throw", cookieMode: "write" },
      { name: "cookie silent no-op", storageMode: "write", cookieMode: "noop" },
      { name: "cookie throws", storageMode: "write", cookieMode: "throw" },
    ] as const;

    scenarios.forEach((scenario) => {
      const persisted = new Map<string, string>();
      const cookieJar = new Map<string, string>();
      const storage: BrowserStorageFixture = {
        getItem: (key) => persisted.get(key) ?? null,
        setItem: (key, value) => {
          if (scenario.storageMode === "throw") throw new DOMException("Storage write failed.", "SecurityError");
          if (scenario.storageMode === "write") persisted.set(key, String(value));
        },
        removeItem: (key) => persisted.delete(key),
        key: (index) => Array.from(persisted.keys())[index] ?? null,
        get length() {
          return persisted.size;
        },
      };
      const helpers = loadBusinessHelpers({
        localStorage: storage,
        cookieJar,
        writeCookie: (serialized, jar) => {
          if (scenario.cookieMode === "throw") throw new DOMException("Cookie write failed.", "SecurityError");
          if (scenario.cookieMode === "noop") return;
          const [pair = ""] = serialized.split(";", 1);
          const separator = pair.indexOf("=");
          jar.set(pair.slice(0, separator), pair.slice(separator + 1));
        },
      });

      helpers.setCookieConsentDecision("optional");

      expect(helpers.getCookieConsentDecision(), scenario.name).toBe("essential");
      expect(helpers.hasAnalyticsConsent(), scenario.name).toBe(false);
    });
  });

  it("keeps an essential opt-out after reload when either persistence channel fails", () => {
    const scenarios = [
      { name: "storage silent no-op", storageMode: "noop", cookieMode: "write" },
      { name: "storage throws", storageMode: "throw", cookieMode: "write" },
      { name: "cookie silent no-op", storageMode: "write", cookieMode: "noop" },
      { name: "cookie throws", storageMode: "write", cookieMode: "throw" },
    ] as const;

    scenarios.forEach((scenario) => {
      const persisted = new Map<string, string>([["pintPathConsentV1", "v1.o1"]]);
      const cookieJar = new Map<string, string>([["pintPathConsentV1", "v1.o1"]]);
      const storage: BrowserStorageFixture = {
        getItem: (key) => persisted.get(key) ?? null,
        setItem: (key, value) => {
          if (scenario.storageMode === "throw") throw new DOMException("Storage write failed.", "SecurityError");
          if (scenario.storageMode === "write") persisted.set(key, String(value));
        },
        removeItem: (key) => persisted.delete(key),
        key: (index) => Array.from(persisted.keys())[index] ?? null,
        get length() {
          return persisted.size;
        },
      };
      const options: BusinessHelperOptions = {
        localStorage: storage,
        cookieJar,
        writeCookie: (serialized, jar) => {
          if (scenario.cookieMode === "throw") throw new DOMException("Cookie write failed.", "SecurityError");
          if (scenario.cookieMode === "noop") return;
          const [pair = ""] = serialized.split(";", 1);
          const separator = pair.indexOf("=");
          jar.set(pair.slice(0, separator), pair.slice(separator + 1));
        },
      };

      const currentPage = loadBusinessHelpers(options);
      currentPage.setCookieConsentDecision("essential");
      expect(currentPage.getCookieConsentDecision(), `${scenario.name} current page`).toBe("essential");
      expect(currentPage.hasAnalyticsConsent(), `${scenario.name} current page`).toBe(false);

      const reloadedPage = loadBusinessHelpers(options);
      expect(reloadedPage.getCookieConsentDecision(), `${scenario.name} reload`).toBe("essential");
      expect(reloadedPage.hasAnalyticsConsent(), `${scenario.name} reload`).toBe(false);
    });
  });

  it("safely migrates legacy essential consent but never legacy optional consent", () => {
    const persisted = new Map<string, string>([
      ["pintPathCookieConsent", "essential"],
      ["pintPathOptionalAnalyticsEnabled", "false"],
      ["pintPathVenueReportsEnabled", "false"],
    ]);
    const cookieJar = new Map<string, string>();
    const storage: BrowserStorageFixture = {
      getItem: (key) => persisted.get(key) ?? null,
      setItem: (key, value) => persisted.set(key, String(value)),
      removeItem: (key) => persisted.delete(key),
      key: (index) => Array.from(persisted.keys())[index] ?? null,
      get length() {
        return persisted.size;
      },
    };
    const helpers = loadBusinessHelpers({ localStorage: storage, cookieJar });

    expect(helpers.getCookieConsentDecision()).toBe("essential");
    expect(helpers.hasAnalyticsConsent()).toBe(false);
    expect(persisted.get("pintPathConsentV1")).toBe("v1.e");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.e");
    expect(persisted.has("pintPathCookieConsent")).toBe(false);
    expect(persisted.has("pintPathOptionalAnalyticsEnabled")).toBe(false);
    expect(persisted.has("pintPathVenueReportsEnabled")).toBe(false);

    persisted.clear();
    cookieJar.clear();
    persisted.set("pintPathCookieConsent", "optional");
    persisted.set("pintPathOptionalAnalyticsEnabled", "true");
    persisted.set("pintPathVenueReportsEnabled", "true");
    const legacyOptionalHelpers = loadBusinessHelpers({ localStorage: storage, cookieJar });
    expect(legacyOptionalHelpers.getCookieConsentDecision()).toBeNull();
    expect(legacyOptionalHelpers.hasAnalyticsConsent()).toBe(false);
    expect(persisted.has("pintPathConsentV1")).toBe(false);
    expect(cookieJar.has("pintPathConsentV1")).toBe(false);

    persisted.set("pintPathCookieConsent", "essential");
    persisted.set("pintPathOptionalAnalyticsEnabled", "false");
    persisted.set("pintPathVenueReportsEnabled", "true");
    const incompleteLegacyDenialHelpers = loadBusinessHelpers({ localStorage: storage, cookieJar });
    expect(incompleteLegacyDenialHelpers.getCookieConsentDecision()).toBeNull();
    expect(incompleteLegacyDenialHelpers.hasAnalyticsConsent()).toBe(false);
    expect(persisted.has("pintPathConsentV1")).toBe(false);
    expect(cookieJar.has("pintPathConsentV1")).toBe(false);
  });

  it("allows only an explicit successful privacy save to promote optional consent", () => {
    const persisted = new Map<string, string>();
    const cookieJar = new Map<string, string>();
    const storage: BrowserStorageFixture = {
      getItem: (key) => persisted.get(key) ?? null,
      setItem: (key, value) => persisted.set(key, String(value)),
      removeItem: (key) => persisted.delete(key),
      key: (index) => Array.from(persisted.keys())[index] ?? null,
      get length() {
        return persisted.size;
      },
    };
    const helpers = loadBusinessHelpers({ localStorage: storage, cookieJar });

    helpers.setPrivacyPreferenceCache({ venueReportInclusionEnabled: true });
    expect(persisted.has("pintPathConsentV1")).toBe(false);
    expect(cookieJar.has("pintPathConsentV1")).toBe(false);
    expect(helpers.getCookieConsentDecision()).toBeNull();
    expect(helpers.hasAnalyticsConsent()).toBe(false);

    helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
    });
    expect(persisted.has("pintPathConsentV1")).toBe(false);
    expect(cookieJar.has("pintPathConsentV1")).toBe(false);
    expect(helpers.getCookieConsentDecision()).toBeNull();
    expect(helpers.hasAnalyticsConsent()).toBe(false);

    helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: false,
    }, { allowOptionalPromotion: true });
    expect(persisted.get("pintPathConsentV1")).toBe("v1.o0");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.o0");
    expect(helpers.hasAnalyticsConsent()).toBe(true);

    helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
    });
    expect(persisted.get("pintPathConsentV1")).toBe("v1.e");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.e");
    expect(helpers.hasAnalyticsConsent()).toBe(false);

    helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
    });
    expect(persisted.get("pintPathConsentV1")).toBe("v1.e");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.e");
    expect(helpers.hasAnalyticsConsent()).toBe(false);

    helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
    }, { allowOptionalPromotion: true });
    expect(persisted.get("pintPathConsentV1")).toBe("v1.o1");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.o1");
    expect(helpers.hasAnalyticsConsent()).toBe(true);

    helpers.setPrivacyPreferenceCache({ optionalAnalyticsEnabled: true });
    expect(persisted.get("pintPathConsentV1")).toBe("v1.e");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.e");
    expect(helpers.hasAnalyticsConsent()).toBe(false);

    helpers.setPrivacyPreferenceCache({
      optionalAnalyticsEnabled: "true",
      venueReportInclusionEnabled: true,
    });
    expect(persisted.get("pintPathConsentV1")).toBe("v1.e");
    expect(cookieJar.get("pintPathConsentV1")).toBe("v1.e");
    expect(helpers.hasAnalyticsConsent()).toBe(false);
  });
});
