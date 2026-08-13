import Foundation

enum AppConfig {
    static let approvedSupabaseOrigin = "https://auth.pintpath.au"

    static var apiBaseURL: URL {
        readURL("PINT_PATH_API_BASE_URL") ?? URL(string: "https://pintpath.au")!
    }

    static var termsURL: URL {
        legalURL(path: "terms.html")
    }

    static var privacyURL: URL {
        legalURL(path: "privacy.html")
    }

    static var supabaseURL: URL? {
        guard readExactString("SUPABASE_URL") == approvedSupabaseOrigin else {
            return nil
        }
        return URL(string: approvedSupabaseOrigin)
    }

    static var supabaseAnonKey: String? {
        guard
            let key = readExactString("SUPABASE_ANON_KEY"),
            key.range(
                of: #"^sb_publishable_[A-Za-z0-9_-]{20,220}$"#,
                options: .regularExpression
            ) != nil
        else {
            return nil
        }
        return key
    }

    private static func legalURL(path: String) -> URL {
        var components = URLComponents(
            url: apiBaseURL.appending(path: path),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "source", value: "ios_app")]
        return components.url!
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

    private static func readExactString(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }
        guard
            !value.isEmpty,
            value == value.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.contains("$(")
        else {
            return nil
        }
        return value
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
    case invalidResponse
    case server(String)
    case unexpectedStatus(Int)
    case configuration(String)
    case reauthenticationRequired
    case legalAcceptanceRequired(
        message: String,
        accessToken: String?,
        refreshToken: String?
    )

    var errorDescription: String? {
        switch self {
        case .invalidURL(let path):
            return "Invalid API path: \(path)"
        case .missingData:
            return "The server response did not include data."
        case .invalidResponse:
            return "Pint Path could not read the latest server response. Please update the app and try again."
        case .server(let message):
            return message
        case .unexpectedStatus(let status):
            return "Request failed (\(status))."
        case .configuration(let message):
            return message
        case .reauthenticationRequired:
            return "For your security, sign out and sign back in before trying this sensitive account action again."
        case .legalAcceptanceRequired(let message, _, _):
            return message
        }
    }

    var isUnauthorized: Bool {
        if case .unexpectedStatus(401) = self { return true }
        return false
    }

    var requiresReauthentication: Bool {
        if case .reauthenticationRequired = self { return true }
        return false
    }

}

private final class RedirectRejectingURLSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

struct BeerMapAPI {
    let baseURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let session: URLSession

    init(baseURL: URL = AppConfig.apiBaseURL, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        self.session = session ?? Self.makeSession()
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.requestCachePolicy = .useProtocolCachePolicy
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 330
        configuration.waitsForConnectivity = true
        configuration.httpMaximumConnectionsPerHost = 6
        return URLSession(
            configuration: configuration,
            delegate: RedirectRejectingURLSessionDelegate(),
            delegateQueue: nil
        )
    }

    func getConfig(forceRefresh: Bool = false) async throws -> PublicConfig {
        try await get(
            "/api/business/config",
            bypassCache: forceRefresh
        )
    }

    func login(
        email: String,
        password: String,
        config: PublicConfig
    ) async throws -> (authResult: AuthResult, refreshToken: String?, accessToken: String?) {
        let tokens: SupabaseAuthTokens = try await supabaseAuthRequest(
            "/auth/v1/token?grant_type=password",
            method: "POST",
            body: LoginRequest(email: email, password: password)
        )
        guard let accessToken = tokens.accessToken else {
            throw BeerMapAPIError.missingData
        }
        do {
            let result = try await syncSupabase(
                accessToken: accessToken,
                config: config,
                ageConfirmed: nil,
                termsAccepted: nil,
                privacyAccepted: nil
            )
            return (result, tokens.refreshToken, accessToken)
        } catch BeerMapAPIError.legalAcceptanceRequired(let message, _, _) {
            throw BeerMapAPIError.legalAcceptanceRequired(
                message: message,
                accessToken: accessToken,
                refreshToken: tokens.refreshToken
            )
        }
    }

