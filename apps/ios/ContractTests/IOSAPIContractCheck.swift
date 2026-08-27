import Foundation

@main
struct IOSAPIContractCheck {
    static func main() throws {
        let fixtureRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("apps/ios/ContractTests/Fixtures", isDirectory: true)
        let decoder = JSONDecoder()
        let responsePaths = Array(CommandLine.arguments.dropFirst())
        guard responsePaths.isEmpty || responsePaths.count == 3 || responsePaths.count == 5 else {
            throw ContractError.failed(
                "Pass config, venue-list, mission-list, and optional price/confirmation response paths together"
            )
        }

        let configURL = responsePaths.isEmpty
            ? fixtureRoot.appendingPathComponent("public-config.json")
            : URL(fileURLWithPath: responsePaths[0])
        let venueURL = responsePaths.isEmpty
            ? fixtureRoot.appendingPathComponent("venue-list.json")
            : URL(fileURLWithPath: responsePaths[1])
        let missionURL = responsePaths.isEmpty
            ? fixtureRoot.appendingPathComponent("mission-list.json")
            : URL(fileURLWithPath: responsePaths[2])
        let priceURL = responsePaths.count == 5
            ? URL(fileURLWithPath: responsePaths[3])
            : fixtureRoot.appendingPathComponent("price-records.json")
        let confirmationURL = responsePaths.count == 5
            ? URL(fileURLWithPath: responsePaths[4])
            : fixtureRoot.appendingPathComponent("price-confirmation.json")

        let configData = try Data(contentsOf: configURL)
        let config = try decoder.decode(APIEnvelope<PublicConfig>.self, from: configData)
        guard config.data?.trackedBeers?.first?.id.isEmpty == false else {
            throw ContractError.failed("trackedBeers must decode the production `key` field as their identity")
        }

        let venueData = try Data(contentsOf: venueURL)
        let venues = try decoder.decode(APIEnvelope<VenueListResponse>.self, from: venueData)
        guard venues.data?.venues.first?.name.isEmpty == false else {
            throw ContractError.failed("the venue list must decode a named public venue")
        }

        let missionData = try Data(contentsOf: missionURL)
        let missions = try decoder.decode(APIEnvelope<MissionListResponse>.self, from: missionData)
        guard missions.data?.missions.isEmpty == false else {
            throw ContractError.failed("the mission list must decode with at least one mission")
        }

        let priceData = try Data(contentsOf: priceURL)
        let prices = try decoder.decode(APIEnvelope<PriceRecordsResponse>.self, from: priceData)
        guard let current = prices.data?.records.first,
              current.isActionablePriceConfirmationCandidate,
              current.isCurrentTrustedPintPrice(
                  asOf: ISO8601DateFormatter().date(from: "2026-08-27T01:00:00Z")!
              ),
              current.matchesBeerKey("carlton_draught"),
              prices.data?.records.last?.isActionablePriceConfirmationCandidate == false
        else {
            throw ContractError.failed("price records must preserve exact confirmation and trusted-result eligibility")
        }

        let confirmationData = try Data(contentsOf: confirmationURL)
        let confirmation = try decoder.decode(APIEnvelope<PriceConfirmationResult>.self, from: confirmationData)
        guard confirmation.data?.outcome == .didntOrder,
              confirmation.data?.analyticsRecorded == false,
              confirmation.data?.recordedAt == nil,
              confirmation.data?.publicTrustMutated == false
        else {
            throw ContractError.failed("an opted-out Didn't-order response must decode as non-recording and non-mutating")
        }

        print("iOS production API response contracts passed.")
    }
}

private enum ContractError: Error {
    case failed(String)
}
