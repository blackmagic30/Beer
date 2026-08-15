const AUTH_TOKEN_KEY = "melbBeerBusinessAuthToken";
const ACCOUNT_CONTEXT_KEY = "pintPathAccountContext";
const ANON_SESSION_KEY = "melbBeerAnonSessionId";
const AUTH_RETURN_KEY = "pintPathAuthReturnTo";
const AUTH_FLOW_KEY = "pintPathAuthFlow";
const OAUTH_PKCE_STORAGE_KEY = "pintPathSupabaseOAuth";
const SENSITIVE_AUTH_RETURN_KEY = "pintPathSensitiveAuthReturnTo";
const PENDING_PORTAL_REDEMPTION_KEY = "pintPathPendingPortalRedemption";
const SENSITIVE_AUTH_RETURN_MAX_AGE_MS = 20 * 60 * 1000;
const AUTH_FLOW_MAX_AGE_MS = 20 * 60 * 1000;
const LEGAL_ACCEPTANCE_KEY = "pintPathLegalAcceptance";
const LEGAL_POLICY_VERSION = String(
  window.MELB_BEER_BOT_VIEWER_CONFIG?.business?.legalPolicyVersion || "2026-08-03"
);
const LEGACY_OPTIONAL_ANALYTICS_KEY = "pintPathOptionalAnalyticsEnabled";
const LEGACY_VENUE_REPORTS_KEY = "pintPathVenueReportsEnabled";
const LEGACY_COOKIE_CONSENT_KEY = "pintPathCookieConsent";
const CONSENT_STATE_STORAGE_KEY = "pintPathConsentV1";
const CONSENT_STATE_COOKIE_NAME = "pintPathConsentV1";
const CONSENT_STATE_ESSENTIAL = "v1.e";
const CONSENT_STATE_OPTIONAL = "v1.o0";
const CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS = "v1.o1";
const CONSENT_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const PASSWORD_RECOVERY_KEY = "pintPathPasswordRecovery";
const SUBMISSION_DEVICE_STORAGE_KEYS = [
  "pintPathUploadLocationProof",
  "pintPathSubmitDraft",
  "pintPathQueuedSubmissions",
];
const LOCAL_SUBMISSION_QUEUE_DB_NAME = "pintPathSubmissionQueue";
const LOCAL_SUBMISSION_QUEUE_DB_VERSION = 1;
const LOCAL_SUBMISSION_QUEUE_STORE_NAME = "queuedSubmissions";
const LEGAL_ACCEPTANCE_MAX_AGE_MS = 30 * 60 * 1000;
const PASSWORD_RECOVERY_MAX_AGE_MS = 20 * 60 * 1000;
const API_REQUEST_TIMEOUT_MS = 20 * 1000;
const LEGACY_SESSION_MIGRATION_TIMEOUT_MS = 8 * 1000;
const MAX_API_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const PRODUCTION_VIEWER_ORIGIN = "https://pintpath.au";
const PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au";
const SUPABASE_PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,220}$/;
const SUPABASE_LEGACY_JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{2,4096}$/;
const RESTORE_REHEARSAL_LOCAL_STORAGE_KEYS = new Set([
  AUTH_TOKEN_KEY,
  ACCOUNT_CONTEXT_KEY,
  ANON_SESSION_KEY,
  AUTH_RETURN_KEY,
  AUTH_FLOW_KEY,
  OAUTH_PKCE_STORAGE_KEY,
  `${OAUTH_PKCE_STORAGE_KEY}-code-verifier`,
  LEGAL_ACCEPTANCE_KEY,
  ...SUBMISSION_DEVICE_STORAGE_KEYS,
  "pintPathLocationPreference",
  "pintPathCanIDriveProfile",
  "pintPathSupportReceipts",
  "pintPath.counterReceiptQueue.v1",
]);
const RESTORE_REHEARSAL_SESSION_STORAGE_KEYS = new Set([
  SENSITIVE_AUTH_RETURN_KEY,
  PENDING_PORTAL_REDEMPTION_KEY,
  PASSWORD_RECOVERY_KEY,
  "pintPathBillingRecoveryOptions",
  "pintPath.counterReceiptQueue.v2",
]);
let restoreIsolationPromise = null;
let restoreAnonymousSessionId = null;
let pageLocalConsentDenied = false;

function isRestoreRehearsalMode() {
  return window.MELB_BEER_BOT_VIEWER_CONFIG?.business?.restoreRehearsalMode === true;
}

function isSupabaseSessionStorageKey(key) {
  return /^sb-.+-auth-token(?:-code-verifier)?$/.test(key) || /^supabase[.:_-].*auth/i.test(key);
}

function isRestoreSensitiveStorageKey(key, exactKeys) {
  return exactKeys.has(key) || key.includes(":account:") || isSupabaseSessionStorageKey(key);
}

function clearRestoreSensitiveStorage(storage, exactKeys) {
  if (!storage) return;
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) || "";
      if (isRestoreSensitiveStorageKey(key, exactKeys)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
    exactKeys.forEach((key) => storage.removeItem(key));
  } catch {
    // Storage can be unavailable in private browsing. All restore-mode getters
    // below still ignore any value that could not be removed.
  }
}

