const AUTH_TOKEN_KEY = "melbBeerBusinessAuthToken";
const ANON_SESSION_KEY = "melbBeerAnonSessionId";
const AUTH_RETURN_KEY = "pintPathAuthReturnTo";

function getAuthToken() {
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

function setAuthToken(token) {
  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}

function getAnonymousSessionId() {
  let value = window.localStorage.getItem(ANON_SESSION_KEY);

  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    window.localStorage.setItem(ANON_SESSION_KEY, value);
  }

  return value;
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

async function signUpWithEmail(email, password, ageConfirmed) {
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
        message: "Account created. Check your email to confirm your Pint Path login, then return here to sign in.",
      };
    }

    if (ageConfirmed) {
      await apiFetch("/api/business/account/age-confirm", {
        method: "POST",
        body: JSON.stringify({ ageConfirmed: true }),
      }).catch(() => null);
    }
    return { ...synced, needsEmailConfirmation: false };
  }

  return {
    configured: true,
    synced: false,
    needsEmailConfirmation: true,
    message: "Account created. Check your email to confirm your Pint Path login, then return here to sign in.",
  };
}

async function requestPasswordReset(email) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Password reset is available when Supabase Auth is configured.");
  }

  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: getAuthCallbackUrl("/account.html"),
  });

  if (error) {
    throw new Error(error.message);
  }
}

function renderNav(active = "") {
  const betaPill = isFieldTestMode() ? '<span class="betaPill">Beta field test</span>' : "";
  const feedbackLink = isFieldTestMode() ? `<a ${active === "feedback" ? 'class="pill"' : ""} href="/feedback.html">Feedback</a>` : "";
  return `
    <nav class="topNav">
      <a class="brand" href="/">
        <strong>Pint Path</strong>
        <span>Verified local price index</span>
      </a>
      ${betaPill}
      <div class="navLinks">
        <a ${active === "map" ? 'class="pill"' : ""} href="/">Map</a>
        <a ${active === "missions" ? 'class="pill"' : ""} href="/missions.html">Missions</a>
        <a ${active === "submit" ? 'class="pill"' : ""} href="/submit.html">Submit data</a>
        <a ${active === "pricing" ? 'class="pill"' : ""} href="/pricing.html">Pricing</a>
        <a ${active === "account" ? 'class="pill"' : ""} href="/account.html">Account</a>
        ${feedbackLink}
      </div>
    </nav>
  `;
}

function installFieldTestChrome() {
  if (!isFieldTestMode() || document.getElementById("fieldTestFeedbackButton")) {
    return;
  }

  document.body.classList.add("fieldTestMode");
  const feedbackButton = document.createElement("a");
  feedbackButton.id = "fieldTestFeedbackButton";
  feedbackButton.className = "floatingFeedback";
  feedbackButton.href = "/feedback.html";
  feedbackButton.textContent = "Send feedback";
  document.body.appendChild(feedbackButton);
}

function formatDate(value) {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.className = `notice ${isError ? "notice--warning" : ""}`;
}

async function trackEvent(eventType, metadata = {}) {
  try {
    const safeMetadata = Object.fromEntries(
      Object.entries(metadata || {}).filter(([key]) => !/(latitude|longitude|\blat\b|\blng\b|coordinates?|gps|precise.?location)/i.test(key)),
    );

    await apiFetch("/api/business/events", {
      method: "POST",
      body: JSON.stringify({
        anonymousSessionId: getAnonymousSessionId(),
        eventType,
        venueId: safeMetadata.venueId || null,
        beerId: safeMetadata.beerId || null,
        suburb: safeMetadata.suburb || null,
        metadata: safeMetadata,
      }),
    });
  } catch {
    // Analytics should never block the user path.
  }
}

window.MelbBeerBusiness = {
  AUTH_TOKEN_KEY,
  getAuthToken,
  setAuthToken,
  getAnonymousSessionId,
  getViewerConfig,
  getBusinessConfig,
  getSupabaseConfig,
  getSupabaseOauthProviders,
  getSupabaseClient,
  getCanonicalBaseUrl,
  getSafeReturnPath,
  getAuthReturnPathFromLocation,
  getAuthCallbackUrl,
  isFieldTestMode,
  apiFetch,
  syncSupabaseSession,
  signInWithOAuth,
  signInWithEmail,
  signUpWithEmail,
  requestPasswordReset,
  renderNav,
  installFieldTestChrome,
  formatDate,
  setStatus,
  trackEvent,
};

window.addEventListener("DOMContentLoaded", installFieldTestChrome);
