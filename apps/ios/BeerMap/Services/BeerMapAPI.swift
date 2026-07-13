import Foundation

enum AppConfig {
    static var apiBaseURL: URL {
        readURL("PINT_PATH_API_BASE_URL") ?? URL(string: "https://pintpath.au")!
    }

    static var supabaseURL: URL? {
        readURL("SUPABASE_URL")
    }

    static var supabaseAnonKey: String? {
        readString("SUPABASE_ANON_KEY")
    }

    private static func readString(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else {
            return nil
        }
        return trimmed
    }

    private static func readURL(_ key: String) -> URL? {
        guard let value = readString(key) else {
            return nil
        }
        return URL(string: value)
    }
}

enum BeerMapAPIError: LocalizedError {
    case invalidURL(String)
    case missingData
    case server(String)
    case unexpectedStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let path):
            return "Invalid API path: \(path)"
        case .missingData:
            return "The server response did not include data."
        case .server(let message):
            return message
        case .unexpectedStatus(let status):
            return "Request failed (\(status))."
        }
    }
}

struct BeerMapAPI {
    let baseURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(baseURL: URL = AppConfig.apiBaseURL) {
        self.baseURL = baseURL
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    func getConfig() async throws -> PublicConfig {
        try await get("/api/business/config")
    }

    func login(email: String, password: String) async throws -> AuthResult {
        try await send("/api/business/auth/login", method: "POST", body: LoginRequest(email: email, password: password))
    }

    func signup(email: String, password: String, displayName: String?) async throws -> AuthResult {
        try await send(
            "/api/business/auth/signup",
            method: "POST",
            body: SignupRequest(
                email: email,
                password: password,
                displayName: displayName.nilIfBlank,
                ageConfirmed: true,
                termsAccepted: true,
                privacyAccepted: true
            )
        )
    }

    func syncSupabase(accessToken: String) async throws -> AuthResult {
        try await send(
            "/api/business/auth/supabase-session",
            method: "POST",
            body: SupabaseSessionRequest(accessToken: accessToken)
        )
    }

    func logout(token: String) async throws -> EmptyResponse {
        try await send("/api/business/auth/logout", method: "POST", body: EmptyResponse(), token: token)
    }

    func account(token: String) async throws -> AccountDashboard {
        try await get("/api/business/account", token: token)
    }

    func updatePrivacy(_ settings: PrivacySettingsRequest, token: String) async throws -> AccountDashboard {
        try await send("/api/business/account/privacy-settings", method: "POST", body: settings, token: token)
    }

    func requestAccountDeletion(message: String?, token: String) async throws -> EmptyResponse {
        try await send(
            "/api/business/account/delete-request",
            method: "POST",
            body: AccountDeletionRequest(message: message),
            token: token
        )
    }

    func discountPass(token: String) async throws -> RotatingCodeResult {
        try await send("/api/business/account/discount-pass", method: "POST", body: EmptyResponse(), token: token)
    }

    func freePintRewardCode(token: String) async throws -> RotatingCodeResult {
        try await send("/api/business/account/free-pint-reward-code", method: "POST", body: EmptyResponse(), token: token)
    }

    func listVenues(query: String? = nil, limit: Int = 80) async throws -> [Venue] {
        var items = [URLQueryItem(name: "limit", value: "\(limit)")]
        if let query = query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            items.append(URLQueryItem(name: "q", value: query))
        }
        let response: VenueListResponse = try await get(path("/api/business/venues", queryItems: items))
        return response.venues
    }

    func priceRecords(venueId: String? = nil, anonymousSessionId: String, reveal: Bool, token: String?) async throws -> PriceRecordsResponse {
        var items = [
            URLQueryItem(name: "anonymousSessionId", value: anonymousSessionId),
            URLQueryItem(name: "reveal", value: reveal ? "true" : "false"),
            URLQueryItem(name: "limit", value: "120")
        ]
        if let venueId {
            items.append(URLQueryItem(name: "venueId", value: venueId))
        }
        return try await get(path("/api/business/price-records", queryItems: items), token: token)
    }

    func missions() async throws -> [Mission] {
        let response: MissionListResponse = try await get("/api/business/missions?limit=50")
        return response.missions
    }

    func saveItem(_ item: SaveItemRequest, token: String) async throws -> EmptyResponse {
        try await send("/api/business/account/saved-items", method: "POST", body: item, token: token)
    }

    func createSubmission(_ submission: CreateSubmissionRequest, token: String) async throws -> SubmissionResult {
        try await send("/api/business/submissions", method: "POST", body: submission, token: token)
    }

    func reportWrongPrice(_ report: WrongPriceReportRequest, token: String?) async throws -> EmptyResponse {
        try await send("/api/business/wrong-price-reports", method: "POST", body: report, token: token)
    }

    func createRequest(_ request: VenueRequestPayload, token: String?) async throws -> EmptyResponse {
        try await send("/api/business/requests", method: "POST", body: request, token: token)
    }

    func track(_ event: EventRequest, token: String?) async {
        do {
            let _: EmptyResponse = try await send("/api/business/events", method: "POST", body: event, token: token)
        } catch {
            return
        }
    }

    func venuePortal(venueId: String? = nil, token: String) async throws -> VenuePortalData {
        var items: [URLQueryItem] = []
        if let venueId {
            items.append(URLQueryItem(name: "venueId", value: venueId))
        }
        return try await get(path("/api/business/venue-portal", queryItems: items), token: token)
    }

    func saveProfile(_ profile: BarProfile, venueId: String, token: String) async throws -> VenuePortalData {
        try await send("/api/business/venue-portal/\(escape(venueId))/profile", method: "POST", body: profile, token: token)
    }

    func saveBeer(_ beer: BarBeer, venueId: String, token: String) async throws -> BarBeer {
        try await send("/api/business/venue-portal/\(escape(venueId))/beers", method: "POST", body: beer, token: token)
    }

    func saveHappyHour(_ happyHour: BarHappyHour, venueId: String, token: String) async throws -> BarHappyHour {
        try await send("/api/business/venue-portal/\(escape(venueId))/happy-hours", method: "POST", body: happyHour, token: token)
    }

    func saveSpecial(_ special: BarSpecial, venueId: String, token: String) async throws -> BarSpecial {
        try await send("/api/business/venue-portal/\(escape(venueId))/specials", method: "POST", body: special, token: token)
    }

    func get<T: Decodable>(_ path: String, token: String? = nil) async throws -> T {
        try await request(path, method: "GET", body: Optional<EmptyResponse>.none, token: token)
    }

    func send<T: Decodable, Body: Encodable>(_ path: String, method: String, body: Body, token: String? = nil) async throws -> T {
        try await request(path, method: method, body: body, token: token)
    }

    private func request<T: Decodable, Body: Encodable>(_ path: String, method: String, body: Body?, token: String?) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw BeerMapAPIError.invalidURL(path)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("BeerMap iOS/0.1", forHTTPHeaderField: "User-Agent")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BeerMapAPIError.missingData
        }

        let envelope = try? decoder.decode(APIEnvelope<T>.self, from: data)
        if !(200..<300).contains(http.statusCode) || envelope?.ok == false {
            if let message = envelope?.error?.message {
                throw BeerMapAPIError.server(message)
            }
            throw BeerMapAPIError.unexpectedStatus(http.statusCode)
        }
        if let data = envelope?.data {
            return data
        }

        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }
        throw BeerMapAPIError.missingData
    }

    private func path(_ path: String, queryItems: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        return components.string ?? path
    }

    private func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}