    func signup(
        email: String,
        password: String,
        displayName: String?,
        config: PublicConfig,
        ageConfirmed: Bool,
        termsAccepted: Bool,
        privacyAccepted: Bool
    ) async throws -> SupabaseSignupOutcome {
        let policyVersion = try requiredLegalPolicyVersion(config)
        let tokens: SupabaseAuthTokens = try await supabaseAuthRequest(
            "/auth/v1/signup",
            method: "POST",
            body: SupabaseSignupRequest(
                email: email,
                password: password,
                data: [
                    "display_name": displayName.nilIfBlank.map(JSONValue.string) ?? .null,
                    "age_confirmed": .bool(ageConfirmed),
                    "terms_accepted": .bool(termsAccepted),
                    "privacy_accepted": .bool(privacyAccepted),
                    "legal_policy_version": .string(policyVersion),
                    "consent_source": .string("ios")
                ]
            )
        )
        guard let accessToken = tokens.accessToken else {
            return SupabaseSignupOutcome(
                authResult: nil,
                refreshToken: nil,
                accessToken: nil,
                confirmationRequired: true
            )
        }
        let result = try await syncSupabase(
            accessToken: accessToken,
            config: config,
            ageConfirmed: ageConfirmed,
            termsAccepted: termsAccepted,
            privacyAccepted: privacyAccepted
        )
        return SupabaseSignupOutcome(
            authResult: result,
            refreshToken: tokens.refreshToken,
            accessToken: accessToken,
            confirmationRequired: false
        )
    }

    func syncSupabase(
        accessToken: String,
        config: PublicConfig,
        ageConfirmed: Bool?,
        termsAccepted: Bool?,
        privacyAccepted: Bool?,
        existingAppToken: String? = nil
    ) async throws -> AuthResult {
        let hasCompleteConsent = ageConfirmed == true && termsAccepted == true && privacyAccepted == true
        let policyVersion: String?
        if hasCompleteConsent {
            policyVersion = try requiredLegalPolicyVersion(config)
        } else {
            policyVersion = nil
        }
        return try await send(
            "/api/business/auth/supabase-session",
            method: "POST",
            body: SupabaseSessionRequest(
                accessToken: accessToken,
                ageConfirmed: hasCompleteConsent ? true : nil,
                termsAccepted: hasCompleteConsent ? true : nil,
                privacyAccepted: hasCompleteConsent ? true : nil,
                termsVersion: policyVersion,
                privacyVersion: policyVersion,
                consentSource: hasCompleteConsent ? "ios" : nil
            ),
            token: existingAppToken
        )
    }

    func requestPasswordReset(email: String, config: PublicConfig) async throws {
        // The web callback verifies the Supabase recovery session, binds it to
        // the existing Pint Path account, and only then opens password-update
        // mode. A direct reset-page redirect has no recovery marker and strands
        // OAuth-created accounts in the request-another-email state.
        let redirectTo = baseURL.appending(path: "auth/callback").absoluteString
        let _: EmptyResponse = try await supabaseAuthRequest(
            "/auth/v1/recover",
            method: "POST",
            body: PasswordRecoveryRequest(email: email, redirectTo: redirectTo)
        )
    }

    func refreshSupabaseSession(
        refreshToken: String,
        config: PublicConfig,
        existingAppToken: String
    ) async throws -> (authResult: AuthResult, refreshToken: String?, accessToken: String) {
        let tokens: SupabaseAuthTokens = try await supabaseAuthRequest(
            "/auth/v1/token?grant_type=refresh_token",
            method: "POST",
            body: SupabaseRefreshRequest(refreshToken: refreshToken)
        )
        guard let accessToken = tokens.accessToken else { throw BeerMapAPIError.missingData }
        let result = try await syncSupabase(
            accessToken: accessToken,
            config: config,
            ageConfirmed: nil,
            termsAccepted: nil,
            privacyAccepted: nil,
            existingAppToken: existingAppToken
        )
        return (result, tokens.refreshToken, accessToken)
    }

