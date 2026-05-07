const AUTH_TOKEN_KEY = "melbBeerBusinessAuthToken";
const ANON_SESSION_KEY = "melbBeerAnonSessionId";

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

function renderNav(active = "") {
  const betaPill = isFieldTestMode() ? '<span class="betaPill">Beta field test</span>' : "";
  const feedbackLink = isFieldTestMode() ? '<a href="/account.html#feedbackForm">Feedback</a>' : "";
  return `
    <nav class="topNav">
      <a class="brand" href="/">
        <strong>Melbourne Beer Map</strong>
        <span>Verified local price index</span>
      </a>
      ${betaPill}
      <div class="navLinks">
        <a ${active === "map" ? 'class="pill"' : ""} href="/">Map</a>
        <a ${active === "pricing" ? 'class="pill"' : ""} href="/pricing.html">Pricing</a>
        <a ${active === "missions" ? 'class="pill"' : ""} href="/missions.html">Missions</a>
        <a ${active === "submit" ? 'class="pill"' : ""} href="/submit.html">Submit data</a>
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
  feedbackButton.href = "/account.html#feedbackForm";
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
    await apiFetch("/api/business/events", {
      method: "POST",
      body: JSON.stringify({
        anonymousSessionId: getAnonymousSessionId(),
        eventType,
        venueId: metadata.venueId || null,
        beerId: metadata.beerId || null,
        suburb: metadata.suburb || null,
        metadata,
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
  isFieldTestMode,
  apiFetch,
  renderNav,
  installFieldTestChrome,
  formatDate,
  setStatus,
  trackEvent,
};

window.addEventListener("DOMContentLoaded", installFieldTestChrome);