function deleteRestoreSubmissionQueue() {
  if (!window.indexedDB?.deleteDatabase) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.deleteDatabase(LOCAL_SUBMISSION_QUEUE_DB_NAME);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function prepareRestoreIsolation() {
  if (!isRestoreRehearsalMode()) {
    return Promise.resolve({ enabled: false, indexedDbCleared: false });
  }

  // This synchronous purge runs as business.js is evaluated, before the
  // DOMContentLoaded handlers render account-dependent browser state.
  clearRestoreSensitiveStorage(window.localStorage, RESTORE_REHEARSAL_LOCAL_STORAGE_KEYS);
  clearRestoreSensitiveStorage(window.sessionStorage, RESTORE_REHEARSAL_SESSION_STORAGE_KEYS);
  window.__melbBeerSupabaseClient = null;

  if (!restoreIsolationPromise) {
    restoreIsolationPromise = deleteRestoreSubmissionQueue().then((indexedDbCleared) => ({
      enabled: true,
      indexedDbCleared,
    }));
  }
  return restoreIsolationPromise;
}

void prepareRestoreIsolation();

function createFetchDeadline(requestedTimeoutMs, callerSignal = null) {
  const requested = Number(requestedTimeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_API_REQUEST_TIMEOUT_MS)
    : API_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function requestTimeoutError() {
  const error = new Error("This request took too long. Check your connection and try again.");
  error.name = "PintPathRequestTimeoutError";
  error.status = 408;
  error.retryable = true;
  error.code = "REQUEST_TIMEOUT";
  error.recovery = "Check your connection, then retry the request.";
  return error;
}

function escapeHtmlAttribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getAuthToken() {
  if (isRestoreRehearsalMode()) {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
    return null;
  }
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

function setAuthToken(token) {
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
  if (!token) {
    setAccountContext(null);
  }
}

function setAccountContext(account, access = null) {
  if (isRestoreRehearsalMode()) {
    window.localStorage.removeItem(ACCOUNT_CONTEXT_KEY);
    return;
  }
  const previousContext = getAccountContext();
  const previousAccountId = previousContext?.id || null;
  const announceAccountChange = (accountId) => {
    if (typeof window.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") {
      return;
    }
    window.dispatchEvent(new window.CustomEvent("pintpath:account-context-changed", {
      detail: { previousAccountId, accountId },
    }));
  };
  if (!account || typeof account !== "object") {
    window.localStorage.removeItem(ACCOUNT_CONTEXT_KEY);
    if (previousAccountId) {
      announceAccountChange(null);
    }
    return;
  }

  const nextAccountId = account.id || null;
  const sameAccount = Boolean(nextAccountId && previousAccountId === nextAccountId);
  const hasAuthoritativeAdmin = typeof access?.isAdmin === "boolean";
  const hasAuthoritativeAdminAccount = typeof access?.isAdminAccount === "boolean";
  const authorityVerified = hasAuthoritativeAdmin
    || hasAuthoritativeAdminAccount
    || (sameAccount && previousContext?.authorityVerified === true);
  const isAdmin = hasAuthoritativeAdmin
    ? access.isAdmin === true
    : Boolean(sameAccount && previousContext?.isAdmin === true);
  const isAdminAccount = hasAuthoritativeAdminAccount
    ? access.isAdminAccount === true
    : hasAuthoritativeAdmin
      ? access.isAdmin === true
      : Boolean(sameAccount && previousContext?.isAdminAccount === true);
  const hasAuthoritativeCounterAssignments = Array.isArray(access?.counterStaffAssignments);
  const counterStaffAssignments = hasAuthoritativeCounterAssignments
    ? access.counterStaffAssignments
      .filter((assignment) => assignment?.capabilities?.openCounter === true && String(assignment.portalPath || "").startsWith("/venue-portal.html"))
      .slice(0, 20)
      .map((assignment) => ({
        venueId: String(assignment.venueId || ""),
        venueName: String(assignment.venueName || "Venue"),
        suburb: assignment.suburb ? String(assignment.suburb) : null,
        portalPath: String(assignment.portalPath),
      }))
    : sameAccount && Array.isArray(previousContext?.counterStaffAssignments)
      ? previousContext.counterStaffAssignments
      : [];
  window.localStorage.setItem(ACCOUNT_CONTEXT_KEY, JSON.stringify({
    id: nextAccountId,
    role: access?.accountRole || account.role || null,
    status: account.status || null,
    subscriptionStatus: account.subscriptionStatus || null,
    authProvider: account.authProvider || (sameAccount ? previousContext?.authProvider : null) || null,
    isAdmin,
    isAdminAccount,
    counterStaffAssignments,
    authorityVerified,
  }));
  if (previousAccountId !== nextAccountId) {
    announceAccountChange(nextAccountId);
  }
}

function getAccountContext() {
  if (isRestoreRehearsalMode()) {
    window.localStorage.removeItem(ACCOUNT_CONTEXT_KEY);
    return null;
  }
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
  const account = getAccountContext();
  return account?.authorityVerified === true && account?.role === "venue_manager";
}

function isAdminContext() {
  return getAccountContext()?.authorityVerified === true && getAccountContext()?.isAdmin === true;
}

function isAdminAccountContext() {
  const account = getAccountContext();
  return account?.authorityVerified === true && account?.isAdminAccount === true;
}

function canUseVenuePortalContext() {
  const account = getAccountContext();
  return account?.authorityVerified === true && (
    account.role === "venue_manager"
    || account.isAdmin === true
    || account.counterStaffAssignments?.length > 0
  );
}

function hasCachedSupabaseSession() {
  if (isRestoreRehearsalMode()) {
    clearCachedSupabaseSessions();
    return false;
  }
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

function clearCachedSupabaseSessions() {
  try {
    const keys = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) || "";
      if (isSupabaseSessionStorageKey(key)) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Best effort; Supabase signOut remains the primary local-session cleanup.
  }
}

function hasAuthenticatedSessionHint() {
  return Boolean(getAccountContext() || getAuthToken() || hasCachedSupabaseSession());
}

function getAccountScopeId() {
  const accountId = getAccountContext()?.id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
}

function getAccountScopedStorageKey(baseKey, accountId = getAccountScopeId()) {
  if (isRestoreRehearsalMode()) {
    return null;
  }
  if (!accountId) {
    return null;
  }
  return `${baseKey}:account:${encodeURIComponent(accountId)}`;
}

function getAccountScopedStorage(baseKey, options = {}) {
  const key = getAccountScopedStorageKey(baseKey, options.accountId);
  if (!key) {
    return null;
  }
  return window.localStorage.getItem(key);
}

function setAccountScopedStorage(baseKey, value, options = {}) {
  if (isRestoreRehearsalMode()) {
    throw new Error("Private device storage is disabled during the isolated restore rehearsal.");
  }
  const key = getAccountScopedStorageKey(baseKey, options.accountId);
  if (!key) {
    throw new Error("A verified account is required before saving private device data.");
  }
  window.localStorage.setItem(key, String(value));
  return key;
}

function removeAccountScopedStorage(baseKey, options = {}) {
  const key = getAccountScopedStorageKey(baseKey, options.accountId);
  if (key) {
    window.localStorage.removeItem(key);
  }
}

async function clearLocalSubmissionDeviceData(accountId = getAccountScopeId()) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) {
    return;
  }

  SUBMISSION_DEVICE_STORAGE_KEYS.forEach((key) => {
    removeAccountScopedStorage(key, { accountId: normalizedAccountId });
  });

  if (!("indexedDB" in window)) {
    return;
  }

  await new Promise((resolve, reject) => {
    const request = window.indexedDB.open(LOCAL_SUBMISSION_QUEUE_DB_NAME, LOCAL_SUBMISSION_QUEUE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_SUBMISSION_QUEUE_STORE_NAME)) {
        db.createObjectStore(LOCAL_SUBMISSION_QUEUE_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error || new Error("Could not open the local submission queue."));
    request.onblocked = () => reject(new Error("The local submission queue is open in another browser tab."));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(LOCAL_SUBMISSION_QUEUE_STORE_NAME, "readwrite");
      const store = transaction.objectStore(LOCAL_SUBMISSION_QUEUE_STORE_NAME);
      const readRequest = store.getAll();
      readRequest.onsuccess = () => {
        const submissions = Array.isArray(readRequest.result) ? readRequest.result : [];
        submissions
          .filter((submission) => submission?.ownerAccountId === normalizedAccountId)
          .forEach((submission) => store.delete(submission.id));
      };
      readRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("Could not clear local submission data."));
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error || readRequest.error || new Error("Could not clear local submission data."));
      };
    };
  });
}

function getAnonymousSessionId() {
  if (isRestoreRehearsalMode()) {
    window.localStorage.removeItem(ANON_SESSION_KEY);
    if (!restoreAnonymousSessionId) {
      restoreAnonymousSessionId = crypto.randomUUID();
    }
    return restoreAnonymousSessionId;
  }
  let value = window.localStorage.getItem(ANON_SESSION_KEY);

  if (!value) {
    value = crypto.randomUUID();
    window.localStorage.setItem(ANON_SESSION_KEY, value);
  }

  return value;
}

