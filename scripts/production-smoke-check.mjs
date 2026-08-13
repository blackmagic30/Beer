const restoreRehearsalValue = process.env.RESTORE_REHEARSAL_MODE?.trim().toLowerCase() ?? "";
if (restoreRehearsalValue && !["0", "false", "no", "off"].includes(restoreRehearsalValue)) {
  throw new Error(
    "Production smoke authentication is disabled while RESTORE_REHEARSAL_MODE is enabled. "
    + "Use an ordinary non-restore environment for authenticated smoke checks.",
  );
}

const canonicalProductionSupabaseOrigin = "https://auth.pintpath.au";
const canonicalProductionBaseOrigin = "https://pintpath.au";
const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
const rawBaseUrl = process.env.PINTPATH_SMOKE_BASE_URL
  ?? canonicalProductionBaseOrigin;
const loopbackTestAuthority = process.env.NODE_ENV === "test"
  && process.env.PINTPATH_SMOKE_ALLOW_LOOPBACK_FOR_TESTS === "true";

function approvedSmokeBaseUrl(value) {
  let candidate;
  try {
    candidate = new URL(value);
  } catch {
    throw new Error("PINTPATH_SMOKE_BASE_URL must be an exact approved origin; no configured value is emitted.");
  }
  const isExactLoopback = loopbackTestAuthority
    && loopbackHostnames.has(candidate.hostname)
    && value === candidate.origin
    && (candidate.protocol === "http:" || candidate.protocol === "https:")
    && !candidate.username
    && !candidate.password
    && !candidate.search
    && !candidate.hash
    && (candidate.pathname === "/" || candidate.pathname === "");
  if (value === canonicalProductionBaseOrigin || isExactLoopback) {
    return value;
  }
  throw new Error(
    "PINTPATH_SMOKE_BASE_URL must be the exact production origin or an exact loopback test origin; no configured value is emitted.",
  );
}

const baseUrl = approvedSmokeBaseUrl(rawBaseUrl);
const strictAuth = process.argv.includes("--strict-auth");
const authOnly = process.argv.includes("--auth-only");
const supabasePublishableKeyPattern = /^sb_publishable_[A-Za-z0-9_-]{20,220}$/;

function readProtectedSupabasePublishableKey() {
  const key = process.env.SUPABASE_ANON_KEY || "";
  if (!supabasePublishableKeyPattern.test(key)) {
    throw new Error(
      "Protected SUPABASE_ANON_KEY must be an sb_publishable_ key with 20 to 220 URL-safe characters.",
    );
  }
  return key;
}

let strictAuthConfigError = null;
if (strictAuth) {
  try {
    readProtectedSupabasePublishableKey();
  } catch (error) {
    strictAuthConfigError = error;
  }
}

const expectedCommitSha = process.env.PINTPATH_EXPECTED_COMMIT_SHA?.trim() || null;
if (expectedCommitSha && !/^[0-9a-f]{40}$/.test(expectedCommitSha)) {
  throw new Error("PINTPATH_EXPECTED_COMMIT_SHA must be the exact 40-character lowercase commit SHA.");
}
const revokeDirectTokens = process.env.PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS === "true";
const enforceLaunchFlags = process.env.PINTPATH_ENFORCE_LAUNCH_FLAGS === "true";
const expectedCommercialLaunchValue =
  process.env.PINTPATH_EXPECTED_COMMERCIAL_LAUNCH_ENABLED?.trim().toLowerCase() ?? "";
if (
  enforceLaunchFlags &&
  !["true", "false"].includes(expectedCommercialLaunchValue)
) {
  throw new Error(
    "PINTPATH_EXPECTED_COMMERCIAL_LAUNCH_ENABLED must be exactly true or false when launch flags are enforced.",
  );
}
const expectedCommercialLaunchEnabled = expectedCommercialLaunchValue === "true";

const rolesArgument = process.argv.find((argument) => argument.startsWith("--roles="));
const selectedRoles = rolesArgument
  ? new Set(rolesArgument.slice("--roles=".length).split(",").map((role) => role.trim()).filter(Boolean))
  : new Set(["user", "venue", "admin"]);
const supportedRoles = new Set(["user", "venue", "admin"]);
const unknownRoles = [...selectedRoles].filter((role) => !supportedRoles.has(role));
if (selectedRoles.size === 0 || unknownRoles.length > 0) {
  console.error(`Invalid --roles value. Choose one or more of: ${[...supportedRoles].join(", ")}.`);
  process.exit(2);
}