    func logoutSupabase(accessToken: String, config: PublicConfig) async throws {
        let _: EmptyResponse = try await supabaseAuthRequest(
            "/auth/v1/logout?scope=local",
            method: "POST",
            body: EmptyResponse(),
            accessToken: accessToken
        )
    }

    func logout(token: String) async throws -> EmptyResponse {
        try await send("/api/business/auth/logout", method: "POST", body: EmptyResponse(), token: token)
    }

    func logoutAll(accessToken: String, token: String) async throws -> EmptyResponse {
        try await send(
            "/api/business/auth/logout-all",
            method: "POST",
            body: LogoutAllRequest(accessToken: accessToken),
            token: token,
            reauthenticationToken: accessToken
        )
    }

    func account(token: String) async throws -> AccountDashboard {
        try await get("/api/business/account", token: token)
    }

    func accountSessions(token: String, reauthenticationToken: String) async throws -> AccountSessionsResponse {
        let pageSize = 100
        var offset = 0
        var sessions: [AccountSession] = []
        var seenIds = Set<String>()
        var total: Int?

        while true {
            let response: AccountSessionsResponse = try await get(
                path("/api/business/account/sessions", queryItems: [
                    URLQueryItem(name: "limit", value: "\(pageSize)"),
                    URLQueryItem(name: "offset", value: "\(offset)")
                ]),
                token: token,
                reauthenticationToken: reauthenticationToken
            )
            total = response.total ?? response.pagination?.total ?? total
            sessions.append(contentsOf: response.sessions.filter { seenIds.insert($0.id).inserted })
            let hasMore = response.pagination?.hasMore ?? (response.sessions.count == pageSize)
            guard hasMore else { break }
            guard !response.sessions.isEmpty else {
                throw BeerMapAPIError.server("Session pagination stopped making progress. Refresh and try again.")
            }
            let pageOffset = response.pagination?.offset ?? offset
            let (nextOffset, overflow) = pageOffset.addingReportingOverflow(response.sessions.count)
            guard !overflow, nextOffset > offset else {
                throw BeerMapAPIError.server("Session pagination returned an invalid next page.")
            }
            offset = nextOffset
        }

        return AccountSessionsResponse(
            sessions: sessions,
            total: total ?? sessions.count,
            pagination: OffsetPagination(total: total ?? sessions.count, limit: pageSize, offset: 0, hasMore: false)
        )
    }

    func revokeAccountSession(_ sessionId: String, token: String, reauthenticationToken: String) async throws -> EmptyResponse {
        try await send("/api/business/account/sessions/\(escape(sessionId))", method: "DELETE", body: EmptyResponse(), token: token, reauthenticationToken: reauthenticationToken)
    }

    func exportAccount(token: String, reauthenticationToken: String) async throws -> JSONValue {
        try await get("/api/business/account/export", token: token, reauthenticationToken: reauthenticationToken)
    }

    func updatePrivacy(_ settings: PrivacySettingsRequest, token: String) async throws -> PrivacySettingsSaveResult {
        try await send("/api/business/account/privacy-settings", method: "POST", body: settings, token: token)
    }

    func accountDeletionStatus(token: String) async throws -> AccountDeletionStatusResponse {
        try await get("/api/business/account/delete-request", token: token)
    }

    func cancelAccountDeletion(_ requestId: String, token: String, reauthenticationToken: String) async throws -> EmptyResponse {
        try await send(
            "/api/business/account/delete-request/\(escape(requestId))",
            method: "DELETE",
            body: EmptyResponse(),
            token: token,
            reauthenticationToken: reauthenticationToken
        )
    }

    func requestAccountDeletion(message: String?, token: String, reauthenticationToken: String) async throws -> EmptyResponse {
        try await send(
            "/api/business/account/delete-request",
            method: "POST",
            body: AccountDeletionRequest(message: message),
            token: token,
            reauthenticationToken: reauthenticationToken
        )
    }