function readLocalConsentState() {
  try {
    return window.localStorage.getItem(CONSENT_STATE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocalConsentState(state) {
  try {
    window.localStorage.setItem(CONSENT_STATE_STORAGE_KEY, state);
    return true;
  } catch {
    return false;
  }
}

function readCookieConsentState() {
  try {
    if (typeof document === "undefined") return null;
    const prefix = `${CONSENT_STATE_COOKIE_NAME}=`;
    const matches = String(document.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(prefix));
    if (matches.length !== 1) return null;
    return matches[0].slice(prefix.length);
  } catch {
    return null;
  }
}

function writeCookieConsentState(state) {
  try {
    if (typeof document === "undefined") return false;
    const secure = window.location.protocol === "https:"
      || String(window.location.origin || "").startsWith("https://");
    document.cookie = `${CONSENT_STATE_COOKIE_NAME}=${state}; Path=/; SameSite=Lax; Max-Age=${CONSENT_COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
    return true;
  } catch {
    return false;
  }
}

function clearLegacyConsentPreferences() {
  [
    LEGACY_COOKIE_CONSENT_KEY,
    LEGACY_OPTIONAL_ANALYTICS_KEY,
    LEGACY_VENUE_REPORTS_KEY,
  ].forEach((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Legacy preferences are ignored even when browser storage cannot remove them.
    }
  });
}

function hasLegacyEssentialConsent() {
  try {
    return window.localStorage.getItem(LEGACY_COOKIE_CONSENT_KEY) === "essential"
      && window.localStorage.getItem(LEGACY_OPTIONAL_ANALYTICS_KEY) === "false"
      && window.localStorage.getItem(LEGACY_VENUE_REPORTS_KEY) === "false";
  } catch {
    return false;
  }
}

function readMirroredConsentState() {
  const localState = readLocalConsentState();
  const cookieState = readCookieConsentState();

  if (localState === CONSENT_STATE_ESSENTIAL || cookieState === CONSENT_STATE_ESSENTIAL) {
    return CONSENT_STATE_ESSENTIAL;
  }

  if (
    (localState === CONSENT_STATE_OPTIONAL || localState === CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS)
    && localState === cookieState
  ) {
    return localState;
  }

  return null;
}

function persistEssentialConsent() {
  pageLocalConsentDenied = true;
  writeLocalConsentState(CONSENT_STATE_ESSENTIAL);
  writeCookieConsentState(CONSENT_STATE_ESSENTIAL);
  readLocalConsentState();
  readCookieConsentState();
  clearLegacyConsentPreferences();
}

function persistOptionalConsent(state) {
  const localWriteSucceeded = writeLocalConsentState(state);
  const cookieWriteSucceeded = writeCookieConsentState(state);
  const localState = readLocalConsentState();
  const cookieState = readCookieConsentState();

  if (
    localWriteSucceeded
    && cookieWriteSucceeded
    && localState === state
    && cookieState === state
  ) {
    pageLocalConsentDenied = false;
    clearLegacyConsentPreferences();
    return;
  }

  persistEssentialConsent();
}

function getEffectiveConsentState() {
  if (pageLocalConsentDenied) {
    return CONSENT_STATE_ESSENTIAL;
  }

  const state = readMirroredConsentState();
  if (state) return state;

  if (hasLegacyEssentialConsent()) {
    persistEssentialConsent();
    return CONSENT_STATE_ESSENTIAL;
  }

  return null;
}

function getCookieConsentDecision() {
  const state = getEffectiveConsentState();
  if (state === CONSENT_STATE_ESSENTIAL) return "essential";
  if (state === CONSENT_STATE_OPTIONAL || state === CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS) return "optional";
  return null;
}

function hasAnalyticsConsent() {
  const state = getEffectiveConsentState();
  return state === CONSENT_STATE_OPTIONAL || state === CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS;
}

function hasVenueReportConsent() {
  return getEffectiveConsentState() === CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS;
}

function setCookieConsentDecision(decision) {
  if (decision === "optional") {
    persistOptionalConsent(CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS);
    return;
  }
  persistEssentialConsent();
}

function setPrivacyPreferenceCache(settings = {}, options = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
  if (!Object.prototype.hasOwnProperty.call(settings, "optionalAnalyticsEnabled")) return;
  if (settings.optionalAnalyticsEnabled !== true) {
    persistEssentialConsent();
    return;
  }
  if (
    settings.venueReportInclusionEnabled !== true
    && settings.venueReportInclusionEnabled !== false
  ) {
    persistEssentialConsent();
    return;
  }
  const existingState = getEffectiveConsentState();
  const alreadyOptional = existingState === CONSENT_STATE_OPTIONAL
    || existingState === CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS;
  if (!alreadyOptional && options.allowOptionalPromotion !== true) return;
  persistOptionalConsent(
    settings.venueReportInclusionEnabled === true
      ? CONSENT_STATE_OPTIONAL_WITH_VENUE_REPORTS
      : CONSENT_STATE_OPTIONAL,
  );
}

function getViewerConfig() {
  return window.MELB_BEER_BOT_VIEWER_CONFIG || {};
}

function getBusinessConfig() {
  return getViewerConfig().business || {};
}

function decodeCanonicalBase64Url(value) {
  if (
    !SUPABASE_LEGACY_JWT_SEGMENT_PATTERN.test(value)
    || value.length % 4 === 1
    || typeof atob !== "function"
    || typeof btoa !== "function"
  ) return null;
  try {
    const paddedValue = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
    const decoded = atob(paddedValue);
    const canonical = btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    if (!decoded || canonical !== value) return null;
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isPlainJsonObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isLegacySupabaseAnonKey(value) {
  if (typeof value !== "string" || typeof TextDecoder !== "function") return false;
  const segments = value.split(".");
  if (segments.length !== 3) return false;
  const headerBytes = decodeCanonicalBase64Url(segments[0]);
  const payloadBytes = decodeCanonicalBase64Url(segments[1]);
  const signatureBytes = decodeCanonicalBase64Url(segments[2]);
  if (!headerBytes || !payloadBytes || signatureBytes?.byteLength !== 32) return false;

  try {
    const decoder = new TextDecoder();
    const header = JSON.parse(decoder.decode(headerBytes));
    const payload = JSON.parse(decoder.decode(payloadBytes));
    return isPlainJsonObject(header)
      && header.alg === "HS256"
      && header.typ === "JWT"
      && isPlainJsonObject(payload)
      && payload.role === "anon";
  } catch {
    return false;
  }
}

function isSupportedBrowserSupabaseKey(value) {
  return typeof value === "string"
    && (SUPABASE_PUBLISHABLE_KEY_PATTERN.test(value) || isLegacySupabaseAnonKey(value));
}

function isSupportedBrowserSupabaseOrigin(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  if (window.location.origin === PRODUCTION_VIEWER_ORIGIN) {
    return value === PRODUCTION_SUPABASE_ORIGIN;
  }
  try {
    const candidate = new URL(value);
    if (candidate.origin !== value) return false;
    return candidate.protocol === "https:" || (
      candidate.protocol === "http:"
      && isLocalOrigin()
      && isLocalOrigin(candidate.origin)
    );
  } catch {
    return false;
  }
}

function supabaseConfigSource() {
  const config = getViewerConfig();
  const business = getBusinessConfig();
  const businessDefinesSupabase = Object.prototype.hasOwnProperty.call(business, "supabaseUrl")
    || Object.prototype.hasOwnProperty.call(business, "supabaseAnonKey");
  return businessDefinesSupabase ? business : config;
}

function createBrowserSupabaseFetch(apiKey) {
  const usesPublishableKey = SUPABASE_PUBLISHABLE_KEY_PATTERN.test(apiKey);
  return async (input, init) => {
    if (!usesPublishableKey) {
      return fetch(input, { ...init, redirect: "error" });
    }
    const sourceHeaders = init?.headers || (
      typeof Request !== "undefined" && input instanceof Request
        ? input.headers
        : null
    );
    if (!sourceHeaders) {
      return fetch(input, { ...init, redirect: "error" });
    }
    const headers = new Headers(sourceHeaders);
    if (
      headers.get("apikey") !== apiKey
      || headers.get("authorization") !== `Bearer ${apiKey}`
    ) {
      return fetch(input, { ...init, redirect: "error" });
    }
    headers.delete("authorization");
    return fetch(input, { ...init, headers, redirect: "error" });
  };
}

function isLocalOrigin(origin = window.location.origin) {
  try {
    const hostname = new URL(origin).hostname;
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function getCanonicalBaseUrl() {
  if (window.location.origin === PRODUCTION_VIEWER_ORIGIN) {
    return PRODUCTION_VIEWER_ORIGIN;
  }
  // OAuth, signup, and recovery callbacks are credentials. Bind every
  // non-production callback to the viewer that initiated the flow rather than
  // trusting mutable public configuration to nominate another origin.
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

function isVenuePortalReturnPath(value = null) {
  const path = String(value || "").trim();
  return /^\/venue-portal(?:\.html)?(?:[?#]|$)/.test(path);
}

function getAuthReturnPathFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const cachedReturnPath = isRestoreRehearsalMode() ? null : window.localStorage.getItem(AUTH_RETURN_KEY);
  return getSafeReturnPath(params.get("next") || params.get("returnTo") || cachedReturnPath);
}

function storeSensitiveAuthReturnPath(value) {
  if (isRestoreRehearsalMode()) {
    clearSensitiveAuthReturnState();
    return null;
  }
  const safePath = getSafeReturnPath(value);
  if (!isVenuePortalReturnPath(safePath)) return null;
  window.sessionStorage.setItem(SENSITIVE_AUTH_RETURN_KEY, JSON.stringify({ path: safePath, createdAt: Date.now() }));
  return safePath;
}

function consumeSensitiveAuthReturnPath() {
  if (isRestoreRehearsalMode()) {
    clearSensitiveAuthReturnState();
    return null;
  }
  const stored = window.sessionStorage.getItem(SENSITIVE_AUTH_RETURN_KEY);
  window.sessionStorage.removeItem(SENSITIVE_AUTH_RETURN_KEY);
  if (!stored) return null;
  let record;
  try {
    record = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!record?.path || !Number.isFinite(record.createdAt) || Date.now() - record.createdAt > SENSITIVE_AUTH_RETURN_MAX_AGE_MS) return null;
  const safePath = getSafeReturnPath(record.path);
  if (!isVenuePortalReturnPath(safePath)) return null;
  const url = new URL(safePath, window.location.origin);
  const fragmentParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const discountCode = url.searchParams.get("discountCode") || fragmentParams.get("discountCode");
  const freePintCode = url.searchParams.get("freePintCode") || fragmentParams.get("freePintCode");
  if (discountCode || freePintCode) {
    window.sessionStorage.setItem(PENDING_PORTAL_REDEMPTION_KEY, JSON.stringify({
      discountCode,
      freePintCode,
      venueId: url.searchParams.get("venueId") || fragmentParams.get("venueId"),
      createdAt: Date.now(),
    }));
    url.searchParams.delete("discountCode");
    url.searchParams.delete("freePintCode");
    fragmentParams.delete("discountCode");
    fragmentParams.delete("freePintCode");
    url.hash = fragmentParams.toString();
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function consumePendingPortalRedemption() {
  if (isRestoreRehearsalMode()) {
    window.sessionStorage.removeItem(PENDING_PORTAL_REDEMPTION_KEY);
    return null;
  }
  const stored = window.sessionStorage.getItem(PENDING_PORTAL_REDEMPTION_KEY);
  window.sessionStorage.removeItem(PENDING_PORTAL_REDEMPTION_KEY);
  if (!stored) return null;
  try {
    const record = JSON.parse(stored);
    if (!Number.isFinite(record?.createdAt) || Date.now() - record.createdAt > SENSITIVE_AUTH_RETURN_MAX_AGE_MS) return null;
    return {
      discountCode: record.discountCode ? String(record.discountCode) : null,
      freePintCode: record.freePintCode ? String(record.freePintCode) : null,
      venueId: record.venueId ? String(record.venueId) : null,
    };
  } catch {
    return null;
  }
}

function clearSensitiveAuthReturnState() {
  window.sessionStorage.removeItem(SENSITIVE_AUTH_RETURN_KEY);
  window.sessionStorage.removeItem(PENDING_PORTAL_REDEMPTION_KEY);
}

function createAuthFlowNonce() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure sign-in flow generation is unavailable in this browser.");
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeAuthFlowState(record) {
  if (!record || typeof record !== "object") return null;
  const createdAt = Number(record.createdAt);
  const nonce = String(record.nonce || "").trim();
  const kind = String(record.kind || "").trim().toLowerCase();
  const now = Date.now();
  if (
    !nonce
    || !Number.isFinite(createdAt)
    || createdAt > now + 60_000
    || now - createdAt > AUTH_FLOW_MAX_AGE_MS
    || !["oauth", "signup", "password_recovery"].includes(kind)
  ) return null;
  return {
    nonce,
    returnTo: getSafeReturnPath(record.returnTo || "/account.html"),
    kind,
    createdAt,
  };
}

function storeAuthFlowState(input = {}) {
  if (isRestoreRehearsalMode()) {
    clearAuthFlowState();
    return null;
  }
  const record = normalizeAuthFlowState({
    nonce: input.nonce || createAuthFlowNonce(),
    returnTo: input.returnTo || "/account.html",
    kind: input.kind || "oauth",
    createdAt: Date.now(),
  });
  if (!record) throw new Error("Secure sign-in flow generation failed.");
  window.localStorage.setItem(AUTH_FLOW_KEY, JSON.stringify(record));
  return record;
}

function peekAuthFlowState() {
  if (isRestoreRehearsalMode()) {
    clearAuthFlowState();
    return null;
  }
  const raw = window.localStorage.getItem(AUTH_FLOW_KEY);
  if (!raw) return null;
  try {
    const record = normalizeAuthFlowState(JSON.parse(raw));
    if (!record) clearAuthFlowState();
    return record;
  } catch {
    clearAuthFlowState();
    return null;
  }
}

function consumeAuthFlowState() {
  const record = peekAuthFlowState();
  window.localStorage.removeItem(AUTH_FLOW_KEY);
  return record;
}

function clearSupabaseOAuthFlowStorage() {
  const ownedKeys = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key === OAUTH_PKCE_STORAGE_KEY || key?.startsWith(`${OAUTH_PKCE_STORAGE_KEY}-`)) {
      ownedKeys.push(key);
    }
  }
  ownedKeys.forEach((key) => window.localStorage.removeItem(key));
}

function clearAuthFlowState() {
  window.localStorage.removeItem(AUTH_FLOW_KEY);
}

function getAuthCallbackUrl() {
  return new URL("/auth/callback", getCanonicalBaseUrl()).toString();
}

function recoverMisroutedAuthCallback() {
  if (isRestoreRehearsalMode() || window.location.pathname === "/auth/callback") return false;
  if (!["/", "/index.html"].includes(window.location.pathname)) return false;
  const query = new URLSearchParams(window.location.search || "");
  const hash = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
  const hasAuthResult = Boolean(
    query.get("code")
    || query.get("error")
    || query.get("error_description")
    || hash.get("access_token")
    || hash.get("error")
    || hash.get("error_description")
  );
  if (!hasAuthResult) return false;

  // A PKCE code is only useful in the browser that started the flow and holds
  // the verifier. Implicit email verification/recovery links can be opened on
  // another device and are still safe to recover from the site-root fallback.
  if (query.get("code") && !peekAuthFlowState()) return false;
  const destination = new URL("/auth/callback", getCanonicalBaseUrl());
  destination.search = window.location.search || "";
  destination.hash = window.location.hash || "";
  window.location.replace(destination.toString());
  return true;
}

recoverMisroutedAuthCallback();

function legalAcceptancePayload(input = {}) {
  return {
    ageConfirmed: Boolean(input.ageConfirmed),
    termsAccepted: Boolean(input.termsAccepted),
    privacyAccepted: Boolean(input.privacyAccepted),
    termsVersion: input.termsVersion || LEGAL_POLICY_VERSION,
    privacyVersion: input.privacyVersion || LEGAL_POLICY_VERSION,
  };
}

function hasCurrentLegalAcceptance(account) {
  return Boolean(
    account?.termsAcceptedAt &&
    account?.privacyAcceptedAt &&
    account?.termsVersion === LEGAL_POLICY_VERSION &&
    account?.privacyVersion === LEGAL_POLICY_VERSION
  );
}

function setPendingLegalAcceptance(input) {
  if (isRestoreRehearsalMode()) {
    clearPendingLegalAcceptance();
    return;
  }
  window.localStorage.setItem(LEGAL_ACCEPTANCE_KEY, JSON.stringify({
    ...legalAcceptancePayload(input),
    expectedEmail: String(input.expectedEmail || "").trim().toLowerCase() || null,
    expectedProvider: String(input.expectedProvider || "").trim().toLowerCase() || null,
    authFlowNonce: String(input.authFlowNonce || "").trim() || null,
    createdAt: new Date().toISOString(),
  }));
}

function clearPendingLegalAcceptance() {
  window.localStorage.removeItem(LEGAL_ACCEPTANCE_KEY);
}

function getPendingLegalAcceptance() {
  if (isRestoreRehearsalMode()) {
    clearPendingLegalAcceptance();
    return null;
  }
  const raw = window.localStorage.getItem(LEGAL_ACCEPTANCE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const createdAt = Date.parse(parsed?.createdAt || "");
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > LEGAL_ACCEPTANCE_MAX_AGE_MS) {
      clearPendingLegalAcceptance();
      return null;
    }
    return {
      ...legalAcceptancePayload(parsed),
      expectedEmail: String(parsed.expectedEmail || "").trim().toLowerCase() || null,
      expectedProvider: String(parsed.expectedProvider || "").trim().toLowerCase() || null,
      authFlowNonce: String(parsed.authFlowNonce || "").trim() || null,
    };
  } catch {
    clearPendingLegalAcceptance();
    return null;
  }
}

function supabaseSessionProvider(session) {
  const directProvider = String(session?.user?.app_metadata?.provider || "").trim().toLowerCase();
  if (directProvider) return directProvider;
  const identityProvider = session?.user?.identities
    ?.map((identity) => String(identity?.provider || "").trim().toLowerCase())
    .find(Boolean);
  return identityProvider || null;
}

async function getVerifiedSupabaseUser(client, accessToken) {
  if (typeof client?.auth?.getUser !== "function") {
    throw new Error("Your sign-in client cannot verify the current identity. Refresh Pint Path and sign in again.");
  }
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data?.user) {
    throw new Error(error?.message || "Your signed-in identity could not be verified. Sign in again and retry.");
  }
  return data.user;
}

async function setPendingLegalAcceptanceForCurrentSession(input, options = {}) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase login is not configured for this environment.");
  const { data, error } = await client.auth.getSession();
  const session = data?.session;
  if (error || !session?.access_token || !session.user) {
    throw new Error(error?.message || "Your provider session expired. Sign in again before accepting the current policies.");
  }
  const verifiedUser = await getVerifiedSupabaseUser(client, session.access_token);
  const authFlowNonce = String(options.authFlowNonce || "").trim() || createAuthFlowNonce();
  const expectedEmail = String(verifiedUser.email || "").trim().toLowerCase() || null;
  const expectedProvider = supabaseSessionProvider({ user: verifiedUser });
  if (!expectedEmail && !expectedProvider) {
    throw new Error("Your signed-in identity could not be verified for policy acceptance. Sign in again and retry.");
  }
  setPendingLegalAcceptance({
    ...input,
    expectedEmail,
    expectedProvider,
    authFlowNonce,
  });
  return { authFlowNonce };
}

function getSupabaseConfig() {
  if (isRestoreRehearsalMode()) {
    return { url: null, anonKey: null };
  }
  const source = supabaseConfigSource();
  const configuredUrl = source.supabaseUrl;
  const configuredKey = source.supabaseAnonKey;
  if (
    !isSupportedBrowserSupabaseOrigin(configuredUrl)
    || !isSupportedBrowserSupabaseKey(configuredKey)
  ) {
    return { url: null, anonKey: null };
  }
  return {
    url: configuredUrl,
    anonKey: configuredKey,
  };
}

function getSupabaseOauthProviders() {
  if (isRestoreRehearsalMode()) {
    return [];
  }
  const config = getViewerConfig();
  const business = getBusinessConfig();
  const providers = business.supabaseOauthProviders || config.supabaseOauthProviders || ["google"];
  return Array.isArray(providers) ? providers : String(providers).split(",").map((provider) => provider.trim()).filter(Boolean);
}

function getSupabaseClient() {
  if (isRestoreRehearsalMode()) {
    clearCachedSupabaseSessions();
    window.__melbBeerSupabaseClient = null;
    return null;
  }
  const config = getSupabaseConfig();
  if (!window.supabase || !config.url || !config.anonKey) {
    return null;
  }

  if (!window.__melbBeerSupabaseClient) {
    window.__melbBeerSupabaseClient = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        flowType: "implicit",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        fetch: createBrowserSupabaseFetch(config.anonKey),
      },
    });

    if (isLocalOrigin() && !window.__melbBeerSupabaseAuthDebugInstalled) {
      window.__melbBeerSupabaseAuthDebugInstalled = true;
      window.__melbBeerSupabaseClient.auth.onAuthStateChange((event, session) => {
        console.debug("[Pint Path auth]", {
          event,
          hasSession: Boolean(session?.user?.id),
        });
      });
    }
  }

  return window.__melbBeerSupabaseClient;
}

function getSupabaseOAuthClient() {
  if (isRestoreRehearsalMode()) {
    clearSupabaseOAuthFlowStorage();
    window.__pintPathSupabaseOAuthClient = null;
    return null;
  }
  const config = getSupabaseConfig();
  if (!window.supabase || !config.url || !config.anonKey) return null;
  if (!window.__pintPathSupabaseOAuthClient) {
    window.__pintPathSupabaseOAuthClient = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: OAUTH_PKCE_STORAGE_KEY,
      },
      global: {
        fetch: createBrowserSupabaseFetch(config.anonKey),
      },
    });
  }
  return window.__pintPathSupabaseOAuthClient;
}

function isFieldTestMode() {
  return Boolean(getBusinessConfig().fieldTestMode);
}

async function apiFetch(path, options = {}) {
  await migrateLegacySessionCookie(path);
  const {
    timeoutMs = API_REQUEST_TIMEOUT_MS,
    signal: callerSignal = null,
    ...fetchOptions
  } = options;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const token = getAuthToken();

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const deadline = createFetchDeadline(timeoutMs, callerSignal);
  let response;
  let payload;
  try {
    response = await fetch(path, {
      ...fetchOptions,
      headers,
      credentials: "same-origin",
      signal: deadline.signal,
      redirect: "error",
    });
    payload = await response.json().catch((error) => {
      if (deadline.timedOut()) throw error;
      return null;
    });
    if (deadline.timedOut()) {
      throw requestTimeoutError();
    }
  } catch (error) {
    if (deadline.timedOut()) {
      throw requestTimeoutError();
    }
    throw error;
  } finally {
    deadline.clear();
  }

  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message || payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    error.details = payload?.error?.details || payload?.details || null;
    error.code = payload?.error?.code || null;
    error.recovery = payload?.error?.recovery || null;
    throw error;
  }

  const data = payload.data;
  const requestPath = String(path).split("?", 1)[0];
  if (data?.account && (
    requestPath === "/api/business/account"
    || data.access
    || typeof data.isAdmin === "boolean"
  )) {
    const authorityBase = data.access || (typeof data.isAdmin === "boolean" ? { isAdmin: data.isAdmin } : null);
    const authority = authorityBase
      ? { ...authorityBase, ...(Array.isArray(data.counterStaffAssignments) ? { counterStaffAssignments: data.counterStaffAssignments } : {}) }
      : null;
    setAccountContext(data.account, authority);
  }
  return data;
}

let currentPasswordDialogPromise = null;

function requestCurrentPassword() {
  if (currentPasswordDialogPromise) return currentPasswordDialogPromise;
  currentPasswordDialogPromise = new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "reauthPasswordDialog panel";
    dialog.setAttribute("aria-labelledby", "reauthPasswordTitle");
    dialog.setAttribute("aria-describedby", "reauthPasswordCopy");
    dialog.innerHTML = `
      <form method="dialog" class="form">
        <div>
          <div class="eyebrow">Security check</div>
          <h2 id="reauthPasswordTitle">Confirm your current password</h2>
          <p id="reauthPasswordCopy" class="muted">Pint Path uses it only for this sensitive request and never stores it.</p>
        </div>
        <label class="field">Current password
          <input name="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <div class="actionRow">
          <button class="button" type="button" data-reauth-cancel>Cancel</button>
          <button class="button button--primary" type="submit">Continue securely</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const input = dialog.querySelector('[name="currentPassword"]');
      if (input) input.value = "";
      dialog.remove();
      currentPasswordDialogPromise = null;
      resolve(value);
    };
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get("currentPassword") || "");
      finish(value || null);
    });
    dialog.querySelector("[data-reauth-cancel]").addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector('[name="currentPassword"]')?.focus();
  });
  return currentPasswordDialogPromise;
}

