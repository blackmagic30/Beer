import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function missionsHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/missions.html"), "utf8");
}

function businessCss() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.css"), "utf8");
}

describe("missions page", () => {
  it("supports location-aware missions and search-to-submit handoff", () => {
    const html = missionsHtml();
    const css = businessCss();

    expect(html).toContain("Search street, area, venue, or reason");
    expect(html).toContain('id="useMissionLocationButton"');
    expect(html).toContain('id="resolveMissionAreaButton"');
    expect(html).toContain('id="clearMissionAreaButton"');
    expect(html).toContain('id="missionRadiusSelect"');
    expect(html).toContain('id="missionsList" class="list missionList"');
    expect(html).toContain('<option value="nearby">Nearest missions</option>');
    expect(html).toContain("/api/business/geocode");
    expect(html).toContain("mission_area_lookup_used");
    expect(html).toContain('source: "area_lookup"');
    expect(html).toContain("navigator.geolocation.getCurrentPosition");
    expect(html).toContain("missionLocationStatus.textContent");
    expect(html).toContain("function missionSubmitHref");
    expect(html).toContain("missionId: String(mission.id)");
    expect(html).toContain("missionReason: String(mission.reason || \"Pint Path mission\")");
    expect(html).toContain("type: submissionTypeForMission(mission)");
    expect(html).toContain("Accept mission");
    expect(html).toContain('const submissionPending = progress === "submitted"');
    expect(html).toContain('const alreadyAccepted = progress === "accepted"');
    expect(html).toContain('"/account.html?settings=submissions"');
    expect(html).toContain("submissionPending || alreadyAccepted");
    expect(html).toContain('progress === "needs_revision"');
    expect(html).toContain("Mission points change with data freshness");
    expect(html).toContain("const INITIAL_MISSION_COUNT = 5");
    expect(html).toContain("const MISSION_PAGE_SIZE = 5");
    expect(html).toContain("let visibleMissionCount = INITIAL_MISSION_COUNT");
    expect(html).toContain("function orderedMissionsForDisplay");
    expect(html).not.toContain("rememberMissionOrder");
    expect(html).toContain("const visibleMissions = missions.slice(0, visibleMissionCount)");
    expect(html).toContain('id="loadMoreMissionsButton"');
    expect(html).toContain("visibleMissionCount += MISSION_PAGE_SIZE");
    expect(html).toContain("formatDistance(mission.distanceMeters)");
    expect(css).toContain(".missionToolbar");
    expect(css).toContain(".missionSearchActions");
    expect(css).toContain(".missionRadiusField");
    expect(css).toContain(".missionList");
    expect(css).toContain(".missionLoadMore");
  });
});
