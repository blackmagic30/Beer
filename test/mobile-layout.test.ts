import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function viewerFile(fileName: string) {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer", fileName), "utf8");
}

describe("mobile layout guardrails", () => {
  it("keeps bottom footer notes free of navigation links", () => {
    const viewerDir = path.resolve(process.cwd(), "viewer");
    const htmlFiles = fs.readdirSync(viewerDir).filter((fileName) => fileName.endsWith(".html"));

    for (const fileName of htmlFiles) {
      const html = viewerFile(fileName);
      const footerBlocks = html.match(/<[^>]+class="(?:footerCopy|responsibleNote)"[\s\S]*?<\/[^>]+>/g) || [];
      for (const footerBlock of footerBlocks) {
        expect(footerBlock, fileName).not.toContain("<a ");
      }
    }
  });

  it("keeps shared navigation, buttons, and form chips at phone-friendly tap sizes", () => {
    const css = viewerFile("business.css");

    expect(css).toMatch(/\.navLinks a,\s*\.button\s*\{[\s\S]*min-height:\s*42px;/);
    expect(css).toMatch(/\.dayChip\s*\{[\s\S]*min-height:\s*44px;/);
    expect(css).toMatch(/\.dayChip input\s*\{[\s\S]*width:\s*20px;[\s\S]*height:\s*20px;/);
    expect(css).toMatch(/\.field input\[type="checkbox"\]\s*\{[\s\S]*width:\s*20px;[\s\S]*height:\s*20px;/);
    expect(css).toMatch(/\.cookieConsent__actions \.button\s*\{[\s\S]*min-height:\s*44px;/);
    expect(css).not.toContain(".footerCopy a");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.brand\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.navLinks\s*\{[\s\S]*flex-wrap:\s*nowrap;[\s\S]*overflow-x:\s*auto;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.navLinks a\s*\{[\s\S]*min-height:\s*40px;[\s\S]*font-size:\s*11px;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.button\s*\{[\s\S]*white-space:\s*normal;/);
  });

  it("keeps map controls usable on iPhone and Android viewport widths", () => {
    const html = viewerFile("index.html");

    expect(html).toMatch(/\.filterChip,\s*\.utilityButton\s*\{[\s\S]*min-height:\s*42px;/);
    expect(html).toMatch(/\.overlayPanel__close\s*\{[\s\S]*width:\s*40px;[\s\S]*height:\s*40px;/);
    expect(html).toMatch(/\.venueRail__sortChip\s*\{[\s\S]*min-height:\s*38px;/);
    expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.filterChip\s*\{[\s\S]*min-height:\s*40px;/);
    expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.venueRail__sortChip\s*\{[\s\S]*min-height:\s*40px;/);
  });
});