async function sensitiveApiFetch(path, options = {}) {
  const client = getSupabaseClient();
  const { data, error } = client ? await client.auth.getSession() : { data: null, error: null };
  const accessToken = data?.session?.access_token;
  if (error) {
    throw new Error(error.message || "Sign in again before using this sensitive account action.");
  }
  const headers = { ...(options.headers || {}) };
  if (accessToken) {
    headers["X-Pint-Path-Reauth-Token"] = accessToken;
  } else {
    const authProvider = String(getAccountContext()?.authProvider || "").toLowerCase();
    if (["supabase", "google", "apple"].includes(authProvider)) {
      throw new Error("Your provider session is no longer available. Sign out, sign back in, then retry this sensitive action.");
    }
    const password = await requestCurrentPassword();
    if (!password) {
      throw new Error("Current password confirmation is required for this sensitive action.");
    }
    headers["X-Pint-Path-Current-Password"] = password;
  }
  try {
    return await apiFetch(path, { ...options, headers });
  } catch (requestError) {
    if (requestError?.details?.reauthenticationRequired) {
      requestError.message = `${requestError.message} Sign out, sign back in or complete MFA, then retry.`;
    }
    throw requestError;
  }
}

let legacySessionMigrationPromise = null;

async function migrateLegacySessionCookie(path = "") {
  const token = getAuthToken();
  if (!token || path === "/api/business/auth/session-cookie") return;
  if (!legacySessionMigrationPromise) {
    const deadline = createFetchDeadline(LEGACY_SESSION_MIGRATION_TIMEOUT_MS);
    legacySessionMigrationPromise = fetch("/api/business/auth/session-cookie", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      credentials: "same-origin",
      body: "{}",
      signal: deadline.signal,
      redirect: "error",
    }).then((response) => {
      if (response.ok) window.localStorage.removeItem(AUTH_TOKEN_KEY);
    }).catch(() => null).finally(() => deadline.clear());
  }
  await legacySessionMigrationPromise;
}

