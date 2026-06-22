const AUTH_TOKEN_KEY = "melbBeerBusinessAuthToken";
const ACCOUNT_CONTEXT_KEY = "pintPathAccountContext";
const ANON_SESSION_KEY = "melbBeerAnonSessionId";
const AUTH_RETURN_KEY = "pintPathAuthReturnTo";
const LEGAL_ACCEPTANCE_KEY = "pintPathLegalAcceptance";
const LEGAL_POLICY_VERSION = "2026-05-24";
const OPTIONAL_ANALYTICS_KEY = "pintPathOptionalAnalyticsEnabled";
const VENUE_REPORTS_KEY = "pintPathVenueReportsEnabled";
const COOKIE_CONSENT_KEY = "pintPathCookieConsent";

function getAuthToken() {
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

function setAuthToken(token) {
  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
    setAccountContext(null);
  }
}

function setAccountContext(account) {
  if (!account || typeof account !== "object") {
    window.localStorage.removeItem(ACCOUNT_CONTEXT_KEY);
    return;
  }

  window.localStorage.setItem(ACCOUNT_CONTEXT_KEY, JSON.stringify({
    id: account.id || null,
    role: account.role || null,
    status: account.status || null,
    email: account.email || null,
    subscriptionStatus: account.subscriptionStatus || null,
  }));
}

function getAccountContext() {
  const raw = window.localStorage.getItem(ACCOUNT_CONTEXT_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    window.localStorage.removeItem(ACCOUNT_CONTEXT_KEY);
    return null;
  }
}

function isVenueManagerContext() {
  return getAccountContext()?.role === "venue_manager";
}

function isAdminContext() {
  const account = getAccountContext();
  return account?.role === "admin" || account?.subscriptionStatus === "admin";
}

function hasCachedSupabaseSession() {
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) || "";
      if (!/^sb-.+-auth-token$/.test(key)) {
        continue;
      }
      const value = window.localStorage.getItem(key) || "";
      if (value.includes("access_token")) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function hasAuthenticatedSessionHint() {
  return Boolean(getAuthToken() || hasCachedSupabaseSession());
}

function getAnonymousSessionId() {
  let value = window.localStorage.getItem(ANON_SESSION_KEY);

  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    window.localStorage.setItem(ANON_SESSION_KEY, value);
  }

  return value;
}

function boolStorageEnabled(key, fallback = true) {
  const value = window.localStorage.getItem(key);
  if (value == null) {
    return fallback;
  }
  return value !== "false";
}

function getCookieConsentDecision() {
  return window.localStorage.getItem(COOKIE_CONSENT_KEY);
}

function hasAnalyticsConsent() {
  const explicitOptional = window.localStorage.getItem(OPTIONAL_ANALYTICS_KEY);
  if (explicitOptional != null) {
    return explicitOptional !== "false";
  }

  return getCookieConsentDecision() === "optional";
}

function setCookieConsentDecision(decision) {
  const normalized = decision === "optional" ? "optional" : "essential";
  window.localStorage.setItem(COOKIE_CONSENT_KEY, normalized);
  if (normalized === "optional") {
    window.localStorage.setItem(OPTIONAL_ANALYTICS_KEY, "true");
    window.localStorage.setItem(VENUE_REPORTS_KEY, "true");
  } else {
    window.localStorage.setItem(OPTIONAL_ANALYTICS_KEY, "false");
    window.localStorage.setItem(VENUE_REPORTS_KEY, "false");
  }
}

function setPrivacyPreferenceCache(settings = {}) {
  if ("optionalAnalyticsEnabled" in settings) {
    window.localStorage.setItem(OPTIONAL_ANALYTICS_KEY, settings.optionalAnalyticsEnabled ? "true" : "false");
    window.localStorage.setItem(COOKIE_CONSENT_KEY, settings.optionalAnalyticsEnabled ? "optional" : "essential");
  }
  if ("venueReportInclusionEnabled" in settings) {
    window.localStorage.setItem(VENUE_REPORTS_KEY, settings.venueReportInclusionEnabled ? "true" : "false");
  }
}

