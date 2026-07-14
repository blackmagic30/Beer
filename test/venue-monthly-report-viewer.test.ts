import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const portalHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/venue-portal.html"), "utf8");
const businessCss = fs.readFileSync(path.resolve(process.cwd(), "viewer/business.css"), "utf8");

describe("venue monthly report viewer", () => {
  it("loads the selected venue month from the month-specific report endpoint", () => {
    expect(portalHtml).toContain("async function loadMonthlyReport(month = reportMonth.value)");
    expect(portalHtml).toContain("/reports/${encodeURIComponent(month)}`");
    expect(portalHtml).toContain('reportMonth.addEventListener("change"');
    expect(portalHtml).toContain("void loadMonthlyReport(reportMonth.value)");
    expect(portalHtml).toContain("monthlyReportRequestSequence");
    expect(portalHtml).toContain("requestedVenueId !== selectedVenueId()");
    expect(portalHtml).toContain("payload.report ?? payload.monthlyReport ?? payload");
    expect(portalHtml).toContain('new URL(window.location.href).searchParams.get("month")');
    expect(portalHtml).toContain('url.searchParams.set("month", month)');
    expect(portalHtml).toContain("embeddedReport.month === initialMonth && renderMonthlyReportDocument(embeddedReport)");
    expect(portalHtml).toContain("reportMonth.max = latestCompletedMonth");
    expect(portalHtml).toContain("data.generated === true && month <= getPreviousReportMonthKey()");
  });

  it("provides accessible loading, empty, error, and retry states", () => {
    expect(portalHtml).toContain('id="reportMonth" type="month" required aria-describedby="monthlyReportStatus"');
    expect(portalHtml).toContain('id="monthlyReportStatus" class="reportLoadStatus muted" role="status" aria-live="polite" aria-atomic="true"');
    expect(portalHtml).toContain('id="monthlyReport" class="monthlyReport" aria-busy="false"');
    expect(portalHtml).toContain("function renderMonthlyReportLoading");
    expect(portalHtml).toContain("function renderMonthlyReportEmpty");
    expect(portalHtml).toContain("function renderMonthlyReportError");
    expect(portalHtml).toContain("data-retry-monthly-report");
    expect(portalHtml).toContain('monthlyReport.setAttribute("aria-busy", "true")');
    expect(portalHtml).toContain("setMonthlyReportExportAvailability(false)");
  });

  it("shows the reporting period, as-of time, useful actions, demand, trends, and privacy context", () => {
    expect(portalHtml).toContain("data.reportingPeriod");
    expect(portalHtml).toContain("Report as of");
    expect(portalHtml).toContain("Recorded actions");
    expect(portalHtml).toContain('reportValue(summary, ["directionsClicks"])');
    expect(portalHtml).toContain('reportValue(summary, ["pricePreviewViews"])');
    expect(portalHtml).toContain('reportValue(summary, ["savesAndNightPlanAdds"])');
    expect(portalHtml).toContain("Demand snapshot");
    expect(portalHtml).toContain("snapshot?.funnel");
    expect(portalHtml).toContain("Local search trends");
    expect(portalHtml).toContain("mostSearchedBeersInArea");
    expect(portalHtml).toContain("mostSearchedBeerStylesInArea");
    expect(portalHtml).toContain("privacy.minimumDistinctContributors");
    expect(portalHtml).toContain("privacy.suppressedMetrics");
    expect(portalHtml).toContain("Below privacy threshold");
    expect(portalHtml).toContain("Aggregate reporting only");
    expect(portalHtml).toContain("individual user clickstreams, email addresses, session IDs or exact user locations");
    expect(portalHtml).toContain("accounts/sessions");
  });

  it("keeps the expanded report responsive on desktop and mobile", () => {
    expect(businessCss).toContain("max-height: calc(100dvh - 36px);");
    expect(businessCss).toContain("overflow-y: auto;");
    expect(businessCss).toContain(".monthlyReport");
    expect(businessCss).toContain(".reportMetricGrid");
    expect(businessCss).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(businessCss).toContain(".reportTrendGrid");
    expect(businessCss).toMatch(/\.reportLoading,\s*\n\s*\.reportMetricGrid,\s*\n\s*\.reportTrendGrid\s*\{\s*\n\s*grid-template-columns: 1fr;/);
    expect(businessCss).toContain("overflow-wrap: anywhere;");
  });
});