async function syncSupabaseSession(options = {}) {
  if (isRestoreRehearsalMode()) {
    await prepareRestoreIsolation();
    setAuthToken(null);
    setAccountContext(null);
    clearPendingLegalAcceptance();
    return { configured: false, synced: false, restoreRehearsal: true };
  }
  const client = getSupabaseClient();
  if (!client) {
    return { configured: false, synced: false };
  }

  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) {
    return { configured: true, synced: false, error: error?.message || null };
  }

  const pendingAcceptance = options.applyPendingLegalAcceptance ? getPendingLegalAcceptance() : null;
  const hasCompletePendingAcceptance = Boolean(
    pendingAcceptance?.ageConfirmed &&
    pendingAcceptance?.termsAccepted &&
    pendingAcceptance?.privacyAccepted
  );
  if (hasCompletePendingAcceptance) {
    const verifiedUser = await getVerifiedSupabaseUser(client, data.session.access_token);
    const sessionEmail = String(verifiedUser.email || "").trim().toLowerCase() || null;
    const sessionProvider = supabaseSessionProvider({ user: verifiedUser });
    const flowMatches = Boolean(
      pendingAcceptance.authFlowNonce
      && String(options.authFlowNonce || "").trim() === pendingAcceptance.authFlowNonce
    );
    const emailMatches = !pendingAcceptance.expectedEmail || pendingAcceptance.expectedEmail === sessionEmail;
    const providerMatches = !pendingAcceptance.expectedProvider || pendingAcceptance.expectedProvider === sessionProvider;
    const isBoundAcceptance = Boolean(
      pendingAcceptance.authFlowNonce
      && (pendingAcceptance.expectedEmail || pendingAcceptance.expectedProvider)
    );
    if (!isBoundAcceptance || !flowMatches || !emailMatches || !providerMatches) {
      clearPendingLegalAcceptance();
      const mismatchError = new Error("Signup acceptance did not match this signed-in identity. Review the current policies again for this account.");
      mismatchError.status = 409;
      mismatchError.legalAcceptanceMismatch = true;
      throw mismatchError;
    }
  }
  let result;
  try {
    result = await apiFetch("/api/business/auth/supabase-session", {
      method: "POST",
      body: JSON.stringify({
        accessToken: data.session.access_token,
        ...(hasCompletePendingAcceptance ? {
          ageConfirmed: true,
          termsAccepted: true,
          privacyAccepted: true,
          termsVersion: pendingAcceptance.termsVersion,
          privacyVersion: pendingAcceptance.privacyVersion,
          consentSource: "web_oauth",
        } : {}),
      }),
    });
  } catch (error) {
    const providerSessionRejected = Number(error?.status) === 401
      && /provider session (?:was revoked|is missing its session identifier)/i.test(String(error?.message || ""));
    if (providerSessionRejected) {
      await client.auth.signOut({ scope: "local" }).catch(() => null);
      clearCachedSupabaseSessions();
      clearPendingLegalAcceptance();
      window.__melbBeerSupabaseClient = null;
      setAuthToken(null);
      setAccountContext(null);
    }
    throw error;
  }
  setAuthToken(result.token);
  setAccountContext(result.account, result.access);
  clearPendingLegalAcceptance();
  return { configured: true, synced: true, account: result.account };
}

