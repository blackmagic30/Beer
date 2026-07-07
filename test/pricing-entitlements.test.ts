import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PREMIUM_PRICING } from "../src/config/business-rules.js";

function readRepoFile(filePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("premium pricing and entitlements", () => {
  it("shows user pricing by default while preserving venue plans for bar accounts", () => {
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
    expect(pricingHtml).toContain("User pricing");
    expect(pricingHtml).toContain("For drinkers");
    expect(pricingHtml).toContain("Unlock the full Pint Path map.");
    expect(pricingHtml).toContain("Freemium");
    expect(pricingHtml).toContain("15 points");
    expect(pricingHtml).toContain("same map access as a paid user");
    expect(pricingHtml).toContain("exact prices, value rings, premium filters, and the member toolkit");
    expect(pricingHtml).toContain('href="/submit.html"');
    expect(pricingHtml).toContain('href="/missions.html"');
    expect(pricingHtml).toContain("A$4.99");
    expect(pricingHtml).toContain("A$50");
    expect(pricingHtml).toContain("Every verified beer price with no daily reveal limit.");
    expect(pricingHtml).toContain("Value rings on map pins");
    expect(pricingHtml).toContain("Cheapest-night filters");
    expect(pricingHtml).toContain("Rotating discount pass for venue specials");
    expect(pricingHtml).toContain("Saved night shortcuts, personal defaults, and savings tracking");
    expect(pricingHtml).not.toContain("Pay monthly, pay yearly, or earn the same access");
    expect(pricingHtml).not.toContain("Own or manage a bar?");
    expect(pricingHtml).not.toContain("Included for paid users");
    expect(pricingHtml).not.toContain("Premium is designed to make each search faster");
    expect(pricingHtml).not.toContain("Exact-price value mode");
    expect(pricingHtml).not.toContain("Personal defaults</h3>");
    expect(pricingHtml).not.toContain("consumerPremiumToolkit");
    expect(pricingHtml).toContain('href="/account.html?checkoutPlan=monthly"');
    expect(pricingHtml).toContain('href="/account.html?checkoutPlan=yearly"');
    expect(pricingHtml).toContain("Venue pricing");
    expect(pricingHtml).toContain("For venues");
    expect(pricingHtml).toContain("Venue tools use the same secure Pint Path login.");
    expect(pricingHtml).toContain("Bars do not need a separate login.");
    expect(pricingHtml).toContain("Free");
    expect(pricingHtml).toContain("Pro");
    expect(pricingHtml).toContain("A$0");
    expect(pricingHtml).toContain("A$149 <span>/month</span>");
    expect(pricingHtml).not.toContain(">Plus<");
    expect(pricingHtml).not.toContain("STRIPE_PLUS_PRICE_ID");
    expect(pricingHtml).not.toContain("A$299");
    expect(pricingHtml).toContain("No Pint Path specials on the Free plan.");
    expect(pricingHtml).toContain("No analytics or monthly reports.");
    expect(pricingHtml).toContain("Area-level search and interaction trends.");
    expect(pricingHtml).toContain("Demand snapshots with beer/style opportunities and next actions.");
    expect(pricingHtml).toContain("Staff/customer update link for QR tap-list prompts and fresh venue data.");
    expect(pricingHtml).toContain("Monthly venue reports");
    expect(pricingHtml).toContain("CSV and JSON report exports");
    expect(pricingHtml).toContain("Premium map pin, listing card, badge, and highlighted venue name.");
    expect(pricingHtml).toContain("Premium Pint Path special treatment after review.");
    expect(pricingHtml).toContain("Priority admin review queue");
    expect(pricingHtml).toContain("Pro growth studio with premium-placement checklist and weekend playbook.");
    expect(pricingHtml).toContain("Transparent discovery boost");
    expect(pricingHtml).toContain("do not treat displayed tiers as final billing terms until checkout, refund, cancellation, tax invoice, and venue subscription terms are published");
    expect(pricingHtml).toContain("Pro placement does not fake popularity or reviews.");
    expect(pricingHtml).toContain('href="/venue-portal.html"');
    expect(pricingHtml).toContain('id="venuePricingSection"');
    expect(pricingHtml).toContain('id="venuePricingSection" class="venuePricingSection" aria-labelledby="venuePricingTitle" hidden');
    expect(pricingHtml).toContain('class="venuePricingSection"');
    expect(pricingHtml).toContain('params.get("audience") === "users"');
    expect(pricingHtml).toContain('role === "venue_manager" || role === "admin"');
    expect(pricingHtml).toContain('!forceUserPricing && (forceVenuePricing || role === "venue_manager" || role === "admin")');
    expect(pricingHtml).toContain('pricingContext = showVenuePricing ? "venue" : "consumer"');
    expect(pricingHtml).not.toContain('type="button" data-plan="monthly"');
    expect(pricingHtml).not.toContain('type="button" data-plan="yearly"');
    expect(readme).toContain("A$4.99/month");
    expect(readme).toContain("A$50/year");
    expect(readme).toContain("Pro A$149/month");
    expect(readme).toContain("value rings");
    expect(readme).toContain("saved night shortcuts");
    expect(readme).toContain("discount-pass access");
    expect(readme).toContain("demand snapshots");
    expect(readme).toContain("Pro growth studio");
    expect(readme).not.toContain("STRIPE_PLUS_PRICE_ID");
    expect(envExample).toContain("STRIPE_PRICE_MONTHLY=price_monthly_499_aud");
    expect(envExample).toContain("STRIPE_PRICE_YEARLY=price_yearly_50_aud");
    expect(envExample).not.toContain("STRIPE_PLUS_PRICE_ID");

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
    expect(pricingHtml).toContain("Premium Pint Path special treatment after review.");
    expect(mapHtml).toContain("Unlock full access to view times, specials, and discount details.");
    expect(mapHtml).toContain("Unlock full access to view the days, times, specials, and discount details.");
    expect(readme).toContain("venue special-discount details");
    expect(pricingHtml).not.toContain("Raw photos");
    expect(pricingHtml).not.toContain("source evidence");
  });

  it("starts consumer checkout through the account page instead of inline pricing scripts", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const accountHtml = readRepoFile("viewer/account.html");
    const businessCss = readRepoFile("viewer/business.css");

    expect(pricingHtml).not.toContain('data-plan="monthly"');
    expect(pricingHtml).not.toContain('data-plan="yearly"');
    expect(pricingHtml).not.toContain('MelbBeerBusiness.apiFetch("/api/business/billing/checkout"');
    expect(pricingHtml).not.toContain("Opening secure Stripe checkout");
    expect(pricingHtml).not.toContain("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    expect(pricingHtml).toContain('MelbBeerBusiness.trackEvent("pricing_page_viewed", { pricingContext })');
    expect(accountHtml).not.toContain('id="premiumMemberHub"');
    expect(accountHtml).not.toContain("renderPremiumMemberHub");
    expect(accountHtml).not.toContain("premiumMemberToolkit");
    expect(accountHtml).toContain("requestedSettingsPanel");
    expect(accountHtml).toContain('data-settings-target="stats"');
    expect(accountHtml).toContain('id="settingsStatsPanel"');
    expect(accountHtml).not.toContain('data-settings-target="watchlist"');
    expect(accountHtml).not.toContain('id="settingsWatchlistPanel"');
    expect(businessCss).toContain(".venuePricingGrid");
    expect(businessCss).toContain(".businessToolkit");
    expect(businessCss).not.toContain(".premiumMemberHub");
    expect(businessCss).not.toContain(".premiumPerkCard");
    expect(businessCss).toContain(".reportToolbar");
    expect(businessCss).toContain(".button:disabled");
  });
});
