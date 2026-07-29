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

@MainActor
final class BeerMapAppModel: ObservableObject {
    private static let missionFetchLimit = 100
    private static let supportedServingSizes = Set(["pint", "pot", "schooner", "jug", "bottle", "can", "other"])
    private static let providerSignInRetryWindow: TimeInterval = 10 * 60

    private enum SessionRefreshOutcome: Sendable {
        case refreshed
        case invalidCredentials
        case retryableFailure
    }

    private struct PendingProviderSignIn: Sendable {
        let accessToken: String
        let refreshToken: String?
        let expiresAt: Date
    }

    @Published var config: PublicConfig?
    @Published var accountDashboard: AccountDashboard?
    @Published var venues: [Venue] = []
    @Published var missions: [Mission] = []
    @Published var selectedVenuePrices: [String: PriceRecordsResponse] = [:]
    @Published var venuePortal: VenuePortalData?
    @Published var discountPass: RotatingCodeResult?
    @Published var freePintReward: RotatingCodeResult?
    @Published var accountSessions: [AccountSession] = []
    @Published private(set) var accountSessionsLoaded = false
    @Published var accountDeletionRequest: AccountDeletionStatus?
    @Published var accountExportURL: URL?
    @Published var venueReportExportURLs: [String: URL] = [:]
    @Published var counterMemberPreview: CounterMemberPreview?
    @Published var counterPurchaseResult: CounterPurchaseResult?
    @Published var counterRewardResult: CounterRewardResult?
    @Published var isLoading = false
    @Published var notice: String?
    @Published var errorMessage: String?
    @Published var reauthenticationContext: String?
    @Published private(set) var billingRecoveryGuidance: String?
    @Published private(set) var billingRecoveryUsesProvider = false
    @Published private(set) var billingRecoveryConsumer = false
    @Published private(set) var billingRecoveryVenues: [BillingRecoveryVenue] = []
    @Published private(set) var legalAcceptanceRequired = false
    @Published private(set) var legalAcceptanceVersion: String?
    @Published private(set) var providerSignInRetryAvailable = false
    @Published var optionalAnalyticsEnabled = false
    @Published var selectedTab: AppTab = .explore
    @Published private(set) var pendingContributionVenueId: String?

    let api: BeerMapAPI
    let anonymousSessionId: String
    private(set) var sessionToken: String?
    private var activeLoadingOperations = 0
    private var hasStarted = false
    private var accountDashboardNeedsRefresh = false
    private var billingRecoveryAccessToken: String?
    private var pendingLegalAcceptance: (accessToken: String, refreshToken: String?)?
    private var pendingProviderSignIn: PendingProviderSignIn?
    private var sessionRefreshTask: Task<SessionRefreshOutcome, Never>?
    private var authenticationGeneration: UInt64 = 0

