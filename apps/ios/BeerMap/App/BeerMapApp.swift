import SwiftUI

enum AppTab: Hashable {
    case explore
    case addPrice
    case account
    case more
}

@main
struct BeerMapApp: App {
    @StateObject private var model = BeerMapAppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(BeerMapTheme.amber)
        }
    }
}

private enum PendingMFAStepUpContinuation {
    case newSession(
        ageConfirmed: Bool?,
        termsAccepted: Bool?,
        privacyAccepted: Bool?,
        successNotice: String
    )
    case refresh(existingAppToken: String, fallbackRefreshToken: String)
    case purpose(existingAppToken: String, purpose: String)
}

private struct PendingMFAStepUp {
    let accessToken: String
    let refreshToken: String?
    let factors: [SupabaseMFAFactor]
    let continuation: PendingMFAStepUpContinuation
}

@MainActor
final class BeerMapAppModel: ObservableObject {
    private static let missionFetchLimit = 100
    private static let supportedServingSizes = Set(["pint", "pot", "schooner", "jug", "bottle", "can", "other"])

    @Published var config: PublicConfig?
    @Published var accountDashboard: AccountDashboard?
    @Published var venues: [Venue] = []
    @Published var missions: [Mission] = []
    @Published var selectedVenuePrices: [String: PriceRecordsResponse] = [:]
    @Published var venuePortal: VenuePortalData?
    @Published var accountSessions: [AccountSession] = []
    @Published private(set) var accountSessionsLoaded = false
    @Published var accountDeletionRequest: AccountDeletionStatus?
    @Published var accountExportURL: URL?
    @Published var isLoading = false
    @Published var notice: String?
    @Published var errorMessage: String?
    @Published var reauthenticationContext: String?
    @Published private(set) var legalAcceptanceRequired = false
    @Published private(set) var legalAcceptanceVersion: String?
    @Published private(set) var mfaStepUpRequired = false
    @Published private(set) var mfaFactors: [SupabaseMFAFactor] = []
    @Published var optionalAnalyticsEnabled = false
    @Published var selectedTab: AppTab = .explore
    @Published private(set) var pendingContributionVenueId: String?

    let api: BeerMapAPI
    let anonymousSessionId: String
    private(set) var sessionToken: String?
    private var activeLoadingOperations = 0
    private var hasStarted = false
    private var accountDashboardNeedsRefresh = false
    private var pendingLegalAcceptance: (accessToken: String, refreshToken: String?)?
    private var pendingMFAStepUp: PendingMFAStepUp?

    var isSignedIn: Bool { sessionToken != nil }
    var account: Account? { accountDashboard?.account }
    var hasContributorAccess: Bool {
        accountDashboard?.account.subscriptionStatus?.caseInsensitiveCompare("contributor_unlocked") == .orderedSame
    }
    var hasAdminAccess: Bool {
        isSignedIn && accountDashboard?.access?.isAdmin == true
    }
    var hasVenueAccess: Bool {
        guard let venuePortal, venuePortal.accessState != "claim_required" else { return false }
        let hasCurrentAdminAuthority = accountDashboard?.access?.isAdmin == true && venuePortal.isAdmin == true
        let hasAssignedVenue = venuePortal.isAdmin != true
            && venuePortal.accessLevel != "counter_staff"
            && venuePortal.assignments?.isEmpty == false
        return hasCurrentAdminAuthority || hasAssignedVenue
    }

    func startPriceContribution(for venue: Venue) {
        pendingContributionVenueId = venue.id
        selectedTab = .addPrice
    }

    func takePendingContributionVenueId() -> String? {
        defer { pendingContributionVenueId = nil }
        return pendingContributionVenueId
    }

    init(api: BeerMapAPI = BeerMapAPI()) {
        self.api = api
        let defaults = UserDefaults.standard
        let installMarkerKey = "au.pintpath.app.installMarker"
        let anonymousSessionKey = "au.pintpath.app.anonymousSessionId"
        let hasInstallMarker = defaults.object(forKey: installMarkerKey) != nil
        let hasLegacyAppContainer = defaults.object(forKey: anonymousSessionKey) != nil
        if !hasInstallMarker && !hasLegacyAppContainer {
            // Keychain entries can survive uninstall. A fresh app container must never
            // silently restore an old account session from a previous installation.
            KeychainSessionStore.deleteToken()
        }
        // The pre-marker app already stored its anonymous ID in UserDefaults. Treat that
        // as an upgrade signal so existing sessions survive this migration exactly once.
        defaults.set(true, forKey: installMarkerKey)
        let restoredSessionToken = KeychainSessionStore.loadToken()
        self.sessionToken = restoredSessionToken
        if let existing = defaults.string(forKey: anonymousSessionKey) {
            self.anonymousSessionId = existing
        } else {
            let generated = UUID().uuidString
            defaults.set(generated, forKey: anonymousSessionKey)
            self.anonymousSessionId = generated
        }
        self.optionalAnalyticsEnabled = restoredSessionToken == nil
            ? false
            : (defaults.object(forKey: "au.pintpath.app.optionalAnalytics") as? Bool ?? false)
        if restoredSessionToken == nil {
            defaults.removeObject(forKey: "au.pintpath.app.optionalAnalytics")
        }
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true
        await loadHome()
        if sessionToken != nil {
            await refreshAccount()
            await refreshVenuePortal()
        }
    }

