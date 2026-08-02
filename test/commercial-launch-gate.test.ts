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
    expect(serviceSource).toContain("commercialLaunchEnabled: this.config.COMMERCIAL_LAUNCH_ENABLED");
    expect(serviceSource).toContain(
      "consumerPaidEnrollmentEnabled: this.config.CONSUMER_PAID_ENROLLMENT_ENABLED",
    );
    expect(serviceSource).toContain('publicCode: "COMMERCIAL_LAUNCH_DISABLED"');
    expect(serviceSource).toContain('publicCode: "CONSUMER_PAID_ENROLLMENT_DISABLED"');
    expect(appSource).toContain("commercialLaunchEnabled: publicConfig.commercialLaunchEnabled");
    expect(appSource).toContain(
      "consumerPaidEnrollmentEnabled: publicConfig.consumerPaidEnrollmentEnabled",
    );
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

  it("documents enabling enrollment only after the full production proof sequence", () => {
    const runbook = readRepoFile("docs/production-launch-runbook.md");

    expect(runbook).toContain("Keep `COMMERCIAL_LAUNCH_ENABLED=false` throughout the first deployment");
    expect(runbook).toContain("Only after all earlier phases and the final go/no-go checklist pass");
    expect(runbook).toContain("set `COMMERCIAL_LAUNCH_ENABLED=true`");
    expect(runbook).toContain("CONSUMER_PAID_ENROLLMENT_ENABLED=false");
    expect(runbook).toMatch(/billing management and Stripe lifecycle processing remain\s+available/);
  });
});