    var isSignedIn: Bool { sessionToken != nil }
    var account: Account? { accountDashboard?.account }
    var hasAdminAccess: Bool {
        isSignedIn && accountDashboard?.access?.isAdmin == true
    }
    var hasVenueAccess: Bool {
        guard let venuePortal, venuePortal.accessState != "claim_required" else { return false }
        let hasCurrentAdminAuthority = accountDashboard?.access?.isAdmin == true && venuePortal.isAdmin == true
        let hasAssignedVenue = venuePortal.isAdmin != true && venuePortal.assignments?.isEmpty == false
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
            async let venueTask = withOptionalAuthenticatedSession { token in
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

    func reloadAccountConfiguration() async {
        setLoading(true)
        defer { setLoading(false) }
        do {
            config = try await api.getConfig()
            errorMessage = nil
        } catch {
            errorMessage = "Pint Path could not load account sign-in yet. Check your connection and try again."
        }
    }

    func login(email: String, password: String) async {
        setLoading(true)
        defer { setLoading(false) }
        clearPendingProviderSignIn()
        clearBillingRecoveryState()
        clearLegalAcceptanceState()
        do {
            guard let config else { throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.") }
            let result = try await api.login(
                email: email,
                password: password,
                config: config
            )
            try storeAuthenticatedSession(
                result.authResult,
                refreshToken: result.refreshToken,
                accessToken: result.accessToken
            )
            finishSignIn(defaultNotice: "Signed in as \(result.authResult.account.email).")
            await refreshAccount()
            await refreshVenuePortal()
        } catch let apiError as BeerMapAPIError {
            if presentBillingRecovery(apiError) { return }
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
        clearPendingProviderSignIn()
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
                try storeAuthenticatedSession(
                    result,
                    refreshToken: outcome.refreshToken,
                    accessToken: outcome.accessToken
                )
                finishSignIn(defaultNotice: "Account created. Welcome to Pint Path.")
                await refreshAccount()
            } else {
                notice = "Check your email to verify the account, then return here to sign in."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func completeOAuthSignIn(
        accessToken: String,
        refreshToken: String?
    ) async {
        await completeOAuthSignIn(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: Date().addingTimeInterval(Self.providerSignInRetryWindow)
        )
    }

    private func completeOAuthSignIn(
        accessToken: String,
        refreshToken: String?,
        expiresAt: Date
    ) async {
        pendingProviderSignIn = PendingProviderSignIn(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: expiresAt
        )
        providerSignInRetryAvailable = true
        setLoading(true)
        defer { setLoading(false) }
        clearBillingRecoveryState()
        clearLegalAcceptanceState()
        do {
            guard let config else { throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.") }
            let result = try await api.syncSupabase(
                accessToken: accessToken,
                config: config,
                ageConfirmed: nil,
                termsAccepted: nil,
                privacyAccepted: nil
            )
            try storeAuthenticatedSession(
                result,
                refreshToken: refreshToken,
                accessToken: accessToken
            )
            clearPendingProviderSignIn()
            finishSignIn(defaultNotice: "Signed in as \(result.account.email).")
            await refreshAccount()
            await refreshVenuePortal()
        } catch let apiError as BeerMapAPIError {
            if presentBillingRecovery(apiError, providerAccessToken: accessToken) { return }
            if presentLegalAcceptance(
                apiError,
                providerAccessToken: accessToken,
                providerRefreshToken: refreshToken
            ) { return }
            errorMessage = "\(apiError.localizedDescription) Your verified provider sign-in is still available; choose Retry finishing sign-in."
        } catch {
            errorMessage = "Pint Path could not finish signing in. Your verified provider sign-in is still available; choose Retry finishing sign-in."
        }
    }

    func retryPendingProviderSignIn() async {
        guard let pendingProviderSignIn else {
            clearPendingProviderSignIn()
            errorMessage = "That sign-in can no longer be retried. Start Apple or Google sign-in again."
            return
        }
        guard pendingProviderSignIn.expiresAt > Date() else {
            clearPendingProviderSignIn()
            errorMessage = "That verified sign-in expired. Start Apple or Google sign-in again."
            return
        }
        await completeOAuthSignIn(
            accessToken: pendingProviderSignIn.accessToken,
            refreshToken: pendingProviderSignIn.refreshToken,
            expiresAt: pendingProviderSignIn.expiresAt
        )
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
            try storeAuthenticatedSession(
                result,
                refreshToken: refreshToken,
                accessToken: pendingLegalAcceptance.accessToken
            )
            finishSignIn(defaultNotice: "Current Terms and Privacy Policy accepted. Signed in as \(result.account.email).")
            await refreshAccount()
            await refreshVenuePortal()
        } catch let apiError as BeerMapAPIError {
            if presentBillingRecovery(
                apiError,
                providerAccessToken: pendingLegalAcceptance.accessToken
            ) { return }
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

    func openBillingRecovery(email: String, password: String, venueId: String?) async -> URL? {
        guard billingRecoveryGuidance != nil else { return nil }
        setLoading(true)
        defer { setLoading(false) }
        let providerAccessToken = billingRecoveryAccessToken
        let selectedVenueId = venueId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
        do {
            let result: BillingRecoveryResult
            if let accessToken = providerAccessToken {
                result = try await api.billingRecoveryPortal(
                    accessToken: accessToken,
                    venueId: selectedVenueId
                )
            } else {
                let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalizedEmail.isEmpty, !password.isEmpty else {
                    throw BeerMapAPIError.configuration(
                        "Enter the suspended account email and password, then choose Manage billing only."
                    )
                }
                result = try await api.billingRecoveryPortal(
                    email: normalizedEmail,
                    password: password,
                    venueId: selectedVenueId
                )
            }
            guard
                let url = URL(string: result.portalUrl),
                url.scheme?.lowercased() == "https",
                url.host != nil
            else {
                throw BeerMapAPIError.server("The billing provider did not return a secure portal link.")
            }
            notice = result.message ?? "Billing portal opened without restoring application access."
            errorMessage = nil
            clearBillingRecoveryState()
            return url
        } catch let apiError as BeerMapAPIError {
            if presentBillingRecovery(apiError, providerAccessToken: providerAccessToken) { return nil }
            errorMessage = apiError.localizedDescription
            return nil
        } catch {
            errorMessage = error.localizedDescription
            return nil
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
        invalidateSessionRefresh()
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
            _ = try await withAuthenticatedSession { token in
                let reauthenticationToken = try self.currentReauthenticationToken()
                _ = try await self.api.logoutAll(
                    accessToken: reauthenticationToken,
                    token: token
                )
            }
            clearLocalSession()
            notice = "Signed out on every device."
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
            accountSessions = try await withAuthenticatedSession { token in
                try await self.api.accountSessions(
                    token: token,
                    reauthenticationToken: try self.currentReauthenticationToken()
                ).sessions
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
            _ = try await withAuthenticatedSession { token in
                try await self.api.requestAccountDeletion(
                    message: "Self-service deletion review requested from the iOS app.",
                    token: token,
                    reauthenticationToken: try self.currentReauthenticationToken()
                )
            }
            accountDeletionRequest = try await withAuthenticatedSession { token in
                try await self.api.accountDeletionStatus(token: token).request
            }
            notice = "Account deletion review requested. You can cancel while it remains pending."
            clearReauthenticationContext(ifMatching: "request account deletion")
        } catch {
            handleSensitiveActionError(error, action: "request account deletion")
        }
    }

    func cancelAccountDeletion() async {
        guard sessionToken != nil, let request = accountDeletionRequest else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.cancelAccountDeletion(
                    request.id,
                    token: token,
                    reauthenticationToken: try self.currentReauthenticationToken()
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
            let payload = try await withAuthenticatedSession { token in
                try await self.api.exportAccount(
                    token: token,
                    reauthenticationToken: try self.currentReauthenticationToken()
                )
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
            _ = try await withAuthenticatedSession { token in
                try await self.api.revokeAccountSession(
                    session.id,
                    token: token,
                    reauthenticationToken: try self.currentReauthenticationToken()
                )
            }
            if session.current == true {
                clearLocalSession()
            } else {
                accountSessions = try await withAuthenticatedSession { token in
                    try await self.api.accountSessions(
                        token: token,
                        reauthenticationToken: try self.currentReauthenticationToken()
                    ).sessions
                }
                accountSessionsLoaded = true
            }
            notice = session.current == true ? "This session was revoked. Sign in again to continue." : "Session revoked."
            clearReauthenticationContext(ifMatching: "revoke a signed-in session")
        } catch {
            handleSensitiveActionError(error, action: "revoke a signed-in session")
        }
    }

    func respondToCounterStaffInvitation(_ invitation: CounterStaffInvitation, decision: String) async {
        guard sessionToken != nil else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            let response = try await withAuthenticatedSession { token in
                try await self.api.respondToCounterStaffInvitation(
                    invitation.id,
                    decision: decision,
                    token: token
                )
            }
            accountDashboard = try await withAuthenticatedSession { token in
                try await self.api.account(token: token)
            }
            if decision == "accept" {
                await refreshVenuePortal(venueId: invitation.venueId)
            }
            notice = response.message ?? (decision == "accept" ? "Counter access accepted." : "Invitation declined.")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func generateDiscountPass() async {
        guard sessionToken != nil else {
            errorMessage = "Sign in before generating a Pint Path special code."
            return
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            discountPass = try await withAuthenticatedSession { token in
                try await self.api.discountPass(token: token)
            }
            notice = "Pint Path special code generated. Show it only when staff are ready."
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func generateFreePintReward() async {
        guard sessionToken != nil else {
            errorMessage = "Sign in before creating a Free Pint Reward code."
            return
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            freePintReward = try await withAuthenticatedSession { token in
                try await self.api.freePintRewardCode(token: token)
            }
            notice = "Free Pint Reward code created. Venue staff still complete age, ID, and RSA checks."
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadPrices(for venue: Venue) async {
        setLoading(true)
        defer { setLoading(false) }
        do {
            let response = try await withOptionalAuthenticatedSession { token in
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
            if venueId != nil, venueId != venuePortal?.selectedVenue?.venueId {
                venueReportExportURLs = [:]
            }
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

    func saveHappyHour(_ happyHour: BarHappyHour) async {
        guard sessionToken != nil, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.saveHappyHour(happyHour, venueId: venueId, token: token)
            }
            notice = "Happy hour saved."
            await refreshVenuePortal(venueId: venueId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveSpecial(_ special: BarSpecial) async {
        guard sessionToken != nil, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.saveSpecial(special, venueId: venueId, token: token)
            }
            notice = "Pint Path special saved."
            await refreshVenuePortal(venueId: venueId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func prepareVenueReportExport(month: String, format: String) async {
        guard
            sessionToken != nil,
            let venueId = venuePortal?.selectedVenue?.venueId
        else {
            errorMessage = "Choose an assigned venue before exporting a report."
            return
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            let normalizedFormat = format == "csv" ? "csv" : "json"
            let data = try await withAuthenticatedSession { token in
                try await self.api.exportVenueMonthlyReport(
                    venueId: venueId,
                    month: month,
                    format: normalizedFormat,
                    token: token
                )
            }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("pint-path-\(month)-monthly-report.\(normalizedFormat)")
            try data.write(to: url, options: .atomic)
            venueReportExportURLs[normalizedFormat] = url
            notice = "Monthly report ready to share or save."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    func previewCounterMember(code: String, transactionReference: String) async -> Bool {
        guard sessionToken != nil, let venueId = venuePortal?.selectedVenue?.venueId else { return false }
        setLoading(true)
        defer { setLoading(false) }
        do {
            counterMemberPreview = try await withAuthenticatedSession { token in
                try await self.api.previewCounterMember(
                    venueId: venueId,
                    code: code.uppercased(),
                    transactionReference: transactionReference,
                    token: token
                )
            }
            counterPurchaseResult = nil
            notice = "Member code checked. Confirm the purchase details before recording."
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func recordCounterPurchase(itemName: String, category: String, quantity: Int, transactionReference: String, notes: String) async -> Bool {
        guard
            sessionToken != nil,
            let venueId = venuePortal?.selectedVenue?.venueId,
            let preview = counterMemberPreview
        else {
            errorMessage = "Check the member code first."
            return false
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            let request = CounterPurchaseRequest(
                checkoutToken: preview.checkoutToken,
                itemName: itemName.nilIfBlank,
                beverageCategory: category,
                quantity: quantity,
                transactionReference: transactionReference,
                notes: notes.nilIfBlank
            )
            counterPurchaseResult = try await withAuthenticatedSession { token in
                try await self.api.recordCounterPurchase(
                    venueId: venueId,
                    request: request,
                    token: token
                )
            }
            counterMemberPreview = nil
            notice = counterPurchaseResult?.copy ?? "Purchase recorded."
            await refreshVenuePortal(venueId: venueId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func voidCounterPurchase(reason: String) async -> Bool {
        guard
            sessionToken != nil,
            let venueId = venuePortal?.selectedVenue?.venueId,
            let recordId = counterPurchaseResult?.record?.id
        else {
            errorMessage = "No recent purchase is available to reverse."
            return false
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await withAuthenticatedSession { token in
                try await self.api.voidCounterPurchase(venueId: venueId, recordId: recordId, reason: reason, token: token)
            }
            counterPurchaseResult = nil
            notice = "Purchase reversed with an audit record."
            await refreshVenuePortal(venueId: venueId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func decideFreePintReward(code: String, action: String, reason: String?) async {
        guard sessionToken != nil, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            counterRewardResult = try await withAuthenticatedSession { token in
                try await self.api.decideFreePintReward(
                    venueId: venueId,
                    code: code.uppercased(),
                    action: action,
                    reason: reason,
                    token: token
                )
            }
            notice = counterRewardResult?.copy ?? "Reward decision recorded."
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
                        isHappyHourPrice: false,
                        happyHourDetails: nil,
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

    func submitHappyHourUpdate(
        clientSubmissionId: String,
        missionId: String? = nil,
        venueId: String,
        days: [String],
        startTime: String,
        endTime: String,
        offerText: String,
        notes: String,
        uploadLocation: UploadLocationRequest? = nil
    ) async -> Bool {
        guard sessionToken != nil else {
            errorMessage = "Sign in before submitting happy-hour updates."
            return false
        }
        guard let venue = venues.first(where: { $0.id == venueId }) else {
            errorMessage = "Choose a venue before submitting."
            return false
        }
        let trimmedOffer = offerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !days.isEmpty, !trimmedOffer.isEmpty else {
            errorMessage = "Add the days and offer details before submitting."
            return false
        }

        setLoading(true)
        defer { setLoading(false) }
        do {
            let detail = "\(days.map { $0.uppercased() }.joined(separator: ", ")) \(startTime)-\(endTime): \(trimmedOffer)"
            let submission = CreateSubmissionRequest(
                clientSubmissionId: clientSubmissionId,
                missionId: missionId,
                venueId: venue.id,
                venueName: venue.name,
                suburb: venue.suburb,
                newVenue: nil,
                submissionType: "happy_hour_update",
                observedAt: isoNow(),
                sourcePhotoDataUrl: nil,
                sourcePhotoDataUrls: [],
                sourceDocumentDataUrl: nil,
                sourcePhotoUrl: nil,
                uploadLocation: uploadLocation,
                notes: notes.nilIfBlank,
                items: [
                    SubmissionItemRequest(
                        beerName: "Happy-hour offer",
                        servingSize: "other",
                        price: nil,
                        isHappyHourPrice: true,
                        happyHourDetails: detail,
                        isOnTap: "unknown"
                    )
                ]
            )
            let result = try await withAuthenticatedSession { token in
                try await self.api.createSubmission(submission, token: token)
            }
            markAccountDashboardDirty()
            notice = result.statusCopy ?? "Happy-hour update sent for review."
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

    private func storeAuthenticatedSession(
        _ result: AuthResult,
        refreshToken: String?,
        accessToken: String?,
        resetAuthority: Bool = true
    ) throws {
        // A newly authenticated identity supersedes every in-flight refresh for the
        // previous session. The generation check prevents a late network response
        // from restoring credentials after logout or overwriting this new account.
        invalidateSessionRefresh()
        guard
            KeychainSessionStore.saveSupabaseRefreshToken(refreshToken),
            KeychainSessionStore.saveSupabaseAccessToken(accessToken)
        else {
            clearLocalSession()
            throw BeerMapAPIError.configuration(
                "Pint Path could not securely save this sign-in. Unlock the device and try again."
            )
        }
        do {
            try storeSession(result, resetAuthority: resetAuthority)
        } catch {
            clearLocalSession()
            throw error
        }
    }

    private func storeSession(_ result: AuthResult, resetAuthority: Bool = true) throws {
        clearBillingRecoveryState()
        clearLegalAcceptanceState()
        guard KeychainSessionStore.saveToken(result.token) else {
            throw BeerMapAPIError.configuration(
                "Pint Path could not securely save this session. Unlock the device and try again."
            )
        }
        sessionToken = result.token
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
            leaderboard: nil,
            discounts: nil,
            pintPoints: nil,
            counterStaffInvitations: nil
        )
        accountDashboardNeedsRefresh = true
    }

    private func refreshExpiredSession() async -> SessionRefreshOutcome {
        if let sessionRefreshTask {
            return await sessionRefreshTask.value
        }
        guard let currentToken = sessionToken else {
            return .invalidCredentials
        }
        let refreshGeneration = authenticationGeneration
        let task = Task { @MainActor [weak self] in
            guard let self else { return SessionRefreshOutcome.retryableFailure }
            return await self.performSessionRefresh(
                expectedGeneration: refreshGeneration,
                expectedSessionToken: currentToken
            )
        }
        sessionRefreshTask = task
        let outcome = await task.value
        if authenticationGeneration == refreshGeneration {
            sessionRefreshTask = nil
        }
        return outcome
    }

    private func performSessionRefresh(
        expectedGeneration: UInt64,
        expectedSessionToken currentToken: String
    ) async -> SessionRefreshOutcome {
        guard authenticationIsCurrent(
            generation: expectedGeneration,
            sessionToken: currentToken
        ) else {
            return .retryableFailure
        }
        guard let refreshToken = KeychainSessionStore.loadSupabaseRefreshToken() else {
            if authenticationIsCurrent(
                generation: expectedGeneration,
                sessionToken: currentToken
            ) {
                clearLocalSession()
            }
            return .invalidCredentials
        }
        do {
            let activeConfig: PublicConfig
            if let config {
                activeConfig = config
            } else {
                activeConfig = try await api.getConfig()
                guard authenticationIsCurrent(
                    generation: expectedGeneration,
                    sessionToken: currentToken
                ) else {
                    return .retryableFailure
                }
                config = activeConfig
            }
            let providerTokens = try await api.refreshSupabaseTokens(
                refreshToken: refreshToken,
                config: activeConfig
            )
            guard authenticationIsCurrent(
                generation: expectedGeneration,
                sessionToken: currentToken
            ) else {
                return .retryableFailure
            }
            guard let providerAccessToken = providerTokens.accessToken else {
                return .retryableFailure
            }
            // Supabase refresh tokens can rotate. Save the verified provider session
            // before the separate Pint Path sync so a brief backend outage cannot
            // strand the user with an already-consumed refresh token.
            guard
                KeychainSessionStore.saveSupabaseRefreshToken(providerTokens.refreshToken ?? refreshToken),
                KeychainSessionStore.saveSupabaseAccessToken(providerAccessToken)
            else {
                return .retryableFailure
            }
            let result = try await api.syncSupabase(
                accessToken: providerAccessToken,
                config: activeConfig,
                ageConfirmed: nil,
                termsAccepted: nil,
                privacyAccepted: nil,
                existingAppToken: currentToken
            )
            guard authenticationIsCurrent(
                generation: expectedGeneration,
                sessionToken: currentToken
            ) else {
                return .retryableFailure
            }
            try storeSession(result, resetAuthority: false)
            do {
                let refreshedDashboard = try await api.account(token: result.token)
                guard authenticationIsCurrent(
                    generation: expectedGeneration,
                    sessionToken: result.token
                ) else {
                    return .retryableFailure
                }
                accountDashboard = refreshedDashboard
                accountDashboardNeedsRefresh = false
            } catch {
                // Token renewal succeeded. Dashboard hydration is ancillary and can
                // be retried without destroying the valid session.
                if authenticationIsCurrent(
                    generation: expectedGeneration,
                    sessionToken: result.token
                ) {
                    accountDashboardNeedsRefresh = true
                }
            }
            guard authenticationIsCurrent(
                generation: expectedGeneration,
                sessionToken: result.token
            ) else {
                return .retryableFailure
            }
            if accountDashboard?.access?.isAdmin != true, venuePortal?.isAdmin == true {
                venuePortal = nil
            }
            let deletionRequest = (try? await api.accountDeletionStatus(token: result.token).request) ?? nil
            guard authenticationIsCurrent(
                generation: expectedGeneration,
                sessionToken: result.token
            ) else {
                return .retryableFailure
            }
            accountDeletionRequest = deletionRequest
            if let settings = accountDashboard?.privacySettings {
                optionalAnalyticsEnabled = settings.optionalAnalyticsEnabled ?? false
                UserDefaults.standard.set(optionalAnalyticsEnabled, forKey: "au.pintpath.app.optionalAnalytics")
            }
            return .refreshed
        } catch let apiError as BeerMapAPIError where apiError.isConclusiveAuthenticationRejection {
            if authenticationIsCurrent(
                generation: expectedGeneration,
                sessionToken: currentToken
            ) {
                clearLocalSession()
            }
            return .invalidCredentials
        } catch {
            return .retryableFailure
        }
    }

    private func clearLocalSession() {
        invalidateSessionRefresh()
        KeychainSessionStore.deleteToken()
        sessionToken = nil
        clearBillingRecoveryState()
        clearLegalAcceptanceState()
        clearPendingProviderSignIn()
        resetOptionalAnalytics()
        accountDashboard = nil
        accountDashboardNeedsRefresh = false
        venuePortal = nil
        discountPass = nil
        freePintReward = nil
        accountSessions = []
        accountSessionsLoaded = false
        accountDeletionRequest = nil
        accountExportURL = nil
        venueReportExportURLs = [:]
        counterMemberPreview = nil
        counterPurchaseResult = nil
        counterRewardResult = nil
        selectedVenuePrices = [:]
        reauthenticationContext = nil
    }

    private func invalidateSessionRefresh() {
        authenticationGeneration &+= 1
        sessionRefreshTask?.cancel()
        sessionRefreshTask = nil
    }

    private func authenticationIsCurrent(
        generation: UInt64,
        sessionToken expectedSessionToken: String
    ) -> Bool {
        !Task.isCancelled
            && authenticationGeneration == generation
            && sessionToken == expectedSessionToken
    }

    @discardableResult
    private func presentBillingRecovery(
        _ error: BeerMapAPIError,
        providerAccessToken: String? = nil
    ) -> Bool {
        guard case .billingRecoveryAvailable(
            let message,
            let embeddedAccessToken,
            let consumer,
            let venues
        ) = error else {
            return false
        }
        // A suspended identity may open Stripe, but it must never receive or retain
        // a Pint Path application session while account access remains suspended.
        clearLocalSession()
        billingRecoveryAccessToken = providerAccessToken ?? embeddedAccessToken
        billingRecoveryUsesProvider = billingRecoveryAccessToken != nil
        billingRecoveryConsumer = consumer
        billingRecoveryVenues = venues
        billingRecoveryGuidance = message
        errorMessage = message
        notice = nil
        return true
    }

    private func clearBillingRecoveryState() {
        billingRecoveryAccessToken = nil
        billingRecoveryGuidance = nil
        billingRecoveryUsesProvider = false
        billingRecoveryConsumer = false
        billingRecoveryVenues = []
    }

    @discardableResult
    private func presentLegalAcceptance(
        _ error: BeerMapAPIError,
        providerAccessToken: String? = nil,
        providerRefreshToken: String? = nil
    ) -> Bool {
        guard case .legalAcceptanceRequired(
            let message,
            let embeddedAccessToken,
            let embeddedRefreshToken
        ) = error,
        let accessToken = providerAccessToken ?? embeddedAccessToken else {
            return false
        }
        // The provider identity has been verified, but no Pint Path authority is
        // retained until this exact credential accepts the currently configured policy.
        clearLocalSession()
        pendingLegalAcceptance = (
            accessToken: accessToken,
            refreshToken: providerRefreshToken ?? embeddedRefreshToken
        )
        legalAcceptanceRequired = true
        legalAcceptanceVersion = config?.legalPolicyVersion
        errorMessage = message
        notice = nil
        return true
    }

    private func clearLegalAcceptanceState() {
        pendingLegalAcceptance = nil
        legalAcceptanceRequired = false
        legalAcceptanceVersion = nil
    }

    private func clearPendingProviderSignIn() {
        pendingProviderSignIn = nil
        providerSignInRetryAvailable = false
    }

    private func currentReauthenticationToken() throws -> String {
        guard let token = KeychainSessionStore.loadSupabaseAccessToken(), !token.isEmpty else {
            throw BeerMapAPIError.reauthenticationRequired
        }
        return token
    }

    private func handleSensitiveActionError(_ error: Error, action: String) {
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
        let operationGeneration = authenticationGeneration
        do {
            return try await operation(currentToken)
        } catch let apiError as BeerMapAPIError where apiError.isUnauthorized {
            guard authenticationGeneration == operationGeneration else {
                throw BeerMapAPIError.configuration("Your signed-in account changed. Retry this action.")
            }
            if sessionToken != currentToken, let newerToken = sessionToken {
                return try await operation(newerToken)
            }
            let refreshOutcome = await refreshExpiredSession()
            guard authenticationGeneration == operationGeneration else {
                throw BeerMapAPIError.configuration("Your signed-in account changed. Retry this action.")
            }
            if sessionToken != currentToken, let newerToken = sessionToken {
                return try await operation(newerToken)
            }
            switch refreshOutcome {
            case .refreshed:
                guard let refreshedToken = sessionToken else {
                    throw BeerMapAPIError.configuration("Your session expired. Sign in again to continue.")
                }
                return try await operation(refreshedToken)
            case .invalidCredentials:
                throw BeerMapAPIError.configuration("Your session expired. Sign in again to continue.")
            case .retryableFailure:
                throw BeerMapAPIError.configuration("Pint Path could not refresh your session right now. Check your connection and retry.")
            }
        }
    }

    private func withOptionalAuthenticatedSession<T: Sendable>(
        _ operation: (String?) async throws -> T
    ) async throws -> T {
        let currentToken = sessionToken
        let operationGeneration = authenticationGeneration
        do {
            return try await operation(currentToken)
        } catch let apiError as BeerMapAPIError where apiError.isUnauthorized && currentToken != nil {
            guard authenticationGeneration == operationGeneration else {
                throw BeerMapAPIError.configuration("Your signed-in account changed. Retry this action.")
            }
            if sessionToken != currentToken, let newerToken = sessionToken {
                return try await operation(newerToken)
            }
            let refreshOutcome = await refreshExpiredSession()
            guard authenticationGeneration == operationGeneration else {
                throw BeerMapAPIError.configuration("Your signed-in account changed. Retry this action.")
            }
            if sessionToken != currentToken, let newerToken = sessionToken {
                return try await operation(newerToken)
            }
            switch refreshOutcome {
            case .refreshed:
                guard let refreshedToken = sessionToken else {
                    throw BeerMapAPIError.configuration("Your session expired. Sign in again to continue.")
                }
                return try await operation(refreshedToken)
            case .invalidCredentials:
                throw BeerMapAPIError.configuration("Your session expired. Sign in again to continue.")
            case .retryableFailure:
                throw BeerMapAPIError.configuration("Pint Path could not refresh your session right now. Check your connection and retry.")
            }
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
