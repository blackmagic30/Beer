import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readFile(filePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("website accessibility polish", () => {
  it("installs shared keyboard and announcement helpers", () => {
    const script = readFile("viewer/business.js");
    const css = readFile("viewer/business.css");

    expect(script).toContain("Skip to main content");
    expect(script).toContain('skipLink.href = `#${main.id}`');
    expect(script).toContain('element.setAttribute("role", isError ? "alert" : "status")');
    expect(script).toContain('element.setAttribute("aria-live", isError ? "assertive" : "polite")');
    expect(css).toContain(".skipLink");
    expect(css).toContain('[aria-invalid="true"]');
    expect(css).toContain("min-height: 44px");
    expect(css).not.toContain(".venueLogoutButton {\n    grid-column: 1 / -1;\n    min-height: 36px");
  });

  it("keeps account and recovery forms understandable to assistive tech", () => {
    const accountHtml = readFile("viewer/account.html");
    const resetHtml = readFile("viewer/reset-password.html");
    const resendHtml = readFile("viewer/resend-confirmation.html");

    expect(accountHtml).toContain('role="tab" aria-selected="true" aria-controls="loginForm"');
    expect(accountHtml).toContain('role="tabpanel" aria-labelledby="showSignupButton signupHeading" hidden');
    expect(accountHtml).toContain("function markAuthFields");
    expect(accountHtml).toContain('input.setAttribute("aria-invalid", "true")');
    expect(accountHtml).toContain('button.setAttribute("aria-label", `${showing ? "Hide" : "Show"} password`)');
    expect(resetHtml).toContain('id="resetStatus" class="notice" role="status" aria-live="polite" aria-atomic="true"');
    expect(resetHtml).toContain("function markResetFieldError");
    expect(resendHtml).toContain('id="resendStatus" class="notice" role="status" aria-live="polite" aria-atomic="true"');
    expect(resendHtml).toContain('$("confirmationEmail").setAttribute("aria-invalid", "true")');
  });

  it("labels map and dashboard interactive regions", () => {
    const mapHtml = readFile("viewer/index.html");
    const portalHtml = readFile("viewer/venue-portal.html");

    expect(mapHtml).toContain('id="map" role="region" aria-label="Interactive Pint Path beer map"');
    expect(mapHtml).toContain('role="dialog" aria-modal="true" aria-live="polite" aria-labelledby="venueDetailOverlayTitle"');
    expect(mapHtml).toContain('id="wrongPriceDialog"');
    expect(mapHtml).toContain("venueDetailInertedElements");
    expect(mapHtml).toContain("venueDetailReturnFocus");
    expect(portalHtml).toContain('class="tabNav" role="tablist" aria-label="Bar dashboard sections"');
    expect(portalHtml).toContain('id="venueTabOverview" class="tabButton is-active" type="button" role="tab" aria-selected="true" aria-controls="venuePanelOverview"');
    expect(portalHtml).toContain('id="venueTabRedemption" class="tabButton" type="button" role="tab" aria-selected="false" aria-controls="venuePanelRedemption"');
    expect(portalHtml).toContain('id="venuePanelOverview" class="tabPanel" role="tabpanel" aria-labelledby="venueTabOverview"');
    expect(portalHtml).toContain('id="venuePanelSupport" class="tabPanel is-hidden" role="tabpanel" aria-labelledby="venueTabSupport"');
    expect(portalHtml).toContain("function configurePortalTabs");
    expect(portalHtml).toContain('button.setAttribute("role", "tab")');
    expect(portalHtml).toContain('panel.setAttribute("role", "tabpanel")');
    expect(portalHtml).toContain('id="portalAccess" class="notice" role="status" aria-live="polite" aria-atomic="true"');
  });

  it("announces camera and Google venue lookup state changes", () => {
    const portalHtml = readFile("viewer/venue-portal.html");
    const adminHtml = readFile("viewer/admin.html");

    expect(portalHtml).toContain('id="memberQrScannerStatus" class="muted" role="status" aria-live="polite" aria-atomic="true"');
    expect(portalHtml).toContain('status.textContent = "Starting camera..."');
    expect(portalHtml).toContain('status.textContent = "Point the camera at the member\'s Pint Path QR code."');
    expect(portalHtml).toContain('status.textContent = "That QR is not a Pint Path member code."');
    expect(portalHtml).toContain('status.textContent = "Keep the QR steady inside the camera view."');
    expect(adminHtml).toContain('id="adminGoogleVenueStatus" class="fieldHint" role="status" aria-live="polite" aria-atomic="true"');
    expect(adminHtml).toContain('adminGoogleVenueStatus.textContent = "Searching Google Maps..."');
    expect(adminHtml).toContain('adminGoogleVenueStatus.textContent = "Loading Google venue details..."');
    expect(adminHtml).toContain('adminGoogleVenueStatus.textContent = error.message || "Google venue search failed."');
    expect(adminHtml).toContain('has been selected for beer capture.`');
    expect(adminHtml).toContain('details loaded. Check the fields, then create the venue.`');
  });
});
