import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const templateFiles = [
  "confirmation.html",
  "recovery.html",
  "password_changed_notification.html",
] as const;

function readTemplate(file: typeof templateFiles[number]): string {
  return fs.readFileSync(path.resolve(process.cwd(), "supabase/templates", file), "utf8");
}

describe("Supabase Auth email templates", () => {
  it.each(templateFiles)("publishes verified operator and legal-contact details in %s", (file) => {
    const html = readTemplate(file);

    expect(html).toContain("Pint Path is a registered business name operated by Isaac William De Worsop, sole trader.");
    expect(html).toContain("ABN 80 319 578 329");
    expect(html).toContain("WOTSO, Level 3, 11–19 Bank Place, Melbourne VIC 3000, Australia.");
    expect(html).toContain('href="mailto:admin@pintpath.au"');
    expect(html).toContain('href="https://pintpath.au/terms.html"');
    expect(html).toContain('href="https://pintpath.au/privacy.html"');
  });

  it("links password-change support instructions directly to the support mailbox", () => {
    const html = readTemplate("password_changed_notification.html");

    expect(html).toContain('href="mailto:admin@pintpath.au"');
    expect(html).toContain(">contact Pint Path support</a>");
  });

  it("keeps Supabase's supported Auth template variables intact", () => {
    const confirmation = readTemplate("confirmation.html");
    const recovery = readTemplate("recovery.html");
    const passwordChanged = readTemplate("password_changed_notification.html");

    expect(confirmation).toContain("{{ .ConfirmationURL }}");
    expect(recovery).toContain("{{ .ConfirmationURL }}");
    expect(confirmation).toContain("{{ .Email }}");
    expect(recovery).toContain("{{ .Email }}");
    expect(passwordChanged).toContain("{{ .Email }}");
    for (const html of [confirmation, recovery, passwordChanged]) {
      expect(html).toContain("{{ .SiteURL }}");
    }
  });
});