async function signInWithOAuth(provider, options = {}) {
  const client = getSupabaseOAuthClient();
  if (!client) {
    throw new Error("Supabase login is not configured for this environment.");
  }

  const scopesByProvider = {
    google: "email profile",
    apple: "name email",
  };

  const returnTo = getSafeReturnPath(options.returnTo || getAuthReturnPathFromLocation());
  window.localStorage.setItem(AUTH_RETURN_KEY, returnTo);
  clearPendingLegalAcceptance();
  const authFlowNonce = createAuthFlowNonce();
  storeAuthFlowState({
    nonce: authFlowNonce,
    returnTo,
    kind: "oauth",
  });

  try {
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: getAuthCallbackUrl(),
        scopes: scopesByProvider[provider] || "email",
      },
    });

    if (error) {
      throw new Error(error.message);
    }
  } catch (error) {
    clearPendingLegalAcceptance();
    clearAuthFlowState();
    clearSupabaseOAuthFlowStorage();
    window.localStorage.removeItem(AUTH_RETURN_KEY);
    throw error;
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

  clearAuthFlowState();
  clearSupabaseOAuthFlowStorage();
  return syncSupabaseSession();
}

async function signUpWithEmail(email, password, ageConfirmed, termsAccepted, privacyAccepted, displayName = null) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase email signup is not configured for this environment.");
  }

  const acceptance = legalAcceptancePayload({ ageConfirmed, termsAccepted, privacyAccepted });
  if (!acceptance.ageConfirmed || !acceptance.termsAccepted || !acceptance.privacyAccepted) {
    throw new Error("Confirm you are 18+ and accept the current Terms and Privacy Policy before creating an account.");
  }

  const returnTo = getAuthReturnPathFromLocation();
  window.localStorage.setItem(AUTH_RETURN_KEY, returnTo);
  clearPendingLegalAcceptance();
  const authFlowNonce = createAuthFlowNonce();
  storeAuthFlowState({
    nonce: authFlowNonce,
    returnTo,
    kind: "signup",
  });
  // Consent is held briefly on this browser and sent to Pint Path's server after
  // Supabase proves the identity. Supabase user_metadata is editable and is not
  // used as evidence of age or legal acceptance.
  setPendingLegalAcceptance({
    ...acceptance,
    expectedEmail: String(email || "").trim().toLowerCase(),
    expectedProvider: "email",
    authFlowNonce,
  });

  let data;
  try {
    const signup = await client.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: getAuthCallbackUrl(),
        data: {
          display_name: displayName || undefined,
          full_name: displayName || undefined,
        },
      },
    });
    if (signup.error) throw new Error(signup.error.message);
    data = signup.data;
  } catch (error) {
    clearPendingLegalAcceptance();
    clearAuthFlowState();
    window.localStorage.removeItem(AUTH_RETURN_KEY);
    throw error;
  }

  if (data.session?.access_token) {
    try {
      const synced = await syncSupabaseSession({ applyPendingLegalAcceptance: true, authFlowNonce });
      return { ...synced, needsEmailConfirmation: false };
    } finally {
      clearAuthFlowState();
      window.localStorage.removeItem(AUTH_RETURN_KEY);
    }
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

  const returnTo = "/account.html";
  const authFlowNonce = createAuthFlowNonce();
  window.localStorage.setItem(AUTH_RETURN_KEY, returnTo);
  storeAuthFlowState({ nonce: authFlowNonce, returnTo, kind: "signup" });
  const pendingAcceptance = getPendingLegalAcceptance();
  if (pendingAcceptance) {
    setPendingLegalAcceptance({ ...pendingAcceptance, authFlowNonce });
  }

  try {
    const { error } = await client.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: getAuthCallbackUrl(),
      },
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    clearAuthFlowState();
    window.localStorage.removeItem(AUTH_RETURN_KEY);
    throw error;
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

  const returnTo = "/reset-password.html?mode=update";
  const authFlowNonce = createAuthFlowNonce();
  window.localStorage.setItem(AUTH_RETURN_KEY, returnTo);
  storeAuthFlowState({ nonce: authFlowNonce, returnTo, kind: "password_recovery" });

  try {
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: getAuthCallbackUrl(),
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    clearAuthFlowState();
    window.localStorage.removeItem(AUTH_RETURN_KEY);
    throw error;
  }

  return {
    message: "If an account exists for that email, a secure reset link has been sent.",
  };
}

function markPasswordRecoverySession(accountId = getAccountScopeId()) {
  if (isRestoreRehearsalMode()) {
    window.sessionStorage.removeItem(PASSWORD_RECOVERY_KEY);
    throw new Error("Password recovery is disabled during the isolated restore rehearsal.");
  }
  if (!accountId) {
    throw new Error("A verified recovery account is required.");
  }
  window.sessionStorage.setItem(PASSWORD_RECOVERY_KEY, JSON.stringify({
    accountId,
    createdAt: new Date().toISOString(),
  }));
}

