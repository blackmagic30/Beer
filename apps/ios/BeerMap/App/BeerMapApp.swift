import SwiftUI

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
    @Published var config: PublicConfig?
    @Published var accountDashboard: AccountDashboard?
    @Published var venues: [Venue] = []
    @Published var missions: [Mission] = []
    @Published var selectedVenuePrices: [String: PriceRecordsResponse] = [:]
    @Published var venuePortal: VenuePortalData?
    @Published var isLoading = false
    @Published var notice: String?
    @Published var errorMessage: String?
    @Published var optionalAnalyticsEnabled = true

    let api: BeerMapAPI
    let anonymousSessionId: String
    private(set) var sessionToken: String?

    var isSignedIn: Bool { sessionToken != nil }
    var account: Account? { accountDashboard?.account }
    var isVenueManager: Bool { account?.role == "venue_manager" || account?.role == "admin" || account?.subscriptionStatus == "admin" }

    init(api: BeerMapAPI = BeerMapAPI()) {
        self.api = api
        self.sessionToken = KeychainSessionStore.loadToken()
        let key = "au.pintpath.beermap.anonymousSessionId"
        if let existing = UserDefaults.standard.string(forKey: key) {
            self.anonymousSessionId = existing
        } else {
            let generated = UUID().uuidString
            UserDefaults.standard.set(generated, forKey: key)
            self.anonymousSessionId = generated
        }
    }

    func start() async {
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
            async let venueTask = api.listVenues(query: search)
            async let missionTask = api.missions()
            config = try await configTask
            venues = try await venueTask
            missions = try await missionTask
            errorMessage = nil
            await track("map_viewed", metadata: ["source": .string("ios_app"), "privacyScope": .string("optional_analytics")])
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func login(email: String, password: String) async {
        setLoading(true)
        defer { setLoading(false) }
        do {
            let result = try await api.login(email: email, password: password)
            storeSession(result)
            notice = "Signed in as \(result.account.email)."
            await refreshAccount()
            await refreshVenuePortal()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signup(email: String, password: String, displayName: String?) async {
        setLoading(true)
        defer { setLoading(false) }
        do {
            let result = try await api.signup(email: email, password: password, displayName: displayName)
            storeSession(result)
            notice = "Account created. Welcome to BeerMap."
            await track("signup_completed", metadata: ["source": .string("ios_app")])
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() async {
        guard let token = sessionToken else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await api.logout(token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
        KeychainSessionStore.deleteToken()
        sessionToken = nil
        accountDashboard = nil
        venuePortal = nil
        notice = "Signed out."
    }

    func refreshAccount() async {
        guard let token = sessionToken else { return }
        do {
            accountDashboard = try await api.account(token: token)
            if let settings = accountDashboard?.privacySettings {
                optionalAnalyticsEnabled = settings.optionalAnalyticsEnabled ?? true
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func savePrivacy(settings: PrivacySettingsRequest) async {
        guard let token = sessionToken else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            accountDashboard = try await api.updatePrivacy(settings, token: token)
            optionalAnalyticsEnabled = settings.optionalAnalyticsEnabled
            notice = "Privacy preferences saved."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func requestAccountDeletion() async {
        guard let token = sessionToken else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await api.requestAccountDeletion(message: "Self-service deletion review requested from the iOS app.", token: token)
            notice = "Account deletion review requested."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func revealPrices(for venue: Venue) async {
        setLoading(true)
        defer { setLoading(false) }
        do {
            let response = try await api.priceRecords(
                venueId: venue.id,
                anonymousSessionId: anonymousSessionId,
                reveal: true,
                token: sessionToken
            )
            selectedVenuePrices[venue.id] = response
            await track("venue_detail_opened", venueId: venue.id, suburb: venue.suburb, metadata: ["source": .string("ios_app")])
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveVenue(_ venue: Venue) async {
        guard let token = sessionToken else {
            errorMessage = "Sign in to save venues to your account."
            return
        }
        do {
            _ = try await api.saveItem(
                SaveItemRequest(
                    itemType: "venue",
                    itemId: venue.id,
                    label: venue.name,
                    suburb: venue.suburb,
                    metadata: ["source": .string("ios_app")]
                ),
                token: token
            )
            notice = "Saved \(venue.name)."
            await track("saved_venue_added", venueId: venue.id, suburb: venue.suburb, metadata: ["source": .string("ios_app")])
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refreshVenuePortal(venueId: String? = nil) async {
        guard let token = sessionToken else { return }
        do {
            venuePortal = try await api.venuePortal(venueId: venueId, token: token)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveProfile(_ profile: BarProfile) async {
        guard let token = sessionToken, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            venuePortal = try await api.saveProfile(profile, venueId: venueId, token: token)
            notice = "Venue profile saved."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveBeer(_ beer: BarBeer) async {
        guard let token = sessionToken, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await api.saveBeer(beer, venueId: venueId, token: token)
            notice = "Beer row saved."
            await refreshVenuePortal(venueId: venueId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveHappyHour(_ happyHour: BarHappyHour) async {
        guard let token = sessionToken, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await api.saveHappyHour(happyHour, venueId: venueId, token: token)
            notice = "Happy hour saved."
            await refreshVenuePortal(venueId: venueId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func saveSpecial(_ special: BarSpecial) async {
        guard let token = sessionToken, let venueId = venuePortal?.selectedVenue?.venueId else { return }
        setLoading(true)
        defer { setLoading(false) }
        do {
            _ = try await api.saveSpecial(special, venueId: venueId, token: token)
            notice = "Pint Path special saved."
            await refreshVenuePortal(venueId: venueId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func track(_ eventType: String, venueId: String? = nil, suburb: String? = nil, metadata: [String: JSONValue] = [:]) async {
        guard optionalAnalyticsEnabled else { return }
        await api.track(
            EventRequest(
                anonymousSessionId: anonymousSessionId,
                eventType: eventType,
                venueId: venueId,
                beerId: nil,
                suburb: suburb,
                metadata: metadata
            ),
            token: sessionToken
        )
    }

    func dismissMessages() {
        notice = nil
        errorMessage = nil
    }

    private func storeSession(_ result: AuthResult) {
        KeychainSessionStore.saveToken(result.token)
        sessionToken = result.token
        accountDashboard = AccountDashboard(
            account: result.account,
            stats: nil,
            savedItems: nil,
            submissions: nil,
            privacySettings: nil,
            access: nil,
            leaderboard: nil
        )
    }

    private func setLoading(_ value: Bool) {
        isLoading = value
    }
}

