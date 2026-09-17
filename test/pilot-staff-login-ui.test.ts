import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { authSupabaseSessionSchema } from "../src/modules/business/business.schemas.js";
import { pilotStaffEmailSignInScopeAllowed } from "../src/lib/pilot-demo-fixture.js";

const html = fs.readFileSync("viewer/account.html", "utf8");
const business = fs.readFileSync("viewer/business.js", "utf8");
function section(source: string, start: string, end: string) {
  const index = source.indexOf(start);
  if (index < 0 || source.indexOf(end, index) < 0) throw new Error(`Missing source section ${start}`);
  return source.slice(index, source.indexOf(end, index));
}
function harness(origin = "https://beer-staging.up.railway.app", enabled = true) {
  class Element {
    hidden = true;
    textContent = "";
    value = "";
    checked = true;
    dataset: Record<string, string> = {};
    classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
    setAttribute = vi.fn();
    focus = vi.fn();
    reset = vi.fn(() => { this.password.value = ""; });
    password = { value: "owner-entered-test-password" };
    email = { value: "staff@example.test" };
    ageConfirmed = { checked: true, focus: vi.fn() };
    termsAccepted = { checked: true };
    privacyAccepted = { checked: true };
    listener?: () => Promise<void>;
    querySelector = vi.fn(() => this);
    addEventListener = vi.fn((_name: string, callback: () => Promise<void>) => { this.listener = callback; });
  }
  const elements = new Map<string, Element>();
  const $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const google = new Element(); google.dataset.provider = "google";
  const state = { authFlowEpoch: 0, pilotStaffSignIn: false };
  const signIn = vi.fn(async (_email: string, _password: string, _options: object) => ({}));
  const apiFetch = vi.fn(async () => ({}));
  const sync = vi.fn(async (_options: object) => ({}));
  const signOut = vi.fn(async () => ({}));
  const oauth = vi.fn(async () => ({ redirected: true }));
  const client = { auth: { signOut } };
  const helpers = {
    getSupabaseClient: vi.fn((): typeof client | null => client), signInWithEmail: signIn,
    signUpWithEmail: vi.fn(), apiFetch, syncSupabaseSession: sync,
    setStatus: vi.fn((element: Element, text: string) => { element.textContent = text; }),
    setPendingLegalAcceptanceForCurrentSession: vi.fn(async () => ({ authFlowNonce: "bound-consent" })),
    clearPendingLegalAcceptance: vi.fn(), clearSensitiveAuthReturnState: vi.fn(),
    broadcastAuthInvalidation: vi.fn(), setAuthToken: vi.fn(),
    getSupabaseOauthProviders: () => ["google"], signInWithOAuthPopup: oauth,
    getAuthReturnPathFromLocation: () => "/account.html", LEGAL_POLICY_VERSION: "fixture-policy",
  };
  const context = vm.createContext({ $, state, MelbBeerBusiness: helpers, URL, URLSearchParams, Set,
    window: { location: { origin, hostname: new URL(origin).hostname, search: "", assign: vi.fn() },
      MELB_BEER_BOT_VIEWER_CONFIG: { business: { pilotStaffEmailSignInEnabled: enabled } } },
    document: { querySelectorAll: (selector: string) => selector === ".oauthButton" ? [google]
      : [...html.matchAll(/id="([^"]+)"[^>]*data-local-email-auth/g)].map(match => $(match[1]!)) },
    FormData: class { constructor(private form: Element) {} entries() { return Object.entries({
      email: this.form.email.value, password: this.form.password.value,
    }); } },
    hideBillingRecovery: vi.fn(), clearAuthFieldErrors: vi.fn(), setLoading: vi.fn(),
    refreshAccount: vi.fn(async () => null), pendingCheckoutPlan: () => false,
    setOauthButtonsLoading: vi.fn(), setAccountStatus: helpers.setStatus,
  });
  vm.runInContext(section(html, "    const WEB_EMAIL_AUTH_ENABLED =", "    const state ="), context);
  vm.runInContext(section(html, "    function configureEmailAuthUi()", "    function showReturningLegalAcceptance()"), context);
  vm.runInContext(section(html, "    function showReturningLegalAcceptance()", "    function authenticatedReturnDestination("), context);
  // These actual event handlers are exercised with form semantics and provider
  // promises; no assertions mirror CSS or a proposed source substring.
  vm.runInContext(section(html, "    async function handleAuth(", "    function installPasswordToggles()"), context);
  vm.runInContext(section(html, "    async function setupOauth()", '    window.addEventListener("DOMContentLoaded"'), context);
  const event = { preventDefault() {}, currentTarget: $("loginForm") };
  context.event = event;
  return { $, state, helpers, signIn, sync, apiFetch, oauth, google, context,
    configure: () => vm.runInContext("configureEmailAuthUi()", context),
    submit: (path = "/api/business/auth/login") => { context.authPath = path; return vm.runInContext("handleAuth(event, authPath)", context) as Promise<void>; },
    accept: () => { context.consentEvent = { ...event, currentTarget: $("returningLegalAcceptanceForm") }; return vm.runInContext("acceptReturningLoginPolicies(consentEvent)", context) as Promise<void>; },
    cancel: () => vm.runInContext("cancelReturningLoginPolicies()", context) as Promise<void>,
    googleStart: async () => { await vm.runInContext("setupOauth()", context); return google.listener!(); },
  };
}

describe("staging staff returning email UI", () => {
  it.each(["https://pintpath.au", "https://beer-staging.up.railway.app.evil.test"])("does not expose or accept email sign-in on %s despite a spoofed capability", async origin => {
    const f = harness(origin); f.configure();
    expect(f.$("webEmailLoginFields").hidden).toBe(true);
    await f.submit();
    expect(f.signIn).not.toHaveBeenCalled(); expect(f.apiFetch).not.toHaveBeenCalled();
  });
  it("requires the server capability and shows only returning login/reset on exact staging", async () => {
    const disabled = harness(undefined, false); disabled.configure();
    expect(disabled.$("webEmailLoginFields").hidden).toBe(true);
    const f = harness(); f.configure();
    for (const id of ["webEmailLoginFields", "webEmailLoginActions", "webEmailAuthUtilities", "passwordResetLink"]) expect(f.$(id).hidden).toBe(false);
    for (const id of ["authTabs", "signupForm", "resendConfirmationLink"]) expect(f.$(id).hidden).toBe(true);
    await f.submit("/api/business/auth/signup");
    expect(f.signIn).not.toHaveBeenCalled(); expect(f.helpers.signUpWithEmail).not.toHaveBeenCalled();
  });
  it("uses genuine provider password login, clears the field and never falls back to local auth", async () => {
    const f = harness();
    await f.submit();
    expect(f.signIn).toHaveBeenCalledWith("staff@example.test", "owner-entered-test-password", { pilotStaffSignIn: true });
    expect(f.$("loginForm").password.value).toBe(""); expect(f.apiFetch).not.toHaveBeenCalled();
    f.helpers.getSupabaseClient.mockReturnValue(null);
    f.$("loginForm").password.value = "second-owner-password";
    await f.submit();
    expect(f.signIn).toHaveBeenCalledTimes(1); expect(f.apiFetch).not.toHaveBeenCalled();
    expect(f.$("loginForm").password.value).toBe("");
  });
  it("preserves restrictive intent through explicit consent and a failed cancellation", async () => {
    const f = harness();
    f.signIn.mockRejectedValue({ status: 403, message: "Accept the current Terms and Privacy Policy" });
    await f.submit();
    expect(f.$("returningLegalAcceptanceForm").hidden).toBe(false);
    expect(f.$("loginForm").password.value).toBe("");
    f.apiFetch.mockRejectedValue(new Error("offline"));
    await f.cancel();
    expect(f.state.pilotStaffSignIn).toBe(true);
    await f.accept();
    expect(f.sync).toHaveBeenCalledWith({ applyPendingLegalAcceptance: true, authFlowNonce: "bound-consent", pilotStaffSignIn: true });
    expect(f.state.pilotStaffSignIn).toBe(false);
  });
  it("clears intent and retires consent only after successful cancellation", async () => {
    const f = harness();
    f.state.pilotStaffSignIn = true; f.$("returningLegalAcceptanceForm").hidden = false;
    await f.cancel();
    expect(f.state.pilotStaffSignIn).toBe(false);
    expect(f.$("returningLegalAcceptanceForm").hidden).toBe(true);
    expect(f.helpers.getSupabaseClient()?.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it.each(["redirect", "provider-failure"])("retires old consent and ignores a stale password reply after Google %s", async outcome => {
    const f = harness();
    if (outcome === "provider-failure") f.oauth.mockRejectedValue(new Error("Provider unavailable"));
    let reject!: (reason: unknown) => void;
    f.signIn.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = f.submit();
    f.$("returningLegalAcceptanceForm").hidden = false;
    await f.googleStart();
    reject({ status: 403, message: "Accept the current Terms and Privacy Policy" });
    await pending;
    expect(f.state.pilotStaffSignIn).toBe(false);
    expect(f.$("returningLegalAcceptanceForm").hidden).toBe(true);
    expect(f.sync).not.toHaveBeenCalled();
  });
});

it("keeps restricted intent additive and incompatible with other credential ceremonies", () => {
  const input = { accessToken: "x".repeat(32), credentialCeremony: "browser_memory_v1", pilotStaffSignIn: true };
  expect(authSupabaseSessionSchema.safeParse(input).success).toBe(true);
  for (const changes of [{ credentialCeremony: undefined }, { credentialCeremony: "native_memory_v1" },
    { credentialCeremony: "browser_email_otp_v1" }, { reauthPurpose: "logout_all" }, { pilotStaffSignIn: false }]) {
    expect(authSupabaseSessionSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  }
});

it("does not treat a permitted loopback publication fixture as hosted staff sign-in authority", () => {
  expect(pilotStaffEmailSignInScopeAllowed({ NODE_ENV: "test", PUBLIC_BASE_URL: "http://127.0.0.1:3217",
    DATABASE_URL: "postgresql://127.0.0.1/pintpath_pilot_unit?sslmode=disable", BAR_PILOT_ENABLED: true,
    BAR_PILOT_DEMO_ENABLED: true, BAR_PILOT_VENUE_IDS: "pintpath-pilot-demo:venue:v1", BAR_PILOT_DEMO_CUSTOMER_IDS: "customer" }, {})).toBe(false);
});

it("forwards the restrictive intent through the existing session exchange rather than another endpoint", async () => {
  const fetch = vi.fn(async () => ({ authenticated: true }));
  const context = vm.createContext({ window: {}, Date, Map, Set, URL,
    getSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "real-provider-placeholder" } }, error: null }) } }),
    isRestoreRehearsalMode: () => false, getAccountContext: () => null,
    getPendingLegalAcceptance: () => null, apiFetch: fetch,
  });
  // Stop at the actual exchange: downstream account rendering is independently
  // tested by account-page tests and does not affect request identity binding.
  const source = section(business, "async function syncSupabaseSession(", "    if (error?.code === \"MFA_STEP_UP_REQUIRED\"");
  vm.runInContext(`${source} throw error; }\n}`, context);
  await vm.runInContext("syncSupabaseSession({pilotStaffSignIn:true})", context);
  const [, request] = fetch.mock.calls[1] as unknown as [string, { body: string }];
  expect(fetch.mock.calls[1]?.[0]).toBe("/api/business/auth/supabase-session");
  expect(JSON.parse(request.body)).toMatchObject({ pilotStaffSignIn: true, credentialCeremony: "browser_memory_v1" });
  expect(request.body).not.toContain("password");
});