function hasPasswordRecoverySession() {
  if (isRestoreRehearsalMode()) {
    window.sessionStorage.removeItem(PASSWORD_RECOVERY_KEY);
    return false;
  }
  try {
    const value = JSON.parse(window.sessionStorage.getItem(PASSWORD_RECOVERY_KEY) || "null");
    const createdAt = Date.parse(value?.createdAt || "");
    if (
      !Number.isFinite(createdAt) ||
      Date.now() - createdAt > PASSWORD_RECOVERY_MAX_AGE_MS ||
      !value?.accountId ||
      value.accountId !== getAccountScopeId()
    ) {
      window.sessionStorage.removeItem(PASSWORD_RECOVERY_KEY);
      return false;
    }
    return true;
  } catch {
    window.sessionStorage.removeItem(PASSWORD_RECOVERY_KEY);
    return false;
  }
}

async function validatePasswordRecoverySession() {
  if (!hasPasswordRecoverySession()) {
    return false;
  }
  const client = getSupabaseClient();
  if (!client) {
    return false;
  }
  const { data, error } = await client.auth.getSession();
  return !error && Boolean(data.session?.access_token);
}

async function updatePassword(password) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Password reset is available when Supabase Auth is configured.");
  }

  if (!hasPasswordRecoverySession()) {
    throw new Error("Open the latest password reset email before setting a new password.");
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

  try {
    await apiFetch("/api/business/auth/password-reset-complete", {
      method: "POST",
      body: JSON.stringify({ accessToken: sessionData.session.access_token }),
    });
  } catch (completionError) {
    throw new Error(
      `Your password changed, but Pint Path could not close every existing session. Keep this page open and retry before signing in elsewhere. ${completionError?.message || "Session cleanup failed."}`,
    );
  }

  await client.auth.signOut({ scope: "global" }).catch(() => null);
  clearCachedSupabaseSessions();
  clearPendingLegalAcceptance();
  setAuthToken(null);
  window.sessionStorage.removeItem(PASSWORD_RECOVERY_KEY);
  return {
    message: "Password updated. Every Pint Path session was signed out; sign in again with your new password.",
    reauthenticationRequired: true,
  };
}

function isIOSLegalSurface() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const isLegalPath = ["/terms", "/terms.html", "/privacy", "/privacy.html"].includes(path);
  return isLegalPath && new URLSearchParams(window.location.search).get("source") === "ios_app";
}

function renderIOSLegalNav() {
  return `
    <nav class="topNav" aria-label="Pint Path legal information">
      <span class="brand" aria-label="Pint Path">
        <img class="brandLogo" src="/assets/pint-path-icon-192.png" alt="" width="36" height="36" aria-hidden="true" />
        <span class="brandText"><strong>Pint Path</strong></span>
      </span>
      <div class="navLinks">
        <a href="mailto:admin@pintpath.au">Contact support</a>
      </div>
    </nav>
  `;
}

function renderNav(active = "") {
  const accountContext = getAccountContext();
  const counterPortalPath = accountContext?.authorityVerified === true
    ? accountContext.counterStaffAssignments?.[0]?.portalPath || null
    : null;
  const counterOnlyPortalPath = isVenueManagerContext() || isAdminContext()
    ? null
    : counterPortalPath;
  const venueManagerNav = active === "venue-portal" || active === "venue-support" || active === "bar-faq" || isVenueManagerContext() || Boolean(counterPortalPath);
  const venuePortalNav = canUseVenuePortalContext();
  const adminNav = active === "admin" || isAdminAccountContext();
  const activeKey = active === "trust" || active === "bar-faq"
    ? "faq"
    : active === "venue-support"
      ? "feedback"
      : active;
  const betaPill = isFieldTestMode() ? '<span class="betaPill">Beta field test</span>' : "";
  const navItems = [
    { key: "map", href: "/", label: "Map" },
    ...(venuePortalNav ? [{ key: "venue-portal", href: counterOnlyPortalPath || "/venue-portal.html", label: counterOnlyPortalPath ? "Counter" : "Dashboard" }] : []),
    { key: "submit", href: "/submit.html", label: "Submit" },
    { key: "missions", href: "/missions.html", label: "Missions" },
    ...(adminNav ? [{ key: "admin", href: "/admin.html", label: "Admin" }] : []),
    { key: "pricing", href: "/pricing.html", label: "Pricing" },
    { key: "faq", href: venueManagerNav ? "/trust.html?audience=bars" : "/trust.html", label: "FAQ" },
    { key: "account", href: "/account.html", label: "Account" },
    { key: "feedback", href: venueManagerNav ? "/feedback.html?audience=bars" : "/feedback.html", label: "Contact us" },
  ];
  const navLinks = navItems
    .map((item) => `<a ${activeKey === item.key ? 'class="pill" aria-current="page"' : ""} href="${escapeHtmlAttribute(item.href)}">${escapeHtmlAttribute(item.label)}</a>`)
    .join("");
  return `
    <nav class="topNav" aria-label="Primary">
      <a class="brand" href="/" aria-label="Pint Path home">
        <img class="brandLogo" src="/assets/pint-path-icon-192.png" alt="" width="36" height="36" aria-hidden="true" />
        <span class="brandText">
          <strong>Pint Path</strong>
        </span>
      </a>
      ${betaPill}
      <button class="mobileNavToggle" type="button" aria-expanded="false" aria-controls="primaryNavLinks" data-mobile-nav-toggle>
        <span data-mobile-nav-label>Menu</span>
        <span class="mobileNavToggle__icon mobileNavToggle__icon--menu" aria-hidden="true">&#9776;</span>
        <span class="mobileNavToggle__icon mobileNavToggle__icon--close" aria-hidden="true">&times;</span>
      </button>
      <div id="primaryNavLinks" class="navLinks" data-mobile-nav-panel>
        ${navLinks}
      </div>
    </nav>
  `;
}

