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
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(78px, 1fr))");
    expect(css).toContain(".readonlySelect:disabled");
  });
});
