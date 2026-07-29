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
        guard venues.data?.venues.first?.highlightedName != nil else {
            throw ContractError.failed("highlightedName must decode as the production Boolean value")
        }

        let missionData = try Data(contentsOf: missionURL)
        let missions = try decoder.decode(APIEnvelope<MissionListResponse>.self, from: missionData)
        guard missions.data?.missions.isEmpty == false else {
            throw ContractError.failed("the mission list must decode with at least one mission")
        }

        let encoder = JSONEncoder()
        let applePayload = try JSONSerialization.jsonObject(
            with: encoder.encode(
                SupabaseIDTokenRequest(
                    provider: "apple",
                    idToken: "apple-id-token",
                    accessToken: nil,
                    nonce: "raw-apple-nonce"
                )
            )
        ) as? [String: Any]
        guard let applePayload,
            applePayload["provider"] as? String == "apple",
            applePayload["id_token"] as? String == "apple-id-token",
            applePayload["nonce"] as? String == "raw-apple-nonce",
            !applePayload.keys.contains("access_token"),
            !applePayload.keys.contains("idToken"),
            !applePayload.keys.contains("accessToken")
        else {
            throw ContractError.failed("Apple ID-token exchange must use Supabase wire keys and the raw nonce")
        }

        let googlePayload = try JSONSerialization.jsonObject(
            with: encoder.encode(
                SupabaseIDTokenRequest(
                    provider: "google",
                    idToken: "google-id-token",
                    accessToken: "google-access-token",
                    nonce: nil
                )
            )
        ) as? [String: Any]
        guard let googlePayload,
            googlePayload["provider"] as? String == "google",
            googlePayload["id_token"] as? String == "google-id-token",
            googlePayload["access_token"] as? String == "google-access-token",
            !googlePayload.keys.contains("nonce"),
            !googlePayload.keys.contains("idToken"),
            !googlePayload.keys.contains("accessToken")
        else {
            throw ContractError.failed("Google ID-token exchange must use Supabase wire keys")
        }

        let pkcePayload = try JSONSerialization.jsonObject(
            with: encoder.encode(
                SupabasePKCERequest(
                    authCode: "one-time-code",
                    codeVerifier: "local-code-verifier"
                )
            )
        ) as? [String: Any]
        guard let pkcePayload,
            pkcePayload["auth_code"] as? String == "one-time-code",
            pkcePayload["code_verifier"] as? String == "local-code-verifier",
            !pkcePayload.keys.contains("authCode"),
            !pkcePayload.keys.contains("codeVerifier")
        else {
            throw ContractError.failed("PKCE fallback exchange must use Supabase wire keys")
        }

        print("iOS production API response contracts passed.")
    }
}

private enum ContractError: Error {
    case failed(String)
}