function setMobileNavOpen(nav, open, restoreFocus = false) {
  const toggle = nav?.querySelector("[data-mobile-nav-toggle]");
  if (!toggle) {
    return;
  }

  nav.classList.toggle("is-mobile-nav-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  const label = toggle.querySelector("[data-mobile-nav-label]");
  if (label) {
    label.textContent = open ? "Close" : "Menu";
  }
  if (restoreFocus) {
    toggle.focus();
  }
}

function installNavigationChrome() {
  if (document.documentElement.dataset.navigationChromeReady === "true") {
    return;
  }
  document.documentElement.dataset.navigationChromeReady = "true";

  document.addEventListener("click", (event) => {
    const toggle = event.target.closest?.("[data-mobile-nav-toggle]");
    if (toggle) {
      const nav = toggle.closest(".topNav");
      const shouldOpen = toggle.getAttribute("aria-expanded") !== "true";
      document.querySelectorAll(".topNav.is-mobile-nav-open").forEach((openNav) => {
        if (openNav !== nav) {
          setMobileNavOpen(openNav, false);
        }
      });
      setMobileNavOpen(nav, shouldOpen);
      return;
    }

    document.querySelectorAll(".topNav.is-mobile-nav-open").forEach((nav) => {
      if (!nav.contains(event.target)) {
        setMobileNavOpen(nav, false);
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    document.querySelectorAll(".topNav.is-mobile-nav-open").forEach((nav) => {
      setMobileNavOpen(nav, false, true);
    });
  });

  const mobileNavQuery = window.matchMedia?.("(max-width: 900px)");
  mobileNavQuery?.addEventListener?.("change", (event) => {
    if (!event.matches) {
      document.querySelectorAll(".topNav.is-mobile-nav-open").forEach((nav) => {
        setMobileNavOpen(nav, false);
      });
    }
  });
}

let authSessionHydrationPromise = null;

function navActiveKey(nav) {
  const href = nav?.querySelector?.('a[aria-current="page"]')?.getAttribute("href") || window.location.pathname;
  const path = new URL(href, window.location.origin).pathname.replace(/\.html$/, "");
  return {
    "/": "map",
    "/venue-portal": "venue-portal",
    "/submit": "submit",
    "/missions": "missions",
    "/admin": "admin",
    "/pricing": "pricing",
    "/trust": "trust",
    "/account": "account",
    "/feedback": "feedback",
  }[path] || "";
}

async function hydrateAuthSessionNavigation() {
  const nav = document.getElementById("nav");
  if (!nav) return null;
  if (isIOSLegalSurface()) return null;
  if (!authSessionHydrationPromise) {
    authSessionHydrationPromise = apiFetch("/api/business/auth/session")
      .then((session) => {
        if (session?.authenticated && session.account) {
          setAccountContext(session.account, session.access);
        } else if (session?.authenticated === false) {
          setAccountContext(null);
        }
        return session;
      })
      .catch(() => null);
  }
  const session = await authSessionHydrationPromise;
  if (session) nav.innerHTML = renderNav(navActiveKey(nav));
  return session;
}

function installFieldTestChrome() {
  if (!isFieldTestMode()) {
    return;
  }

  document.body.classList.add("fieldTestMode");
}

function installAccessibilityChrome() {
  const main = document.getElementById("mainContent") || document.querySelector("main") || document.getElementById("mapShell");
  if (!main) {
    return;
  }

  if (!main.id) {
    main.id = "mainContent";
  }
  if (!main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
  }

  if (!document.getElementById("skipToMainContent")) {
    const skipLink = document.createElement("a");
    skipLink.id = "skipToMainContent";
    skipLink.className = "skipLink";
    skipLink.href = `#${main.id}`;
    skipLink.textContent = "Skip to main content";
    skipLink.addEventListener("click", () => {
      window.requestAnimationFrame(() => main.focus({ preventScroll: true }));
    });
    document.body.prepend(skipLink);
  }
}

function installCookieConsent() {
  if (getCookieConsentDecision() || document.getElementById("cookieConsent")) {
    return;
  }

  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inertedElements = [];
  const banner = document.createElement("aside");
  const backdrop = document.createElement("div");
  backdrop.id = "cookieConsentBackdrop";
  backdrop.className = "cookieConsentBackdrop";
  banner.id = "cookieConsent";
  banner.className = "cookieConsent";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-modal", "true");
  banner.setAttribute("aria-labelledby", "cookieConsentTitle");
  banner.setAttribute("aria-describedby", "cookieConsentDescription");
  banner.innerHTML = `
    <div class="cookieConsent__copy">
      <span class="cookieConsent__badge">Privacy</span>
      <strong id="cookieConsentTitle">Choose your cookie settings</strong>
      <p id="cookieConsentDescription">Essential cookies keep login and security working. Optional analytics help improve map search and aggregate venue reports.</p>
    </div>
    <div class="cookieConsent__actions">
      <button class="button" type="button" data-cookie-choice="essential">Essentials only</button>
      <button class="button button--primary" type="button" data-cookie-choice="optional">Accept all</button>
      <a class="button" href="/account.html?settings=privacy" data-cookie-manage>Manage in account</a>
    </div>
  `;

  const closeCookieDialog = (choice) => {
    try {
      setCookieConsentDecision(choice);
    } finally {
      inertedElements.forEach((element) => {
        element.inert = false;
      });
      backdrop.remove();
      banner.remove();
      returnFocus?.focus?.();
    }
  };

  banner.querySelectorAll("[data-cookie-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      closeCookieDialog(button.getAttribute("data-cookie-choice"));
    });
  });
  banner.querySelector("[data-cookie-manage]")?.addEventListener("click", (event) => {
    event.preventDefault();
    const destination = event.currentTarget.href;
    closeCookieDialog("essential");
    window.location.assign(destination);
  });

  banner.addEventListener("keydown", (event) => {
    const focusable = Array.from(banner.querySelectorAll('button:not([disabled]), a[href]'));
    if (event.key === "Escape") {
      event.preventDefault();
      closeCookieDialog("essential");
      return;
    }
    if (event.key !== "Tab" || focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.body.appendChild(backdrop);
  document.body.appendChild(banner);
  Array.from(document.body.children).forEach((element) => {
    if (element !== banner && element !== backdrop && !element.inert) {
      element.inert = true;
      inertedElements.push(element);
    }
  });
  window.requestAnimationFrame(() => banner.querySelector("button")?.focus());
}

function installLegalFooter() {
  if (document.querySelector("[data-legal-footer]")) {
    return;
  }
  const main = document.querySelector("main");
  if (!main) {
    return;
  }
  const footer = document.createElement("footer");
  footer.className = "legalFooter";
  footer.dataset.legalFooter = "true";
  if (isIOSLegalSurface()) {
    footer.innerHTML = `
      <span>Pint Path · ABN 80 319 578 329 · <a href="mailto:admin@pintpath.au">admin@pintpath.au</a> · Policy version ${LEGAL_POLICY_VERSION}</span>
    `;
    main.appendChild(footer);
    return;
  }
  footer.innerHTML = `
    <nav aria-label="Legal, privacy, and help">
      <a href="/terms.html">Terms</a>
      <a href="/privacy.html">Privacy</a>
      <a href="/security.html">Security</a>
      <a href="/community.html">Community rules</a>
      <a href="/status.html">Service status</a>
      <a href="/feedback.html">Contact us</a>
    </nav>
    <span>Pint Path · ABN 80 319 578 329 · <a href="mailto:admin@pintpath.au">admin@pintpath.au</a> · Policy version ${LEGAL_POLICY_VERSION}</span>
  `;
  main.appendChild(footer);
}

function formatDate(value) {
  if (!value) {
    return "Not set";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function setStatus(element, message, isError = false) {
  if (!element) {
    return;
  }
  element.hidden = false;
  element.textContent = message;
  element.className = `notice ${isError ? "notice--warning" : ""}`;
  element.setAttribute("role", isError ? "alert" : "status");
  element.setAttribute("aria-live", isError ? "assertive" : "polite");
  element.setAttribute("aria-atomic", "true");
}

async function trackEvent(eventType, metadata = {}) {
  try {
    if (isRestoreRehearsalMode()) {
      return;
    }
    if (!hasAnalyticsConsent()) {
      return;
    }
    const safeMetadata = Object.fromEntries(
      Object.entries(metadata || {}).filter(([key]) => !/(latitude|longitude|\blat\b|\blng\b|coordinates?|gps|precise.?location)/i.test(key)),
    );
    const hasVenueContext = Boolean(safeMetadata.venueId);
    if (hasVenueContext && !hasVenueReportConsent()) {
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
  LEGAL_POLICY_VERSION,
  isRestoreRehearsalMode,
  prepareRestoreIsolation,
  getAuthToken,
  setAuthToken,
  setAccountContext,
  getAccountContext,
  isVenueManagerContext,
  isAdminContext,
  isAdminAccountContext,
  canUseVenuePortalContext,
  hasAuthenticatedSessionHint,
  getAccountScopeId,
  getAccountScopedStorageKey,
  getAccountScopedStorage,
  setAccountScopedStorage,
  removeAccountScopedStorage,
  clearLocalSubmissionDeviceData,
  getAnonymousSessionId,
  getViewerConfig,
  getBusinessConfig,
  getSupabaseConfig,
  getSupabaseOauthProviders,
  getSupabaseClient,
  getSupabaseOAuthClient,
  getCookieConsentDecision,
  setCookieConsentDecision,
  hasAnalyticsConsent,
  getCanonicalBaseUrl,
  getSafeReturnPath,
  isVenuePortalReturnPath,
  getAuthReturnPathFromLocation,
  storeSensitiveAuthReturnPath,
  consumeSensitiveAuthReturnPath,
  consumePendingPortalRedemption,
  clearSensitiveAuthReturnState,
  getAuthCallbackUrl,
  createAuthFlowNonce,
  peekAuthFlowState,
  consumeAuthFlowState,
  clearAuthFlowState,
  clearSupabaseOAuthFlowStorage,
  setPrivacyPreferenceCache,
  isFieldTestMode,
  apiFetch,
  sensitiveApiFetch,
  syncSupabaseSession,
  setPendingLegalAcceptance,
  setPendingLegalAcceptanceForCurrentSession,
  clearPendingLegalAcceptance,
  hasCurrentLegalAcceptance,
  signInWithOAuth,
  signInWithEmail,
  signUpWithEmail,
  resendSignupConfirmation,
  requestPasswordReset,
  markPasswordRecoverySession,
  validatePasswordRecoverySession,
  updatePassword,
  isIOSLegalSurface,
  renderIOSLegalNav,
  renderNav,
  hydrateAuthSessionNavigation,
  installNavigationChrome,
  installFieldTestChrome,
  installAccessibilityChrome,
  installCookieConsent,
  installLegalFooter,
  formatDate,
  setStatus,
  trackEvent,
};

window.addEventListener("DOMContentLoaded", async () => {
  await prepareRestoreIsolation();
  installAccessibilityChrome();
  installNavigationChrome();
  installFieldTestChrome();
  if (!isIOSLegalSurface()) {
    installCookieConsent();
  }
  installLegalFooter();
  void hydrateAuthSessionNavigation();
});
