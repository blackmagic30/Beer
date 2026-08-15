const AUTH_TOKEN_KEY = "melbBeerBusinessAuthToken";
const ACCOUNT_CONTEXT_KEY = "pintPathAccountContext";
const ANON_SESSION_KEY = "melbBeerAnonSessionId";
const AUTH_RETURN_KEY = "pintPathAuthReturnTo";
const AUTH_FLOW_KEY = "pintPathAuthFlow";
const AUTH_INVALIDATION_GENERATION_KEY = "pintPathAuthInvalidationGeneration";
const BROWSER_REAUTHENTICATION_STATE_KEY = "pintPathBrowserReauthentication";
const OAUTH_PKCE_STORAGE_KEY = "pintPathSupabaseOAuth";
// auth-js 2.112.3 opens BroadcastChannel(storageKey) whenever both the key and
// persistSession are truthy, then broadcasts full provider sessions. Keep the
// SDK key deliberately falsy so PKCE can still use our split storage without
// exposing access or refresh tokens to a same-origin auth channel. The adapter
// below maps the SDK's verifier-only slots back into our namespaced key.
const OAUTH_SDK_STORAGE_KEY = "";
const OAUTH_POPUP_STATE_KEY = "pintPathSupabaseOAuthPopup";
const SENSITIVE_AUTH_RETURN_KEY = "pintPathSensitiveAuthReturnTo";
const PENDING_PORTAL_REDEMPTION_KEY = "pintPathPendingPortalRedemption";
const SENSITIVE_AUTH_RETURN_MAX_AGE_MS = 20 * 60 * 1000;
const AUTH_FLOW_MAX_AGE_MS = 20 * 60 * 1000;
const BROWSER_REAUTHENTICATION_CACHE_MAX_AGE_MS = 14 * 60 * 1000;
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
  AUTH_INVALIDATION_GENERATION_KEY,
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
  BROWSER_REAUTHENTICATION_STATE_KEY,
  OAUTH_POPUP_STATE_KEY,
  "pintPathBillingRecoveryOptions",
  "pintPath.counterReceiptQueue.v2",
]);
let restoreIsolationPromise = null;
let restoreAnonymousSessionId = null;
let pageLocalConsentDenied = false;
const oauthMemoryStorage = new Map();
let browserReauthenticationState = null;
let providerReauthenticationEmail = null;

function normalizeBrowserReauthenticationState(record) {
  if (!record || typeof record !== "object") return null;
  const purpose = String(record.purpose || "").trim().toLowerCase();
  const expiresAt = Number(record.expiresAt);
  const now = Date.now();
  if (
    ![
      "session_management",
      "account_export",
      "account_deletion",
      "billing_portal",
      "venue_billing_portal",
      "logout_all",
    ].includes(purpose)
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || expiresAt > now + BROWSER_REAUTHENTICATION_CACHE_MAX_AGE_MS
  ) return null;
  return { purpose, expiresAt };
}

function setBrowserReauthenticationState(record) {
  const normalized = normalizeBrowserReauthenticationState(record);
  browserReauthenticationState = normalized;
  if (normalized) {
    safeStorageSet(window.sessionStorage, BROWSER_REAUTHENTICATION_STATE_KEY, JSON.stringify(normalized));
  } else {
    safeStorageRemove(window.sessionStorage, BROWSER_REAUTHENTICATION_STATE_KEY);
  }
  return normalized;
}

function getBrowserReauthenticationState() {
  if (browserReauthenticationState) {
    const normalized = normalizeBrowserReauthenticationState(browserReauthenticationState);
    if (normalized) return normalized;
  }
  try {
    return setBrowserReauthenticationState(JSON.parse(
      safeStorageGet(window.sessionStorage, BROWSER_REAUTHENTICATION_STATE_KEY) || "null",
    ));
  } catch {
    return setBrowserReauthenticationState(null);
  }
}

function isRestoreRehearsalMode() {
  return window.MELB_BEER_BOT_VIEWER_CONFIG?.business?.restoreRehearsalMode === true;
}

function isSupabaseSessionStorageKey(key) {
  return /^sb-.+-auth-token(?:-code-verifier)?$/.test(key) || /^supabase[.:_-].*auth/i.test(key);
}

function isSupabaseBearerStorageRecord(key, value = "") {
  if (String(key || "").endsWith("-code-verifier")) return false;
  if (/^sb-.+-auth-token$/.test(String(key || ""))) return true;
  return (
    String(key || "") === OAUTH_PKCE_STORAGE_KEY
    || /^supabase[.:_-].*auth/i.test(String(key || ""))
  )
    && /(?:access_token|refresh_token)/i.test(String(value || ""));
}

