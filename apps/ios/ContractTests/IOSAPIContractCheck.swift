import Foundation

@main
struct IOSAPIContractCheck {
    static func main() throws {
        let fixtureRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent("apps/ios/ContractTests/Fixtures", isDirectory: true)
        let decoder = JSONDecoder()
        let responsePaths = Array(CommandLine.arguments.dropFirst())
        guard responsePaths.isEmpty || responsePaths.count == 3 else {
            throw ContractError.failed("Pass config, venue-list, and mission-list response paths together")
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

        print("iOS production API response contracts passed.")
    }
}

private enum ContractError: Error {
    case failed(String)
}
