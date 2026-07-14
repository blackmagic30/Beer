const baseUrl = (process.env.PINTPATH_SMOKE_BASE_URL || "https://pintpath.au").replace(/\/$/, "");
const strictAuth = process.argv.includes("--strict-auth");
const expectedCommitSha = process.env.PINTPATH_EXPECTED_COMMIT_SHA?.trim() || null;

interface CheckResult {
  id: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

const results: CheckResult[] = [];

async function checkJson(id: string, pathname: string, assertion: (data: unknown) => boolean, token?: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json() as unknown;
    const passed = response.ok && assertion(payload);
    results.push({
      id,
      status: passed ? "pass" : "fail",
      detail: passed ? `HTTP ${response.status}` : `Unexpected HTTP ${response.status} response`,
    });
  } catch (error) {
    results.push({ id, status: "fail", detail: error instanceof Error ? error.message : "Request failed" });
  }
}

async function checkHtml(id: string, pathname: string, requiredText: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    const passed = response.ok && /text\/html/i.test(response.headers.get("content-type") || "") && body.includes(requiredText);
    results.push({ id, status: passed ? "pass" : "fail", detail: passed ? `HTTP ${response.status}` : "HTML marker missing" });
  } catch (error) {
    results.push({ id, status: "fail", detail: error instanceof Error ? error.message : "Request failed" });
  }
}

function nestedData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const data = (value as { data?: unknown }).data;
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}

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
    const deployment = data.deployment && typeof data.deployment === "object"
      ? data.deployment as Record<string, unknown>
      : {};
    const commitSha = String(deployment.commitSha ?? "").trim();
    return Boolean(commitSha) && (
      commitSha === expectedCommitSha
      || commitSha.startsWith(expectedCommitSha)
      || expectedCommitSha.startsWith(commitSha)
    );
  });
}

const authChecks = [
  {
    id: "user_account",
    token: process.env.PINTPATH_SMOKE_USER_TOKEN,
    path: "/api/business/account",
    assert: (payload: unknown) => Boolean(nestedData(payload).account),
  },
  {
    id: "venue_manager_portal",
    token: process.env.PINTPATH_SMOKE_VENUE_TOKEN,
    path: "/api/business/venue-portal",
    assert: (payload: unknown) => Boolean(nestedData(payload).selectedVenue),
  },
  {
    id: "admin_queues",
    token: process.env.PINTPATH_SMOKE_ADMIN_TOKEN,
    path: "/api/business/admin/queues?limit=1&offset=0",
    assert: (payload: unknown) => {
      const data = nestedData(payload);
      return Array.isArray(data.feedback)
        && Array.isArray(data.wrongPriceReports)
        && Array.isArray(data.venueRequests)
        && Boolean(data.pagination)
        && Boolean(data.totals);
    },
  },
];

for (const check of authChecks) {
  if (!check.token) {
    results.push({
      id: check.id,
      status: strictAuth ? "fail" : "skip",
      detail: strictAuth ? "Required smoke token is missing" : "Set the matching PINTPATH_SMOKE_*_TOKEN for role proof",
    });
    continue;
  }
  await checkJson(check.id, check.path, check.assert, check.token);
}

const failed = results.filter((result) => result.status === "fail");
console.log(JSON.stringify({
  ok: failed.length === 0,
  baseUrl,
  strictAuth,
  expectedCommitSha,
  summary: {
    passed: results.filter((result) => result.status === "pass").length,
    failed: failed.length,
    skipped: results.filter((result) => result.status === "skip").length,
  },
  checks: results,
}, null, 2));

if (failed.length) process.exitCode = 1;
