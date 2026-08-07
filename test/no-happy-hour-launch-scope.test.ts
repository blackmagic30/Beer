import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("signed no-happy-hour public launch scope", () => {
  it("removes consumer discovery and promotional copy while keeping the map fail closed", () => {
    const map = read("viewer/index.html");
    const initialMapMarkup = map.slice(0, map.lastIndexOf("\n  <script>"));

    expect(initialMapMarkup).not.toMatch(/happy[ -]?hour/i);
    expect(map).not.toContain('data-filter-chip="happy_hour_active_now"');
    expect(map).toContain("const HAPPY_HOUR_DISCOVERY_ENABLED = BUSINESS_CONFIG.happyHourDiscoveryEnabled === true");
    expect(map).toContain("if (!HAPPY_HOUR_DISCOVERY_ENABLED)");
    expect(map).toContain("record.isHappyHourPrice !== true");

    [
      "viewer/community.html",
      "viewer/google-map.html",
      "viewer/pricing.html",
      "viewer/site.webmanifest",
    ].forEach((file) => {
      expect(read(file), file).not.toMatch(/happy[ -]?hour/i);
    });

    const trust = read("viewer/trust.html");
    const publicTrustMarkup = trust.slice(0, trust.lastIndexOf("\n  <script>"));
    expect(publicTrustMarkup).not.toMatch(/happy[ -]?hour/i);
  });

  it("filters happy-hour missions and never creates a public happy-hour submission link", () => {
    const missions = read("viewer/missions.html");
    const initialMissionMarkup = missions.slice(0, missions.lastIndexOf("\n  <script>"));

    expect(initialMissionMarkup).not.toMatch(/happy[ -]?hour/i);
    expect(missions).not.toContain('<option value="missing_happy_hour">');
    expect(missions).not.toContain('return "happy_hour_update"');
    expect(missions).toContain("rawPage.filter((mission) => !isHappyHourMission(mission))");
    expect(missions).toContain("offset: String(append ? missionServerOffset : 0)");
  });

  it("keeps public contribution controls hidden and disabled unless an exact server flag enables them", () => {
    const submit = read("viewer/submit.html");
    const submitHead = submit.slice(0, submit.indexOf("</head>"));

    expect(submitHead).not.toMatch(/happy[ -]?hour/i);
    expect(submit).toContain('<option value="happy_hour_update" hidden disabled>');
    expect(submit).toContain('id="happyHourSection" class="submitModeBlock is-hidden" hidden inert aria-hidden="true"');
    expect(submit).toContain("const HAPPY_HOUR_CONTRIBUTIONS_ENABLED = BUSINESS_CONFIG.happyHourContributionsEnabled === true");
    expect(submit).toContain('submissionTypeSelect.value = "single_beer_price"');
    expect(submit).toContain("if (!isPublicSubmissionTypeEnabled(next.payload?.submissionType))");

    const app = read("src/app.ts");
    const service = read("src/modules/business/business.service.ts");
    expect(app).toContain("happyHourContributionsEnabled: publicConfig.happyHourContributionsEnabled");
    expect(service).toContain("const PUBLIC_HAPPY_HOUR_CONTRIBUTIONS_ENABLED = false");
    expect(service).toContain("happyHourContributionsEnabled: PUBLIC_HAPPY_HOUR_CONTRIBUTIONS_ENABLED");
    expect(service).toContain("this.assertPublicHappyHourContributionAllowed(account, input)");
  });

  it("retains accurate legal disclosures, history labels, and venue/admin collection tools", () => {
    expect(read("viewer/privacy.html")).toMatch(/happy[ -]?hour/i);
    expect(read("viewer/terms.html")).toMatch(/happy[ -]?hour/i);
    expect(read("viewer/account.html")).toContain('item.isHappyHourPrice ? "Special price" : ""');
    expect(read("viewer/account.html")).not.toContain("Finding happy hours");
    expect(read("viewer/venue-portal.html")).toContain('id="happyHourForm"');
    expect(read("viewer/admin.html")).toContain('item.isHappyHourPrice ? "Happy-hour price" : null');
    expect(read("src/modules/business/business.routes.ts")).toContain('router.post("/venue-portal/:venueId/happy-hours"');
  });
});
