#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
const EXPECTED_NODE_VERSION = "v22.23.2";
const ROUTE_TIMEOUT_MS = 15_000;
const sourceArtifact = path.resolve(process.cwd(), "dist");
const serverEntrypoint = path.join(sourceArtifact, "src", "server.js");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.version !== EXPECTED_NODE_VERSION) {
  console.error(
    `Rendered artifact smoke requires Node ${EXPECTED_NODE_VERSION.slice(1)}; received ${process.version}.`,
  );
  process.exit(1);
}

if (!fs.existsSync(serverEntrypoint)) {
  console.error("Rendered artifact smoke requires a completed npm run build.");
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  console.error(
    "Rendered artifact smoke requires the lockfile-pinned playwright-core dependency. Run npm ci first.",
  );
  process.exit(1);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a rendered-artifact smoke port.");
  }
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return port;
}

async function waitForHealthyServer(origin, child, output) {
  const deadline = Date.now() + ROUTE_TIMEOUT_MS;
  let healthResponse;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      healthResponse = await fetch(`${origin}/health`);
      if (healthResponse.ok) break;
    } catch {
      // The isolated production artifact is still starting.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  if (!healthResponse?.ok) {
    throw new Error(`Artifact server did not become healthy. ${output.join("").slice(-4_000)}`);
  }
  const startupResponse = await fetch(`${origin}/startup`);
  invariant(
    startupResponse.ok,
    `Artifact startup probe failed with HTTP ${startupResponse.status}.`,
  );
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once("exit", () => resolve(true));
  });
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited,
    new Promise((resolve) => {
      setTimeout(() => resolve(false), 3_000);
    }),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function expectedPermissionDenial(url, status) {
  if (status !== 401) return false;
  const pathname = new URL(url).pathname;
  return pathname === "/api/business/account" || pathname === "/api/business/venue-portal";
}

function consoleErrorIsExpectedPermissionNoise(entry, deniedResponses) {
  if (!/Failed to load resource: the server responded with a status of 401/i.test(entry.text)) {
    return false;
  }
  if (entry.url) {
    try {
      const pathname = new URL(entry.url).pathname;
      if (["/api/business/account", "/api/business/venue-portal"].includes(pathname)) {
        return true;
      }
    } catch {
      // Fall through to the response-bound check below.
    }
  }
  return deniedResponses.length > 0;
}

async function assertBasicFormLabels(page, routeLabel) {
  const unlabeled = await page.evaluate(() => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const labelText = (element) => {
      const ariaLabel = element.getAttribute("aria-label")?.trim();
      if (ariaLabel) return ariaLabel;
      const labelledBy = element.getAttribute("aria-labelledby")?.trim();
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() || "")
          .filter(Boolean)
          .join(" ");
        if (text) return text;
      }
      if (element.id) {
        const explicit = [...document.querySelectorAll("label")]
          .find((label) => label.htmlFor === element.id);
        if (explicit?.textContent?.trim()) return explicit.textContent.trim();
      }
      return element.closest("label")?.textContent?.trim() || "";
    };

    return [...document.querySelectorAll("input:not([type='hidden']), select, textarea")]
      .filter(isVisible)
      .filter((element) => !labelText(element))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        name: element.getAttribute("name"),
        type: element.getAttribute("type"),
      }));
  });
  invariant(
    unlabeled.length === 0,
    `${routeLabel} has visible form controls without labels: ${JSON.stringify(unlabeled)}`,
  );
}

async function assertNoMobileOverflow(page, routeLabel) {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const pageWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0,
    );
    const offenders = [...document.body.querySelectorAll("*")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && (rect.left < -1 || rect.right > viewportWidth + 1);
      })
      .slice(0, 8)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      });
    return { viewportWidth, pageWidth, offenders };
  });
  invariant(
    overflow.pageWidth <= overflow.viewportWidth + 1,
    `${routeLabel} overflows the mobile viewport: ${JSON.stringify(overflow)}`,
  );
}

