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
    case mfaStepUpRequired(accessToken: String?, refreshToken: String?)
    case providerGlobalRevocationCompleted
    case providerGlobalRevocationPending
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
        case .mfaStepUpRequired:
            return "Enter the six-digit code from your authenticator app to finish signing in."
        case .providerGlobalRevocationCompleted:
            return "Security cleanup is complete. Wait one minute, then sign in again."
        case .providerGlobalRevocationPending:
            return "Provider-wide sign-out is still being completed. Wait five minutes, then retry."
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

    var requiresMFAStepUp: Bool {
        if case .mfaStepUpRequired = self { return true }
        return false
    }

    var mfaProviderTokens: (accessToken: String?, refreshToken: String?) {
        if case .mfaStepUpRequired(let accessToken, let refreshToken) = self {
            return (accessToken, refreshToken)
        }
        return (nil, nil)
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
        // Pint Path app authority is carried explicitly from the Keychain-backed
        // tagged cookie credential below. Do not also copy it into Foundation's
        // global cookie store, where unrelated sessions could send it implicitly.
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
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
        } catch BeerMapAPIError.mfaStepUpRequired(_, _) {
            throw BeerMapAPIError.mfaStepUpRequired(
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
        let result: AuthResult
        do {
            result = try await syncSupabase(
                accessToken: accessToken,
                config: config,
                ageConfirmed: ageConfirmed,
                termsAccepted: termsAccepted,
                privacyAccepted: privacyAccepted
            )
        } catch BeerMapAPIError.mfaStepUpRequired(_, _) {
            throw BeerMapAPIError.mfaStepUpRequired(
                accessToken: accessToken,
                refreshToken: tokens.refreshToken
            )
        }
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
        existingAppToken: String? = nil,
        reauthPurpose: String? = nil
    ) async throws -> AuthResult {
        let hasCompleteConsent = ageConfirmed == true && termsAccepted == true && privacyAccepted == true
        let policyVersion: String?
        if hasCompleteConsent {
            policyVersion = try requiredLegalPolicyVersion(config)
        } else {
            policyVersion = nil
        }
        do {
            return try await send(
                "/api/business/auth/supabase-session",
                method: "POST",
                body: SupabaseSessionRequest(
                    accessToken: accessToken,
                    credentialCeremony: reauthPurpose == nil ? nil : "native_memory_v1",
                    reauthPurpose: reauthPurpose,
                    ageConfirmed: hasCompleteConsent ? true : nil,
                    termsAccepted: hasCompleteConsent ? true : nil,
                    privacyAccepted: hasCompleteConsent ? true : nil,
                    termsVersion: policyVersion,
                    privacyVersion: policyVersion,
                    consentSource: hasCompleteConsent ? "ios" : nil
                ),
                token: existingAppToken,
                nativeReauthenticationClient: reauthPurpose != nil
            )
        } catch BeerMapAPIError.providerGlobalRevocationPending where reauthPurpose == nil {
            let recovery: ProviderGlobalRevocationResumeResponse = try await send(
                "/api/business/auth/provider-global-signout-resume",
                method: "POST",
                body: ProviderGlobalRevocationResumeRequest(accessToken: accessToken)
            )
            guard recovery.providerSessionsRevoked else {
                throw BeerMapAPIError.providerGlobalRevocationPending
            }
            KeychainSessionStore.deleteToken()
            throw BeerMapAPIError.providerGlobalRevocationCompleted
        }
    }

    func reauthenticateSupabaseSession(
        accessToken: String,
        purpose: String,
        config: PublicConfig,
        existingAppToken: String
    ) async throws -> AuthResult {
        try await syncSupabase(
            accessToken: accessToken,
            config: config,
            ageConfirmed: nil,
            termsAccepted: nil,
            privacyAccepted: nil,
            existingAppToken: existingAppToken,
            reauthPurpose: purpose
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
        let result: AuthResult
        do {
            result = try await syncSupabase(
                accessToken: accessToken,
                config: config,
                ageConfirmed: nil,
                termsAccepted: nil,
                privacyAccepted: nil,
                existingAppToken: existingAppToken
            )
        } catch BeerMapAPIError.mfaStepUpRequired(_, _) {
            throw BeerMapAPIError.mfaStepUpRequired(
                accessToken: accessToken,
                refreshToken: tokens.refreshToken ?? refreshToken
            )
        }
        return (result, tokens.refreshToken, accessToken)
    }

    func verifiedSupabaseTotpFactors(accessToken: String) async throws -> [SupabaseMFAFactor] {
        let binding = try supabaseTokenBinding(accessToken)
        let user: SupabaseMFAUser = try await supabaseAuthGet("/auth/v1/user", accessToken: accessToken)
        guard user.id == binding.userId else {
            throw BeerMapAPIError.server("The authenticator belongs to a different provider session. Sign in again.")
        }
        return (user.factors ?? []).filter {
            $0.factorType == "totp" && $0.status == "verified" && !$0.id.isEmpty
        }
    }

    func challengeAndVerifySupabaseMFA(
        accessToken: String,
        refreshToken: String?,
        factorId: String,
        code: String
    ) async throws -> SupabaseAuthTokens {
        let normalizedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedCode.range(of: #"^[0-9]{6}$"#, options: .regularExpression) != nil else {
            throw BeerMapAPIError.server("Enter the six-digit code from your authenticator app.")
        }
        let originalBinding = try supabaseTokenBinding(accessToken)
        let factors = try await verifiedSupabaseTotpFactors(accessToken: accessToken)
        guard
            factorId.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil,
            factors.contains(where: { $0.id == factorId })
        else {
            throw BeerMapAPIError.server("That verified authenticator is no longer available. Sign in again.")
        }
        let challenge: SupabaseMFAChallenge = try await supabaseAuthRequest(
            "/auth/v1/factors/\(factorId)/challenge",
            method: "POST",
            body: EmptyResponse(),
            accessToken: accessToken
        )
        guard !challenge.id.isEmpty else { throw BeerMapAPIError.missingData }
        let upgraded: SupabaseAuthTokens = try await supabaseAuthRequest(
            "/auth/v1/factors/\(factorId)/verify",
            method: "POST",
            body: SupabaseMFAVerifyRequest(challengeId: challenge.id, code: normalizedCode),
            accessToken: accessToken
        )
        guard let upgradedAccessToken = upgraded.accessToken else { throw BeerMapAPIError.missingData }
        let upgradedBinding = try supabaseTokenBinding(upgradedAccessToken)
        guard
            upgradedBinding.userId == originalBinding.userId,
            upgradedBinding.sessionId == originalBinding.sessionId,
            upgradedBinding.aal == "aal2"
        else {
            throw BeerMapAPIError.server("Authenticator verification did not upgrade this exact provider session. Sign in again.")
        }
        return SupabaseAuthTokens(
            accessToken: upgradedAccessToken,
            refreshToken: upgraded.refreshToken ?? refreshToken,
            expiresIn: upgraded.expiresIn
        )
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

    func logoutAll(accessToken: String, token: String) async throws -> LogoutAllResponse {
        try await send(
            "/api/business/auth/logout-all",
            method: "POST",
            body: LogoutAllRequest(accessToken: accessToken),
            token: token
        )
    }

    func account(token: String) async throws -> AccountDashboard {
        try await get("/api/business/account", token: token)
    }

    func accountSessions(token: String) async throws -> AccountSessionsResponse {
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
                token: token
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

    func revokeAccountSession(_ sessionId: String, token: String) async throws -> EmptyResponse {
        try await send("/api/business/account/sessions/\(escape(sessionId))", method: "DELETE", body: EmptyResponse(), token: token)
    }

    func exportAccount(token: String) async throws -> JSONValue {
        try await get("/api/business/account/export", token: token)
    }

    func updatePrivacy(_ settings: PrivacySettingsRequest, token: String) async throws -> PrivacySettingsSaveResult {
        try await send("/api/business/account/privacy-settings", method: "POST", body: settings, token: token)
    }

    func accountDeletionStatus(token: String) async throws -> AccountDeletionStatusResponse {
        try await get("/api/business/account/delete-request", token: token)
    }

    func cancelAccountDeletion(_ requestId: String, token: String) async throws -> EmptyResponse {
        try await send(
            "/api/business/account/delete-request/\(escape(requestId))",
            method: "DELETE",
            body: EmptyResponse(),
            token: token
        )
    }

    func requestAccountDeletion(message: String?, token: String) async throws -> EmptyResponse {
        try await send(
            "/api/business/account/delete-request",
            method: "POST",
            body: AccountDeletionRequest(message: message),
            token: token
        )
    }

    func listVenues(
        query: String? = nil,
        limit: Int = 250,
        maximumResults: Int = 1_000,
        token: String? = nil
    ) async throws -> [Venue] {
        let resultLimit = min(2_000, max(1, maximumResults))
        let pageSize = min(resultLimit, min(250, max(1, limit)))
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

    func priceRecords(
        venueId: String? = nil,
        anonymousSessionId: String,
        token: String?,
        maximumRecords: Int? = nil
    ) async throws -> PriceRecordsResponse {
        let boundedMaximumRecords = maximumRecords.map { min(5_000, max(1, $0)) }
        let maximumPageCount = boundedMaximumRecords.map { (($0 + 499) / 500) + 1 } ?? 1_000
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
            try Task<Never, Never>.checkCancellation()
            pageCount += 1
            guard pageCount <= maximumPageCount else {
                throw BeerMapAPIError.server("Price pagination exceeded its safety limit. Refresh and try again.")
            }
            let remainingRecords = boundedMaximumRecords.map { max(1, $0 - records.count) }
            let pageSize = min(500, remainingRecords ?? 500)
            var items = [
                URLQueryItem(name: "anonymousSessionId", value: anonymousSessionId),
                URLQueryItem(name: "limit", value: "\(pageSize)")
            ]
            if let venueId { items.append(URLQueryItem(name: "venueId", value: venueId)) }
            if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
            let response: PriceRecordsResponse = try await get(
                path("/api/business/price-records", queryItems: items),
                token: token
            )
            try Task<Never, Never>.checkCancellation()
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
            if let boundedMaximumRecords, records.count >= boundedMaximumRecords {
                throw BeerMapAPIError.server(
                    "Price measurement exceeded its bounded catalogue window. Try a narrower search."
                )
            }
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

    func answerPriceConfirmation(
        priceRecordId: String,
        outcome: PriceConfirmationOutcome,
        token: String
    ) async throws -> PriceConfirmationResult {
        try await send(
            "/api/business/price-records/\(escape(priceRecordId))/confirmation",
            method: "POST",
            body: PriceConfirmationRequest(outcome: outcome),
            token: token
        )
    }

    func createRequest(_ request: VenueRequestPayload, token: String?) async throws -> EmptyResponse {
        try await send("/api/business/requests", method: "POST", body: request, token: token)
    }

    @discardableResult
    func track(_ event: EventRequest, token: String?) async -> Bool {
        do {
            let _: EmptyResponse = try await send("/api/business/events", method: "POST", body: event, token: token)
            return true
        } catch {
            return false
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
        bypassCache: Bool = false
    ) async throws -> T {
        try await request(
            path,
            method: "GET",
            body: Optional<EmptyResponse>.none,
            token: token,
            bypassCache: bypassCache
        )
    }

    func send<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String,
        body: Body,
        token: String? = nil,
        timeoutInterval: TimeInterval? = nil,
        nativeReauthenticationClient: Bool = false
    ) async throws -> T {
        try await request(
            path,
            method: method,
            body: body,
            token: token,
            timeoutInterval: timeoutInterval,
            nativeReauthenticationClient: nativeReauthenticationClient
        )
    }

    private func request<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String,
        body: Body?,
        token: String?,
        timeoutInterval: TimeInterval? = nil,
        bypassCache: Bool = false,
        nativeReauthenticationClient: Bool = false
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
        if nativeReauthenticationClient {
            guard path == "/api/business/auth/supabase-session" else {
                throw BeerMapAPIError.invalidURL(path)
            }
            request.setValue("ios-native-v1", forHTTPHeaderField: "Sec-Pint-Path-Client")
        }
        if let token {
            if let cookieValue = KeychainSessionStore.cookieValue(from: token) {
                request.setValue("pint_path_session=\(cookieValue)", forHTTPHeaderField: "Cookie")
            } else if path == "/api/business/auth/supabase-session",
                      let bearerToken = KeychainSessionStore.legacyBearerToken(from: token) {
                // A pre-cookie credential is sent only to the atomic exchange
                // that replaces it with a tagged cookie.
                request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
            }
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
            if statusEnvelope?.error?.code == "MFA_STEP_UP_REQUIRED" {
                throw BeerMapAPIError.mfaStepUpRequired(accessToken: nil, refreshToken: nil)
            }
            if statusEnvelope?.error?.code == "PROVIDER_GLOBAL_REVOCATION_PENDING" {
                throw BeerMapAPIError.providerGlobalRevocationPending
            }
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
            if path == "/api/business/auth/supabase-session" {
                guard
                    let cookieValue = sessionCookieValue(from: http, requestURL: url),
                    KeychainSessionStore.saveSessionCookie(cookieValue)
                else {
                    throw BeerMapAPIError.invalidResponse
                }
            }
            return data
        }
        throw BeerMapAPIError.missingData
    }

    private func sessionCookieValue(from response: HTTPURLResponse, requestURL: URL) -> String? {
        guard let rawHeader = response.value(forHTTPHeaderField: "Set-Cookie") else { return nil }
        let parts = rawHeader.split(separator: ";", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let nameValue = parts.first, nameValue.hasPrefix("pint_path_session=") else { return nil }
        let value = String(nameValue.dropFirst("pint_path_session=".count))
        guard !value.isEmpty, !value.contains(",") else { return nil }

        let attributes = parts.dropFirst().map { $0.lowercased() }
        guard attributes.contains("httponly") else { return nil }
        guard attributes.contains("path=/") else { return nil }
        guard attributes.contains("samesite=lax") else { return nil }
        guard !attributes.contains(where: { $0.hasPrefix("domain=") }) else { return nil }
        if requestURL.scheme?.lowercased() == "https" && !attributes.contains("secure") {
            return nil
        }
        return value
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

    private func supabaseAuthGet<T: Decodable>(
        _ path: String,
        accessToken: String
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
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(key, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BeerMapAPIError.missingData }
        guard (200..<300).contains(http.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = object?["msg"] as? String
                ?? object?["error_description"] as? String
                ?? object?["message"] as? String
                ?? "Authentication failed (\(http.statusCode))."
            throw BeerMapAPIError.server(message)
        }
        return try decoder.decode(T.self, from: data)
    }

    private func supabaseTokenBinding(_ accessToken: String) throws -> (
        userId: String,
        sessionId: String,
        aal: String
    ) {
        let segments = accessToken.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else {
            throw BeerMapAPIError.server("The sign-in provider returned an invalid session token.")
        }
        var payload = String(segments[1]).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        payload.append(String(repeating: "=", count: (4 - payload.count % 4) % 4))
        guard
            let data = Data(base64Encoded: payload),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let userId = object["sub"] as? String,
            let sessionId = object["session_id"] as? String,
            let aal = object["aal"] as? String,
            !userId.isEmpty,
            !sessionId.isEmpty
        else {
            throw BeerMapAPIError.server("The sign-in provider returned an invalid session token.")
        }
        return (userId, sessionId, aal)
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