function getViewerConfig() {
  return window.MELB_BEER_BOT_VIEWER_CONFIG || {};
}

function getBusinessConfig() {
  return getViewerConfig().business || {};
}

function isLocalOrigin(origin = window.location.origin) {
  try {
    const hostname = new URL(origin).hostname;
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
}

function getConfiguredPublicBaseUrl() {
  const config = getViewerConfig();
  const business = getBusinessConfig();
  return business.publicBaseUrl || config.publicBaseUrl || null;
}

function getCanonicalBaseUrl() {
  const configured = getConfiguredPublicBaseUrl();

  if (configured && !isLocalOrigin()) {
    try {
      return new URL(configured).origin;
    } catch {
      return window.location.origin;
    }
  }

  return window.location.origin;
}

function getSafeReturnPath(value = null) {
  const fallback = "/account.html";
  const raw = String(value || "").trim();

  if (!raw) {
    return fallback;
  }

  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin && parsed.origin !== getCanonicalBaseUrl()) {
      return fallback;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
  }
}

function getAuthReturnPathFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return getSafeReturnPath(params.get("next") || params.get("returnTo") || window.localStorage.getItem(AUTH_RETURN_KEY));
}

function getAuthCallbackUrl(returnTo = "/account.html") {
  const url = new URL("/auth/callback", getCanonicalBaseUrl());
  url.searchParams.set("returnTo", getSafeReturnPath(returnTo));
  return url.toString();
}

function legalAcceptancePayload(input = {}) {
  return {
    ageConfirmed: Boolean(input.ageConfirmed),
    termsAccepted: Boolean(input.termsAccepted),
    privacyAccepted: Boolean(input.privacyAccepted),
    termsVersion: input.termsVersion || LEGAL_POLICY_VERSION,
    privacyVersion: input.privacyVersion || LEGAL_POLICY_VERSION,
  };
}

function setPendingLegalAcceptance(input) {
  window.localStorage.setItem(LEGAL_ACCEPTANCE_KEY, JSON.stringify(legalAcceptancePayload(input)));
}

function getPendingLegalAcceptance() {
  const raw = window.localStorage.getItem(LEGAL_ACCEPTANCE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return legalAcceptancePayload(JSON.parse(raw));
  } catch {
    window.localStorage.removeItem(LEGAL_ACCEPTANCE_KEY);
    return null;
  }
}

async function applyPendingLegalAcceptance() {
  const acceptance = getPendingLegalAcceptance();
  if (!acceptance) {
    return null;
  }

  if (acceptance.ageConfirmed) {
    await apiFetch("/api/business/account/age-confirm", {
      method: "POST",
      body: JSON.stringify({ ageConfirmed: true }),
    }).catch(() => null);
  }

  if (acceptance.termsAccepted && acceptance.privacyAccepted) {
    const result = await apiFetch("/api/business/account/legal-acceptance", {
      method: "POST",
      body: JSON.stringify({
        termsAccepted: true,
        privacyAccepted: true,
        termsVersion: acceptance.termsVersion,
        privacyVersion: acceptance.privacyVersion,
      }),
    });
    window.localStorage.removeItem(LEGAL_ACCEPTANCE_KEY);
    return result;
  }

  return null;
}

function getSupabaseConfig() {
  const config = getViewerConfig();
  const business = getBusinessConfig();
  return {
    url: business.supabaseUrl || config.supabaseUrl || null,
    anonKey: business.supabaseAnonKey || config.supabaseAnonKey || null,
  };
}

function getSupabaseOauthProviders() {
  const config = getViewerConfig();
  const business = getBusinessConfig();
  const providers = business.supabaseOauthProviders || config.supabaseOauthProviders || ["google", "apple"];
  return Array.isArray(providers) ? providers : String(providers).split(",").map((provider) => provider.trim()).filter(Boolean);
}

