import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PREMIUM_PRICING } from "../src/config/business-rules.js";

function readRepoFile(filePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("Free launch access surface", () => {
  it("keeps the legacy pricing URL as a no-index Free access explanation", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const businessJs = readRepoFile("viewer/business.js");
    const sitemap = readRepoFile("viewer/sitemap.xml");
    const notFound = readRepoFile("viewer/404.html");

    expect(pricingHtml).toContain('<meta name="robots" content="noindex,follow"');
    expect(pricingHtml).toContain("Pint Path is free to use for this launch.");
    expect(pricingHtml).toContain("Drinkers and contributors");
    expect(pricingHtml).toContain("For venues");
    expect(pricingHtml).toContain('href="/missions.html"');
    expect(pricingHtml).toContain('href="/submit.html"');
    expect(pricingHtml).toContain('href="/venue-portal.html"');
    expect(pricingHtml).toContain("contributor full-map access");
    expect(pricingHtml).toContain("MelbBeerBusiness.renderNav()");

    expect(pricingHtml).not.toMatch(/\bPro\b/);
    expect(pricingHtml).not.toMatch(/premium/i);
    expect(pricingHtml).not.toMatch(/checkout/i);
    expect(pricingHtml).not.toMatch(/subscription/i);
    expect(pricingHtml).not.toMatch(/coming later|deferred commercial|final price pending/i);
    expect(pricingHtml).not.toMatch(/A\$\s*\d/);
    expect(pricingHtml).not.toContain("checkoutPlan=");
    expect(pricingHtml).not.toContain("pricing_page_viewed");
    expect(pricingHtml).not.toContain("consumerPaidEnrollmentEnabled");
    expect(pricingHtml).not.toContain("commercialLaunchEnabled");

    expect(businessJs).toContain('{ key: "venue-portal", href: "/venue-portal.html", label: "For venues" }');
    expect(businessJs).not.toContain('{ key: "pricing", href: "/pricing.html", label: "Pricing" }');
    expect(sitemap).not.toContain("/pricing.html");
    expect(notFound).not.toContain('href="/pricing.html"');
    expect(notFound).toContain('href="/venue-portal.html">For venues');
  });

  it("keeps dormant commercial amounts internal and out of the public Free page", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const readme = readRepoFile("README.md");
    const envExample = readRepoFile(".env.example");

    expect(PREMIUM_PRICING).toMatchObject({
      monthlyAudCents: 499,
      yearlyAudCents: 5000,
    });
    expect(pricingHtml).not.toContain(PREMIUM_PRICING.monthlyLabel);
    expect(pricingHtml).not.toContain(PREMIUM_PRICING.yearlyLabel);
    expect(pricingHtml).not.toContain("A$149");
    expect(readme).not.toContain("A$4.99/month");
    expect(readme).not.toContain("A$50/year");
    expect(readme).toContain("No price or offer is approved");
    expect(envExample).toContain("COMMERCIAL_LAUNCH_ENABLED=false");
    expect(envExample).toContain("CONSUMER_PAID_ENROLLMENT_ENABLED=false");
    expect(envExample).toContain("VENUE_PRO_TRIAL_DAYS=0");
  });

  it("keeps public happy-hour and special discovery fail closed", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const mapHtml = readRepoFile("viewer/index.html");
    const service = readRepoFile("src/modules/business/business.service.ts");

    expect(pricingHtml).not.toMatch(/happy[ -]?hour/i);
    expect(pricingHtml).not.toMatch(/Pint Path specials/i);
    expect(mapHtml).toContain('id="specialsFilterRow" class="specialsFilterRow" aria-label="Specials filters" hidden');
    expect(mapHtml).toContain("const PUBLIC_SPECIAL_DISCOVERY_ENABLED = HAPPY_HOUR_DISCOVERY_ENABLED && COMMERCIAL_LAUNCH_ENABLED");
    expect(mapHtml).toContain("specialsFilterRow.hidden = !PUBLIC_SPECIAL_DISCOVERY_ENABLED");
    expect(mapHtml).toContain("if (!HAPPY_HOUR_DISCOVERY_ENABLED) {");
    expect(mapHtml).toContain("if (!PUBLIC_SPECIAL_DISCOVERY_ENABLED || !specials.length)");
    expect(mapHtml).toContain("if (!PUBLIC_SPECIAL_DISCOVERY_ENABLED) {");
    expect(service).toContain("canViewSpecialDiscounts: hasFullAccess && this.config.COMMERCIAL_LAUNCH_ENABLED");
    expect(service).toContain("canUseDiscountPass: hasFullAccess && this.config.COMMERCIAL_LAUNCH_ENABLED");
  });
});