function storageKeys(storage) {
  if (!storage) return [];
  const keys = [];
  try {
    for (let index = 0; index < Number(storage.length || 0); index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function availableBrowserStorageAreas() {
  const storages = [];
  ["localStorage", "sessionStorage"].forEach((name) => {
    try {
      const storage = window[name];
      if (storage) storages.push(storage);
    } catch {
      // A locked-down browser may deny access to the storage object itself.
    }
  });
  return storages;
}

function purgeLegacySupabaseBearerRecords() {
  availableBrowserStorageAreas().forEach((storage) => {
    storageKeys(storage).forEach((key) => {
      try {
        if (isSupabaseBearerStorageRecord(key, storage.getItem(key))) storage.removeItem(key);
      } catch {
        // A locked-down browser may deny storage access. The active clients
        // below still use memory-only session storage.
      }
    });
  });
}

// Remove credentials written by the former persistent clients on every page,
// including public pages that never initialize Supabase during this visit.
purgeLegacySupabaseBearerRecords();

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
  window.__melbBeerSupabaseAuthStateInstalled = false;

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
    setBrowserReauthenticationState(null);
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
    providerReauthenticationEmail = null;
    window.localStorage.removeItem(ACCOUNT_CONTEXT_KEY);
    if (previousAccountId) {
      announceAccountChange(null);
    }
    return;
  }

  const nextAccountId = account.id || null;
  const sameAccount = Boolean(nextAccountId && previousAccountId === nextAccountId);
  if (!sameAccount) providerReauthenticationEmail = null;
  const accountEmail = String(account.email || "").trim().toLowerCase();
  if (accountEmail) providerReauthenticationEmail = accountEmail;
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
    authIdentityProvider: access?.authIdentityProvider
      || (sameAccount ? previousContext?.authIdentityProvider : null)
      || null,
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
  return window.__pintPathSupabaseMemorySessionAvailable === true;
}

function clearCachedSupabaseSessions() {
  availableBrowserStorageAreas().forEach((storage) => {
    storageKeys(storage).forEach((key) => {
      try {
        const value = storage.getItem(key);
        if (isSupabaseBearerStorageRecord(key, value)) storage.removeItem(key);
      } catch {
        // Best effort; Supabase signOut remains the primary memory cleanup.
      }
    });
  });
  window.__pintPathSupabaseMemorySessionAvailable = false;
  setBrowserReauthenticationState(null);
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

let observedAuthInvalidationId = null;

function normalizeAuthInvalidationRecord(record) {
  if (!record || typeof record !== "object") return null;
  const id = String(record.id || "").trim();
  const generation = Number(record.generation);
  const createdAt = Number(record.createdAt);
  if (
    !/^[A-Za-z0-9_-]{8,160}$/.test(id)
    || !Number.isSafeInteger(generation)
    || generation < 1
    || !Number.isFinite(createdAt)
    || Math.abs(Date.now() - createdAt) > 24 * 60 * 60 * 1000
  ) return null;
  return { id, generation, createdAt, reason: String(record.reason || "logout").slice(0, 80) };
}

function invalidateMemoryOnlyAuth() {
  const mainClient = window.__melbBeerSupabaseClient || null;
  const oauthClient = window.__pintPathSupabaseOAuthClient || null;
  window.__melbBeerSupabaseClient = null;
  window.__pintPathSupabaseOAuthClient = null;
  window.__melbBeerSupabaseAuthStateInstalled = false;
  window.__pintPathSupabaseMemorySessionAvailable = false;
  setBrowserReauthenticationState(null);
  clearSupabaseOAuthFlowStorage();
  clearOAuthPopupState();
  clearAuthFlowState();
  clearPendingLegalAcceptance();
  safeStorageRemove(window.localStorage, AUTH_RETURN_KEY);
  setAuthToken(null);
  [mainClient, oauthClient].filter(Boolean).forEach((client) => {
    void client.auth.signOut({ scope: "local" }).catch(() => null);
  });
  if (typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
    window.dispatchEvent(new window.CustomEvent("pintpath:auth-invalidated"));
  }
}

function acceptAuthInvalidationRecord(input) {
  const record = normalizeAuthInvalidationRecord(input);
  if (!record || record.id === observedAuthInvalidationId) return false;
  observedAuthInvalidationId = record.id;
  invalidateMemoryOnlyAuth();
  return true;
}

function broadcastAuthInvalidation(reason = "logout") {
  if (isRestoreRehearsalMode()) {
    invalidateMemoryOnlyAuth();
    return null;
  }
  let previousGeneration = 0;
  try {
    previousGeneration = Number(JSON.parse(
      safeStorageGet(window.localStorage, AUTH_INVALIDATION_GENERATION_KEY) || "null",
    )?.generation || 0);
  } catch {
    previousGeneration = 0;
  }
  const record = {
    id: createAuthFlowNonce(),
    generation: Math.max(
      Number.isSafeInteger(previousGeneration) ? previousGeneration + 1 : 1,
      Date.now(),
    ),
    createdAt: Date.now(),
    reason: String(reason || "logout").slice(0, 80),
  };
  observedAuthInvalidationId = record.id;
  safeStorageSet(window.localStorage, AUTH_INVALIDATION_GENERATION_KEY, JSON.stringify(record));
  try {
    window.__pintPathAuthInvalidationChannel?.postMessage({
      type: "pintpath:auth-invalidated",
      record,
    });
  } catch {
    // The storage generation still reaches other tabs when channels are unavailable.
  }
  invalidateMemoryOnlyAuth();
  return record;
}

function installAuthInvalidationListener() {
  if (window.__pintPathAuthInvalidationListenerInstalled) return;
  window.__pintPathAuthInvalidationListenerInstalled = true;
  try {
    const current = normalizeAuthInvalidationRecord(JSON.parse(
      safeStorageGet(window.localStorage, AUTH_INVALIDATION_GENERATION_KEY) || "null",
    ));
    observedAuthInvalidationId = current?.id || null;
  } catch {
    observedAuthInvalidationId = null;
  }
  window.addEventListener?.("storage", (event) => {
    if (event.key !== AUTH_INVALIDATION_GENERATION_KEY || !event.newValue) return;
    try {
      acceptAuthInvalidationRecord(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed cross-tab state; it never restores authentication.
    }
  });
  if (typeof window.BroadcastChannel === "function") {
    try {
      const channel = new window.BroadcastChannel("pintpath:auth-invalidation");
      channel.onmessage = (event) => {
        if (event?.data?.type === "pintpath:auth-invalidated") {
          acceptAuthInvalidationRecord(event.data.record);
        }
      };
      window.__pintPathAuthInvalidationChannel = channel;
    } catch {
      window.__pintPathAuthInvalidationChannel = null;
    }
  }
}

installAuthInvalidationListener();

function normalizeAuthFlowState(record) {
  if (!record || typeof record !== "object") return null;
  const createdAt = Number(record.createdAt);
  const nonce = String(record.nonce || "").trim();
  const kind = String(record.kind || "").trim().toLowerCase();
  const reauthPurpose = String(record.reauthPurpose || "").trim().toLowerCase() || null;
  const continuation = String(record.continuation || "").trim().toLowerCase() || null;
  const isBrowserEmailReauthentication = kind === "browser_email_reauthentication";
  const now = Date.now();
  if (
    !nonce
    || !Number.isFinite(createdAt)
    || createdAt > now + 60_000
    || now - createdAt > AUTH_FLOW_MAX_AGE_MS
    || !["oauth", "signup", "password_recovery", "browser_email_reauthentication"].includes(kind)
    || (reauthPurpose !== null && (
      !["oauth", "browser_email_reauthentication"].includes(kind)
      || ![
        "session_management",
        "account_export",
        "account_deletion",
        "billing_portal",
        "venue_billing_portal",
        "logout_all",
      ].includes(reauthPurpose)
    ))
    || (isBrowserEmailReauthentication && reauthPurpose === null)
    || (continuation !== null && (
      !isBrowserEmailReauthentication
      || reauthPurpose !== "session_management"
      || continuation !== "mfa_management"
    ))
  ) return null;
  return {
    nonce,
    returnTo: getSafeReturnPath(record.returnTo || "/account.html"),
    kind,
    reauthPurpose,
    continuation,
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
    reauthPurpose: input.reauthPurpose || null,
    continuation: input.continuation || null,
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

function oauthVerifierBrowserStorageKey(key) {
  const normalizedKey = String(key || "");
  const verifierSuffix = normalizedKey.startsWith(`${OAUTH_PKCE_STORAGE_KEY}-`)
    ? normalizedKey.slice(OAUTH_PKCE_STORAGE_KEY.length)
    : normalizedKey;
  if (!verifierSuffix.startsWith("-") || !verifierSuffix.endsWith("-code-verifier")) {
    return null;
  }
  return `${OAUTH_PKCE_STORAGE_KEY}${verifierSuffix}`;
}

function safeStorageGet(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

function safeStorageSet(storage, key, value) {
  try {
    storage?.setItem?.(key, String(value));
    return true;
  } catch {
    return false;
  }
}

function safeStorageRemove(storage, key) {
  try {
    storage?.removeItem?.(key);
  } catch {
    // Best effort cleanup for browsers that disable storage.
  }
}

const oauthPkceSplitStorage = {
  getItem(key) {
    const verifierStorageKey = oauthVerifierBrowserStorageKey(key);
    if (!verifierStorageKey) return oauthMemoryStorage.get(String(key)) ?? null;
    const sessionValue = safeStorageGet(window.sessionStorage, verifierStorageKey);
    if (sessionValue !== null) return sessionValue;

    // Migrate a verifier created by the former localStorage client exactly
    // once, without ever migrating its provider session/bearer record.
    const legacyValue = safeStorageGet(window.localStorage, verifierStorageKey);
    if (legacyValue !== null) {
      safeStorageSet(window.sessionStorage, verifierStorageKey, legacyValue);
      safeStorageRemove(window.localStorage, verifierStorageKey);
    }
    return legacyValue;
  },
  setItem(key, value) {
    const verifierStorageKey = oauthVerifierBrowserStorageKey(key);
    if (verifierStorageKey) {
      if (!safeStorageSet(window.sessionStorage, verifierStorageKey, value)) {
        throw new Error("Secure provider sign-in storage is unavailable in this browser.");
      }
      safeStorageRemove(window.localStorage, verifierStorageKey);
      return;
    }
    oauthMemoryStorage.set(String(key), String(value));
  },
  removeItem(key) {
    const verifierStorageKey = oauthVerifierBrowserStorageKey(key);
    if (verifierStorageKey) {
      safeStorageRemove(window.sessionStorage, verifierStorageKey);
      safeStorageRemove(window.localStorage, verifierStorageKey);
      return;
    }
    oauthMemoryStorage.delete(String(key));
  },
};

function normalizeOAuthPopupState(record) {
  if (!record || typeof record !== "object") return null;
  const channelId = String(record.channelId || "").trim();
  const provider = String(record.provider || "").trim().toLowerCase();
  const purpose = String(record.purpose || "login").trim().toLowerCase();
  const createdAt = Number(record.createdAt);
  const now = Date.now();
  if (
    !/^[A-Za-z0-9_-]{8,160}$/.test(channelId)
    || !getSupabaseOauthProviders().includes(provider)
    || ![
      "login",
      "session_management",
      "account_export",
      "account_deletion",
      "billing_portal",
      "venue_billing_portal",
      "logout_all",
    ].includes(purpose)
    || !Number.isFinite(createdAt)
    || createdAt > now + 60_000
    || now - createdAt > AUTH_FLOW_MAX_AGE_MS
  ) return null;
  return {
    channelId,
    provider,
    purpose,
    returnTo: getSafeReturnPath(record.returnTo || "/account.html"),
    createdAt,
  };
}

function storeOAuthPopupState(input = {}) {
  if (isRestoreRehearsalMode()) return null;
  const record = normalizeOAuthPopupState({ ...input, createdAt: Date.now() });
  if (!record) throw new Error("Secure provider popup state was invalid.");
  if (!safeStorageSet(window.sessionStorage, OAUTH_POPUP_STATE_KEY, JSON.stringify(record))) {
    throw new Error("Secure provider popup state could not be held in this tab.");
  }
  return record;
}

function peekOAuthPopupState() {
  if (isRestoreRehearsalMode()) return null;
  try {
    const record = normalizeOAuthPopupState(JSON.parse(
      safeStorageGet(window.sessionStorage, OAUTH_POPUP_STATE_KEY) || "null",
    ));
    if (!record) clearOAuthPopupState();
    return record;
  } catch {
    clearOAuthPopupState();
    return null;
  }
}

function clearOAuthPopupState() {
  safeStorageRemove(window.sessionStorage, OAUTH_POPUP_STATE_KEY);
}

function clearSupabaseOAuthFlowStorage() {
  oauthMemoryStorage.clear();
  [window.localStorage, window.sessionStorage].filter(Boolean).forEach((storage) => {
    storageKeys(storage).forEach((key) => {
      if (key === OAUTH_PKCE_STORAGE_KEY || key.startsWith(`${OAUTH_PKCE_STORAGE_KEY}-`)) {
        safeStorageRemove(storage, key);
      }
    });
  });
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

  purgeLegacySupabaseBearerRecords();
  if (!window.__melbBeerSupabaseClient) {
    window.__pintPathSupabaseMemorySessionAvailable = false;
    window.__melbBeerSupabaseClient = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        flowType: "implicit",
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        fetch: createBrowserSupabaseFetch(config.anonKey),
      },
    });

    if (
      !window.__melbBeerSupabaseAuthStateInstalled
      && typeof window.__melbBeerSupabaseClient.auth.onAuthStateChange === "function"
    ) {
      window.__melbBeerSupabaseAuthStateInstalled = true;
      window.__melbBeerSupabaseClient.auth.onAuthStateChange((event, session) => {
        window.__pintPathSupabaseMemorySessionAvailable = Boolean(session?.access_token);
        if (isLocalOrigin()) {
          console.debug("[Pint Path auth]", {
            event,
            hasSession: Boolean(session?.user?.id),
          });
        }
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
  purgeLegacySupabaseBearerRecords();
  if (!window.__pintPathSupabaseOAuthClient) {
    window.__pintPathSupabaseOAuthClient = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: OAUTH_SDK_STORAGE_KEY,
        storage: oauthPkceSplitStorage,
      },
      global: {
        fetch: createBrowserSupabaseFetch(config.anonKey),
      },
    });
  }
  return window.__pintPathSupabaseOAuthClient;
}

async function setSupabaseMemorySession(session) {
  const accessToken = String(session?.access_token || "").trim();
  const refreshToken = String(session?.refresh_token || "").trim();
  const client = getSupabaseClient();
  if (!client || !accessToken || !refreshToken || typeof client.auth.setSession !== "function") {
    throw new Error("Your sign-in client cannot install the secure memory-only session. Refresh Pint Path and try again.");
  }
  const { data, error } = await client.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) throw new Error(error.message || "The secure provider session could not be installed.");
  window.__pintPathSupabaseMemorySessionAvailable = true;
  return data?.session || session;
}

function providerSessionIdentity(accessToken) {
  const payload = decodeJwtPayloadForBrowser(accessToken);
  const subject = String(payload?.sub || "").trim();
  const sessionId = String(payload?.session_id || "").trim();
  return subject && sessionId ? { subject, sessionId } : null;
}

async function getLiveSupabaseProviderSession(initialSession = null, client = getSupabaseClient()) {
  const { data, error } = client
    ? await client.auth.getSession()
    : { data: null, error: null };
  const liveSession = data?.session;
  if (error || !liveSession?.access_token || !liveSession.refresh_token) {
    throw new Error(error?.message || "The live provider session is no longer available. Start the security check again.");
  }
  if (initialSession?.access_token) {
    const initialIdentity = providerSessionIdentity(initialSession.access_token);
    const liveIdentity = providerSessionIdentity(liveSession.access_token);
    if (
      !initialIdentity
      || !liveIdentity
      || initialIdentity.subject !== liveIdentity.subject
      || initialIdentity.sessionId !== liveIdentity.sessionId
    ) {
      throw new Error("The provider session changed while authentication was completing. Start the security check again.");
    }
  }
  return {
    access_token: liveSession.access_token,
    refresh_token: liveSession.refresh_token,
  };
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
let providerPasswordDialogPromise = null;
let providerMfaDialogPromise = null;

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

function requestProviderEmailPassword(purpose) {
  if (providerPasswordDialogPromise) return providerPasswordDialogPromise;
  const purposeLabels = {
    session_management: "manage signed-in sessions",
    account_export: "export your account data",
    account_deletion: "request account deletion",
    billing_portal: "open billing settings",
    venue_billing_portal: "open venue billing settings",
    logout_all: "log out every session",
  };
  const purposeLabel = purposeLabels[purpose] || "continue with this sensitive action";
  providerPasswordDialogPromise = new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "reauthPasswordDialog panel";
    dialog.setAttribute("aria-labelledby", "providerPasswordTitle");
    dialog.setAttribute("aria-describedby", "providerPasswordCopy");
    dialog.innerHTML = `
      <form method="dialog" class="form">
        <div>
          <div class="eyebrow">Provider security check</div>
          <h2 id="providerPasswordTitle">Sign in again to ${purposeLabel}</h2>
          <p id="providerPasswordCopy" class="muted">Your email and password go directly to the configured Supabase identity provider. Pint Path keeps the resulting provider session only in this tab's memory.</p>
        </div>
        <label class="field">Account email
          <input name="providerEmail" type="email" autocomplete="username" value="${escapeHtmlAttribute(providerReauthenticationEmail || "")}" required />
        </label>
        <label class="field">Provider password
          <input name="providerPassword" type="password" autocomplete="current-password" required />
        </label>
        <div class="actionRow">
          <button class="button" type="button" data-provider-reauth-cancel>Cancel</button>
          <button class="button button--primary" type="submit">Continue securely</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const passwordInput = dialog.querySelector('[name="providerPassword"]');
      if (passwordInput) passwordInput.value = "";
      dialog.remove();
      providerPasswordDialogPromise = null;
      resolve(value);
    };
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const email = String(form.get("providerEmail") || "").trim().toLowerCase();
      const password = String(form.get("providerPassword") || "");
      finish(email && password ? { email, password } : null);
    });
    dialog.querySelector("[data-provider-reauth-cancel]").addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector(providerReauthenticationEmail ? '[name="providerPassword"]' : '[name="providerEmail"]')?.focus();
  });
  return providerPasswordDialogPromise;
}

function requestProviderMfaCode(purposeLabel = "continue") {
  if (providerMfaDialogPromise) return providerMfaDialogPromise;
  providerMfaDialogPromise = new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "reauthPasswordDialog panel";
    dialog.setAttribute("aria-labelledby", "providerMfaTitle");
    dialog.setAttribute("aria-describedby", "providerMfaCopy");
    dialog.innerHTML = `
      <form method="dialog" class="form">
        <div>
          <div class="eyebrow">Authenticator check</div>
          <h2 id="providerMfaTitle">Enter your authenticator code</h2>
          <p id="providerMfaCopy" class="muted"></p>
        </div>
        <label class="field">Six-digit code
          <input name="providerMfaCode" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required />
        </label>
        <div class="actionRow">
          <button class="button" type="button" data-provider-mfa-cancel>Cancel</button>
          <button class="button button--primary" type="submit">Verify securely</button>
        </div>
      </form>
    `;
    dialog.querySelector("#providerMfaCopy").textContent =
      `Pint Path requires the current code from your enrolled authenticator to ${purposeLabel}.`;
    document.body.appendChild(dialog);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const input = dialog.querySelector('[name="providerMfaCode"]');
      if (input) input.value = "";
      dialog.remove();
      providerMfaDialogPromise = null;
      resolve(value);
    };
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const code = String(new FormData(event.currentTarget).get("providerMfaCode") || "").replace(/\D/g, "");
      if (/^\d{6}$/.test(code)) finish(code);
    });
    dialog.querySelector("[data-provider-mfa-cancel]").addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector('[name="providerMfaCode"]')?.focus();
  });
  return providerMfaDialogPromise;
}

async function completeSupabaseMfaStepUp(client, purposeLabel = "continue") {
  const { data: beforeData, error: beforeError } = await client.auth.getSession();
  if (beforeError || !beforeData.session?.access_token) {
    throw new Error(beforeError?.message || "The provider session expired before authenticator verification.");
  }
  const beforePayload = decodeJwtPayloadForBrowser(beforeData.session.access_token);
  const [{ data: factorData, error: factorError }, { data: assuranceData, error: assuranceError }] =
    await Promise.all([
      client.auth.mfa.listFactors(),
      client.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
  if (factorError || assuranceError) throw factorError || assuranceError;
  if (assuranceData?.currentLevel === "aal2") return beforeData.session;
  const verifiedFactors = (Array.isArray(factorData?.all) ? factorData.all : [])
    .filter((factor) => factor?.status === "verified" && factor?.id);
  if (verifiedFactors.length === 0) return beforeData.session;
  const verifiedFactor = verifiedFactors
    .find((factor) => factor?.factor_type === "totp" && factor?.status === "verified" && factor?.id);
  if (!verifiedFactor) {
    throw new Error(
      "Authenticator verification is required, but no usable verified factor was returned. Contact Pint Path support.",
    );
  }
  const code = await requestProviderMfaCode(purposeLabel);
  if (!code) throw new Error("Authenticator verification was cancelled.");
  const { error: verificationError } = await client.auth.mfa.challengeAndVerify({
    factorId: verifiedFactor.id,
    code,
  });
  if (verificationError) throw new Error(verificationError.message);
  const { data: afterData, error: afterError } = await client.auth.getSession();
  const afterToken = afterData.session?.access_token;
  const afterPayload = decodeJwtPayloadForBrowser(afterToken);
  if (
    afterError
    || !afterToken
    || afterPayload?.aal !== "aal2"
    || !beforePayload?.sub
    || afterPayload?.sub !== beforePayload.sub
    || !beforePayload?.session_id
    || afterPayload?.session_id !== beforePayload.session_id
  ) {
    throw new Error(afterError?.message || "Authenticator verification did not preserve this provider session.");
  }
  return afterData.session;
}

function reauthenticationPurposeForPath(path) {
  const pathname = String(path || "").split(/[?#]/, 1)[0];
  if (pathname === "/api/business/account/export") return "account_export";
  if (pathname === "/api/business/billing/portal") return "billing_portal";
  if (/^\/api\/business\/venue-portal\/[^/]+\/billing\/portal$/.test(pathname)) return "venue_billing_portal";
  if (pathname === "/api/business/auth/logout-all") return "logout_all";
  if (/^\/api\/business\/account\/sessions(?:\/|$)/.test(pathname)) return "session_management";
  if (/^\/api\/business\/account\/delete-request(?:\/|$)/.test(pathname)) return "account_deletion";
  throw new Error("This sensitive action is missing an approved reauthentication purpose.");
}

async function sensitiveApiFetch(path, options = {}) {
  const requestOptions = options;
  const purpose = reauthenticationPurposeForPath(path);
  // This call begins before the first await so a missing memory-only provider
  // session can open its reauthentication popup from the user's click gesture.
  await ensureSupabaseSessionForPurpose(purpose);
  const client = getSupabaseClient();
  const { data, error } = client ? await client.auth.getSession() : { data: null, error: null };
  const accessToken = data?.session?.access_token;
  if (error) {
    throw new Error(error.message || "Sign in again before using this sensitive account action.");
  }
  const headers = { ...(requestOptions.headers || {}) };
  const accountContext = getAccountContext();
  if (!accountContext?.id) {
    throw new Error("Your Pint Path session is no longer available. Sign in again before retrying this action.");
  }
  const authProvider = String(accountContext.authProvider || "").toLowerCase();
  if (authProvider !== "supabase") {
    const password = await requestCurrentPassword();
    if (!password) {
      throw new Error("Current password confirmation is required for this sensitive action.");
    }
    headers["X-Pint-Path-Current-Password"] = password;
  } else if (!accessToken && !hasCurrentBrowserReauthenticationPurpose(purpose)) {
    throw new Error("Your provider session is no longer available. Reauthenticate and retry this sensitive action.");
  }
  try {
    // Hosted accounts use the freshly rotated, credential-bound HttpOnly app
    // cookie established by syncSupabaseSession; raw provider JWTs never need
    // to be copied into application request headers.
    return await apiFetch(path, { ...requestOptions, headers });
  } catch (requestError) {
    if (requestError?.details?.reauthenticationRequired || Number(requestError?.status) === 401) {
      if (authProvider === "supabase") {
        setBrowserReauthenticationState(null);
        requestError.message = `${requestError.message} Select the action again to reauthenticate securely.`;
      } else {
        requestError.message = `${requestError.message} Confirm your password or complete MFA, then retry.`;
      }
    }
    throw requestError;
  }
}

let legacySessionMigrationPromise = null;

function decodeJwtPayloadForBrowser(accessToken) {
  const payload = String(accessToken || "").split(".")[1];
  if (!payload || typeof atob !== "function") return null;
  try {
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
  } catch {
    return null;
  }
}

function browserReauthenticationExpiryForAccessToken(accessToken, now = Date.now()) {
  const payload = decodeJwtPayloadForBrowser(accessToken);
  const allowedMethods = new Set([
    "oauth",
    "otp",
    "passkey",
    "password",
    "saml",
    "sso",
    "totp",
    "webauthn",
  ]);
  const candidates = [];
  let allowedStringMethod = false;
  if (Array.isArray(payload?.amr)) {
    payload.amr.forEach((entry) => {
      if (typeof entry === "string") {
        if (allowedMethods.has(entry.trim().toLowerCase())) allowedStringMethod = true;
        return;
      }
      if (!entry || typeof entry !== "object") return;
      const method = String(entry.method || "").trim().toLowerCase();
      const timestamp = Number(entry.timestamp);
      if (allowedMethods.has(method) && Number.isSafeInteger(timestamp) && timestamp > 0) {
        candidates.push(timestamp);
      }
    });
  }
  if (
    candidates.length === 0
    && allowedStringMethod
    && Number.isSafeInteger(payload?.auth_time)
    && Number(payload.auth_time) > 0
  ) candidates.push(Number(payload.auth_time));
  if (candidates.length === 0) return null;
  const credentialExpiry = Math.max(...candidates) * 1000 + BROWSER_REAUTHENTICATION_CACHE_MAX_AGE_MS;
  if (!Number.isFinite(credentialExpiry) || credentialExpiry <= now) return null;
  return Math.min(credentialExpiry, now + BROWSER_REAUTHENTICATION_CACHE_MAX_AGE_MS);
}

function browserReauthenticationStateForToken(purpose, accessToken) {
  const expiresAt = browserReauthenticationExpiryForAccessToken(accessToken);
  return expiresAt ? { purpose, expiresAt } : null;
}

async function migrateLegacySessionCookie(path = "") {
  const token = getAuthToken();
  if (!token || path === "/api/business/auth/session-cookie") return;
  if (!legacySessionMigrationPromise) {
    const deadline = createFetchDeadline(LEGACY_SESSION_MIGRATION_TIMEOUT_MS);
    const migration = fetch("/api/business/auth/session-cookie", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      credentials: "same-origin",
      body: "{}",
      signal: deadline.signal,
      redirect: "error",
    }).then((response) => {
      const retryable = response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500;
      if ((response.ok || !retryable) && getAuthToken() === token) {
        window.localStorage.removeItem(AUTH_TOKEN_KEY);
      }
    }).catch(() => null).finally(() => {
      deadline.clear();
      if (legacySessionMigrationPromise === migration) {
        legacySessionMigrationPromise = null;
      }
    });
    legacySessionMigrationPromise = migration;
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

  const reauthPurpose = options.reauthPurpose == null
    ? null
    : String(options.reauthPurpose).trim().toLowerCase();
  if (reauthPurpose && ![
    "session_management",
    "account_export",
    "account_deletion",
    "billing_portal",
    "venue_billing_portal",
    "logout_all",
  ].includes(reauthPurpose)) {
    throw new Error("The requested browser reauthentication purpose is not supported.");
  }
  const credentialCeremony = options.credentialCeremony == null
    ? "browser_memory_v1"
    : String(options.credentialCeremony).trim().toLowerCase();
  if (!["browser_memory_v1", "browser_email_otp_v1"].includes(credentialCeremony)) {
    throw new Error("The requested browser credential ceremony is not supported.");
  }
  if (credentialCeremony === "browser_email_otp_v1" && !reauthPurpose) {
    throw new Error("Email reauthentication requires an approved sensitive-action purpose.");
  }
  const rememberedIdentityProvider = String(
    getAccountContext()?.authIdentityProvider || "",
  ).trim().toLowerCase() || null;

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
  if (!reauthPurpose) {
    const existingSession = await apiFetch("/api/business/auth/session");
    if (existingSession?.authenticated === false) {
      await apiFetch("/api/business/auth/logout", { method: "POST", body: "{}" });
    }
  }
  let result;
  const sessionExchangeBody = JSON.stringify({
    accessToken: data.session.access_token,
    credentialCeremony,
    ...(reauthPurpose ? { reauthPurpose } : {}),
    ...(hasCompletePendingAcceptance ? {
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: pendingAcceptance.termsVersion,
      privacyVersion: pendingAcceptance.privacyVersion,
      consentSource: "web_oauth",
    } : {}),
  });
  try {
    result = await apiFetch("/api/business/auth/supabase-session", {
      method: "POST",
      body: sessionExchangeBody,
    });
  } catch (error) {
    if (error?.code === "MFA_STEP_UP_REQUIRED" && options.mfaRetryAttempted !== true) {
      await completeSupabaseMfaStepUp(
        client,
        reauthPurpose ? "authorize this sensitive action" : "finish signing in",
      );
      return syncSupabaseSession({ ...options, mfaRetryAttempted: true });
    }
    if (!reauthPurpose && error?.code === "PROVIDER_GLOBAL_REVOCATION_PENDING") {
      const recovery = await apiFetch("/api/business/auth/provider-global-signout-resume", {
        method: "POST",
        body: JSON.stringify({ accessToken: data.session.access_token }),
      });
      if (recovery?.providerSessionsRevoked !== true) {
        throw new Error(
          "Provider-wide sign-out is still incomplete. Try signing in again shortly or contact Pint Path support.",
        );
      }
      // Completing the pending cleanup advances the provider-token epoch and
      // deliberately invalidates this exact access token. Do not replay it.
      // Clear every local authority and require one genuinely fresh provider
      // sign-in after the bounded clock-skew window instead.
      await client.auth.signOut({ scope: "local" }).catch(() => null);
      clearCachedSupabaseSessions();
      clearPendingLegalAcceptance();
      window.__melbBeerSupabaseClient = null;
      window.__melbBeerSupabaseAuthStateInstalled = false;
      setAuthToken(null);
      setAccountContext(null);
      broadcastAuthInvalidation("provider_global_signout_completed");
      const completedError = new Error(
        "Security cleanup is complete. Wait one minute, then sign in again to create a new Pint Path session.",
      );
      completedError.status = 401;
      completedError.code = "PROVIDER_GLOBAL_REVOCATION_COMPLETED";
      completedError.reauthenticationRequired = true;
      throw completedError;
    } else {
      const providerSessionRejected = Number(error?.status) === 401
        && /provider session (?:was revoked|is missing its session identifier)/i.test(String(error?.message || ""));
      if (providerSessionRejected) {
        await client.auth.signOut({ scope: "local" }).catch(() => null);
        clearCachedSupabaseSessions();
        clearPendingLegalAcceptance();
        if (!reauthPurpose) {
          window.__melbBeerSupabaseClient = null;
          window.__melbBeerSupabaseAuthStateInstalled = false;
          setAuthToken(null);
          setAccountContext(null);
        }
      }
      throw error;
    }
  }
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
  setAccountContext(result.account, {
    ...result.access,
    authIdentityProvider: credentialCeremony === "browser_email_otp_v1"
      || options.preserveAuthIdentityProvider === true
      ? rememberedIdentityProvider
      : supabaseSessionProvider(data.session),
  });
  setBrowserReauthenticationState(reauthPurpose
    ? browserReauthenticationStateForToken(reauthPurpose, data.session.access_token)
    : null);
  clearPendingLegalAcceptance();
  return { configured: true, synced: true, account: result.account, access: result.access || null };
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
    reauthPurpose: options.reauthPurpose || null,
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

function getSupabaseReauthenticationProvider() {
  const enabledProviders = getSupabaseOauthProviders();
  const rememberedProvider = String(getAccountContext()?.authIdentityProvider || "").trim().toLowerCase();
  if (rememberedProvider === "email") return "email";
  if (enabledProviders.includes(rememberedProvider)) return rememberedProvider;
  return null;
}

async function beginBrowserEmailReauthentication(purpose, options = {}) {
  const normalizedPurpose = String(purpose || "").trim().toLowerCase();
  const continuation = String(options.continuation || "").trim().toLowerCase() || null;
  if (![
    "session_management",
    "account_export",
    "account_deletion",
    "billing_portal",
    "venue_billing_portal",
    "logout_all",
  ].includes(normalizedPurpose)) {
    throw new Error("The requested email reauthentication purpose is not supported.");
  }
  if (
    continuation !== null
    && (normalizedPurpose !== "session_management" || continuation !== "mfa_management")
  ) {
    throw new Error("The requested email reauthentication continuation is not supported.");
  }
  const account = getAccountContext();
  const client = getSupabaseClient();
  if (
    String(account?.authProvider || "").toLowerCase() !== "supabase"
    || !account?.id
    || typeof client?.auth?.signInWithOtp !== "function"
  ) {
    throw new Error("Email reauthentication is unavailable for this account.");
  }
  const challenge = await apiFetch("/api/business/auth/browser-email-reauthentication", {
    method: "POST",
    body: JSON.stringify({ purpose: normalizedPurpose }),
  });
  const email = String(challenge?.email || "").trim().toLowerCase();
  const expiresAt = Date.parse(challenge?.expiresAt || "");
  if (!email || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Pint Path could not prepare a valid email security check. Retry this action.");
  }
  const authFlowNonce = createAuthFlowNonce();
  const returnTo = getSafeReturnPath(
    options.returnTo
      || `${window.location.pathname || "/account.html"}${window.location.search || ""}`,
  );
  clearOAuthPopupState();
  storeAuthFlowState({
    nonce: authFlowNonce,
    returnTo,
    kind: "browser_email_reauthentication",
    reauthPurpose: normalizedPurpose,
    continuation,
  });
  try {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: getAuthCallbackUrl(),
        shouldCreateUser: false,
      },
    });
    if (error) throw new Error(error.message || "The email security check could not be sent.");
  } catch (error) {
    if (peekAuthFlowState()?.nonce === authFlowNonce) clearAuthFlowState();
    throw error;
  }
  return {
    sent: true,
    purpose: normalizedPurpose,
    expiresAt: challenge.expiresAt,
  };
}

function emailReauthenticationPendingError() {
  const error = new Error(
    "Check your verified account email and open the latest Pint Path security link in this browser. The link will continue this action securely.",
  );
  error.code = "EMAIL_REAUTHENTICATION_SENT";
  error.reauthenticationPending = true;
  return error;
}

function signInWithOAuthPopup(provider, options = {}) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const purpose = String(options.purpose || "login").trim().toLowerCase();
  const returnTo = getSafeReturnPath(options.returnTo || getAuthReturnPathFromLocation());
  const expectedAccountId = purpose === "login" ? null : String(getAccountContext()?.id || "");
  if (!getSupabaseOauthProviders().includes(normalizedProvider)) {
    return Promise.reject(new Error("That secure sign-in provider is not enabled for Pint Path."));
  }
  if (![
    "login",
    "session_management",
    "account_export",
    "account_deletion",
    "billing_portal",
    "venue_billing_portal",
    "logout_all",
  ].includes(purpose)) {
    return Promise.reject(new Error("That secure sign-in purpose is not supported."));
  }

  const useTopLevelFallback = () => {
    if (options.requirePopup === true && purpose !== "login") {
      return Promise.reject(new Error(
        "This action needs a secure sign-in popup so the provider session remains in this tab. Allow popups for Pint Path, then retry.",
      ));
    }
    return signInWithOAuth(normalizedProvider, {
      returnTo,
      ...(purpose === "login" ? {} : { reauthPurpose: purpose }),
    }).then(() => ({
      popup: false,
      redirected: true,
    }));
  };

  if (options.preferTopLevel === true) {
    return useTopLevelFallback();
  }

  const PopupChannel = window.BroadcastChannel;
  if (typeof PopupChannel !== "function" || typeof window.open !== "function") {
    return useTopLevelFallback();
  }

  const channelId = createAuthFlowNonce();
  let channel;
  try {
    channel = new PopupChannel(`pintpath:oauth:${channelId}`);
  } catch {
    return useTopLevelFallback();
  }
  const popupUrl = new URL("/auth/callback", getCanonicalBaseUrl());
  popupUrl.searchParams.set("oauthStart", normalizedProvider);
  popupUrl.searchParams.set("popupChannel", channelId);
  popupUrl.searchParams.set("popupPurpose", purpose);
  popupUrl.searchParams.set("returnTo", returnTo);
  let popup;
  try {
    popup = window.open(
      popupUrl.toString(),
      `pintpath-oauth-${channelId}`,
      "popup,width=520,height=720,resizable=yes,scrollbars=yes",
    );
  } catch {
    channel.close();
    return useTopLevelFallback();
  }
  if (!popup) {
    channel.close();
    return useTopLevelFallback();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      try {
        popup.close();
      } catch {
        // The provider can sever the opener relationship while redirecting.
      }
      finish(new Error("Secure provider sign-in timed out. Please try again."));
    }, Math.min(AUTH_FLOW_MAX_AGE_MS, 5 * 60 * 1000));

    channel.onmessage = async (event) => {
      const message = event?.data;
      if (!message || message.channelId !== channelId || settled) return;
      if (message.type === "pintpath:oauth-billing-recovery") {
        try {
          if (
            purpose !== "login"
            || !message.accessToken
            || !message.refreshToken
            || message.recovery?.eligible !== true
          ) {
            throw new Error("The provider popup did not return complete billing-recovery authority.");
          }
          await setSupabaseMemorySession({
            access_token: message.accessToken,
            refresh_token: message.refreshToken,
          });
          clearPendingLegalAcceptance();
          const recoveryError = new Error(String(
            message.message || "Account access is suspended. Billing-only recovery remains available.",
          ));
          recoveryError.code = "ACCOUNT_SUSPENDED_BILLING_RECOVERY";
          recoveryError.recovery = message.recovery;
          recoveryError.details = { billingRecoveryEligible: true };
          channel.postMessage({ type: "pintpath:oauth-ack", channelId });
          finish(recoveryError);
        } catch (error) {
          finish(error);
        }
        return;
      }
      if (message.type === "pintpath:oauth-error") {
        channel.postMessage({ type: "pintpath:oauth-ack", channelId });
        finish(new Error(String(message.message || "Secure provider sign-in failed.")));
        return;
      }
      if (message.type !== "pintpath:oauth-session") return;
      try {
        if (!message.account?.id) {
          throw new Error("The provider popup did not return a verified Pint Path account.");
        }
        if (expectedAccountId && String(message.account.id) !== expectedAccountId) {
          await apiFetch("/api/business/auth/logout", { method: "POST", body: "{}" });
          broadcastAuthInvalidation("provider_reauthentication_account_mismatch");
          channel.postMessage({ type: "pintpath:oauth-ack", channelId });
          throw new Error("That provider login belongs to a different Pint Path account. Sign in to the original account and retry.");
        }
        await setSupabaseMemorySession({
          access_token: message.accessToken,
          refresh_token: message.refreshToken,
        });
        setAccountContext(message.account, {
          ...(message.access || {}),
          authIdentityProvider: normalizedProvider,
        });
        setBrowserReauthenticationState(purpose === "login"
          ? null
          : browserReauthenticationStateForToken(purpose, message.accessToken));
        clearPendingLegalAcceptance();
        channel.postMessage({ type: "pintpath:oauth-ack", channelId });
        finish(null, {
          configured: true,
          synced: true,
          account: message.account,
          access: message.access || null,
          popup: true,
          purpose,
          returnTo: getSafeReturnPath(message.returnTo || returnTo),
        });
      } catch (error) {
        finish(error);
      }
    };
  });
}

function hasCurrentBrowserReauthenticationPurpose(purpose) {
  const state = getBrowserReauthenticationState();
  return state?.purpose === purpose && Date.now() < state.expiresAt;
}

async function ensureSupabaseSessionForPurpose(purpose, options = {}) {
  const account = getAccountContext();
  const forceFresh = options.forceFresh === true;
  if (String(account?.authProvider || "").toLowerCase() !== "supabase") {
    return Promise.resolve({ required: false });
  }
  const provider = getSupabaseReauthenticationProvider();
  const isHostedOAuthProvider = Boolean(
    provider && provider !== "email" && getSupabaseOauthProviders().includes(provider),
  );
  const startEmailReauthentication = async () => {
    await beginBrowserEmailReauthentication(purpose, {
      returnTo: `${window.location.pathname || "/account.html"}${window.location.search || ""}`,
      ...(options.continuation ? { continuation: options.continuation } : {}),
    });
    throw emailReauthenticationPendingError();
  };
  if (forceFresh && isHostedOAuthProvider) {
    return startEmailReauthentication();
  }
  if (
    !forceFresh &&
    hasCurrentBrowserReauthenticationPurpose(purpose)
    && (options.requireProviderSession !== true || window.__pintPathSupabaseMemorySessionAvailable === true)
  ) {
    return { required: false, purpose };
  }
  if (!forceFresh && window.__pintPathSupabaseMemorySessionAvailable === true) {
    const client = getSupabaseClient();
    try {
      const synced = await syncSupabaseSession({ reauthPurpose: purpose });
      if (!synced.synced) {
        throw new Error(synced.error || "The provider session could not authorize this action.");
      }
      return { ...synced, required: true, purpose };
    } catch (error) {
      if (isHostedOAuthProvider && error?.code === "EMAIL_REAUTHENTICATION_REQUIRED") {
        return startEmailReauthentication();
      }
      await client?.auth.signOut({ scope: "local" }).catch(() => null);
      window.__pintPathSupabaseMemorySessionAvailable = false;
      setBrowserReauthenticationState(null);
      const failure = error instanceof Error
        ? error
        : new Error("The provider session could not authorize this action.");
      failure.message = `${failure.message} Select the action again to open secure reauthentication.`;
      throw failure;
    }
  }
  if (provider === "email") {
    const credentials = await requestProviderEmailPassword(purpose);
    if (!credentials) {
      throw new Error("Provider password reauthentication was cancelled. Select the action again when you are ready.");
    }
    const expectedAccountId = String(account.id || "");
    const client = getSupabaseClient();
    try {
      const synced = await signInWithEmail(credentials.email, credentials.password, { reauthPurpose: purpose });
      if (!synced.synced || !synced.account?.id) {
        throw new Error(synced.error || "The provider session could not authorize this action.");
      }
      if (String(synced.account.id) !== expectedAccountId) {
        await apiFetch("/api/business/auth/logout", { method: "POST", body: "{}" });
        broadcastAuthInvalidation("provider_reauthentication_account_mismatch");
        throw new Error("That provider login belongs to a different Pint Path account. Sign in to the original account and retry.");
      }
      return { ...synced, required: true, purpose };
    } catch (error) {
      await client?.auth.signOut({ scope: "local" }).catch(() => null);
      window.__pintPathSupabaseMemorySessionAvailable = false;
      setBrowserReauthenticationState(null);
      throw error;
    } finally {
      credentials.password = "";
    }
  }
  if (!provider) {
    return Promise.reject(new Error(
      "Your hosted sign-in method could not be recovered safely. Sign out, sign in again with the same provider, then retry this action.",
    ));
  }
  if (isHostedOAuthProvider) return startEmailReauthentication();
  return Promise.reject(new Error(
    "Your hosted sign-in method is not supported for secure reauthentication. Sign out and contact Pint Path support.",
  ));
}

async function signInWithEmail(email, password, options = {}) {
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
  window.__pintPathSupabaseMemorySessionAvailable = true;

  clearAuthFlowState();
  clearSupabaseOAuthFlowStorage();
  return syncSupabaseSession(options);
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
    window.__pintPathSupabaseMemorySessionAvailable = true;
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

  const recoveryAccessToken = sessionData.session.access_token;
  const steppedUpSession = await completeSupabaseMfaStepUp(client, "update your password");

  const { error } = await client.auth.updateUser({ password });
  if (error) {
    throw new Error(error.message);
  }

  let completion;
  try {
    completion = await apiFetch("/api/business/auth/password-reset-complete", {
      method: "POST",
      body: JSON.stringify({
        accessToken: recoveryAccessToken,
        ...(steppedUpSession.access_token !== recoveryAccessToken
          ? { mfaAccessToken: steppedUpSession.access_token }
          : {}),
      }),
    });
  } catch (completionError) {
    throw new Error(
      `Your password changed, but Pint Path could not close every existing session. Keep this page open and retry before signing in elsewhere. ${completionError?.message || "Session cleanup failed."}`,
    );
  }
  if (completion?.providerSessionsRevoked !== true) {
    throw new Error(
      "Your password changed and every Pint Path app session was closed, but provider-wide sign-out was not confirmed. Retry while this recovery session remains available; otherwise sign in with the new password and choose Log out all sessions.",
    );
  }

  await client.auth.signOut({ scope: "global" }).catch(() => null);
  broadcastAuthInvalidation("password_reset");
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
  setSupabaseMemorySession,
  getLiveSupabaseProviderSession,
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
  broadcastAuthInvalidation,
  peekAuthFlowState,
  consumeAuthFlowState,
  clearAuthFlowState,
  clearSupabaseOAuthFlowStorage,
  storeOAuthPopupState,
  peekOAuthPopupState,
  clearOAuthPopupState,
  setPrivacyPreferenceCache,
  isFieldTestMode,
  apiFetch,
  sensitiveApiFetch,
  reauthenticationPurposeForPath,
  browserReauthenticationExpiryForAccessToken,
  syncSupabaseSession,
  setPendingLegalAcceptance,
  setPendingLegalAcceptanceForCurrentSession,
  clearPendingLegalAcceptance,
  hasCurrentLegalAcceptance,
  signInWithOAuth,
  signInWithOAuthPopup,
  getSupabaseReauthenticationProvider,
  beginBrowserEmailReauthentication,
  ensureSupabaseSessionForPurpose,
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