async function waitForRouteState(page, routeName) {
  if (routeName === "map") {
    await page.locator("#map").filter({ hasText: "Google Maps could not load" }).waitFor({
      state: "visible",
      timeout: ROUTE_TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => document.getElementById("venueRailTitle")?.textContent !== "Loading venue list",
      null,
      { timeout: ROUTE_TIMEOUT_MS },
    );
  } else if (routeName === "venue portal") {
    await page.waitForFunction(
      () => !document.getElementById("claimPanel")?.classList.contains("is-hidden"),
      null,
      { timeout: ROUTE_TIMEOUT_MS },
    );
    await page.waitForFunction(
      () => document.querySelectorAll("[data-commercial-surface]").length === 0,
      null,
      { timeout: ROUTE_TIMEOUT_MS },
    );
  } else if (routeName === "admin") {
    await page.locator("#status").filter({ hasText: "Sign in with an admin account" }).waitFor({
      state: "visible",
      timeout: ROUTE_TIMEOUT_MS,
    });
  }
  await page.evaluate(() => new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  }));
}

async function renderRoute(context, origin, spec, mobile) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const unexpectedResponses = [];
  const failedRequests = [];
  const deniedResponses = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push({
      text: message.text(),
      url: message.location().url || "",
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error instanceof Error ? error.stack || error.message : String(error));
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    if (expectedPermissionDenial(response.url(), response.status())) {
      deniedResponses.push({ url: response.url(), status: response.status() });
      return;
    }
    unexpectedResponses.push({ url: response.url(), status: response.status() });
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      reason: request.failure()?.errorText || "unknown",
    });
  });

  try {
    const response = await page.goto(`${origin}${spec.path}`, {
      waitUntil: "load",
      timeout: ROUTE_TIMEOUT_MS,
    });
    invariant(response?.status() === 200, `${spec.name} returned HTTP ${response?.status() ?? "none"}.`);
    await page.locator("h1").filter({ hasText: spec.heading }).first().waitFor({
      state: "visible",
      timeout: ROUTE_TIMEOUT_MS,
    });
    await waitForRouteState(page, spec.name);

    const title = await page.title();
    invariant(spec.title.test(title), `${spec.name} rendered unexpected title ${JSON.stringify(title)}.`);
    await assertBasicFormLabels(page, spec.name);
    if (mobile) await assertNoMobileOverflow(page, spec.name);

    if (spec.name === "map") {
      const mapFallback = await page.locator("#map").innerText();
      invariant(
        /Missing Google Maps browser key/.test(mapFallback),
        `Map fallback did not explain the missing browser key: ${JSON.stringify(mapFallback)}`,
      );
      invariant(
        await page.locator("#venueRail").getAttribute("aria-hidden") === "false",
        "Map fallback did not expose the venue-list alternative.",
      );
    }

    if (spec.name === "venue portal") {
      const anonymousResult = await page.evaluate(async () => {
        const permissionResponse = await fetch("/api/business/venue-portal", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        return {
          status: permissionResponse.status,
          payload: await permissionResponse.json(),
        };
      });
      invariant(
        anonymousResult.status === 401
          && anonymousResult.payload?.ok === false
          && anonymousResult.payload?.error?.message === "Login required."
          && anonymousResult.payload?.error?.stack === undefined,
        `Anonymous venue permission response was not fail-closed and sanitized: ${JSON.stringify(anonymousResult)}`,
      );
      const renderedUrl = new URL(page.url());
      invariant(
        !renderedUrl.searchParams.has("checkout") && !renderedUrl.searchParams.has("billing"),
        `Commercial return parameters survived while launch is disabled: ${renderedUrl.href}`,
      );
      invariant(
        await page.locator("[data-upgrade-tier]").count() === 0,
        "Commercial upgrade controls rendered while launch is disabled.",
      );
    }

    if (spec.name === "admin") {
      invariant(await page.locator("#adminContent").isHidden(), "Anonymous admin content became visible.");
    }

    await page.waitForLoadState("networkidle", { timeout: ROUTE_TIMEOUT_MS });
    await page.evaluate(() => new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    }));

    const actionableConsoleErrors = consoleErrors.filter(
      (entry) => !consoleErrorIsExpectedPermissionNoise(entry, deniedResponses),
    );
    invariant(pageErrors.length === 0, `${spec.name} page errors: ${JSON.stringify(pageErrors)}`);
    invariant(
      actionableConsoleErrors.length === 0,
      `${spec.name} console errors: ${JSON.stringify(actionableConsoleErrors)}`,
    );
    invariant(
      unexpectedResponses.length === 0,
      `${spec.name} unexpected HTTP responses: ${JSON.stringify(unexpectedResponses)}`,
    );
    invariant(
      failedRequests.length === 0,
      `${spec.name} failed browser requests: ${JSON.stringify(failedRequests)}`,
    );
    console.log(`[browser-smoke] PASS ${mobile ? "mobile" : "desktop"} ${spec.path}`);
  } finally {
    await page.close();
  }
}