function getSupabaseClient() {
  const config = getSupabaseConfig();
  if (!window.supabase || !config.url || !config.anonKey) {
    return null;
  }

  if (!window.__melbBeerSupabaseClient) {
    window.__melbBeerSupabaseClient = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    if (isLocalOrigin() && !window.__melbBeerSupabaseAuthDebugInstalled) {
      window.__melbBeerSupabaseAuthDebugInstalled = true;
      window.__melbBeerSupabaseClient.auth.onAuthStateChange((event, session) => {
        console.debug("[Pint Path auth]", {
          event,
          userId: session?.user?.id || null,
          email: session?.user?.email || null,
        });
      });
    }
  }

  return window.__melbBeerSupabaseClient;
}

function isFieldTestMode() {
  return Boolean(getBusinessConfig().fieldTestMode);
}

async function apiFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const token = getAuthToken();

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error?.message || payload?.error || `Request failed (${response.status})`);
  }

  return payload.data;
}

async function syncSupabaseSession() {
  const client = getSupabaseClient();
  if (!client) {
    return { configured: false, synced: false };
  }

  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) {
    return { configured: true, synced: false, error: error?.message || null };
  }

  const result = await apiFetch("/api/business/auth/supabase-session", {
    method: "POST",
    body: JSON.stringify({ accessToken: data.session.access_token }),
  });
  setAuthToken(result.token);
  setAccountContext(result.account);
  return { configured: true, synced: true, account: result.account };
}

async function signInWithOAuth(provider, options = {}) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase login is not configured for this environment.");
  }

  const scopesByProvider = {
    google: "email profile",
    apple: "name email",
  };

  const returnTo = getSafeReturnPath(options.returnTo || getAuthReturnPathFromLocation());
  window.localStorage.setItem(AUTH_RETURN_KEY, returnTo);
  if (options.legalAcceptance) {
    setPendingLegalAcceptance(options.legalAcceptance);
  }

  const { error } = await client.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: getAuthCallbackUrl(returnTo),
      scopes: scopesByProvider[provider] || "email",
    },
  });

  if (error) {
    throw new Error(error.message);
  }
}

async function signInWithEmail(email, password) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase email login is not configured for this environment.");
  }

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(error.message);
  }

  if (!data.session?.access_token) {
    throw new Error("Email login did not return a session. Confirm your email, then try again.");
  }

  return syncSupabaseSession();
}

async function signUpWithEmail(email, password, ageConfirmed, termsAccepted, privacyAccepted, displayName = null) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase email signup is not configured for this environment.");
  }

  const returnTo = getAuthReturnPathFromLocation();
  window.localStorage.setItem(AUTH_RETURN_KEY, returnTo);

  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: getAuthCallbackUrl(returnTo),
      data: {
        age_confirmed: Boolean(ageConfirmed),
        terms_accepted: Boolean(termsAccepted),
        privacy_accepted: Boolean(privacyAccepted),
        display_name: displayName || undefined,
        full_name: displayName || undefined,
        terms_version: LEGAL_POLICY_VERSION,
        privacy_version: LEGAL_POLICY_VERSION,
      },
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  if (data.session?.access_token) {
    let synced;
    try {
      synced = await syncSupabaseSession();
    } catch {
      return {
        configured: true,
        synced: false,
        needsEmailConfirmation: true,
        message: "Account created and confirmation requested. Check your email, then return here to sign in. If no link arrives within a minute, use Resend confirmation.",
      };
    }

    if (ageConfirmed) {
      await apiFetch("/api/business/account/age-confirm", {
        method: "POST",
        body: JSON.stringify({ ageConfirmed: true }),
      }).catch(() => null);
    }
    if (termsAccepted && privacyAccepted) {
      await apiFetch("/api/business/account/legal-acceptance", {
        method: "POST",
        body: JSON.stringify({
          termsAccepted: true,
          privacyAccepted: true,
          termsVersion: LEGAL_POLICY_VERSION,
          privacyVersion: LEGAL_POLICY_VERSION,
        }),
      }).catch(() => null);
    }
    return { ...synced, needsEmailConfirmation: false };
  }

  return {
    configured: true,
    synced: false,
    needsEmailConfirmation: true,
    message: "Account created and confirmation requested. Check your email, then return here to sign in. If no link arrives within a minute, use Resend confirmation.",
  };
}