    func listVenues(
        query: String? = nil,
        limit: Int = 250,
        maximumResults: Int = 1_000,
        token: String? = nil
    ) async throws -> [Venue] {
        let resultLimit = min(2_000, max(1, maximumResults))
        let pageSize = min(resultLimit, min(500, max(1, limit)))
        let normalizedQuery = query?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        var offset = 0
        var venues: [Venue] = []
        var seenIds = Set<String>()

        while true {
            var items = [
                URLQueryItem(name: "limit", value: "\(pageSize)"),
                URLQueryItem(name: "offset", value: "\(offset)")
            ]
            if let normalizedQuery { items.append(URLQueryItem(name: "q", value: normalizedQuery)) }
            let response: VenueListResponse = try await get(
                path("/api/business/venues", queryItems: items),
                token: token
            )
            let remainingCapacity = resultLimit - venues.count
            venues.append(contentsOf: response.venues
                .filter { seenIds.insert($0.id).inserted }
                .prefix(max(0, remainingCapacity)))
            guard venues.count < resultLimit else { break }
            let hasMore = response.pagination?.hasMore ?? (response.venues.count == pageSize)
            guard hasMore else { break }
            guard !response.venues.isEmpty else {
                throw BeerMapAPIError.server("Venue pagination stopped making progress. Refresh and try again.")
            }
            let pageOffset = response.pagination?.offset ?? offset
            let (nextOffset, overflow) = pageOffset.addingReportingOverflow(response.venues.count)
            guard !overflow, nextOffset > offset else {
                throw BeerMapAPIError.server("Venue pagination returned an invalid next page.")
            }
            offset = nextOffset
        }
        return venues
    }

    func priceRecords(venueId: String? = nil, anonymousSessionId: String, token: String?) async throws -> PriceRecordsResponse {
        var records: [PriceRecord] = []
        var seenRecordKeys = Set<String>()
        var seenCursors = Set<String>()
        var cursor: String?
        var access: AccessState?
        var previewModel: String?
        var previewIncludedCount = 0
        var previewLockedCount = 0
        var pageCount = 0

        while true {
            pageCount += 1
            guard pageCount <= 1_000 else {
                throw BeerMapAPIError.server("Price pagination exceeded its safety limit. Refresh and try again.")
            }
            var items = [
                URLQueryItem(name: "anonymousSessionId", value: anonymousSessionId),
                URLQueryItem(name: "limit", value: "500")
            ]
            if let venueId { items.append(URLQueryItem(name: "venueId", value: venueId)) }
            if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
            let response: PriceRecordsResponse = try await get(
                path("/api/business/price-records", queryItems: items),
                token: token
            )
            records.append(contentsOf: response.records.filter {
                seenRecordKeys.insert(priceRecordIdentityKey($0)).inserted
            })
            access = response.access ?? access
            if let pagePreview = response.preview {
                previewModel = pagePreview.model
                previewIncludedCount += response.records.filter { $0.freePreviewIncluded == true }.count
                previewLockedCount += response.records.filter { $0.priceRedacted == true }.count
            }

            guard let nextCursor = response.nextCursor, !nextCursor.isEmpty else { break }
            guard nextCursor != cursor, seenCursors.insert(nextCursor).inserted else {
                throw BeerMapAPIError.server("Price pagination returned a repeated cursor. Refresh and try again.")
            }
            cursor = nextCursor
        }

        return PriceRecordsResponse(
            records: records,
            access: access,
            preview: previewModel.map {
                PricePreview(
                    model: $0,
                    includedCount: previewIncludedCount,
                    lockedCount: previewLockedCount
                )
            },
            nextCursor: nil
        )
    }

    private func priceRecordIdentityKey(_ record: PriceRecord) -> String {
        let beer = record.normalizedBeerId?.nilIfBlank
            ?? normalizedPriceIdentityPart(record.beerName)
        return [
            "beer",
            record.venueId ?? "",
            beer,
            normalizedPriceIdentityPart(record.servingSize)
        ].joined(separator: ":")
    }