async function createContext(browser, origin, viewport, externalRequests) {
  const context = await browser.newContext({
    viewport,
    locale: "en-AU",
    timezoneId: "Australia/Melbourne",
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.addInitScript(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem("pintPathCookieConsent", "essential");
  });
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const parsed = new URL(requestUrl);
    if (parsed.origin === origin || ["data:", "blob:"].includes(parsed.protocol)) {
      await route.continue();
      return;
    }
    externalRequests.push(requestUrl);
    await route.abort("blockedbyclient");
  });
  return context;
}

const desktopRoutes = [
  {
    name: "map",
    path: "/",
    heading: "Pint Path",
    title: /Melbourne Venue & Beer Price Directory \| Pint Path/,
  },
  {
    name: "venue portal",
    path: "/venue-portal?checkout=success&billing=returned&tab=specials",
    heading: "Venue portal",
    title: /Bar Owner Dashboard & Venue Portal \| Pint Path/,
  },
  {
    name: "admin",
    path: "/admin.html",
    heading: "Pint Path admin",
    title: /Admin \| Pint Path/,
  },
  {
    name: "feedback",
    path: "/feedback.html",
    heading: "Tell us what you need, or ask about joining as a venue.",
    title: /Contact Pint Path \| Support and Bar Partnerships/,
  },
  {
    name: "privacy",
    path: "/privacy.html",
    heading: "Clear rules for Pint Path data.",
    title: /Privacy Policy \| Pint Path/,
  },
  {
    name: "terms",
    path: "/terms.html",
    heading: "Use Pint Path fairly, accurately, and responsibly.",
    title: /Terms and Conditions \| Pint Path/,
  },
];
const mobileRoutes = desktopRoutes.filter(({ name }) => ["map", "venue portal"].includes(name));

const isolatedRoot = fs.mkdtempSync(path.join(process.cwd(), ".artifact-browser-smoke-"));
const copiedArtifact = path.join(isolatedRoot, "dist");
const output = [];
const externalRequests = [];
let child;
let browser;

try {
  fs.cpSync(sourceArtifact, copiedArtifact, { recursive: true });
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(copiedArtifact, "src", "server.js")], {
    cwd: isolatedRoot,
    env: {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_BASE_URL: origin,
      DATABASE_PATH: path.join(isolatedRoot, "data", "pint-path.sqlite"),
      SOURCE_EVIDENCE_STORAGE_DIR: path.join(isolatedRoot, "data", "source-evidence"),
      OUTBOUND_CALLS_ENABLED: "false",
      COMMERCIAL_LAUNCH_ENABLED: "false",
      CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
      PINT_POINTS_REWARDS_ENABLED: "false",
      ALCOHOL_GAMIFICATION_ENABLED: "false",
      GOOGLE_MAPS_API_KEY: "",
      GOOGLE_MAPS_MAP_ID: "",
      GOOGLE_PLACES_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  await waitForHealthyServer(origin, child, output);

  const executablePath = process.env.PINTPATH_BROWSER_EXECUTABLE_PATH?.trim();
  if (executablePath) {
    invariant(fs.existsSync(executablePath), `Browser executable does not exist: ${executablePath}`);
  }
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });

  const desktopContext = await createContext(
    browser,
    origin,
    { width: 1280, height: 800 },
    externalRequests,
  );
  try {
    for (const spec of desktopRoutes) {
      await renderRoute(desktopContext, origin, spec, false);
    }
  } finally {
    await desktopContext.close();
  }

  const mobileContext = await createContext(
    browser,
    origin,
    { width: 390, height: 844 },
    externalRequests,
  );
  try {
    for (const spec of mobileRoutes) {
      await renderRoute(mobileContext, origin, spec, true);
    }
  } finally {
    await mobileContext.close();
  }

  invariant(
    externalRequests.length === 0,
    `Rendered smoke attempted external provider requests: ${JSON.stringify(externalRequests)}`,
  );
  console.log(
    "Rendered production artifact browser smoke passed (6 direct routes, 2 mobile routes, no provider calls).",
  );
} catch (error) {
  const serverTail = output.join("").slice(-4_000);
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  if (serverTail) console.error(`Artifact server output (tail):\n${serverTail}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await stopChild(child);
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
}