async function resendSignupConfirmation(email) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase confirmation email is not configured for this environment.");
  }

  const { error } = await client.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: getAuthCallbackUrl("/account.html"),
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  return {
    message: "If a Supabase signup exists for that email, a confirmation email has been sent. Check spam and Google Workspace quarantine if it does not arrive.",
  };
}

async function requestPasswordReset(email) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Password reset is available when Supabase Auth is configured.");
  }

  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: getAuthCallbackUrl("/reset-password.html?mode=update"),
  });

  if (error) {
    throw new Error(error.message);
  }

  return {
    message: "If an account exists for that email, a secure reset link has been sent.",
  };
}

async function updatePassword(password) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Password reset is available when Supabase Auth is configured.");
  }

  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) {
    throw new Error(sessionError.message);
  }
  if (!sessionData.session?.access_token) {
    throw new Error("Open the latest password reset email before setting a new password.");
  }

  const { error } = await client.auth.updateUser({ password });
  if (error) {
    throw new Error(error.message);
  }

  await syncSupabaseSession().catch(() => null);
  return {
    message: "Password updated. You can continue to your Pint Path account.",
  };
}

function renderNav(active = "") {
  const activeKey = active === "trust" || active === "bar-faq" ? "faq" : active;
  const betaPill = isFieldTestMode() ? '<span class="betaPill">Beta field test</span>' : "";
  const adminPageNav = active === "admin";
  const venueManagerNav = active === "venue-portal" || active === "bar-faq" || active === "venue-support" || isVenueManagerContext();
  const adminNav = active === "admin" || isAdminContext();
  const navItems = adminPageNav ? [
    { key: "map", href: "/", label: "Map" },
    { key: "submit", href: "/submit.html", label: "Submit" },
    { key: "admin", href: "/admin.html", label: "Admin" },
    { key: "account", href: "/account.html", label: "Account" },
  ] : venueManagerNav ? [
    { key: "map", href: "/", label: "Map" },
    { key: "venue-portal", href: "/venue-portal.html", label: "Dashboard" },
    ...(adminNav ? [{ key: "admin", href: "/admin.html", label: "Admin" }] : []),
    { key: "pricing", href: "/pricing.html", label: "Pricing" },
    { key: "faq", href: "/trust.html?audience=bars", label: "Bar FAQ" },
    { key: "venue-support", href: "/feedback.html?audience=bars", label: "Support" },
  ] : [
    { key: "map", href: "/", label: "Map" },
    { key: "submit", href: "/submit.html", label: "Submit" },
    { key: "missions", href: "/missions.html", label: "Missions" },
    ...(adminNav ? [{ key: "admin", href: "/admin.html", label: "Admin" }] : []),
    { key: "pricing", href: "/pricing.html", label: "Pricing" },
    { key: "faq", href: "/trust.html", label: "FAQ" },
    { key: "account", href: "/account.html", label: "Account" },
    ...(isFieldTestMode() ? [{ key: "feedback", href: "/feedback.html", label: "Contact us" }] : []),
  ];
  const navLinks = navItems
    .map((item) => `<a ${activeKey === item.key ? 'class="pill"' : ""} href="${item.href}">${item.label}</a>`)
    .join("");
  return `
    <nav class="topNav" aria-label="Primary">
      <a class="brand" href="/">
        <img class="brandLogo" src="/assets/pint-path-icon-192.png" alt="" width="36" height="36" aria-hidden="true" />
        <span class="brandText">
          <strong>Pint Path</strong>
        </span>
      </a>
      ${betaPill}
      <div class="navLinks">
        ${navLinks}
      </div>
    </nav>
  `;
}

function installFieldTestChrome() {
  if (!isFieldTestMode()) {
    return;
  }

  document.body.classList.add("fieldTestMode");
}

function installAccessibilityChrome() {
  if (!document.getElementById("mainContent")) {
    const main = document.querySelector("main");
    if (main) {
      main.id = "mainContent";
      main.setAttribute("tabindex", "-1");
    }
  }
}

