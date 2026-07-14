const baseUrl = (process.env.PINTPATH_SMOKE_BASE_URL || "https://pintpath.au").replace(/\/$/, "");
const strictAuth = process.argv.includes("--strict-auth");
const authOnly = process.argv.includes("--auth-only");
const expectedCommitSha = process.env.PINTPATH_EXPECTED_COMMIT_SHA?.trim() || null;
const revokeDirectTokens = process.env.PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS === "true";

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
      const pinnedUrlText = process.env.SUPABASE_URL?.trim() || "";
      const pinnedAnonKey = process.env.SUPABASE_ANON_KEY?.trim() || "";
      if (!pinnedUrlText || !pinnedAnonKey) {
        throw new Error("Set protected SUPABASE_URL and SUPABASE_ANON_KEY values for smoke authentication");
      }
      const pinnedUrl = new URL(pinnedUrlText);
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
      const smokeTarget = new URL(baseUrl);
      const localSmokeTarget = ["localhost", "127.0.0.1", "::1"].includes(smokeTarget.hostname);
      if (!localSmokeTarget && pinnedUrl.protocol !== "https:") {
        throw new Error("Protected SUPABASE_URL must use HTTPS for production smoke authentication");
      }

      const response = await fetch(`${baseUrl}/api/business/config`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await parseJson(response, "Public auth configuration");
      const data = nestedData(payload);
      const publicUrlText = typeof data.supabaseUrl === "string" ? data.supabaseUrl.trim() : "";
      const publicAnonKey = typeof data.supabaseAnonKey === "string" ? data.supabaseAnonKey.trim() : "";
      if (!response.ok || !publicUrlText || !publicAnonKey) {
        throw new Error(`Public auth configuration is unavailable (HTTP ${response.status})`);
      }
      const publicUrl = new URL(publicUrlText);
      if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:") {
        throw new Error("Public auth configuration returned an unsupported URL");
      }
      if (publicUrl.origin !== pinnedUrl.origin) {
        throw new Error("Public Supabase URL does not match protected SUPABASE_URL");
      }
      if (publicAnonKey !== pinnedAnonKey) {
        throw new Error("Public Supabase key does not match protected SUPABASE_ANON_KEY");
      }
      return { supabaseUrl: pinnedUrl.origin, supabaseAnonKey: pinnedAnonKey };
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
    checkJson("ready", "/ready", (payload) => nestedData(payload).status === "ready"),
    checkJson("config", "/api/business/config", (payload) => Boolean(nestedData(payload).pricing)),
    checkJson("venues", "/api/business/venues?limit=3", (payload) => Array.isArray(nestedData(payload).venues)),
    checkJson("prices", "/api/business/price-records?limit=3", (payload) => Array.isArray(nestedData(payload).records)),
    checkHtml("map_page", "/", "Pint Path"),
    checkHtml("account_page", "/account.html", "Pint Path"),
    checkHtml("venue_portal_page", "/venue-portal.html", "Venue portal"),
    checkHtml("admin_page", "/admin.html", "Pint Path"),
  ]);

  if (expectedCommitSha) {
    await checkJson("deployed_commit", "/ready", (payload) => {
      const data = nestedData(payload);
      const deployment = data.deployment && typeof data.deployment === "object" ? data.deployment : {};
      const commitSha = String(deployment.commitSha ?? "").trim();
      return Boolean(commitSha) && (
        commitSha === expectedCommitSha
        || commitSha.startsWith(expectedCommitSha)
        || expectedCommitSha.startsWith(commitSha)
      );
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

for (const role of authChecks.filter((check) => selectedRoles.has(check.role))) {
  let session = null;
  try {
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
  summary: {
    passed: results.filter((result) => result.status === "pass").length,
    failed: failed.length,
    skipped: results.filter((result) => result.status === "skip").length,
  },
  checks: results,
}, null, 2));

if (failed.length) process.exitCode = 1;
