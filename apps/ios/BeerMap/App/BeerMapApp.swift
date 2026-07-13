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
    @Published var discountPass: RotatingCodeResult?
    @Published var freePintReward: RotatingCodeResult?
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
        discountPass = nil
        freePintReward = nil
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

    func generateDiscountPass() async {
        guard let token = sessionToken else {
            errorMessage = "Sign in before generating a Pint Path special code."
            return
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            discountPass = try await api.discountPass(token: token)
            notice = "Pint Path special code generated. Show it only when staff are ready."
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func generateFreePintReward() async {
        guard let token = sessionToken else {
            errorMessage = "Sign in before creating a Free Pint Reward code."
            return
        }
        setLoading(true)
        defer { setLoading(false) }
        do {
            freePintReward = try await api.freePintRewardCode(token: token)
            notice = "Free Pint Reward code created. Venue staff still complete age, ID, and RSA checks."
            await refreshAccount()
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

    func submitPriceUpdate(venueId: String, beerName: String, servingSize: String, priceText: String, notes: String) async {
        guard let token = sessionToken else {
            errorMessage = "Sign in before submitting venue data."
            return
        }
        guard let venue = venues.first(where: { $0.id == venueId }) else {
            errorMessage = "Choose a venue before submitting."
            return
        }
        let trimmedBeer = beerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBeer.isEmpty else {
            errorMessage = "Add the beer name before submitting."
            return
        }
        let cleanedPrice = priceText
            .replacingOccurrences(of: "$", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let price = Double(cleanedPrice), price > 0 else {
            errorMessage = "Add a valid observed price."
            return
        }

        setLoading(true)
        defer { setLoading(false) }
        do {
            let submission = CreateSubmissionRequest(
                clientSubmissionId: "ios-\(UUID().uuidString)",
                missionId: nil,
                venueId: venue.id,
                venueName: venue.name,
                suburb: venue.suburb,
                newVenue: nil,
                submissionType: "single_beer_price",
                observedAt: isoNow(),
                sourcePhotoDataUrl: nil,
                sourcePhotoDataUrls: [],
                sourceDocumentDataUrl: nil,
                sourcePhotoUrl: nil,
                uploadLocation: nil,
                notes: notes.nilIfBlank,
                items: [
                    SubmissionItemRequest(
                        beerName: trimmedBeer,
                        servingSize: servingSize,
                        price: price,
                        isHappyHourPrice: false,
                        happyHourDetails: nil,
                        isOnTap: "unknown"
                    )
                ]
            )
            _ = try await api.createSubmission(submission, token: token)
            notice = "Price update sent for review."
            await track("submission_completed", venueId: venue.id, suburb: venue.suburb, metadata: ["source": .string("ios_app")])
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func submitSourcePhotoUpdate(venueId: String, sourcePhotoDataUrl: String, notes: String) async {
        guard let token = sessionToken else {
            errorMessage = "Sign in before uploading source evidence."
            return
        }
        guard let venue = venues.first(where: { $0.id == venueId }) else {
            errorMessage = "Choose a venue before uploading."
            return
        }

        setLoading(true)
        defer { setLoading(false) }
        do {
            let submission = CreateSubmissionRequest(
                clientSubmissionId: "ios-photo-\(UUID().uuidString)",
                missionId: nil,
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
                uploadLocation: nil,
                notes: notes.nilIfBlank,
                items: []
            )
            _ = try await api.createSubmission(submission, token: token)
            notice = "Source photo sent for review."
            await track("data_upload_created", venueId: venue.id, suburb: venue.suburb, metadata: ["source": .string("ios_app")])
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func submitHappyHourUpdate(
        venueId: String,
        days: [String],
        startTime: String,
        endTime: String,
        offerText: String,
        notes: String
    ) async {
        guard let token = sessionToken else {
            errorMessage = "Sign in before submitting happy-hour updates."
            return
        }
        guard let venue = venues.first(where: { $0.id == venueId }) else {
            errorMessage = "Choose a venue before submitting."
            return
        }
        let trimmedOffer = offerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !days.isEmpty, !trimmedOffer.isEmpty else {
            errorMessage = "Add the days and offer details before submitting."
            return
        }

        setLoading(true)
        defer { setLoading(false) }
        do {
            let detail = "\(days.map { $0.uppercased() }.joined(separator: ", ")) \(startTime)-\(endTime): \(trimmedOffer)"
            let submission = CreateSubmissionRequest(
                clientSubmissionId: "ios-happy-\(UUID().uuidString)",
                missionId: nil,
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
                uploadLocation: nil,
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
            _ = try await api.createSubmission(submission, token: token)
            notice = "Happy-hour update sent for review."
            await track("submission_completed", venueId: venue.id, suburb: venue.suburb, metadata: ["source": .string("ios_app"), "submissionType": .string("happy_hour_update")])
            await refreshAccount()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func reportWrongPrice(venueId: String, beerName: String, notes: String) async {
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
                priceRecordId: nil,
                beerName: beerName.nilIfBlank,
                reason: "other",
                notes: notes.nilIfBlank,
                sourcePhotoDataUrl: nil,
                sourcePhotoUrl: nil
            )
            _ = try await api.reportWrongPrice(report, token: sessionToken)
            notice = "Wrong-price report sent."
            await track("wrong_price_reported", venueId: venue.id, suburb: venue.suburb, metadata: ["source": .string("ios_app")])
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func requestMissing(requestType: String, venueName: String, beerName: String, suburb: String, notes: String) async {
        let trimmedVenue = venueName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBeer = beerName.trimmingCharacters(in: .whitespacesAndNewlines)
        if requestType == "missing_beer", trimmedBeer.isEmpty {
            errorMessage = "Add the beer name before sending the request."
            return
        }
        if requestType != "missing_beer", trimmedVenue.isEmpty {
            errorMessage = "Add the venue name before sending the request."
            return
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
            _ = try await api.createRequest(payload, token: sessionToken)
            notice = requestType == "missing_beer" ? "Beer request sent." : "Venue request sent."
            await track(requestType == "missing_beer" ? "beer_requested" : "venue_requested", suburb: suburb.nilIfBlank, metadata: ["source": .string("ios_app")])
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
            leaderboard: nil,
            discounts: nil,
            pintPoints: nil
        )
    }

    private func setLoading(_ value: Bool) {
        isLoading = value
    }

    private func isoNow() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}
