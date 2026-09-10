#!/usr/bin/env node
// Uses a disposable loopback fixture by default. Permanent staging requires exact opt-in.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { validatePilotBrowserTarget } from "./lib/bar-pilot-browser-target.mjs";

const fixturePath = process.env.PINTPATH_PILOT_BROWSER_FIXTURE_PATH || "/tmp/pintpath-bar-pilot-browser-fixture.json";
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const { origin, hosted } = validatePilotBrowserTarget(fixture, process.env.PINTPATH_PILOT_BROWSER_ALLOW_STAGING === "true");
const output = process.env.PINTPATH_PILOT_BROWSER_OUTPUT || "/tmp/pintpath-pilot-browser-evidence";
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PINTPATH_BROWSER_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const evidence = [];
const pageErrors = [];
const pass = (check) => { evidence.push(check); console.log(`PASS ${check}`); };
function invariant(condition, message) { if (!condition) throw new Error(message); }
async function textIncludes(page, selector, text) {
  try { await page.waitForFunction(({ selector: selected, text: expected }) => document.querySelector(selected)?.textContent?.includes(expected), { selector, text }, { timeout: 20000 }); }
  catch { throw new Error(`${selector} expected ${text}; shown: ${await page.locator(selector).textContent()}`); }
}
async function phoneFits(page, label) {
  invariant(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1), `${label} overflows the iPhone viewport.`);
  pass(`iPhone layout: ${label}`);
}
async function login(role, mobile = false) {
  if (hosted && !fixture.accounts[role].storageState) throw new Error("Hosted acceptance requires an existing legitimate authenticated browser storageState file for each role.");
  const context = await browser.newContext({ ...(hosted ? { storageState: fixture.accounts[role].storageState } : {}), viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => pageErrors.push({ role, error: error.message }));
  await page.goto(`${origin}/account.html`);
  if (await page.locator('[data-cookie-choice="essential"]').isVisible()) await page.locator('[data-cookie-choice="essential"]').click();
  if (hosted) {
    await page.locator("#accountDashboard").waitFor({ state: "visible" });
    pass(`${role} existing Supabase-authenticated browser session is accepted`);
    return page;
  }
  if (mobile) {
    await phoneFits(page, "sign-in");
    await page.locator("#showSignupButton").click();
    await phoneFits(page, "signup");
    await page.locator("#showLoginButton").click();
  }
  await page.locator('#loginForm [name="email"]').fill(fixture.accounts[role].email);
  await page.locator('#loginForm [name="password"]').fill(fixture.accounts[role].password);
  await page.locator('#loginForm button[type="submit"]').click();
  try { await page.waitForFunction(() => ["accountDashboard", "portalContent"].some((id) => { const element = document.getElementById(id); return element && !element.hidden && !element.classList.contains("is-hidden"); })); }
  catch { throw new Error(`${role} sign-in failed: ${await page.locator("#authStatus").textContent()}`); }
  pass(`${role} signs in through the normal browser form`);
  return page;
}
async function showCounter(page) {
  await page.goto(`${origin}/venue-portal.html?venueId=${encodeURIComponent(fixture.venueId)}&tab=redemption`);
  await page.locator("#memberPurchaseForm").waitFor({ state: "visible" });
}
async function identify(page, code) {
  await page.locator('#memberPurchaseForm [name="code"]').fill(code);
  await page.locator("#checkMemberButton").click();
  await page.waitForFunction(() => !document.getElementById("memberPurchaseFields")?.disabled);
}
try {
  const publicContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const publicPage = await publicContext.newPage();
  await publicPage.goto(`${origin}/?venueId=${encodeURIComponent(fixture.venueId)}`);
  await publicPage.locator('[data-cookie-choice="essential"]').click();
  await publicPage.waitForFunction(() => document.getElementById("venueDetailOverlay")?.getAttribute("aria-hidden") === "false");
  await phoneFits(publicPage, "anonymous direct venue link after cookie choice");
  await publicPage.locator("#closeVenueDetail").click();
  pass("fresh anonymous venue link keeps cookie choice and venue close controls usable");
  await publicContext.close();
  const customer = await login("customer", true);
  const manager = await login("manager");
  const staff = await login("staff");
  await showCounter(manager);
  await showCounter(staff);
  invariant(await staff.locator('[data-tab="profile"]').isHidden(), "Counter staff can see manager profile controls.");
  invariant(await staff.locator("#pilotDemoPanel").isHidden(), "Staff can see restricted demo controls.");
  pass("staff controls stay separate from manager/demo controls");
  await manager.locator('[data-tab="profile"]').click();
  await manager.locator('#profileForm [name="phone"]').fill("03 9000 0123");
  await manager.locator('[data-opening-day="mon"] [data-opening-open]').check();
  await manager.locator('[data-opening-day="mon"] [data-opening-start]').fill("13:00");
  await manager.locator('#profileForm button[type="submit"]').click();
  await textIncludes(manager, "#profileStatus", "saved");
  pass("manager edits venue profile and ordinary opening hours");
  await manager.locator('[data-tab="beers"]').click();
  for (const [beer, size, price] of [["Carlton Draught", "schooner", "10.50"], ["Guinness", "pot", "8.50"], ["Stone & Wood Pacific Ale", "schooner", "11.50"]]) {
    const existing = manager.locator("#beerList .listItem").filter({ hasText: beer }).filter({ hasText: size });
    if (await existing.count()) await existing.first().locator("[data-edit-beer]").click();
    await manager.locator('#beerForm [name="beerName"]').fill(beer);
    await manager.locator('#beerForm [name="beerName"]').dispatchEvent("change");
    await manager.locator('#beerForm [name="serveSize"]').selectOption(size);
    await manager.locator('#beerForm [name="price"]').fill(price);
    await manager.locator('#beerForm [name="onTap"]').check();
    await manager.locator('#beerForm [name="inStock"]').check();
    await manager.locator('#beerForm [name="priceConfirmed"]').check();
    await manager.locator('#beerForm [name="stockConfirmed"]').check();
    const [saveResponse] = await Promise.all([
      manager.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/beers")),
      manager.locator('#beerForm button[type="submit"]').click(),
    ]);
    invariant(saveResponse.ok(), `Beer save rejected (${saveResponse.status()}): ${await saveResponse.text()}`);
    await textIncludes(manager, "#beerStatus", "saved");
    try { await manager.waitForFunction(() => document.querySelector('#beerForm [name="beerName"]')?.value === ""); }
    catch { throw new Error(`Beer form did not complete: ${await manager.locator("#beerStatus").textContent()}`); }
  }
  pass("manager creates or updates three beer/size/stock/price rows using the form");
  await customer.goto(`${origin}/?venueId=${encodeURIComponent(fixture.venueId)}`);
  await textIncludes(customer, "#venueRail", "Pilot");
  await phoneFits(customer, "map-provider fallback and venue list");
  if (await customer.locator("#venueDetailOverlay").isHidden()) await customer.locator(".venueRail__card").first().click();
  await customer.locator("#venueDetailOverlay").waitFor({ state: "visible" });
  await textIncludes(customer, "#venueDetailOverlay", "$10.5");
  await textIncludes(customer, "#venueDetailOverlay", "Guinness");
  await textIncludes(customer, "#venueDetailOverlay", "Balter XPA");
  await phoneFits(customer, "venue details and published beers/prices");
  await customer.waitForFunction(() => getComputedStyle(document.getElementById("venueDetailOverlay")).opacity === "1");
  await customer.screenshot({ path: path.join(output, "iphone-venue.png"), fullPage: true, animations: "disabled" });
  pass("manager venue changes and non-preview pilot beers publish to the customer phone");
  await customer.locator("#closeVenueDetail").click();
  await customer.locator("#beerSearch").selectOption({ label: "Balter XPA" });
  await textIncludes(customer, "#venueRail", "Pilot");
  await phoneFits(customer, "beer search");
  await customer.goto(`${origin}/account.html`);
  await customer.locator("#betaFeaturePintPoints").waitFor({ state: "visible" });
  await customer.locator("#refreshPintPointPassButton").click();
  await customer.locator("#pintPointPassResult").waitFor({ state: "visible" });
  const code = await customer.locator("#pintPointPassCode").innerText();
  invariant(/^[A-Z0-9]{6}$/.test(code), "Customer pass is not a six-character rotating code.");
  await phoneFits(customer, "account wallet and rotating QR");
  invariant((await customer.locator("#pintPointPassQr").boundingBox()).width >= 200, "QR is too small to scan.");
  await customer.screenshot({ path: path.join(output, "iphone-wallet.png"), fullPage: true });
  await manager.locator('[data-tab="redemption"]').click();
  await identify(manager, code);
  await manager.locator('[data-pilot-threshold="49"]').click();
  await textIncludes(manager, "#pilotDemoStatus", "49");
  await textIncludes(customer, "#pintPointBalanceHero", "49 / 50");
  await manager.locator('#memberPurchaseForm [name="itemName"]').fill("Carlton Draught");
  await manager.locator("#recordMemberPurchaseButton").click();
  await textIncludes(manager, "#memberPurchaseStatus", "recorded");
  await textIncludes(customer, "#pintPointBalanceHero", "50 / 50");
  pass("one eligible purchase propagates exactly one point to the phone and unlocks fifty-point reward");
  await manager.locator("#repeatPilotPurchaseButton").click();
  await textIncludes(manager, "#pilotDemoStatus", "no duplicate Pint Point");
  invariant((await customer.locator("#pintPointBalanceHero").innerText()).includes("50 / 50"), "Duplicate receipt changed points.");
  pass("normal demo control retries the identical transaction without duplicate award");
  await customer.locator("#freePintRewardButton").click();
  await customer.locator("#freePintRewardResult").waitFor({ state: "visible" });
  const reward = await customer.locator("#freePintRewardCode").innerText();
  await staff.locator('#freePintRewardForm [name="code"]').fill(reward);
  await staff.locator('[data-free-pint-action="confirm"]').click();
  await textIncludes(staff, "#freePintRewardStatus", "FREE PINT REDEEMED");
  await textIncludes(customer, "#pintPointBalanceHero", "0 / 50");
  await textIncludes(customer, "#pintPointWalletStatus", "FREE PINT REDEEMED");
  invariant(await customer.locator("#freePintRewardResult").isHidden(), "Redeemed reward remains presented to the customer.");
  pass("staff redemption consumes exactly fifty, earns no point, clears customer QR and updates both screens");
  await staff.locator('[data-free-pint-action="confirm"]').click();
  await staff.waitForFunction(() => document.getElementById("freePintRewardStatus")?.classList.contains("notice--warning"));
  invariant(!(await staff.locator("#freePintRewardStatus").innerText()).includes("FREE PINT REDEEMED"), "Replayed reward reports success.");
  pass("same reward replay visibly fails");
  await manager.locator('[data-tab="history"]').click();
  await manager.locator("#refreshReconciliationButton").click();
  await textIncludes(manager, "#reconciliationHistory", "Free pint redeemed");
  pass("manager history shows the purchase and successful redemption");
  await manager.screenshot({ path: path.join(output, "manager-history.png"), fullPage: true });
  await manager.locator('[data-tab="redemption"]').click();
  await customer.locator("#refreshPintPointPassButton").click();
  await customer.locator("#pintPointPassResult").waitFor({ state: "visible" });
  await identify(manager, await customer.locator("#pintPointPassCode").innerText());
  await manager.locator('#memberPurchaseForm [name="itemName"]').fill("Guinness");
  await manager.locator("#recordMemberPurchaseButton").click();
  await textIncludes(customer, "#pintPointBalanceHero", "1 / 50");
  await manager.locator('[data-tab="history"]').click();
  await manager.locator("#refreshReconciliationButton").click();
  await manager.locator("[data-void-pint-point]").first().click();
  await manager.locator('#voidPintPointForm [name="reason"]').fill("Demo mistaken member purchase");
  await manager.locator('#voidPintPointForm button[type="submit"]').click();
  await textIncludes(customer, "#pintPointBalanceHero", "0 / 50");
  await textIncludes(manager, "#reconciliationHistory", "Reversed");
  pass("audited reversal corrects the balance and retains original history");
  invariant(pageErrors.length === 0, `Browser exceptions: ${JSON.stringify(pageErrors)}`);
  fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ runtime: hosted ? "permanent hosted staging" : "disposable loopback PostgreSQL 17", viewport: "390x844", evidence, pageErrors }, null, 2));
  console.log(`Completed ${evidence.length} browser checks. Evidence: ${output}`);
} finally { await browser.close(); }