function installCookieConsent() {
  if (getCookieConsentDecision() || window.localStorage.getItem(OPTIONAL_ANALYTICS_KEY) != null || document.getElementById("cookieConsent")) {
    return;
  }

  const banner = document.createElement("aside");
  const backdrop = document.createElement("div");
  backdrop.id = "cookieConsentBackdrop";
  backdrop.className = "cookieConsentBackdrop";
  banner.id = "cookieConsent";
  banner.className = "cookieConsent";
  banner.setAttribute("aria-label", "Cookie and analytics choices");
  banner.innerHTML = `
    <div class="cookieConsent__copy">
      <span class="cookieConsent__badge">Privacy</span>
      <strong>Choose your cookie settings</strong>
      <p>Essential cookies keep login and security working. Optional analytics help improve map search and aggregate venue reports.</p>
    </div>
    <div class="cookieConsent__actions">
      <button class="button" type="button" data-cookie-choice="essential">Essentials only</button>
      <button class="button button--primary" type="button" data-cookie-choice="optional">Accept all</button>
      <a class="button" href="/account.html#privacyControlsSection">Manage in account</a>
    </div>
  `;

  banner.querySelectorAll("[data-cookie-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      setCookieConsentDecision(button.getAttribute("data-cookie-choice"));
      backdrop.remove();
      banner.remove();
    });
  });

  document.body.appendChild(backdrop);
  document.body.appendChild(banner);
}

function formatDate(value) {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function setStatus(element, message, isError = false) {
  element.hidden = false;
  element.textContent = message;
  element.className = `notice ${isError ? "notice--warning" : ""}`;
}

async function trackEvent(eventType, metadata = {}) {
  try {
    if (!hasAnalyticsConsent()) {
      return;
    }
    const safeMetadata = Object.fromEntries(
      Object.entries(metadata || {}).filter(([key]) => !/(latitude|longitude|\blat\b|\blng\b|coordinates?|gps|precise.?location)/i.test(key)),
    );
    const hasVenueContext = Boolean(safeMetadata.venueId);
    if (hasVenueContext && !boolStorageEnabled(VENUE_REPORTS_KEY, true)) {
      return;
    }

    await apiFetch("/api/business/events", {
      method: "POST",
      body: JSON.stringify({
        anonymousSessionId: getAnonymousSessionId(),
        eventType,
        venueId: safeMetadata.venueId || null,
        beerId: safeMetadata.beerId || null,
        suburb: safeMetadata.suburb || null,
        metadata: {
          ...safeMetadata,
          privacyScope: hasVenueContext ? "venue_insight" : "optional_analytics",
        },
      }),
    });
  } catch {
    // Analytics should never block the user path.
  }
}

window.MelbBeerBusiness = {
  AUTH_TOKEN_KEY,
  ACCOUNT_CONTEXT_KEY,
  getAuthToken,
  setAuthToken,
  setAccountContext,
  getAccountContext,
  isVenueManagerContext,
  isAdminContext,
  hasAuthenticatedSessionHint,
  getAnonymousSessionId,
  getViewerConfig,
  getBusinessConfig,
  getSupabaseConfig,
  getSupabaseOauthProviders,
  getSupabaseClient,
  getCookieConsentDecision,
  setCookieConsentDecision,
  hasAnalyticsConsent,
  getCanonicalBaseUrl,
  getSafeReturnPath,
  getAuthReturnPathFromLocation,
  getAuthCallbackUrl,
  setPrivacyPreferenceCache,
  isFieldTestMode,
  apiFetch,
  syncSupabaseSession,
  setPendingLegalAcceptance,
  applyPendingLegalAcceptance,
  signInWithOAuth,
  signInWithEmail,
  signUpWithEmail,
  resendSignupConfirmation,
  requestPasswordReset,
  updatePassword,
  renderNav,
  installFieldTestChrome,
  installAccessibilityChrome,
  installCookieConsent,
  formatDate,
  setStatus,
  trackEvent,
};

window.addEventListener("DOMContentLoaded", () => {
  installAccessibilityChrome();
  installFieldTestChrome();
  installCookieConsent();
});