    private func normalizedPriceIdentityPart(_ value: String?) -> String {
        (value ?? "")
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_AU"))
            .lowercased()
            .filter { $0.isLetter || $0.isNumber }
    }

    func missions(token: String? = nil, limit: Int = 100) async throws -> [Mission] {
        let resultLimit = min(200, max(1, limit))
        var offset = 0
        var missions: [Mission] = []
        var seenIds = Set<String>()

        while missions.count < resultLimit {
            let pageSize = min(100, resultLimit - missions.count)
            let response: MissionListResponse = try await get(
                path("/api/business/missions", queryItems: [
                    URLQueryItem(name: "limit", value: "\(pageSize)"),
                    URLQueryItem(name: "offset", value: "\(offset)")
                ]),
                token: token
            )
            let remainingCapacity = resultLimit - missions.count
            missions.append(contentsOf: response.missions
                .filter { seenIds.insert($0.id).inserted }
                .prefix(remainingCapacity))
            let hasMore = response.pagination?.hasMore ?? (response.missions.count == pageSize)
            guard hasMore, missions.count < resultLimit else { break }
            guard !response.missions.isEmpty else {
                throw BeerMapAPIError.server("Mission pagination stopped making progress. Refresh and try again.")
            }
            let pageOffset = response.pagination?.offset ?? offset
            let (nextOffset, overflow) = pageOffset.addingReportingOverflow(response.missions.count)
            guard !overflow, nextOffset > offset else {
                throw BeerMapAPIError.server("Mission pagination returned an invalid next page.")
            }
            offset = nextOffset
        }
        return missions
    }

    func acceptMission(_ missionId: String, token: String) async throws -> MissionActionResponse {
        try await send("/api/business/missions/\(escape(missionId))/accept", method: "POST", body: EmptyResponse(), token: token)
    }

    func releaseMission(_ missionId: String, token: String) async throws -> MissionActionResponse {
        try await send("/api/business/missions/\(escape(missionId))/release", method: "POST", body: EmptyResponse(), token: token)
    }

    func saveItem(_ item: SaveItemRequest, token: String) async throws -> EmptyResponse {
        try await send("/api/business/account/saved-items", method: "POST", body: item, token: token)
    }

    func createSubmission(_ submission: CreateSubmissionRequest, token: String) async throws -> SubmissionResult {
        try await send(
            "/api/business/submissions",
            method: "POST",
            body: submission,
            token: token,
            timeoutInterval: submission.submissionType == "photo_upload" ? 300 : nil
        )
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

    func saveProfile(_ profile: BarProfile, venueId: String, token: String) async throws -> BarProfileSaveResult {
        var request = profile
        request.replaceVenueTags = false
        request.expectedUpdatedAt = profile.updatedAt
        return try await send("/api/business/venue-portal/\(escape(venueId))/profile", method: "POST", body: request, token: token)
    }

    func saveBeer(_ beer: BarBeer, venueId: String, token: String) async throws -> BarBeerSaveResult {
        var request = beer
        request.expectedUpdatedAt = beer.updatedAt
        return try await send("/api/business/venue-portal/\(escape(venueId))/beers", method: "POST", body: request, token: token)
    }

    func get<T: Decodable>(
        _ path: String,
        token: String? = nil,
        reauthenticationToken: String? = nil,
        bypassCache: Bool = false
    ) async throws -> T {
        try await request(
            path,
            method: "GET",
            body: Optional<EmptyResponse>.none,
            token: token,
            reauthenticationToken: reauthenticationToken,
            bypassCache: bypassCache
        )
    }

    func send<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String,
        body: Body,
        token: String? = nil,
        reauthenticationToken: String? = nil,
        timeoutInterval: TimeInterval? = nil
    ) async throws -> T {
        try await request(
            path,
            method: method,
            body: body,
            token: token,
            reauthenticationToken: reauthenticationToken,
            timeoutInterval: timeoutInterval
        )
    }

