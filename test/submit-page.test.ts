import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function submitHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/submit.html"), "utf8");
}

describe("submit page auth gate", () => {
  it("requires login before showing the submission form", () => {
    const html = submitHtml();

    expect(html).toContain('id="loginRequiredPanel"');
    expect(html).toContain('id="submissionPanel" class="panel is-hidden"');
    expect(html).toContain("Sign in before submitting data");
    expect(html).toContain("every upload is linked to an account");
    expect(html).toContain("False or abusive data can receive fraud strikes");
    expect(html).toContain("await MelbBeerBusiness.apiFetch(\"/api/business/account/dashboard\")");
  });

  it("does not expose the submission form to anonymous users by default", () => {
    const html = submitHtml();

    expect(html).toContain("loginRequiredPanel.classList.remove(\"is-hidden\")");
    expect(html).toContain("submissionPanel.classList.add(\"is-hidden\")");
    expect(html).toContain("Log in before submitting venue data.");
  });
});