    func loadHome(search: String? = nil) async {
        setLoading(true)
        defer { setLoading(false) }
        do {
            async let configTask = api.getConfig()
            async let venueTask = withContributorAuthenticatedSession { token in
                try await self.api.listVenues(query: search, token: token)
            }
            config = try await configTask
            async let missionTask = withOptionalAuthenticatedSession { token in
                try await self.api.missions(token: token, limit: Self.missionFetchLimit)
            }
            venues = try await venueTask
            missions = try await missionTask
            errorMessage = nil
            Task { [weak self] in
                await self?.track(
                    "map_viewed",
                    metadata: ["source": .string("ios_app"), "privacyScope": .string("optional_analytics")]
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func login(email: String, password: String) async {
        setLoading(true)
        defer { setLoading(false) }
        clearLegalAcceptanceState()
        do {
            guard let config else { throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.") }
            let result = try await api.login(
                email: email,
                password: password,
                config: config
            )
            try storeSession(result.authResult)
            KeychainSessionStore.saveSupabaseRefreshToken(result.refreshToken)
            KeychainSessionStore.saveSupabaseAccessToken(result.accessToken)
            finishSignIn(defaultNotice: "Signed in as \(result.authResult.account.email).")
            await refreshAccount()
            await refreshVenuePortal()
        } catch let apiError as BeerMapAPIError {
            if await presentMFAStepUp(
                apiError,
                continuation: .newSession(
                    ageConfirmed: nil,
                    termsAccepted: nil,
                    privacyAccepted: nil,
                    successNotice: "Signed in."
                )
            ) { return }
            if presentLegalAcceptance(apiError) { return }
            errorMessage = apiError.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signup(
        email: String,
        password: String,
        displayName: String?,
        ageConfirmed: Bool,
        termsAccepted: Bool,
        privacyAccepted: Bool
    ) async {
        setLoading(true)
        defer { setLoading(false) }
        clearLegalAcceptanceState()
        do {
            guard let config else { throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.") }
            let outcome = try await api.signup(
                email: email,
                password: password,
                displayName: displayName,
                config: config,
                ageConfirmed: ageConfirmed,
                termsAccepted: termsAccepted,
                privacyAccepted: privacyAccepted
            )
            if let result = outcome.authResult {
                try storeSession(result)
                KeychainSessionStore.saveSupabaseRefreshToken(outcome.refreshToken)
                KeychainSessionStore.saveSupabaseAccessToken(outcome.accessToken)
                finishSignIn(defaultNotice: "Account created. Welcome to Pint Path.")
                await refreshAccount()
            } else {
                notice = "Check your email to verify the account, then return here to sign in."
            }
        } catch let apiError as BeerMapAPIError {
            if await presentMFAStepUp(
                apiError,
                continuation: .newSession(
                    ageConfirmed: ageConfirmed,
                    termsAccepted: termsAccepted,
                    privacyAccepted: privacyAccepted,
                    successNotice: "Account created. Welcome to Pint Path."
                )
            ) { return }
            errorMessage = apiError.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func acceptCurrentPolicies(
        ageConfirmed: Bool,
        termsAccepted: Bool,
        privacyAccepted: Bool
    ) async {
        guard ageConfirmed && termsAccepted && privacyAccepted else {
            errorMessage = "Confirm 18+ and accept the current Terms and Privacy Policy to continue."
            return
        }
        guard let pendingLegalAcceptance, let config else {
            clearLegalAcceptanceState()
            errorMessage = "Your verified sign-in expired. Sign in again to review the current policies."
            return
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            let result = try await api.syncSupabase(
                accessToken: pendingLegalAcceptance.accessToken,
                config: config,
                ageConfirmed: true,
                termsAccepted: true,
                privacyAccepted: true
            )
            let refreshToken = pendingLegalAcceptance.refreshToken
            clearLegalAcceptanceState()
            try storeSession(result)
            KeychainSessionStore.saveSupabaseRefreshToken(refreshToken)
            KeychainSessionStore.saveSupabaseAccessToken(pendingLegalAcceptance.accessToken)
            finishSignIn(defaultNotice: "Current Terms and Privacy Policy accepted. Signed in as \(result.account.email).")
            await refreshAccount()
            await refreshVenuePortal()
        } catch let apiError as BeerMapAPIError {
            if await presentMFAStepUp(
                apiError,
                accessToken: pendingLegalAcceptance.accessToken,
                refreshToken: pendingLegalAcceptance.refreshToken,
                continuation: .newSession(
                    ageConfirmed: true,
                    termsAccepted: true,
                    privacyAccepted: true,
                    successNotice: "Current Terms and Privacy Policy accepted."
                )
            ) {
                clearLegalAcceptanceState()
                return
            }
            errorMessage = apiError.localizedDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func cancelPendingLegalAcceptance() {
        clearLegalAcceptanceState()
        errorMessage = nil
        notice = "Sign-in cancelled. No Pint Path session was created."
    }

    func cancelPendingMFAStepUp() {
        guard pendingMFAStepUp != nil else { return }
        clearMFAStepUpState()
        errorMessage = nil
        notice = isSignedIn
            ? "Authenticator verification cancelled. Your existing Pint Path session was not upgraded."
            : "Sign-in cancelled. No Pint Path session was created."
    }

    func completeMFAStepUp(factorId: String, code: String) async {
        guard let pendingMFAStepUp else {
            errorMessage = "Authenticator verification expired. Sign in again."
            return
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            let upgraded = try await api.challengeAndVerifySupabaseMFA(
                accessToken: pendingMFAStepUp.accessToken,
                refreshToken: pendingMFAStepUp.refreshToken,
                factorId: factorId,
                code: code
            )
            guard let upgradedAccessToken = upgraded.accessToken else {
                throw BeerMapAPIError.missingData
            }
            let upgradedRefreshToken = upgraded.refreshToken ?? pendingMFAStepUp.refreshToken
            let continuation = pendingMFAStepUp.continuation
            // The AAL1 authority is discarded before the Pint Path exchange is
            // retried. A repeated server boundary cannot recursively reopen MFA.
            clearMFAStepUpState()
            switch continuation {
            case .newSession(
                let ageConfirmed,
                let termsAccepted,
                let privacyAccepted,
                let successNotice
            ):
                do {
                    let result = try await api.syncSupabase(
                        accessToken: upgradedAccessToken,
                        config: try currentConfig(),
                        ageConfirmed: ageConfirmed,
                        termsAccepted: termsAccepted,
                        privacyAccepted: privacyAccepted
                    )
                    try storeSession(result)
                    KeychainSessionStore.saveSupabaseRefreshToken(upgradedRefreshToken)
                    KeychainSessionStore.saveSupabaseAccessToken(upgradedAccessToken)
                    finishSignIn(defaultNotice: "\(successNotice) Signed in as \(result.account.email).")
                    await refreshAccount()
                    await refreshVenuePortal()
                } catch let apiError as BeerMapAPIError {
                    if case .legalAcceptanceRequired(let message, _, _) = apiError {
                        stageLegalAcceptance(
                            message: message,
                            accessToken: upgradedAccessToken,
                            refreshToken: upgradedRefreshToken
                        )
                        return
                    }
                    throw apiError
                }
            case .refresh(let existingAppToken, let fallbackRefreshToken):
                let result = try await api.syncSupabase(
                    accessToken: upgradedAccessToken,
                    config: try currentConfig(),
                    ageConfirmed: nil,
                    termsAccepted: nil,
                    privacyAccepted: nil,
                    existingAppToken: existingAppToken
                )
                try storeSession(result, resetAuthority: false)
                KeychainSessionStore.saveSupabaseRefreshToken(upgradedRefreshToken ?? fallbackRefreshToken)
                KeychainSessionStore.saveSupabaseAccessToken(upgradedAccessToken)
                accountDashboardNeedsRefresh = true
                errorMessage = nil
                notice = "Authenticator verified. Retry the action that needed a refreshed session."
            case .purpose(let existingAppToken, let purpose):
                let result = try await api.syncSupabase(
                    accessToken: upgradedAccessToken,
                    config: try currentConfig(),
                    ageConfirmed: nil,
                    termsAccepted: nil,
                    privacyAccepted: nil,
                    existingAppToken: existingAppToken,
                    reauthPurpose: purpose
                )
                try storeSession(result, resetAuthority: false)
                KeychainSessionStore.saveSupabaseRefreshToken(upgradedRefreshToken)
                KeychainSessionStore.saveSupabaseAccessToken(upgradedAccessToken)
                errorMessage = nil
                notice = "Authenticator verified. Retry the sensitive action; Pint Path has not run it automatically."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func requestPasswordReset(email: String) async {
        setLoading(true)
        defer { setLoading(false) }
        do {
            guard let config else { throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.") }
            try await api.requestPasswordReset(email: email, config: config)
            notice = "If that email has an account, a secure reset link is on its way."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() async {
        guard let token = sessionToken else { return }
        setLoading(true)
        defer { setLoading(false) }
        if let accessToken = KeychainSessionStore.loadSupabaseAccessToken(), let config {
            do {
                try await api.logoutSupabase(accessToken: accessToken, config: config)
            } catch {
                // The local and Pint Path sessions must still be removed if Supabase is unreachable.
            }
        }
        do {
            _ = try await api.logout(token: token)
        } catch {
            // Clear the local session even when the backend is temporarily unreachable.
        }
        clearLocalSession()
        notice = "Signed out."
    }

    func logoutAllSessions() async {
        guard sessionToken != nil else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            let result = try await withPurposeBoundSession("logout_all") { token, accessToken in
                try await self.api.logoutAll(
                    accessToken: accessToken,
                    token: token
                )
            }
            clearLocalSession()
            if result.providerSessionsRevoked {
                notice = "Signed out on every device."
            } else {
                notice = nil
                errorMessage = "Every Pint Path app session was revoked, but the sign-in provider could not finish its own global sign-out. Sign in again and retry before relying on provider-wide logout."
            }
        } catch {
            handleSensitiveActionError(error, action: "sign out all devices")
        }
    }

    func signOutForReauthentication() async {
        let pendingContext = reauthenticationContext ?? "complete the sensitive account action"
        await logout()
        reauthenticationContext = pendingContext
        notice = "Sign back in to \(pendingContext). Pint Path will not complete it until you retry."
    }

    func refreshAccount() async {
        guard sessionToken != nil else { return }
        do {
            accountDashboard = try await withAuthenticatedSession { token in
                try await self.api.account(token: token)
            }
            accountDashboardNeedsRefresh = false
            if accountDashboard?.access?.isAdmin != true, venuePortal?.isAdmin == true {
                venuePortal = nil
            }
            accountDeletionRequest = (try? await withAuthenticatedSession { token in
                try await self.api.accountDeletionStatus(token: token).request
            }) ?? nil
            if let settings = accountDashboard?.privacySettings {
                optionalAnalyticsEnabled = settings.optionalAnalyticsEnabled ?? false
                UserDefaults.standard.set(optionalAnalyticsEnabled, forKey: "au.pintpath.app.optionalAnalytics")
            }
            if reauthenticationContext == nil { errorMessage = nil }
        } catch {
            resetOptionalAnalytics()
            venuePortal = nil
            errorMessage = error.localizedDescription
        }
    }

    func refreshAccountIfNeeded() async {
        guard sessionToken != nil else { return }
        guard accountDashboard == nil || accountDashboardNeedsRefresh else { return }
        await refreshAccount()
    }

    func loadAccountSessions() async {
        guard sessionToken != nil else { return }
        setLoading(true)
        defer { setLoading(false) }
        accountSessions = []
        accountSessionsLoaded = false
        do {
            accountSessions = try await withPurposeBoundSession("session_management") { token, _ in
                try await self.api.accountSessions(token: token).sessions
            }
            accountSessionsLoaded = true
            clearReauthenticationContext(ifMatching: "review signed-in sessions")
        } catch {
            handleSensitiveActionError(error, action: "review signed-in sessions")
        }
    }

    func savePrivacy(settings: PrivacySettingsRequest) async {
        guard sessionToken != nil else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.updatePrivacy(settings, token: token)
            }
            accountDashboard = try await withAuthenticatedSession { token in
                try await self.api.account(token: token)
            }
            optionalAnalyticsEnabled = settings.optionalAnalyticsEnabled
            UserDefaults.standard.set(optionalAnalyticsEnabled, forKey: "au.pintpath.app.optionalAnalytics")
            notice = "Privacy preferences saved."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func requestAccountDeletion() async {
        guard sessionToken != nil else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withPurposeBoundSession("account_deletion") { token, _ in
                try await self.api.requestAccountDeletion(
                    message: "Self-service account deletion scheduled from the iOS app.",
                    token: token
                )
            }
            accountDeletionRequest = try await withAuthenticatedSession { token in
                try await self.api.accountDeletionStatus(token: token).request
            }
            notice = "Account deletion scheduled. You can cancel during the displayed seven-day cancellation window."
            clearReauthenticationContext(ifMatching: "schedule account deletion")
        } catch {
            handleSensitiveActionError(error, action: "schedule account deletion")
        }
    }

    func cancelAccountDeletion() async {
        guard sessionToken != nil, let request = accountDeletionRequest else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withPurposeBoundSession("account_deletion") { token, _ in
                try await self.api.cancelAccountDeletion(
                    request.id,
                    token: token
                )
            }
            accountDeletionRequest = try await withAuthenticatedSession { token in
                try await self.api.accountDeletionStatus(token: token).request
            }
            notice = "Account deletion request cancelled."
            clearReauthenticationContext(ifMatching: "cancel account deletion")
        } catch {
            handleSensitiveActionError(error, action: "cancel account deletion")
        }
    }

    func prepareAccountExport() async {
        guard sessionToken != nil else { return }
        setLoading(true)
        defer { setLoading(false) }
        accountExportURL = nil
        do {
            let payload = try await withPurposeBoundSession("account_export") { token, _ in
                try await self.api.exportAccount(token: token)
            }
            let data = try JSONEncoder().encode(payload)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("pint-path-account-export.json")
            try data.write(to: url, options: .atomic)
            accountExportURL = url
            notice = "Your private account export is ready to share or save."
            clearReauthenticationContext(ifMatching: "prepare your account export")
        } catch {
            handleSensitiveActionError(error, action: "prepare your account export")
        }
    }

    func revokeAccountSession(_ session: AccountSession) async {
        guard sessionToken != nil else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withPurposeBoundSession("session_management") { token, _ in
                try await self.api.revokeAccountSession(
                    session.id,
                    token: token
                )
            }
            if session.current == true {
                clearLocalSession()
            } else {
                accountSessions = try await withPurposeBoundSession("session_management") { token, _ in
                    try await self.api.accountSessions(token: token).sessions
                }
                accountSessionsLoaded = true
            }
            notice = session.current == true ? "This session was revoked. Sign in again to continue." : "Session revoked."
            clearReauthenticationContext(ifMatching: "revoke a signed-in session")
        } catch {
            handleSensitiveActionError(error, action: "revoke a signed-in session")
        }
    }

    func loadPrices(for venue: Venue) async {
        setLoading(true)
        defer { setLoading(false) }
        do {
            let response = try await withContributorAuthenticatedSession { token in
                try await self.api.priceRecords(
                    venueId: venue.id,
                    anonymousSessionId: self.anonymousSessionId,
                    token: token
                )
            }
            selectedVenuePrices[venue.id] = response
            Task { [weak self] in
                await self?.track(
                    "venue_detail_opened",
                    venueId: venue.id,
                    suburb: venue.suburb,
                    metadata: ["source": .string("ios_app")]
                )
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveVenue(_ venue: Venue) async {
        guard sessionToken != nil else {
            errorMessage = "Sign in to save venues to your account."
            return
        }
        do {
            let item = SaveItemRequest(
                itemType: "venue",
                itemId: venue.id,
                label: venue.name,
                suburb: venue.suburb,
                metadata: ["source": .string("ios_app")]
            )
            _ = try await withAuthenticatedSession { token in
                try await self.api.saveItem(item, token: token)
            }
            notice = "Saved \(venue.name)."
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshVenuePortal(venueId: String? = nil) async {
        guard sessionToken != nil else { return }
        do {
            venuePortal = try await withAuthenticatedSession { token in
                try await self.api.venuePortal(venueId: venueId, token: token)
            }
            errorMessage = nil
        } catch {
            venuePortal = nil
            errorMessage = error.localizedDescription
        }
    }

    func saveProfile(_ profile: BarProfile) async {
        guard sessionToken != nil, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.saveProfile(profile, venueId: venueId, token: token)
            }
            await refreshVenuePortal(venueId: venueId)
            notice = "Venue profile saved."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveBeer(_ beer: BarBeer) async {
        guard sessionToken != nil, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.saveBeer(beer, venueId: venueId, token: token)
            }
            notice = "Beer row saved."
            await refreshVenuePortal(venueId: venueId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func acceptMission(_ mission: Mission) async -> Bool {
        guard sessionToken != nil else {
            errorMessage = "Sign in before reserving a mission."
            return false
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.acceptMission(mission.id, token: token)
            }
            missions = try await withAuthenticatedSession { token in
                try await self.api.missions(token: token, limit: Self.missionFetchLimit)
            }
            notice = "Mission reserved for 24 hours. Submit the linked update before it expires."
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func releaseMission(_ mission: Mission) async -> Bool {
        guard sessionToken != nil else {
            errorMessage = "Sign in before releasing a mission."
            return false
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.releaseMission(mission.id, token: token)
            }
            missions = try await withAuthenticatedSession { token in
                try await self.api.missions(token: token, limit: Self.missionFetchLimit)
            }
            notice = "Mission released for another contributor."
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func refreshMissions() async {
        do {
            missions = try await withOptionalAuthenticatedSession { token in
                try await self.api.missions(token: token, limit: Self.missionFetchLimit)
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func submitPriceUpdate(
        clientSubmissionId: String,
        missionId: String? = nil,
        venueId: String,
        beerName: String,
        servingSize: String,
        priceText: String,
        notes: String,
        sourcePhotoDataUrl: String? = nil,
        uploadLocation: UploadLocationRequest? = nil
    ) async -> Bool {
        guard sessionToken != nil else {
            errorMessage = "Sign in before submitting venue data."
            return false
        }
        guard let venue = venues.first(where: { $0.id == venueId }) else {
            errorMessage = "Choose a venue before submitting."
            return false
        }
        let trimmedBeer = beerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBeer.isEmpty else {
            errorMessage = "Add the beer name before submitting."
            return false
        }
        guard trimmedBeer.count <= 120 else {
            errorMessage = "Keep the beer name to 120 characters or fewer."
            return false
        }
        let normalizedServingSize = servingSize
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard Self.supportedServingSizes.contains(normalizedServingSize) else {
            errorMessage = "Choose a supported serving size before submitting."
            return false
        }
        guard let price = validatedObservedPrice(priceText) else {
            errorMessage = "Enter a price from $0.01 to $250 with no more than two decimal places."
            return false
        }
        let normalizedSourcePhotoDataUrl = sourcePhotoDataUrl?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfBlank

        setLoading(true)
        defer { setLoading(false) }
        do {
            let submission = CreateSubmissionRequest(
                clientSubmissionId: clientSubmissionId,
                missionId: missionId,
                venueId: venue.id,
                venueName: venue.name,
                suburb: venue.suburb,
                newVenue: nil,
                submissionType: "single_beer_price",
                observedAt: isoNow(),
                sourcePhotoDataUrl: normalizedSourcePhotoDataUrl,
                sourcePhotoDataUrls: [],
                sourceDocumentDataUrl: nil,
                sourcePhotoUrl: nil,
                uploadLocation: uploadLocation,
                notes: notes.nilIfBlank,
                items: [
                    SubmissionItemRequest(
                        beerName: trimmedBeer,
                        servingSize: normalizedServingSize,
                        price: price,
                        isOnTap: "unknown"
                    )
                ]
            )
            let result = try await withAuthenticatedSession { token in
                try await self.api.createSubmission(submission, token: token)
            }
            markAccountDashboardDirty()
            notice = result.statusCopy ?? "Price update sent for review."
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func submitSourcePhotoUpdate(clientSubmissionId: String, missionId: String? = nil, venueId: String, sourcePhotoDataUrl: String, notes: String, uploadLocation: UploadLocationRequest? = nil) async -> Bool {
        guard sessionToken != nil else {
            errorMessage = "Sign in before uploading source evidence."
            return false
        }
        guard let venue = venues.first(where: { $0.id == venueId }) else {
            errorMessage = "Choose a venue before uploading."
            return false
        }

        setLoading(true)
        defer { setLoading(false) }
        do {
            let submission = CreateSubmissionRequest(
                clientSubmissionId: clientSubmissionId,
                missionId: missionId,
                venueId: venue.id,
                venueName: venue.name,
                suburb: venue.suburb,
                newVenue: nil,
                submissionType: "photo_upload",
                observedAt: isoNow(),
                sourcePhotoDataUrl: sourcePhotoDataUrl,
                sourcePhotoDataUrls: [],
                sourceDocumentDataUrl: nil,
                sourcePhotoUrl: nil,
                uploadLocation: uploadLocation,
                notes: notes.nilIfBlank,
                items: []
            )
            let result = try await withAuthenticatedSession { token in
                try await self.api.createSubmission(submission, token: token)
            }
            markAccountDashboardDirty()
            notice = result.statusCopy ?? "Source photo sent for review."
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func reportWrongPrice(venueId: String, priceRecordId: String? = nil, beerName: String, notes: String) async {
        guard let venue = venues.first(where: { $0.id == venueId }) else {
            errorMessage = "Choose a venue before reporting."
            return
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            let report = WrongPriceReportRequest(
                anonymousSessionId: anonymousSessionId,
                venueId: venue.id,
                venueName: venue.name,
                priceRecordId: priceRecordId,
                beerName: beerName.nilIfBlank,
                reason: "other",
                notes: notes.nilIfBlank,
                sourcePhotoDataUrl: nil,
                sourcePhotoUrl: nil
            )
            _ = try await withOptionalAuthenticatedSession { token in
                try await self.api.reportWrongPrice(report, token: token)
            }
            notice = "Wrong-price report sent."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func requestMissing(requestType: String, venueName: String, beerName: String, suburb: String, notes: String) async -> Bool {
        let trimmedVenue = venueName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBeer = beerName.trimmingCharacters(in: .whitespacesAndNewlines)
        if requestType == "missing_beer", trimmedBeer.isEmpty {
            errorMessage = "Add the beer name before sending the request."
            return false
        }
        if requestType != "missing_beer", trimmedVenue.isEmpty {
            errorMessage = "Add the venue name before sending the request."
            return false
        }

        setLoading(true)
        defer { setLoading(false) }
        do {
            let payload = VenueRequestPayload(
                anonymousSessionId: anonymousSessionId,
                requestType: requestType,
                venueId: nil,
                venueName: trimmedVenue.nilIfBlank,
                beerName: trimmedBeer.nilIfBlank,
                suburb: suburb.nilIfBlank,
                notes: notes.nilIfBlank
            )
            _ = try await withOptionalAuthenticatedSession { token in
                try await self.api.createRequest(payload, token: token)
            }
            notice = requestType == "missing_beer" ? "Beer request sent." : "Venue request sent."
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func track(_ eventType: String, venueId: String? = nil, suburb: String? = nil, metadata: [String: JSONValue] = [:]) async {
        guard optionalAnalyticsEnabled, let token = sessionToken else { return }
        var scopedMetadata = metadata
        scopedMetadata["privacyScope"] = .string("optional_analytics")
        await api.track(
            EventRequest(
                anonymousSessionId: anonymousSessionId,
                eventType: eventType,
                venueId: venueId,
                beerId: nil,
                suburb: suburb,
                metadata: scopedMetadata
            ),
            token: token
        )
    }

    func dismissMessages() {
        notice = nil
        errorMessage = nil
    }

    private func storeSession(_ result: AuthResult, resetAuthority: Bool = true) throws {
        clearLegalAcceptanceState()
        let credential: String
        if
            let storedCredential = KeychainSessionStore.loadToken(),
            KeychainSessionStore.cookieValue(from: storedCredential) != nil
        {
            credential = storedCredential
        } else if let token = result.token {
            guard
                KeychainSessionStore.legacyBearerToken(from: token) != nil,
                KeychainSessionStore.saveToken(token)
            else {
                throw BeerMapAPIError.invalidResponse
            }
            credential = token
        } else {
            throw BeerMapAPIError.invalidResponse
        }
        sessionToken = credential
        guard resetAuthority else { return }
        resetOptionalAnalytics()
        // Never carry venue authority across a newly authenticated account. The portal
        // must be fetched again and cross-checked against the current account access.
        venuePortal = nil
        accountSessions = []
        accountSessionsLoaded = false
        accountDashboard = AccountDashboard(
            account: result.account,
            stats: nil,
            savedItems: nil,
            submissions: nil,
            privacySettings: nil,
            access: nil,
            leaderboard: nil
        )
        accountDashboardNeedsRefresh = true
    }

    private func refreshExpiredSession() async -> Bool {
        guard
            let currentToken = sessionToken,
            let refreshToken = KeychainSessionStore.loadSupabaseRefreshToken()
        else { return false }
        do {
            let activeConfig: PublicConfig
            if let config {
                activeConfig = config
            } else {
                activeConfig = try await api.getConfig()
                config = activeConfig
            }
            let result = try await api.refreshSupabaseSession(
                refreshToken: refreshToken,
                config: activeConfig,
                existingAppToken: currentToken
            )
            try storeSession(result.authResult, resetAuthority: false)
            KeychainSessionStore.saveSupabaseRefreshToken(result.refreshToken ?? refreshToken)
            KeychainSessionStore.saveSupabaseAccessToken(result.accessToken)
            guard let refreshedCredential = sessionToken else { return false }
            accountDashboard = try await api.account(token: refreshedCredential)
            accountDashboardNeedsRefresh = false
            if accountDashboard?.access?.isAdmin != true, venuePortal?.isAdmin == true {
                venuePortal = nil
            }
            accountDeletionRequest = (try? await api.accountDeletionStatus(token: refreshedCredential).request) ?? nil
            if let settings = accountDashboard?.privacySettings {
                optionalAnalyticsEnabled = settings.optionalAnalyticsEnabled ?? false
                UserDefaults.standard.set(optionalAnalyticsEnabled, forKey: "au.pintpath.app.optionalAnalytics")
            }
            return true
        } catch let apiError as BeerMapAPIError {
            if await presentMFAStepUp(
                apiError,
                continuation: .refresh(
                    existingAppToken: currentToken,
                    fallbackRefreshToken: refreshToken
                )
            ) {
                return false
            }
            return false
        } catch {
            return false
        }
    }

    private func clearLocalSession() {
        KeychainSessionStore.deleteToken()
        sessionToken = nil
        clearLegalAcceptanceState()
        clearMFAStepUpState()
        resetOptionalAnalytics()
        accountDashboard = nil
        accountDashboardNeedsRefresh = false
        venuePortal = nil
        accountSessions = []
        accountSessionsLoaded = false
        accountDeletionRequest = nil
        accountExportURL = nil
        selectedVenuePrices = [:]
        reauthenticationContext = nil
    }

    @discardableResult
    private func presentLegalAcceptance(_ error: BeerMapAPIError) -> Bool {
        guard case .legalAcceptanceRequired(
            let message,
            let embeddedAccessToken,
            let embeddedRefreshToken
        ) = error,
        let accessToken = embeddedAccessToken else {
            return false
        }
        stageLegalAcceptance(
            message: message,
            accessToken: accessToken,
            refreshToken: embeddedRefreshToken
        )
        return true
    }

    private func stageLegalAcceptance(
        message: String,
        accessToken: String,
        refreshToken: String?
    ) {
        // The identity has been verified, but no Pint Path authority is
        // retained until this exact credential accepts the current policy.
        let retainedReauthenticationContext = reauthenticationContext
        clearLocalSession()
        reauthenticationContext = retainedReauthenticationContext
        pendingLegalAcceptance = (accessToken: accessToken, refreshToken: refreshToken)
        legalAcceptanceRequired = true
        legalAcceptanceVersion = config?.legalPolicyVersion
        errorMessage = message
        notice = nil
    }

    private func clearLegalAcceptanceState() {
        pendingLegalAcceptance = nil
        legalAcceptanceRequired = false
        legalAcceptanceVersion = nil
    }

    @discardableResult
    private func presentMFAStepUp(
        _ error: BeerMapAPIError,
        accessToken explicitAccessToken: String? = nil,
        refreshToken explicitRefreshToken: String? = nil,
        continuation: PendingMFAStepUpContinuation
    ) async -> Bool {
        guard error.requiresMFAStepUp else { return false }
        let embedded = error.mfaProviderTokens
        guard let accessToken = explicitAccessToken ?? embedded.accessToken else {
            errorMessage = "Authenticator verification could not retain the provider session. Sign in again."
            return true
        }
        let refreshToken = explicitRefreshToken ?? embedded.refreshToken
        let retainedReauthenticationContext = reauthenticationContext
        switch continuation {
        case .newSession:
            // Any prior account cookie and long-lived provider credential are
            // removed before the short-lived AAL1 tokens enter pending memory.
            clearLocalSession()
            reauthenticationContext = retainedReauthenticationContext
        case .refresh, .purpose:
            clearMFAStepUpState()
        }
        do {
            let factors = try await api.verifiedSupabaseTotpFactors(accessToken: accessToken)
            guard !factors.isEmpty else {
                throw BeerMapAPIError.server("No verified authenticator is available for this account. Sign in again or contact support.")
            }
            pendingMFAStepUp = PendingMFAStepUp(
                accessToken: accessToken,
                refreshToken: refreshToken,
                factors: factors,
                continuation: continuation
            )
            mfaFactors = factors
            mfaStepUpRequired = true
            errorMessage = nil
            notice = nil
        } catch {
            clearMFAStepUpState()
            errorMessage = error.localizedDescription
        }
        return true
    }

    private func clearMFAStepUpState() {
        pendingMFAStepUp = nil
        mfaFactors = []
        mfaStepUpRequired = false
    }

    private func currentConfig() throws -> PublicConfig {
        guard let config else {
            throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.")
        }
        return config
    }

    private func currentReauthenticationToken() throws -> String {
        guard let token = KeychainSessionStore.loadSupabaseAccessToken(), !token.isEmpty else {
            throw BeerMapAPIError.reauthenticationRequired
        }
        return token
    }

    private func withPurposeBoundSession<T: Sendable>(
        _ purpose: String,
        _ operation: (String, String) async throws -> T
    ) async throws -> T {
        guard var currentCredential = sessionToken else {
            throw BeerMapAPIError.configuration("Sign in again to continue.")
        }
        guard let config else {
            throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.")
        }
        var accessToken = try currentReauthenticationToken()
        func establishPurposeCookie() async throws {
            _ = try await api.reauthenticateSupabaseSession(
                accessToken: accessToken,
                purpose: purpose,
                config: config,
                existingAppToken: currentCredential
            )
        }
        do {
            try await establishPurposeCookie()
        } catch let apiError as BeerMapAPIError where apiError.requiresMFAStepUp {
            _ = await presentMFAStepUp(
                apiError,
                accessToken: accessToken,
                refreshToken: KeychainSessionStore.loadSupabaseRefreshToken(),
                continuation: .purpose(existingAppToken: currentCredential, purpose: purpose)
            )
            throw BeerMapAPIError.mfaStepUpRequired(accessToken: nil, refreshToken: nil)
        } catch let apiError as BeerMapAPIError where apiError.isUnauthorized {
            // The app cookie can remain valid long after the short-lived
            // Supabase access JWT expires. Refresh the provider session once,
            // rotate the generic app cookie, then repeat only the credential
            // exchange. Never retry the sensitive operation itself.
            guard await refreshExpiredSession(), let refreshedCredential = sessionToken else {
                if mfaStepUpRequired {
                    throw BeerMapAPIError.mfaStepUpRequired(accessToken: nil, refreshToken: nil)
                }
                throw BeerMapAPIError.reauthenticationRequired
            }
            currentCredential = refreshedCredential
            accessToken = try currentReauthenticationToken()
            try await establishPurposeCookie()
        }
        guard
            let rotatedCredential = KeychainSessionStore.loadToken(),
            KeychainSessionStore.cookieValue(from: rotatedCredential) != nil
        else {
            throw BeerMapAPIError.invalidResponse
        }
        sessionToken = rotatedCredential
        return try await operation(rotatedCredential, accessToken)
    }

    private func handleSensitiveActionError(_ error: Error, action: String) {
        if let apiError = error as? BeerMapAPIError, apiError.requiresMFAStepUp {
            errorMessage = nil
            notice = nil
            return
        }
        if let apiError = error as? BeerMapAPIError, apiError.requiresReauthentication {
            reauthenticationContext = action
            errorMessage = "For your security, sign out and sign back in to \(action). Nothing was completed; retry after signing in."
            return
        }
        errorMessage = error.localizedDescription
    }

    private func clearReauthenticationContext(ifMatching action: String) {
        if reauthenticationContext == action {
            reauthenticationContext = nil
            errorMessage = nil
        }
    }

    private func finishSignIn(defaultNotice: String) {
        if let pendingContext = reauthenticationContext {
            notice = "Signed in. You can now \(pendingContext); Pint Path has not run it automatically."
            reauthenticationContext = nil
        } else {
            notice = defaultNotice
        }
        errorMessage = nil
    }

    private func resetOptionalAnalytics() {
        optionalAnalyticsEnabled = false
        UserDefaults.standard.removeObject(forKey: "au.pintpath.app.optionalAnalytics")
    }

    private func withAuthenticatedSession<T: Sendable>(
        _ operation: (String) async throws -> T
    ) async throws -> T {
        guard let currentToken = sessionToken else {
            throw BeerMapAPIError.configuration("Sign in again to continue.")
        }
        do {
            return try await operation(currentToken)
        } catch let apiError as BeerMapAPIError where apiError.isUnauthorized {
            guard await refreshExpiredSession(), let refreshedToken = sessionToken else {
                if mfaStepUpRequired {
                    throw BeerMapAPIError.mfaStepUpRequired(accessToken: nil, refreshToken: nil)
                }
                clearLocalSession()
                throw BeerMapAPIError.configuration("Your session expired. Sign in again to continue.")
            }
            return try await operation(refreshedToken)
        }
    }

    private func withOptionalAuthenticatedSession<T: Sendable>(
        _ operation: (String?) async throws -> T
    ) async throws -> T {
        let currentToken = sessionToken
        do {
            return try await operation(currentToken)
        } catch let apiError as BeerMapAPIError where apiError.isUnauthorized && currentToken != nil {
            guard await refreshExpiredSession(), let refreshedToken = sessionToken else {
                clearLocalSession()
                throw BeerMapAPIError.configuration("Your session expired. Sign in again to continue.")
            }
            return try await operation(refreshedToken)
        }
    }

    private func withContributorAuthenticatedSession<T: Sendable>(
        _ operation: (String?) async throws -> T
    ) async throws -> T {
        guard hasContributorAccess else {
            return try await operation(nil)
        }
        return try await withAuthenticatedSession { token in
            try await operation(token)
        }
    }

    private func setLoading(_ value: Bool) {
        if value {
            activeLoadingOperations += 1
        } else {
            activeLoadingOperations = max(0, activeLoadingOperations - 1)
        }
        isLoading = activeLoadingOperations > 0
    }

    private func isoNow() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private func markAccountDashboardDirty() {
        accountDashboardNeedsRefresh = true
    }

    private func validatedObservedPrice(_ priceText: String) -> Double? {
        ObservedPriceParser.parse(priceText)
    }
}