const results = [];
let publicConfigPromise = null;

function detailFromError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function parseJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned unreadable JSON (HTTP ${response.status})`);
  }
}

async function checkJson(id, pathname, assertion, token) {
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await parseJson(response, id);
    const passed = response.ok && assertion(payload);
    results.push({
      id,
      status: passed ? "pass" : "fail",
      detail: passed ? `HTTP ${response.status}` : `Unexpected HTTP ${response.status} response`,
    });
  } catch (error) {
    results.push({ id, status: "fail", detail: detailFromError(error, "Request failed") });
  }
}

async function checkProductionReadiness() {
  try {
    const response = await fetch(`${baseUrl}/ready`, {
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await parseJson(response, "ready");
    const data = nestedData(payload);
    const rateLimiterRedis = data.dependencies?.rateLimiterRedis;
    const offsiteBackup = data.dependencies?.offsiteBackup;
    const readyPassed = response.ok
      && data.status === "ready"
      && rateLimiterRedis?.required === true
      && rateLimiterRedis?.configured === true
      && rateLimiterRedis?.ready === true;
    const logicalBackupPassed = response.ok
      && offsiteBackup?.status === "ok"
      && offsiteBackup?.required === true
      && offsiteBackup?.liveProbe === true
      && typeof offsiteBackup?.lastSuccessfulAt === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        offsiteBackup.lastSuccessfulAt,
      )
      && typeof offsiteBackup?.ageHours === "number"
      && Number.isFinite(offsiteBackup.ageHours)
      && offsiteBackup.ageHours >= 0;
    results.push({
      id: "ready",
      status: readyPassed ? "pass" : "fail",
      detail: readyPassed
        ? `HTTP ${response.status}`
        : `Unexpected HTTP ${response.status} response`,
    });
    results.push({
      id: "postgres_logical_backup_attestation",
      status: logicalBackupPassed ? "pass" : "fail",
      detail: logicalBackupPassed
        ? "Fresh live-bound remote attestation"
        : "Postgres logical-backup attestation is absent, stale, unbound, or unreachable",
    });
  } catch (error) {
    const detail = detailFromError(error, "Request failed");
    results.push({ id: "ready", status: "fail", detail });
    results.push({
      id: "postgres_logical_backup_attestation",
      status: "fail",
      detail,
    });
  }
}

async function checkHtml(id, pathname, requiredText) {
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    const passed = response.ok && /text\/html/i.test(response.headers.get("content-type") || "") && body.includes(requiredText);
    results.push({ id, status: passed ? "pass" : "fail", detail: passed ? `HTTP ${response.status}` : "HTML marker missing" });
  } catch (error) {
    results.push({ id, status: "fail", detail: detailFromError(error, "Request failed") });
  }
}

function nestedData(value) {
  if (!value || typeof value !== "object") return {};
  const data = value.data;
  return data && typeof data === "object" ? data : {};
}

async function getPublicAuthConfig() {
  if (!publicConfigPromise) {
    publicConfigPromise = (async () => {
      const pinnedUrlText = process.env.SUPABASE_URL || "";
      if (!pinnedUrlText) {
        throw new Error("Set protected SUPABASE_URL for smoke authentication");
      }
      const pinnedAnonKey = readProtectedSupabasePublishableKey();
      const pinnedUrl = new URL(pinnedUrlText);
      const smokeTarget = new URL(baseUrl);
      const localSmokeTarget = loopbackHostnames.has(smokeTarget.hostname);
      if (
        localSmokeTarget
          ? pinnedUrlText !== pinnedUrl.origin
          : pinnedUrlText !== canonicalProductionSupabaseOrigin
      ) {
        throw new Error(
          localSmokeTarget
            ? "Protected SUPABASE_URL must be an exact unnormalized provider origin for local smoke authentication"
            : "Protected SUPABASE_URL must be the exact reviewed production provider origin",
        );
      }
      if (
        (pinnedUrl.protocol !== "https:" && pinnedUrl.protocol !== "http:")
        || pinnedUrl.username
        || pinnedUrl.password
        || pinnedUrl.search
        || pinnedUrl.hash
        || (pinnedUrl.pathname !== "/" && pinnedUrl.pathname !== "")
      ) {
        throw new Error("Protected SUPABASE_URL is not a valid provider origin");
      }

      const response = await fetch(`${baseUrl}/api/business/config`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await parseJson(response, "Public auth configuration");
      const data = nestedData(payload);
      const publicUrlText = typeof data.supabaseUrl === "string" ? data.supabaseUrl : "";
      const publicAnonKey = typeof data.supabaseAnonKey === "string" ? data.supabaseAnonKey : "";
      if (!response.ok || !publicUrlText || !publicAnonKey) {
        throw new Error(`Public auth configuration is unavailable (HTTP ${response.status})`);
      }
      const publicUrl = new URL(publicUrlText);
      if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:") {
        throw new Error("Public auth configuration returned an unsupported URL");
      }
      if (publicUrlText !== pinnedUrlText || publicUrl.origin !== pinnedUrl.origin) {
        throw new Error("Public Supabase URL does not match protected SUPABASE_URL");
      }
      if (publicAnonKey !== pinnedAnonKey) {
        throw new Error("Public Supabase key does not match protected SUPABASE_ANON_KEY");
      }
      return { supabaseUrl: pinnedUrlText, supabaseAnonKey: pinnedAnonKey };
    })();
  }
  return publicConfigPromise;
}

async function createDisposableSession(role) {
  const prefix = `PINTPATH_SMOKE_${role.environmentPrefix}`;
  const email = process.env[`${prefix}_EMAIL`]?.trim() || "";
  const password = process.env[`${prefix}_PASSWORD`] || "";
  if (!email || !password) {
    throw new Error(`Set both ${prefix}_EMAIL and ${prefix}_PASSWORD`);
  }

  const { supabaseUrl, supabaseAnonKey } = await getPublicAuthConfig();
  const providerResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({ email, password }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const providerPayload = await parseJson(providerResponse, `${role.label} provider sign-in`);
  const accessToken = typeof providerPayload.access_token === "string" ? providerPayload.access_token : "";
  if (!providerResponse.ok || !accessToken) {
    throw new Error(`${role.label} provider sign-in failed (HTTP ${providerResponse.status})`);
  }

  try {
    const exchangeResponse = await fetch(`${baseUrl}/api/business/auth/supabase-session`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const exchangePayload = await parseJson(exchangeResponse, `${role.label} Pint Path session exchange`);
    const token = typeof nestedData(exchangePayload).token === "string" ? nestedData(exchangePayload).token.trim() : "";
    if (!exchangeResponse.ok || !token) {
      throw new Error(`${role.label} Pint Path session exchange failed (HTTP ${exchangeResponse.status})`);
    }
    return {
      token,
      revokeAfterUse: true,
      source: "supabase_password",
      providerSession: { accessToken, supabaseUrl, supabaseAnonKey },
    };
  } catch (error) {
    await revokeProviderSession({ accessToken, supabaseUrl, supabaseAnonKey }).catch(() => null);
    throw error;
  }
}

async function resolveRoleSession(role) {
  const directToken = process.env[`PINTPATH_SMOKE_${role.environmentPrefix}_TOKEN`]?.trim();
  if (directToken) {
    return { token: directToken, revokeAfterUse: revokeDirectTokens, source: "pintpath_token" };
  }
  if (role.role === "admin") {
    throw new Error("Set PINTPATH_SMOKE_ADMIN_TOKEN to a fresh MFA/AAL2 Pint Path session");
  }
  return createDisposableSession(role);
}

async function revokeSession(role, session) {
  try {
    const response = await fetch(`${baseUrl}/api/business/auth/logout`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await parseJson(response, `${role.label} temporary-session cleanup`);
    const passed = response.ok && nestedData(payload).revoked === true;
    results.push({
      id: `${role.id}_session_cleanup`,
      status: passed ? "pass" : "fail",
      detail: passed ? `HTTP ${response.status}` : `Temporary session was not revoked (HTTP ${response.status})`,
    });
  } catch (error) {
    results.push({
      id: `${role.id}_session_cleanup`,
      status: "fail",
      detail: detailFromError(error, "Temporary session cleanup failed"),
    });
  }

  if (!session.providerSession) return;
  try {
    const response = await revokeProviderSession(session.providerSession);
    const passed = response.ok || [401, 403, 404].includes(response.status);
    results.push({
      id: `${role.id}_provider_session_cleanup`,
      status: passed ? "pass" : "fail",
      detail: passed ? `HTTP ${response.status}` : `Provider session was not revoked (HTTP ${response.status})`,
    });
  } catch (error) {
    results.push({
      id: `${role.id}_provider_session_cleanup`,
      status: "fail",
      detail: detailFromError(error, "Provider session cleanup failed"),
    });
  }
}

function revokeProviderSession(providerSession) {
  return fetch(`${providerSession.supabaseUrl}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      apikey: providerSession.supabaseAnonKey,
      Authorization: `Bearer ${providerSession.accessToken}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}

if (!authOnly) {
  await Promise.all([
    checkJson("health", "/health", (payload) => nestedData(payload).status === "ok"),
    checkProductionReadiness(),
    checkJson("config", "/api/business/config", (payload) => nestedData(payload).priceAccessModel === "fixed_preview"),
    checkJson("venues", "/api/business/venues?limit=3", (payload) => Array.isArray(nestedData(payload).venues)),
    checkJson("prices", "/api/business/price-records?limit=3", (payload) => Array.isArray(nestedData(payload).records)),
    checkHtml("map_page", "/", "Pint Path"),
    checkHtml("account_page", "/account.html", "Pint Path"),
    checkHtml("venue_portal_page", "/venue-portal.html", "Venue portal"),
    checkHtml("admin_page", "/admin.html", "Pint Path"),
  ]);

  if (enforceLaunchFlags) {
    await checkJson("launch_flags", "/api/business/config", (payload) => {
      const data = nestedData(payload);
      return data.commercialLaunchEnabled === expectedCommercialLaunchEnabled
        && data.consumerPaidEnrollmentEnabled === false
        && data.pintPointsRewardsEnabled === false
        && data.alcoholGamificationEnabled === false
        && data.happyHourDiscoveryEnabled === false
        && data.venueProTrialDays === (expectedCommercialLaunchEnabled ? 60 : 0)
        && data.venueProTrialRequiresPaymentMethod === false
        && data.demoBillingMode === false
        && data.fieldTestMode === false;
    });
  }

  if (expectedCommitSha) {
    await checkJson("deployed_commit", "/ready", (payload) => {
      const data = nestedData(payload);
      const deployment = data.deployment && typeof data.deployment === "object" ? data.deployment : {};
      const commitSha = String(deployment.commitSha ?? "").trim();
      return commitSha === expectedCommitSha;
    });
  }
}

const authChecks = [
  {
    role: "user",
    id: "user_account",
    environmentPrefix: "USER",
    label: "User smoke account",
    path: "/api/business/account",
    assert: (payload) => Boolean(nestedData(payload).account),
  },
  {
    role: "venue",
    id: "venue_manager_portal",
    environmentPrefix: "VENUE",
    label: "Venue-manager smoke account",
    path: "/api/business/venue-portal",
    assert: (payload) => Boolean(nestedData(payload).selectedVenue),
  },
  {
    role: "admin",
    id: "admin_queues",
    environmentPrefix: "ADMIN",
    label: "MFA admin smoke account",
    path: "/api/business/admin/queues?limit=1&offset=0",
    assert: (payload) => {
      const data = nestedData(payload);
      return Array.isArray(data.feedback)
        && Array.isArray(data.wrongPriceReports)
        && Array.isArray(data.venueRequests)
        && Boolean(data.pagination)
        && Boolean(data.totals);
    },
  },
];

if (strictAuth) {
  try {
    await getPublicAuthConfig();
  } catch (error) {
    strictAuthConfigError = error;
  }
}

for (const role of authChecks.filter((check) => selectedRoles.has(check.role))) {
  let session = null;
  try {
    if (strictAuthConfigError) throw strictAuthConfigError;
    session = await resolveRoleSession(role);
    await checkJson(role.id, role.path, role.assert, session.token);
  } catch (error) {
    results.push({
      id: role.id,
      status: strictAuth ? "fail" : "skip",
      detail: detailFromError(error, "Authenticated smoke session is unavailable"),
    });
  } finally {
    if (session?.revokeAfterUse) await revokeSession(role, session);
  }
}

const failed = results.filter((result) => result.status === "fail");
console.log(JSON.stringify({
  ok: failed.length === 0,
  baseUrl,
  strictAuth,
  authOnly,
  roles: [...selectedRoles],
  expectedCommitSha,
  enforceLaunchFlags,
  expectedCommercialLaunchEnabled: enforceLaunchFlags
    ? expectedCommercialLaunchEnabled
    : null,
  summary: {
    passed: results.filter((result) => result.status === "pass").length,
    failed: failed.length,
    skipped: results.filter((result) => result.status === "skip").length,
  },
  checks: results,
}, null, 2));

if (failed.length) process.exitCode = 1;
