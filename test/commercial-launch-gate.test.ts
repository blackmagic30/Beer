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
    const routesSource = readRepoFile("src/modules/business/business.routes.ts");
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
    expect(serviceSource).toContain('publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED"');
    expect(serviceSource).toContain("Paid and introductory-trial venue enrollment is not available in the current Free release.");
    expect(serviceSource).toContain("Consumer paid enrollment is not available in the current Free release.");
    expect(serviceSource).not.toContain("Existing subscriptions and billing management remain available.");
    expect(routesSource).toContain("isDeferredCommercialVenueRoute(req.path)");
    expect(routesSource).toContain("businessService.assertCommercialVenueFeatureOpen()");
    expect(appSource).toContain("commercialLaunchEnabled: publicConfig.commercialLaunchEnabled");
    expect(appSource).toContain(
      "consumerPaidEnrollmentEnabled: publicConfig.consumerPaidEnrollmentEnabled",
    );
    expect(appSource).toContain("pricing: publicConfig.pricing");
  });

  it("keeps every new-enrollment browser path inert unless config explicitly enables launch", () => {
    const pricingHtml = readRepoFile("viewer/pricing.html");
    const accountHtml = readRepoFile("viewer/account.html");
    const indexHtml = readRepoFile("viewer/index.html");
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
    expect(accountResume).toContain("Paid subscriptions are not available in the current Free release.");
    expect(accountResume).not.toContain("Existing subscriptions can still be managed or cancelled");
    expect(accountHtml).toContain("const COMMERCIAL_LAUNCH_ENABLED =");
    expect(accountHtml).toContain("const PINT_POINTS_REWARDS_ENABLED = COMMERCIAL_LAUNCH_ENABLED &&");
    expect(accountHtml).toContain('COMMERCIAL_LAUNCH_ENABLED ? "Freemium" : "Free"');
    expect(accountHtml).toContain('accountDiscountFeature accountHeroMetric accountHeroMetric--special" data-commercial-surface hidden');
    expect(accountHtml).toContain('id="counterStaffAccess" class="panel" aria-labelledby="counterStaffAccessTitle" data-commercial-surface hidden');
    expect(accountHtml).toContain('id="discountPassModal" class="discountPassModal" role="dialog" aria-modal="true" aria-labelledby="discountPassModalTitle" data-commercial-surface hidden');
    expect(accountHtml).toContain('id="betaTestingNavButton" class="settingsNavButton settingsNavButton--beta"');
    expect(accountHtml).toContain('aria-selected="false" data-commercial-surface hidden>Beta tools</button>');
    expect(accountHtml).toContain('id="settingsBetaTestingPanel" class="settingsPanel" data-settings-panel="beta-testing" role="tabpanel" aria-labelledby="betaTestingNavButton" data-commercial-surface hidden');

    const venueLegend = indexHtml.slice(
      indexHtml.indexOf("function getLegendConfig"),
      indexHtml.indexOf("function renderLegend"),
    );
    expect(venueLegend).toContain("items: COMMERCIAL_LAUNCH_ENABLED");
    expect(venueLegend).toContain("This is the full Free venue footprint.");
    expect(venueLegend.indexOf("COMMERCIAL_LAUNCH_ENABLED"))
      .toBeLessThan(venueLegend.indexOf('["pro", "Premium venue"'));

    expect(venuePortalHtml).toContain("viewerConfig.business?.commercialLaunchEnabled === true");
    expect(venuePortalHtml).toContain("syncCommercialCheckoutControls");
    expect(venuePortalHtml).toContain("removeDeferredCommercialSurfaces");
    expect(venuePortalHtml).toContain("new MutationObserver");
    expect(venuePortalHtml).toContain("surfaces.forEach((surface) => surface.remove())");
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
    expect(upgradeActionRenderer).toContain('return ""');
    expect(venuePortalHtml).toContain('data-panel="redemption" data-commercial-surface hidden');
    expect(venuePortalHtml).toContain('data-panel="staff-access" data-commercial-surface hidden');
    expect(venuePortalHtml).toContain('data-panel="specials" data-commercial-surface hidden');
    expect(venuePortalHtml).toContain('data-panel="report" data-commercial-surface hidden');
    expect(venuePortalHtml).toContain("if (!COMMERCIAL_LAUNCH_ENABLED) return;");
    expect(venuePortalHtml).toContain("requestCodesButton.hidden = !COMMERCIAL_LAUNCH_ENABLED");
    expect(venuePortalHtml).toContain("removeDeferredCommercialSurfaces();");
    const portalAccessSync = venuePortalHtml.slice(
      venuePortalHtml.indexOf("function syncPortalAccessControls"),
      venuePortalHtml.indexOf("function clearStatus"),
    );
    expect(portalAccessSync).toContain("!COMMERCIAL_LAUNCH_ENABLED");
    expect(portalAccessSync).toContain('element.matches("[data-commercial-surface]")');
    expect(portalAccessSync).toContain("element.hidden = counterOnly || commercialSurfaceClosed");

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
    expect(runbook).toContain("No public billing management");
    expect(runbook).toContain("Stripe lifecycle, venue-Pro, report-delivery, POS/counter, or reward entry point");
    expect(runbook).not.toMatch(/billing management and Stripe lifecycle processing remain\s+available/);
  });
});
