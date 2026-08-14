import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readViewer(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer", file), "utf8");
}

describe("public UI hardening", () => {
  it("keeps production map configuration authoritative and refreshes account identity before personal storage", () => {
    const html = readViewer("index.html");

    expect(html).toContain('const IS_LOCAL_VIEWER_ORIGIN = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)');
    expect(html).toContain('(IS_LOCAL_VIEWER_ORIGIN && (params.get("googleMapsMapId") || params.get("mapId")))');
    expect(html).toContain('(IS_LOCAL_VIEWER_ORIGIN && (params.get("googleMapsKey") || window.localStorage.getItem("googleMapsKey")))');
    expect(html).toContain('mapId: EFFECTIVE_GOOGLE_MAPS_MAP_ID');
    expect(html).toContain('GOOGLE_MAPS_MAP_ID ||\n      GOOGLE_MAPS_DEMO_MAP_ID');
    expect(html).toContain('if (IS_LOCAL_VIEWER_ORIGIN && params.get("googleMapsKey"))');
    expect(html).toContain('if (response.isAuthenticated) {\n          await window.MelbBeerBusiness.apiFetch("/api/business/account");');
    expect(html).toContain('window.MelbBeerBusiness.setAccountContext(null);\n        console.warn("Could not load business access state"');
    expect(html).toContain("function getPersonalStorageKey");
    expect(html).toContain("getAccountScopedStorageKey(baseKey, accountId)");
    expect(html.indexOf("await refreshBusinessAccess();")).toBeLessThan(html.indexOf("recentlyViewedVenues = readStoredVenues"));
  });

  it("keeps privacy-sensitive feedback out of query strings when JavaScript is unavailable", () => {
    const html = readViewer("feedback.html");

    expect(html).toContain('method="post" action="/api/business/feedback"');
    expect(html).toContain("<noscript>");
    expect(html).not.toContain('method="get"');
  });

  it("does not overstate production price coverage or expose pre-launch happy-hour discovery", () => {
    const html = readViewer("index.html");

    expect(html).toContain("Verified price coverage is limited and expanding");
    expect(html).toContain("Confirm current details with the venue.");
    expect(html).not.toContain("verified beer prices and happy hours across Melbourne");
    expect(html).toContain("const HAPPY_HOUR_DISCOVERY_ENABLED = BUSINESS_CONFIG.happyHourDiscoveryEnabled === true");
    expect(html).not.toContain('data-filter-chip="happy_hour_active_now"');
    expect(html).toContain("if (!HAPPY_HOUR_DISCOVERY_ENABLED)");
    expect(html).not.toContain('<option value="happy_hour_changed">');
  });

  it("uses accessible, cancellable dialogs instead of destructive prompt-based reporting", () => {
    const html = readViewer("index.html");

    expect(html).toContain('id="venueDetailOverlay" class="is-hidden-panel" role="dialog" aria-modal="true"');
    expect(html).toContain('id="wrongPriceDialog" class="panel wrongPriceDialog"');
    expect(html).toContain('id="wrongPriceStatus" class="notice" role="status" aria-live="polite"');
    ["price_changed", "beer_not_available", "wrong_serving_size", "other"].forEach((reason) => {
      expect(html).toContain(`<option value="${reason}">`);
    });
    expect(html).toContain('wrongPriceDialog.close("cancel")');
    expect(html).toContain('wrongPriceDialog.close("submitted")');
    expect(html).toContain("element !== venueDetailOverlayEl && element !== wrongPriceDialog");
    expect(html).toContain("if (wrongPriceDialog.open) {");
    expect(html).toContain("wrongPriceReportContext?.button?.focus?.()");
    expect(html).not.toContain("window.prompt(");
    expect(html).not.toContain("prompt(");
  });

  it("keeps utility pages navigable and gives support submissions a reference", () => {
    const stats = readViewer("stats.html");
    const feedback = readViewer("feedback.html");
    const pricing = readViewer("pricing.html");

    expect(stats).toContain('$("nav").innerHTML = MelbBeerBusiness.renderNav("account")');
    expect(feedback).toContain("result.feedback?.id");
    expect(feedback).toContain("Keep this reference for follow-up.");
    expect(pricing).toContain('class="pricingAudienceSwitch" role="tablist"');
    expect(pricing).toContain('role="tabpanel" aria-labelledby="consumerPricingTab userPricingTitle"');
    expect(pricing).toContain('role="tabpanel" aria-labelledby="venuePricingTab venuePricingTitle" hidden');
    expect(pricing).toContain('url.searchParams.set("audience", showVenuePricing ? "venues" : "users")');
  });

  it("renders the 404 navigation without a CSP-blocked inline script", () => {
    const notFound = readViewer("404.html");
    const notFoundScript = readViewer("404.js");

    expect(notFound).toContain('<script src="/404.js" defer></script>');
    expect(notFound).not.toMatch(/<script>\s*window\.addEventListener/);
    expect(notFoundScript).toContain('document.getElementById("nav")');
    expect(notFoundScript).toContain('window.MelbBeerBusiness.renderNav("")');
  });

  it("keeps security-page consent copy aligned with the live account controls", () => {
    const security = readViewer("security.html");

    expect(security).toContain("optional analytics and dependent venue-report inclusion");
    expect(security).toContain("does not currently run a separate research-contact or marketing-email programme");
    expect(security).not.toContain("research contact, and email update preferences");
  });

  it("shows account deletion progress and per-device session controls", () => {
    const account = readViewer("account.html");

    expect(account).toContain('id="accountDeletionStatus"');
    expect(account).toContain('MelbBeerBusiness.apiFetch("/api/business/account/delete-request")');
    expect(account).toContain("data-cancel-deletion-request");
    expect(account).toContain('id="accountSessionList"');
    expect(account).toContain("/api/business/account/sessions?limit=${ACCOUNT_SESSION_PAGE_SIZE}&offset=${requestedOffset}");
    expect(account).toContain("requestId !== accountSessionsRequestId");
    expect(account).toContain("requestedOffset !== state.accountSessionOffset");
    expect(account).toContain("!isAccountUiContextCurrent(requestedContext)");
    expect(account).toContain("data-revoke-account-session");
    expect(account).toContain("Review active sessions and revoke any device you do not recognise.");
  });

  it("requires a live recovery callback before accepting a new password", () => {
    const business = readViewer("business.js");
    const callback = readViewer("auth/callback.html");
    const reset = readViewer("reset-password.html");

    expect(callback).toContain("MelbBeerBusiness.markPasswordRecoverySession(result.account?.id)");
    expect(reset).toContain("MelbBeerBusiness.validatePasswordRecoverySession()");
    expect(business).toContain("PASSWORD_RECOVERY_MAX_AGE_MS");
    expect(business).toContain("value.accountId !== getAccountScopeId()");
    expect(business).toContain('throw new Error("Open the latest password reset email before setting a new password.")');
    expect(business).toContain("window.sessionStorage.removeItem(PASSWORD_RECOVERY_KEY)");
  });

  it("keeps asynchronous search, paging, and geocoding responses from overwriting newer input", () => {
    const account = readViewer("account.html");
    const submit = readViewer("submit.html");
    const missions = readViewer("missions.html");
    const portal = readViewer("venue-portal.html");
    const admin = readViewer("admin.html");

    expect(account).toContain("pubGolfLocationRequestIds.get(input) !== requestId");
    expect(account).toContain("requestId !== submissionHistoryRequestId");
    expect(account).toContain("requestedOffset !== state.submissionHistoryOffset");
    expect(missions).toContain("requestId !== missionAreaRequestId || suburbFilter.value.trim() !== query");
    expect(submit).toContain("requestId !== newVenueGoogleSearchRequestId || newVenueGoogleSearch.value.trim() !== query");
    expect(portal).toContain("requestId !== venueClaimSearchRequestId");
    expect(admin).toContain("requestId !== adminGoogleVenueSearchRequestId || adminGoogleVenueSearch.value.trim() !== query");
    expect(admin).toContain("requestId !== managerUserSearchRequestId || managerUserSearch.value.trim() !== query");
    expect(admin).toContain("requestId !== adminLoadRequestId");
  });

  it("preserves private venue return state without putting redemption codes in the login URL", () => {
    const business = readViewer("business.js");
    const portal = readViewer("venue-portal.html");
    const account = readViewer("account.html");
    const callback = readViewer("auth/callback.html");

    expect(business).toContain('const SENSITIVE_AUTH_RETURN_KEY = "pintPathSensitiveAuthReturnTo"');
    expect(business).toContain("window.sessionStorage.setItem(SENSITIVE_AUTH_RETURN_KEY, JSON.stringify({ path: safePath, createdAt: Date.now() }))");
    expect(business).toContain("Date.now() - record.createdAt > SENSITIVE_AUTH_RETURN_MAX_AGE_MS");
    expect(portal).toContain("sensitiveRedemptionReturnPath");
    expect(portal).toContain("MelbBeerBusiness.storeSensitiveAuthReturnPath(sensitiveRedemptionReturnPath)");
    expect(business).toContain("PENDING_PORTAL_REDEMPTION_KEY");
    expect(business).toContain('url.searchParams.delete("discountCode")');
    expect(business).toContain('fragmentParams.delete("discountCode")');
    expect(portal).toContain('initialRedemptionUrl.hash.replace(/^#/, "")');
    expect(portal).toContain("MelbBeerBusiness.consumePendingPortalRedemption()");
    expect(account).toContain("function authenticatedReturnDestination(account)");
    expect(callback).toContain("MelbBeerBusiness.consumeSensitiveAuthReturnPath()");
  });

  it("renders venue-managed public profile fields and exposes selected filter state", () => {
    const map = readViewer("index.html");

    expect(map).toContain("function renderVenuePublicProfileMarkup(row, venue)");
    expect(map).toContain('venue?.website');
    expect(map).toContain('venue?.instagram');
    expect(map).toContain('venue?.phone');
    expect(map).toContain('class="beerPopup__openState ${openNow ? "is-open" : ""}"');
    expect(map).not.toContain('data-filter-chip="happy_hour_active_now"');
    expect(map).toContain('data-beer-chip="${escapeHtml(beer.query)}" aria-pressed="false"');
    expect(map).toContain('chipEl.setAttribute("aria-pressed", isActive ? "true" : "false")');
  });

  it("serializes account night-plan writes and reports local-only fallback on sync failure", () => {
    const map = readViewer("index.html");

    expect(map).toContain("let nightPlanPersistRequestedVersion = 0");
    expect(map).toContain("while (nightPlanPersistCompletedVersion < nightPlanPersistRequestedVersion)");
    expect(map).toContain("const snapshot = nightPlanVenues.map((venue) => ({ ...venue }))");
    expect(map).toContain("Night plan is saved on this device, but account sync failed.");
  });
});
