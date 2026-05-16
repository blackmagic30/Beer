import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function accountHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/account.html"), "utf8");
}

describe("account page shell", () => {
  it("renders separate logged-out auth and logged-in dashboard states", () => {
    const html = accountHtml();

    expect(html).toContain('id="loggedOutView"');
    expect(html).toContain('id="accountDashboard"');
    expect(html).toContain("Pint Path Contributor Account");
    expect(html).toContain("Contributor dashboard");
    expect(html).toContain("Quick beer price upload");
    expect(html).toContain("Recent submissions");
    expect(html).toContain("How verification works");
    expect(html).not.toContain("Current status");
  });

  it("hides the auth shell after a successful account fetch", () => {
    const html = accountHtml();

    expect(html).toContain('$("loggedOutView").hidden = true');
    expect(html).toContain('$("accountDashboard").hidden = false');
    expect(html).toContain('$("loggedOutView").hidden = false');
    expect(html).toContain('$("accountDashboard").hidden = true');
  });

  it("keeps contributor evidence copy private and reviewer-focused", () => {
    const html = accountHtml();

    expect(html).toContain("Evidence is stored privately");
    expect(html).toContain("Raw photos, receipts, OCR evidence, and reviewer notes are not public map data");
    expect(html).toContain("Private until reviewed");
  });
});