    private func request<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String,
        body: Body?,
        token: String?,
        reauthenticationToken: String?,
        timeoutInterval: TimeInterval? = nil,
        bypassCache: Bool = false
    ) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw BeerMapAPIError.invalidURL(path)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if bypassCache {
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("no-cache, no-store", forHTTPHeaderField: "Cache-Control")
            request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        }
        if let timeoutInterval {
            request.timeoutInterval = timeoutInterval
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("PintPath iOS/1.0.0", forHTTPHeaderField: "User-Agent")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let reauthenticationToken, !reauthenticationToken.isEmpty {
            request.setValue(reauthenticationToken, forHTTPHeaderField: "X-Pint-Path-Reauth-Token")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BeerMapAPIError.missingData
        }

        let statusEnvelope = try? decoder.decode(APIStatusEnvelope.self, from: data)
        if !(200..<300).contains(http.statusCode) || statusEnvelope?.ok == false {
            let message = statusEnvelope?.error?.message ?? "Request failed (\(http.statusCode))."
            let normalizedMessage = message.lowercased()
            if http.statusCode == 403 && (
                statusEnvelope?.error?.details?.reauthenticationRequired == true ||
                normalizedMessage.contains("reauthenticat") ||
                normalizedMessage.contains("fresh provider sign-in") ||
                normalizedMessage.contains("recent sign-in")
            ) {
                throw BeerMapAPIError.reauthenticationRequired
            }
            if http.statusCode == 403 &&
                normalizedMessage.contains("accept the current terms") &&
                normalizedMessage.contains("privacy policy") {
                throw BeerMapAPIError.legalAcceptanceRequired(
                    message: message,
                    accessToken: nil,
                    refreshToken: nil
                )
            }
            if let message = statusEnvelope?.error?.message {
                if http.statusCode == 401 { throw BeerMapAPIError.unexpectedStatus(401) }
                throw BeerMapAPIError.server(message)
            }
            throw BeerMapAPIError.unexpectedStatus(http.statusCode)
        }

        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }

        let envelope: APIEnvelope<T>
        do {
            envelope = try decoder.decode(APIEnvelope<T>.self, from: data)
        } catch {
#if DEBUG
            print("Pint Path API response decoding failed for \(path): \(error)")
#endif
            throw BeerMapAPIError.invalidResponse
        }

        if let data = envelope.data {
            return data
        }
        throw BeerMapAPIError.missingData
    }

    private func supabaseAuthRequest<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String,
        body: Body,
        accessToken: String? = nil
    ) async throws -> T {
        guard
            let supabaseURL = AppConfig.supabaseURL,
            let key = AppConfig.supabaseAnonKey,
            let url = URL(string: path, relativeTo: supabaseURL)
        else {
            throw BeerMapAPIError.configuration(
                "This Pint Path build does not contain the approved public authentication configuration. Update the app or contact support."
            )
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(key, forHTTPHeaderField: "apikey")
        if let accessToken, accessToken != key {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try encoder.encode(body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BeerMapAPIError.missingData }

        if !(200..<300).contains(http.statusCode) {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = object?["msg"] as? String
                ?? object?["error_description"] as? String
                ?? object?["message"] as? String
                ?? "Authentication failed (\(http.statusCode))."
            if http.statusCode == 401 || http.statusCode == 400 {
                throw BeerMapAPIError.server(message)
            }
            throw BeerMapAPIError.unexpectedStatus(http.statusCode)
        }

        if T.self == EmptyResponse.self, data.isEmpty || String(data: data, encoding: .utf8) == "{}" {
            return EmptyResponse() as! T
        }
        return try decoder.decode(T.self, from: data)
    }

    private func requiredLegalPolicyVersion(_ config: PublicConfig) throws -> String {
        guard
            let version = config.legalPolicyVersion?.trimmingCharacters(in: .whitespacesAndNewlines),
            !version.isEmpty
        else {
            throw BeerMapAPIError.configuration(
                "The current Terms and Privacy Policy version is unavailable. Refresh the app and try again."
            )
        }
        return version
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
