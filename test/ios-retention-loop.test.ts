import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const appModel = read("apps/ios/BeerMap/App/BeerMapApp.swift");
const api = read("apps/ios/BeerMap/Services/BeerMapAPI.swift");
const models = read("apps/ios/BeerMap/Models/BeerMapModels.swift");
const discover = read("apps/ios/BeerMap/Features/DiscoverView.swift");

describe("iOS retention-loop parity", () => {
  it("measures committed searches with truthful current-price usefulness and dedupes UI commits", () => {
    expect(discover).toContain(".onSubmit(trackCommittedSearch)");
    expect(discover).toContain("onDismiss: trackCommittedSearch");
    expect(discover).toContain("lastTrackedSearchSignature");
    expect(discover).toContain("guard signature != lastTrackedSearchSignature else { return }");
    expect(discover).toContain("if !measured, lastTrackedSearchSignature == signature");
    expect(discover).not.toMatch(/\.onChange\(of: searchText\)[\s\S]*trackExploreSearch/);
    expect(discover).toContain(
      "@State private var activeSearchMeasurementTask: Task<Void, Never>?",
    );
    expect(discover).toMatch(
      /private func trackCommittedSearch\(\)[\s\S]*activeSearchMeasurementTask\?\.cancel\(\)[\s\S]*activeSearchMeasurementTask = Task/,
    );
    expect(discover).toMatch(
      /\.onDisappear\s*\{[\s\S]*pendingSearchTrackingTask\?\.cancel\(\)[\s\S]*activeSearchMeasurementTask\?\.cancel\(\)[\s\S]*\}/,
    );
    expect(discover).not.toMatch(/let results = makeVenueResults\(\)\s*\n\s*Task \{/);

    expect(appModel).toContain("func trackExploreSearch(");
    expect(appModel).toContain("guard optionalAnalyticsEnabled, sessionToken != nil else { return false }");
    expect(appModel).toContain('"visibleResultCount": .number(Double(visibleVenues.count))');
    expect(appModel).toContain('"usefulResultCount": .number(Double(usefulResultCount))');
    expect(appModel).toContain('"usefulResultThreshold": .number(3)');
    expect(appModel).toContain('"searchSuccessful": .bool(usefulResultCount >= 3)');
    expect(appModel).toContain('"usefulnessMeasurement": .string("client_visible_current_trusted_pint_v1")');
    expect(appModel).toContain("selectedBeerKey == nil ? 3 : 1");
    expect(appModel).toContain("A failed background measurement must not interrupt discovery");
    expect(appModel).toMatch(/func trackExploreSearch\([\s\S]*\) async -> Bool/);
    expect(appModel).toContain("maximumRecords: 2_000");
    expect(appModel).toMatch(
      /maximumRecords: 2_000[\s\S]*try Task<Never, Never>\.checkCancellation\(\)[\s\S]*usefulSearchVenueCount/,
    );
    expect(api).toContain("let boundedMaximumRecords = maximumRecords.map");
    expect(api).toContain("let maximumPageCount = boundedMaximumRecords.map");
    expect(api).toContain("records.count >= boundedMaximumRecords");
    expect(api).toMatch(
      /while true \{\s*try Task<Never, Never>\.checkCancellation\(\)\s*pageCount \+= 1/,
    );
    expect(api).toMatch(
      /let response: PriceRecordsResponse = try await get\([\s\S]*try Task<Never, Never>\.checkCancellation\(\)[\s\S]*records\.append/,
    );
    expect(api).toMatch(/func track\([\s\S]*async -> Bool[\s\S]*return false/);

    expect(models).toContain("func isCurrentTrustedPintPrice(asOf: Date = Date()) -> Bool");
    for (const confidence of [
      "admin_verified",
      "venue_confirmed",
      "photo_verified",
      "community_confirmed",
    ]) {
      expect(models).toContain(`"${confidence}"`);
    }
    expect(models).toContain("age <= (30 * 24 * 60 * 60)");
    expect(models).toContain('isOnTap?.caseInsensitiveCompare("yes") == .orderedSame');
    expect(models).toContain('servingSize?.caseInsensitiveCompare("pint") == .orderedSame');
  });

  it("uses the signed durable confirmation endpoint for all three one-tap answers", () => {
    expect(api).toContain("func answerPriceConfirmation(");
    expect(api).toContain('"/api/business/price-records/\\(escape(priceRecordId))/confirmation"');
    expect(api).toContain("body: PriceConfirmationRequest(outcome: outcome)");

    expect(discover).toContain("Was this price still correct?");
    expect(models).toContain('case didntOrder = "didnt_order"');
    expect(models).toContain('case .didntOrder: return "Didn’t order it"');
    expect(discover).toContain("model.isSignedIn && record.isActionablePriceConfirmationCandidate");
    expect(discover).toContain("ViewThatFits(in: .horizontal)");
    expect(discover).toMatch(/ViewThatFits\(in: \.horizontal\)[\s\S]*VStack\(alignment: \.leading/);
    expect(discover).toContain(".frame(minHeight: 44)");
    expect(appModel).toMatch(/func answerPriceConfirmation\([\s\S]*withAuthenticatedSession/);
    expect(appModel).not.toMatch(/func answerPriceConfirmation\([\s\S]*track\(\s*"price_confirmation_answered"/);
    expect(discover).toContain("result.analyticsRecorded");
    expect(discover).toContain("Got it — no optional analytics recorded.");
  });
});
