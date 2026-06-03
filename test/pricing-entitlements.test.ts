import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PREMIUM_PRICING } from "../src/config/business-rules.js";

function readRepoFile(filePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("premium pricing and entitlements", () => {
  it("keeps consumer prices out of public pricing while showing venue plans", () => {
    const appSource = readRepoFile("src/app.ts");
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const readme = readRepoFile("README.md");
    const envExample = readRepoFile(".env.example");

    expect(PREMIUM_PRICING).toMatchObject({
      monthlyAudCents: 499,
      yearlyAudCents: 5000,
      monthlyLabel: "A$4.99/month",
      yearlyLabel: "A$50/year",
    });

    expect(appSource).toContain("monthly: PREMIUM_PRICING.monthlyLabel");
    expect(appSource).toContain("yearly: PREMIUM_PRICING.yearlyLabel");
    expect(pricingHtml).toContain("Venue pricing");
    expect(pricingHtml).toContain("For venues");
    expect(pricingHtml).toContain("Venue tools use the same secure Pint Path login.");
    expect(pricingHtml).toContain("Bars do not need a separate login.");
    expect(pricingHtml).toContain("Free");
    expect(pricingHtml).toContain("Plus");
    expect(pricingHtml).toContain("Pro");
    expect(pricingHtml).toContain("A$0");
    expect(pricingHtml).toContain("A$149");
    expect(pricingHtml).toContain("A$299");
    expect(pricingHtml).toContain("No Pint Path specials on the Free plan.");
    expect(pricingHtml).toContain("No analytics or monthly reports.");
    expect(pricingHtml).toContain("Suburb-level search and interaction trends.");
    expect(pricingHtml).toContain("Monthly venue reports");
    expect(pricingHtml).toContain("Premium venue badge");
    expect(pricingHtml).toContain('href="/venue-portal.html"');
    expect(pricingHtml).toContain('id="venuePricingSection"');
    expect(pricingHtml).toContain('class="venuePricingSection"');
    expect(pricingHtml).not.toContain("Freemium");
    expect(pricingHtml).not.toContain("15 pts");
    expect(pricingHtml).not.toContain("A$4.99");
    expect(pricingHtml).not.toContain("A$50");
    expect(pricingHtml).not.toContain('type="button" data-plan="monthly"');
    expect(pricingHtml).not.toContain('type="button" data-plan="yearly"');
    expect(readme).toContain("A$4.99/month");
    expect(readme).toContain("A$50/year");
    expect(envExample).toContain("STRIPE_PRICE_MONTHLY=price_monthly_499_aud");
    expect(envExample).toContain("STRIPE_PRICE_YEARLY=price_yearly_50_aud");

    const combined = [appSource, pricingHtml, readme, envExample].join("\n");
    expect(combined).not.toContain("A$1.99");
    expect(combined).not.toContain("A$19/year");
    expect(combined).not.toContain("price_monthly_199_aud");
    expect(combined).not.toContain("price_yearly_19_aud");
  });

  it("makes special-discount access a premium entitlement without exposing raw private evidence", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const mapHtml = readRepoFile("viewer/index.html");
    const readme = readRepoFile("README.md");

    expect(pricingHtml).toContain("No Pint Path specials on the Free plan.");
    expect(pricingHtml).toContain("Add reviewed Pint Path specials.");
    expect(mapHtml).toContain("Unlock full access to view times, specials, and discount details.");
    expect(mapHtml).toContain("Unlock full access to view the days, times, specials, and discount details.");
    expect(readme).toContain("venue special-discount details");
    expect(pricingHtml).not.toContain("Raw photos");
    expect(pricingHtml).not.toContain("source evidence");
  });

  it("does not expose consumer checkout on the venue pricing page", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const businessCss = readRepoFile("viewer/business.css");

    expect(pricingHtml).not.toContain('data-plan="monthly"');
    expect(pricingHtml).not.toContain('data-plan="yearly"');
    expect(pricingHtml).not.toContain('MelbBeerBusiness.apiFetch("/api/business/billing/checkout"');
    expect(pricingHtml).not.toContain("Opening secure Stripe checkout");
    expect(pricingHtml).not.toContain("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    expect(pricingHtml).toContain('MelbBeerBusiness.trackEvent("pricing_page_viewed", { pricingContext: "venue" })');
    expect(businessCss).toContain(".venuePricingGrid");
    expect(businessCss).toContain(".button:disabled");
  });
});
