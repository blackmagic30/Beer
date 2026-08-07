import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readRepoFile(filePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), filePath), "utf8");
}

describe("commercial launch gate", () => {
  it("defaults closed and publishes only the non-secret gate state to browsers", () => {
    const envSource = readRepoFile("src/config/env.ts");
    const envExample = readRepoFile(".env.example");
    const serviceSource = readRepoFile("src/modules/business/business.service.ts");
    const appSource = readRepoFile("src/app.ts");

    expect(envSource).toContain("COMMERCIAL_LAUNCH_ENABLED: booleanFromEnv.default(false)");
    expect(envSource).toContain("CONSUMER_PAID_ENROLLMENT_ENABLED: booleanFromEnv.default(false)");
    expect(envExample).toContain("COMMERCIAL_LAUNCH_ENABLED=false");
    expect(envExample).toContain("CONSUMER_PAID_ENROLLMENT_ENABLED=false");
    expect(serviceSource).toContain("commercialLaunchEnabled,");
    expect(serviceSource).toContain("consumerPaidEnrollmentEnabled,");
    expect(serviceSource).toContain("pricing: consumerPaidEnrollmentEnabled ? PREMIUM_PRICING : null");
    expect(serviceSource).toContain("venueProTrialDays: commercialLaunchEnabled ? this.config.VENUE_PRO_TRIAL_DAYS : 0");
    expect(serviceSource).toContain('publicCode: "COMMERCIAL_LAUNCH_DISABLED"');
    expect(serviceSource).toContain('publicCode: "CONSUMER_PAID_ENROLLMENT_DISABLED"');
    expect(appSource).toContain("commercialLaunchEnabled: publicConfig.commercialLaunchEnabled");
    expect(appSource).toContain(
      "consumerPaidEnrollmentEnabled: publicConfig.consumerPaidEnrollmentEnabled",
    );
    expect(appSource).toContain("pricing: publicConfig.pricing");
  });

  it("keeps every new-enrollment browser path inert unless config explicitly enables launch", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const accountHtml = readRepoFile("viewer/account.html");
    const venuePortalHtml = readRepoFile("viewer/venue-portal.html");

    expect(pricingHtml).toContain('id="consumerMonthlyAction" class="button button--primary" aria-disabled="true"');
    expect(pricingHtml).toContain('id="consumerYearlyAction" class="button button--premium" aria-disabled="true"');
    expect(pricingHtml).toContain("businessConfig.commercialLaunchEnabled === true");
    expect(pricingHtml).toContain("businessConfig.consumerPaidEnrollmentEnabled === true");
    expect(pricingHtml).toContain('action.removeAttribute("href")');

    const accountResume = accountHtml.slice(
      accountHtml.indexOf("async function resumeCheckoutIfRequested"),
      accountHtml.indexOf("async function reconcileCheckoutReturnIfNeeded"),
    );
    expect(accountResume.indexOf("if (!CONSUMER_PAID_ENROLLMENT_ENABLED)")).toBeGreaterThan(-1);
    expect(accountResume.indexOf("if (!CONSUMER_PAID_ENROLLMENT_ENABLED)"))
      .toBeLessThan(accountResume.indexOf('apiFetch("/api/business/billing/checkout"'));
    expect(accountResume).toContain("Existing subscriptions can still be managed or cancelled");

    expect(venuePortalHtml).toContain("viewerConfig.business?.commercialLaunchEnabled === true");
    expect(venuePortalHtml).toContain("syncCommercialCheckoutControls");
    expect(venuePortalHtml).toContain("new MutationObserver");
    expect(venuePortalHtml).toContain('disabled aria-disabled="true"');
    const venueUpgradeHandler = venuePortalHtml.slice(
      venuePortalHtml.indexOf("const upgradeTier = target.dataset.upgradeTier"),
      venuePortalHtml.indexOf("const happyHourId = target.dataset.editHappyHour"),
    );
    expect(venueUpgradeHandler.indexOf("if (!COMMERCIAL_LAUNCH_ENABLED)")).toBeGreaterThan(-1);
    expect(venueUpgradeHandler.indexOf("if (!COMMERCIAL_LAUNCH_ENABLED)"))
      .toBeLessThan(venueUpgradeHandler.indexOf("/billing/checkout"));
  });

  it("fails closed in the initial pricing and venue-portal markup without advertising unsettled prices", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const termsHtml = readRepoFile("viewer/terms.html");
    const venuePortalHtml = readRepoFile("viewer/venue-portal.html");

    expect(pricingHtml).toContain(
      'id="consumerMonthlyCard" class="card pricingCard card--highlight" hidden',
    );
    expect(pricingHtml).toContain(
      'id="consumerYearlyCard" class="card pricingCard card--tierPro" hidden',
    );
    expect(pricingHtml).toContain(
      'id="venueProCard" class="card venuePricingCard venuePricingCard--pro card--tierPro" hidden',
    );
    expect(pricingHtml).toContain(
      'id="venueCommercialTerms" class="helperCopy" hidden',
    );
    expect(pricingHtml).toContain(
      'id="consumerPricingDeferred" class="card pricingCard card--highlight"',
    );
    expect(pricingHtml).toContain(
      'id="venuePricingDeferred" class="card venuePricingCard venuePricingCard--pro card--tierPro"',
    );
    expect(pricingHtml).toContain("Paid pricing is coming later");
    expect(pricingHtml).toContain("Pro pricing and enrolment are coming later");
    expect(pricingHtml).toContain("No payment or checkout is available.");
    expect(pricingHtml).toContain("No trial starts automatically or from this page");
    expect(pricingHtml).toContain("card.hidden = !consumerPaidEnrollmentEnabled");
    expect(pricingHtml).toContain("consumerPricingDeferred.hidden = consumerPaidEnrollmentEnabled");
    expect(pricingHtml).toContain("venueProCard.hidden = !commercialLaunchEnabled");
    expect(pricingHtml).toContain("venuePricingDeferred.hidden = commercialLaunchEnabled");
    expect(pricingHtml).toContain("venueCommercialTerms.hidden = !commercialLaunchEnabled");

    const upgradeActionRenderer = venuePortalHtml.slice(
      venuePortalHtml.indexOf("function renderCommercialUpgradeAction"),
      venuePortalHtml.indexOf("function commercialEnrollmentCopy"),
    );
    expect(upgradeActionRenderer.indexOf("if (!COMMERCIAL_LAUNCH_ENABLED)"))
      .toBeLessThan(upgradeActionRenderer.indexOf('return `<button class="${escapeHtml(className)}"'));
    expect(upgradeActionRenderer).toContain("No payment or trial starts from this page.");
    expect(venuePortalHtml.match(/<button[^>]*data-upgrade-tier=/g) || []).toHaveLength(2);
    expect(venuePortalHtml).toContain('disabled aria-disabled="true"');
    expect(venuePortalHtml).toContain("renderCommercialUpgradeAction(\"Upgrade to Pro\")");

    const paidTerms = termsHtml.slice(
      termsHtml.indexOf("<h2>9. Paid access and billing</h2>"),
      termsHtml.indexOf("<h2>10. Availability and changes</h2>"),
    );
    expect(paidTerms.indexOf("currently disabled")).toBeGreaterThan(-1);
    expect(paidTerms).not.toContain("A$149");
    expect(paidTerms).toContain("No venue-offer duration or paid price is approved for this release.");
    expect(paidTerms).toContain("describe the future commercial service");
  });

  it("documents a pricing-deferred release that never enables enrollment", () => {
    const runbook = readRepoFile("docs/production-launch-runbook.md");

    expect(runbook).toContain("Keep `COMMERCIAL_LAUNCH_ENABLED=false` throughout the first deployment");
    expect(runbook).toContain("No paid or trial surface is authorised by this release");
    expect(runbook).toContain("COMMERCIAL_LAUNCH_ENABLED=false");
    expect(runbook).toContain("VENUE_PRO_TRIAL_DAYS=0");
    expect(runbook).not.toContain("set `COMMERCIAL_LAUNCH_ENABLED=true`");
    expect(runbook).not.toContain("PINTPATH_EXPECTED_COMMERCIAL_LAUNCH_ENABLED=true");
    expect(runbook).toContain("CONSUMER_PAID_ENROLLMENT_ENABLED=false");
    expect(runbook).toMatch(/billing management and Stripe lifecycle processing remain\s+available/);
  });
});
