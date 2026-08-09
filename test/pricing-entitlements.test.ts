import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PREMIUM_PRICING } from "../src/config/business-rules.js";

function readRepoFile(filePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("premium pricing and entitlements", () => {
  it("keeps paid pricing deferred without publishing the dormant amounts", () => {
    const appSource = readRepoFile("src/app.ts");
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const readme = readRepoFile("README.md");
    const envExample = readRepoFile(".env.example");
    const termsHtml = readRepoFile("viewer/terms.html");
    const venuePortalHtml = readRepoFile("viewer/venue-portal.html");

    expect(PREMIUM_PRICING).toMatchObject({
      monthlyAudCents: 499,
      yearlyAudCents: 5000,
      monthlyLabel: "A$4.99/month",
      yearlyLabel: "A$50/year",
    });

    expect(appSource).toContain("monthly: PREMIUM_PRICING.monthlyLabel");
    expect(appSource).toContain("yearly: PREMIUM_PRICING.yearlyLabel");
    expect(pricingHtml).toContain("For drinkers");
    expect(pricingHtml).toContain("Freemium");
    expect(pricingHtml).toContain("15 points");
    expect(pricingHtml).toContain('href="/submit.html"');
    expect(pricingHtml).toContain('href="/missions.html"');
    expect(pricingHtml).toContain("Paid pricing is coming later");
    expect(pricingHtml).toContain("Pro pricing and enrolment are coming later");
    expect(pricingHtml).toContain("No payment or checkout is available.");
    expect(pricingHtml).toContain("Final price pending");
    expect(pricingHtml).not.toContain("A$4.99");
    expect(pricingHtml).not.toContain("A$50");
    expect(pricingHtml).not.toContain("A$149");
    expect(termsHtml).not.toContain("A$149");
    expect(venuePortalHtml).not.toContain("A$149");
    expect(envExample).not.toContain("FREE_PRICE_REVEALS_PER_DAY");
    expect(readRepoFile("viewer/config.example.js")).not.toContain("freePriceRevealsPerDay");
    expect(readRepoFile("src/config/env.ts")).not.toContain("FREE_PRICE_REVEALS_PER_DAY");
    expect(readme).not.toContain("FREE_PRICE_REVEALS_PER_DAY");
    expect(readme).not.toContain("freePriceRevealsPerDay");
    expect(readme).toContain("The free preview is fixed rather than quota-based");
    expect(pricingHtml).toContain('id="consumerMonthlyAction" class="button button--primary" aria-disabled="true"');
    expect(pricingHtml).toContain('id="consumerYearlyAction" class="button button--premium" aria-disabled="true"');
    expect(pricingHtml).toContain('href: "/account.html?checkoutPlan=monthly"');
    expect(pricingHtml).toContain('href: "/account.html?checkoutPlan=yearly"');
    expect(pricingHtml).toContain("For venues");
    expect(pricingHtml).toContain("Venue tools use the same secure Pint Path login.");
    expect(pricingHtml).toContain("Bars do not need a separate login.");
    expect(pricingHtml).toContain("Free");
    expect(pricingHtml).toContain("Pro");
    expect(pricingHtml).toContain("A$0");
    expect(pricingHtml).not.toContain(">Plus<");
    expect(pricingHtml).not.toContain("STRIPE_PLUS_PRICE_ID");
    expect(pricingHtml).not.toContain("A$299");
    expect(pricingHtml).toContain("No Pint Path specials on the Free plan.");
    expect(pricingHtml).toContain("No analytics or monthly reports.");
    expect(pricingHtml).toContain("No Pro feature or paid placement is promised by this deferred release.");
    expect(pricingHtml).toContain("Any later analytics must remain aggregate");
    expect(pricingHtml).toContain("must not fake popularity");
    expect(pricingHtml).toContain('href="/venue-portal.html"');
    expect(pricingHtml).toContain('id="venuePricingSection"');
    expect(pricingHtml).toContain('id="venuePricingSection" class="venuePricingSection" role="tabpanel" aria-labelledby="venuePricingTab venuePricingTitle" hidden');
    expect(pricingHtml).toContain('id="userPricingSection" class="consumerPricingSection" role="tabpanel"');
    expect(pricingHtml).toContain('class="pricingAudienceSwitch" role="tablist"');
    expect(pricingHtml).toContain('class="venuePricingSection"');
    expect(pricingHtml).toContain('params.get("audience") === "users"');
    expect(pricingHtml).toContain('role === "venue_manager" || role === "admin"');
    expect(pricingHtml).toContain('!forceUserPricing && (forceVenuePricing || role === "venue_manager" || role === "admin")');
    expect(pricingHtml).toContain('pricingContext = showVenuePricing ? "venue" : "consumer"');
    expect(pricingHtml).not.toContain('type="button" data-plan="monthly"');
    expect(pricingHtml).not.toContain('type="button" data-plan="yearly"');
    expect(readme).not.toContain("A$4.99/month");
    expect(readme).not.toContain("A$50/year");
    expect(readme).not.toContain("Pro A$149/month");
    expect(readme).toContain("No price or offer is approved");
    expect(readme).not.toContain("STRIPE_PLUS_PRICE_ID");
    expect(envExample).toContain("STRIPE_PRICE_MONTHLY=\n");
    expect(envExample).toContain("STRIPE_PRICE_YEARLY=\n");
    expect(envExample).toContain("STRIPE_PRO_PRICE_ID=\n");
    expect(envExample).toContain("POS_WEBHOOK_SIGNING_SECRET=\n");
    expect(envExample).toContain("COMMERCIAL_LAUNCH_ENABLED=false");
    expect(envExample).toContain("CONSUMER_PAID_ENROLLMENT_ENABLED=false");
    expect(envExample).toContain("VENUE_PRO_TRIAL_DAYS=0");
    expect(envExample).not.toContain("STRIPE_PLUS_PRICE_ID");

    const combined = [appSource, pricingHtml, readme, envExample].join("\n");
    expect(combined).not.toContain("A$1.99");
    expect(combined).not.toContain("A$19/year");
    expect(combined).not.toContain("price_monthly_199_aud");
    expect(combined).not.toContain("price_yearly_19_aud");
  });

  it("keeps public specials and discount-pass discovery out of the deferred launch", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const mapHtml = readRepoFile("viewer/index.html");
    const service = readRepoFile("src/modules/business/business.service.ts");
    const terms = readRepoFile("viewer/terms.html");

    expect(pricingHtml).toContain("No Pint Path specials on the Free plan.");
    expect(pricingHtml).not.toContain("Add and manage Pint Path specials directly.");
    expect(pricingHtml).not.toContain("Premium Pint Path special treatment in discovery.");
    expect(mapHtml).toContain('id="specialsFilterRow" class="specialsFilterRow" aria-label="Specials filters" hidden');
    expect(mapHtml).toContain("specialsFilterRow.hidden = !COMMERCIAL_LAUNCH_ENABLED");
    expect(service).toContain("canViewSpecialDiscounts: hasFullAccess && this.config.COMMERCIAL_LAUNCH_ENABLED");
    expect(service).toContain("canUseDiscountPass: hasFullAccess && this.config.COMMERCIAL_LAUNCH_ENABLED");
    expect(terms).toContain("Public leaderboards, alcohol-linked rewards, and discount-pass redemptions are not available in this release.");
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
