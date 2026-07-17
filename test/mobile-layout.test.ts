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
    const mobileCss = css.slice(css.indexOf("@media (max-width: 760px)"));
    const mobileNavLinksBlock = mobileCss.match(/\.navLinks\s*\{([^}]*)\}/)?.[1] || "";

    expect(css).toMatch(/\.navLinks a,\s*\.button\s*\{[\s\S]*min-height:\s*42px;/);
    expect(css).toMatch(/\.dayChip\s*\{[\s\S]*min-height:\s*44px;/);
    expect(css).toMatch(/\.dayChip input\s*\{[\s\S]*width:\s*20px;[\s\S]*height:\s*20px;/);
    expect(css).toMatch(/\.field input\[type="checkbox"\]\s*\{[\s\S]*width:\s*20px;[\s\S]*height:\s*20px;/);
    expect(css).toMatch(/\.cookieConsent__actions \.button\s*\{[\s\S]*min-height:\s*44px;/);
    expect(css).not.toContain(".footerCopy a");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.brand\s*\{[\s\S]*min-height:\s*44px;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.navLinks\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.mobileNavToggle\s*\{[\s\S]*min-height:\s*44px;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.navLinks a\s*\{[\s\S]*min-height:\s*44px;[\s\S]*font-size:\s*13px;/);
    expect(mobileNavLinksBlock).not.toContain("overflow-x");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.button\s*\{[\s\S]*white-space:\s*normal;/);
  });

  it("keeps map controls usable on iPhone and Android viewport widths", () => {
    const html = viewerFile("index.html");
    const phoneCss = html.slice(html.indexOf("@media (max-width: 640px)"));

    expect(html).toMatch(/\.filterChip,\s*\.utilityButton\s*\{[\s\S]*min-height:\s*44px;/);
    expect(html).toMatch(/\.overlayPanel__close\s*\{[\s\S]*width:\s*40px;[\s\S]*height:\s*40px;/);
    expect(html).toMatch(/\.venueRail__sortChip\s*\{[\s\S]*min-height:\s*38px;/);
    expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.filterChip\s*\{[\s\S]*min-height:\s*44px;/);
    expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.overlayPanel__close\s*\{[\s\S]*width:\s*44px;[\s\S]*height:\s*44px;/);
    expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.venueRail__sortChip\s*\{[\s\S]*min-height:\s*44px;/);
    expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.venueDetailOverlay__close\s*\{[\s\S]*width:\s*44px;[\s\S]*height:\s*44px;/);
    expect(html).toContain('class="mapNavCard topNav"');
    expect(html).toContain('aria-controls="topbarBusinessLinks" data-mobile-nav-toggle');
    expect(html).toContain('id="topbarBusinessLinks" class="topbar__businessLinks" aria-label="Business navigation" data-mobile-nav-panel');
    expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.topbar__businessLinks\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(html).toContain("#topbar .mapNavCard.is-mobile-nav-open {\n        z-index: 30;");
    expect(html).not.toMatch(/\.topbar__businessLinks\s*\{[^}]*overflow-x:\s*auto;/);
    expect(phoneCss).toMatch(/\.specialsFilterRow,\s*\.popularBeerRow\s*\{[\s\S]*?overflow-x:\s*auto;/);
    expect(phoneCss).not.toMatch(/\.specialsFilterRow\s*\{[^}]*display:\s*none;/);
  });

  it("switches role-aware navigation to a menu before tablet links wrap", () => {
    const css = viewerFile("business.css");
    const html = viewerFile("index.html");
    const script = viewerFile("business.js");

    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.navLinks\s*\{[\s\S]*?display:\s*none;[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.button--small,[\s\S]*?\.premiumPlanSwitcher button,[\s\S]*?min-height:\s*44px;/);
    expect(html).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.topbar__businessLinks\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(script).toContain('window.matchMedia?.("(max-width: 900px)")');
  });

  it("stacks venue operations on small tablets without hiding account roles", () => {
    const css = viewerFile("business.css");
    const tabletCss = css.slice(css.indexOf("@media (min-width: 761px) and (max-width: 1040px)"));

    expect(tabletCss).toMatch(/\.dashboardShell,[\s\S]*?\.venueBeerStockGrid,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(tabletCss).toMatch(/\.dashboardSidebar \.mobileSectionPicker\s*\{[\s\S]*?display:\s*grid;/);
    expect(tabletCss).toMatch(/\.dashboardSidebar \.tabNav\s*\{[\s\S]*?display:\s*none;/);
    expect(css).not.toContain(".accountAccessBadgeRow .accountAccessBadge:not(:first-child)");
  });

  it("keeps compact actions, dialogs, and pricing controls usable", () => {
    const css = viewerFile("business.css");

    expect(css).toMatch(/\.hero::after\s*\{[\s\S]*?pointer-events:\s*none;/);
    expect(css).toMatch(/\.venueHappyHourBeerOffer input\s*\{[\s\S]*?min-height:\s*44px;/);
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*?\.adminQueueBeerRows \.adminBeerRow \.field input,[\s\S]*?min-height:\s*44px;/);
    expect(css).toMatch(/\.pricingCard__actions,[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 136px\), 1fr\)\);/);
    expect(css).toMatch(/#happyHourForm > \.actionRow\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 180px\), 1fr\)\);/);
    expect(css).toMatch(/\.cookieConsent\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 36px\);[\s\S]*?overflow:\s*auto;/);
    expect(css).toMatch(/\.discountPassModalPanel\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 32px\);[\s\S]*?overflow:\s*auto;/);
    expect(css).toMatch(/\.outreachPipelineCard \.button--small,[\s\S]*?\.premiumPlanSwitcher button,[\s\S]*?min-height:\s*44px;/);
  });
});
