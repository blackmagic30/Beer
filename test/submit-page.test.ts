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
    expect(html).toContain("Search and choose a venue first.");
    expect(html).not.toContain('venueSelect.addEventListener("change"');
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
});
