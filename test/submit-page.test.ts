import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function submitHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/submit.html"), "utf8");
}

function businessCss() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.css"), "utf8");
}

describe("submit page auth gate", () => {
  it("requires login before showing the submission form", () => {
    const html = submitHtml();

    expect(html).toContain('id="loginRequiredPanel"');
    expect(html).toContain('id="submissionPanel" class="panel is-hidden"');
    expect(html).toContain("Sign in before submitting data");
    expect(html).toContain("every upload is linked to an account");
    expect(html).toContain("False or abusive data can receive fraud strikes");
    expect(html).toContain("await MelbBeerBusiness.apiFetch(\"/api/business/account\")");
    expect(html).toContain("window.location.assign(loginUrl)");
  });

  it("does not expose the submission form to anonymous users by default", () => {
    const html = submitHtml();

    expect(html).toContain("loginRequiredPanel.classList.remove(\"is-hidden\")");
    expect(html).toContain("submissionPanel.classList.add(\"is-hidden\")");
    expect(html).toContain("Log in before submitting venue data.");
  });

  it("uses search-driven venue selection with a read-only chosen venue field", () => {
    const html = submitHtml();

    expect(html).toContain("Chosen venue");
    expect(html).not.toContain("Choose venue");
    expect(html).toContain('id="venueSelect" class="readonlySelect" required disabled');
    expect(html).toContain("Search above and click the matching venue suggestion before submitting.");
    expect(html).toContain("function clearSelectedVenue");
    expect(html).toContain("Search and choose a venue first, or tick that the venue is not on Pint Path yet.");
    expect(html).not.toContain('venueSelect.addEventListener("change"');
  });

  it("lets contributors request a missing venue with beer data before admin approval", () => {
    const html = submitHtml();

    expect(html).toContain('id="newVenueToggle"');
    expect(html).toContain("This venue is not on Pint Path yet");
    expect(html).toContain('id="newVenuePanel"');
    expect(html).toContain('id="newVenueName"');
    expect(html).toContain('id="newVenueAddress"');
    expect(html).toContain("function collectNewVenue()");
    expect(html).toContain("function createPendingVenueId()");
    expect(html).toContain("newVenue,");
    expect(html).toContain("Use saved location as venue coordinates");
    expect(html).toContain("Find coordinates from address");
    expect(html).toContain("It only appears on the global map after admin approval.");
  });

  it("keeps submit-time, notes, and evidence fields constrained by submission type", () => {
    const html = submitHtml();

    expect(html).not.toContain("Observed date/time");
    expect(html).not.toContain('name="observedAt"');
    expect(html).not.toContain('name="notes" placeholder="Optional notes, conditions, or source details"');
    expect(html).toContain('id="sourcePhotoField" class="field is-hidden"');
    expect(html).toContain('id="sourcePhoto" type="file" accept="image/*" disabled');
    expect(html).toContain("sourcePhotoField.classList.toggle(\"is-hidden\", !isPhotoOnly)");
    expect(html).toContain("sourcePhoto.disabled = !isPhotoOnly");
    expect(html).toContain("sourcePhoto.required = isPhotoOnly");
    expect(html).toContain("const observedAt = new Date().toISOString();");
    expect(html).toContain('submissionTypeSelect.value === "photo_upload"');
    expect(html).toContain("const notes = missionNote || null;");
    expect(html).toContain("A full venue update needs at least 3 beer rows.");
    expect(html).not.toContain("A full venue update needs either a source photo");
    expect(html).not.toContain("Happy-hour updates need a source photo");
  });

  it("keeps happy-hour day controls inside a responsive grid", () => {
    const css = businessCss();

    expect(css).toContain(".dayChecklist");
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(106px, 1fr))");
    expect(css).toContain("min-height: 42px");
    expect(css).toContain(".dayChip");
    expect(css).toContain(".readonlySelect:disabled");
  });

  it("carries accepted mission context into submission payloads", () => {
    const html = submitHtml();
    const css = businessCss();

    expect(html).toContain('id="missionContext"');
    expect(html).toContain("const missionId = params.get(\"missionId\") || \"\"");
    expect(html).toContain("const missionReason = params.get(\"missionReason\") || \"\"");
    expect(html).toContain("const initialSubmissionType = params.get(\"type\")");
    expect(html).toContain("submissionTypeSelect.value = initialSubmissionType");
    expect(html).toContain("Mission accepted");
    expect(html).toContain("Your upload should match this mission");
    expect(html).toContain("Mission ${missionId}: ${missionReason || \"Pint Path mission\"}");
    expect(html).toContain("missionId: missionId || null");
    expect(css).toContain(".missionContext");
  });

  it("captures intentional upload-location proof for contributor points without auto-requesting on load", () => {
    const html = submitHtml();

    expect(html).toContain("Points need location proof");
    expect(html).toContain("Use my location for points");
    expect(html).toContain("function captureUploadLocation()");
    expect(html).toContain("uploadLocation,");
    expect(html).toContain("getCurrentPosition");
    expect(html).toContain("UPLOAD_LOCATION_STORAGE_KEY");
    expect(html).toContain("restoreUploadLocation()");
    expect(html).toContain("localStorage.setItem");
    expect(html).toContain("localStorage.removeItem");
    expect(html).not.toContain("window.addEventListener(\"DOMContentLoaded\", captureUploadLocation");
  });

  it("adds field-test controls for signal status, draft recovery, and quick common-beer rows", () => {
    const html = submitHtml();
    const css = businessCss();

    expect(html).toContain('class="fieldTestConsole"');
    expect(html).toContain('id="networkStatusPill"');
    expect(html).toContain('id="draftStatusPill"');
    expect(html).toContain('id="locationStatusPill"');
    expect(html).toContain('id="saveDraftButton"');
    expect(html).toContain('id="restoreDraftButton"');
    expect(html).toContain('id="clearDraftButton"');
    expect(html).toContain("FIELD_DRAFT_STORAGE_KEY");
    expect(html).toContain("function collectFieldDraft()");
    expect(html).toContain("function restoreFieldDraft()");
    expect(html).toContain("localStorage.setItem(FIELD_DRAFT_STORAGE_KEY");
    expect(html).toContain('submissionForm.addEventListener("input", scheduleDraftAutosave)');
    expect(html).toContain('window.addEventListener("online", updateNetworkStatus)');
    expect(html).toContain('window.addEventListener("offline", updateNetworkStatus)');
    expect(html).toContain("QUICK_BEERS");
    expect(html).toContain('id="quickBeerButtons"');
    expect(html).toContain("function fillQuickBeer");
    expect(html).toContain('const statusEl = document.getElementById("status")');
    expect(html).toContain("MelbBeerBusiness.setStatus(statusEl");
    expect(html).toContain("Photo attached for this submit. Drafts save fields only, not image files.");
    expect(css).toContain(".fieldTestConsole");
    expect(css).toContain(".fieldStatusPill--success");
    expect(css).toContain(".quickBeerChip");
  });
});
