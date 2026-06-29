import Foundation

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

struct APIEnvelope<T: Decodable>: Decodable {
    let ok: Bool?
    let data: T?
    let error: APIErrorPayload?
}

struct APIErrorPayload: Decodable {
    let message: String?
}

struct EmptyResponse: Codable {}

struct PublicConfig: Codable {
    let pricing: JSONValue?
    let freePriceRevealsPerDay: Int?
    let contributorUnlockPoints: Int?
    let contributorUnlockDays: Int?
    let stripePublishableKey: String?
    let supabaseUrl: String?
    let supabaseAnonKey: String?
    let supabaseOauthProviders: [String]?
    let demoBillingMode: Bool?
    let fieldTestMode: Bool?
    let trackedBeers: [TrackedBeer]?
}

struct TrackedBeer: Codable, Identifiable, Hashable {
    let id: String
    let name: String
}

struct AuthResult: Codable {
    let token: String
    let account: Account
}

struct SignupRequest: Codable {
    let email: String
    let password: String
    let displayName: String?
    let ageConfirmed: Bool
    let termsAccepted: Bool
    let privacyAccepted: Bool
}

struct LoginRequest: Codable {
    let email: String
    let password: String
}

struct SupabaseSessionRequest: Codable {
    let accessToken: String
}

struct AccountDashboard: Codable {
    let account: Account
    let stats: AccountStats?
    let savedItems: [SavedItem]?
    let submissions: [SubmissionSummary]?
    let privacySettings: PrivacySettings?
    let access: AccessState?
    let leaderboard: LeaderboardContext?
}

struct Account: Codable, Identifiable, Hashable {
    let id: String
    let email: String
    let displayName: String?
    let role: String?
    let status: String?
    let subscriptionStatus: String?
    let authProvider: String?
    let publicAccountId: String?
    let contributionPointsCurrentMonth: Double?
    let contributionPointsAllTime: Double?
    let trustScore: Double?
    let ageConfirmedAt: String?
    let emailVerifiedAt: String?
}

struct AccountStats: Codable, Hashable {
    let totalSubmissions: Int?
    let approvedSubmissions: Int?
    let pendingSubmissions: Int?
    let totalSavingsCents: Int?
    let trustScore: Double?
}

struct SavedItem: Codable, Identifiable, Hashable {
    let id: String?
    let itemType: String
    let itemId: String
    let label: String
    let suburb: String?

    var stableId: String { id ?? "\(itemType)-\(itemId)" }
}

struct SubmissionSummary: Codable, Identifiable, Hashable {
    let id: String
    let venueName: String?
    let suburb: String?
    let status: String?
    let submissionType: String?
    let createdAt: String?
}

struct PrivacySettings: Codable, Hashable {
    var optionalAnalyticsEnabled: Bool?
    var venueReportInclusionEnabled: Bool?
    var productResearchEnabled: Bool?
    var emailUpdatesEnabled: Bool?
}

struct AccessState: Codable, Hashable {
    let tier: String?
    let subscriptionStatus: String?
    let hasFullAccess: Bool?
    let contributorAccessActive: Bool?
    let freePriceRevealsRemaining: Int?
    let freePriceRevealsPerDay: Int?
}

struct LeaderboardContext: Codable, Hashable {
    let accountId: String?
    let rank: Int?
}

struct VenueListResponse: Codable {
    let venues: [Venue]
}

struct Venue: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let address: String?
    let suburb: String?
    let state: String?
    let postcode: String?
    let latitude: Double?
    let longitude: Double?
    let membershipTier: String?
    let highlightedName: String?
    let premiumBadge: String?
    let promoted: Bool?
    let featuredSpecialEligible: Bool?

    var displayLocation: String {
        [suburb, state].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

struct PriceRecordsResponse: Codable {
    let records: [PriceRecord]
    let access: AccessState?
    let revealed: Bool?
    let blocked: Bool?
}

struct PriceRecord: Codable, Identifiable, Hashable {
    let id: String
    let venueId: String?
    let venueName: String?
    let suburb: String?
    let beerName: String?
    let normalizedBeerId: String?
    let servingSize: String?
    let price: Double?
    let priceCents: Int?
    let priceRedacted: Bool?
    let freePreviewIncluded: Bool?
    let isHappyHourPrice: Bool?
    let happyHour: String?
    let lastVerifiedAt: String?

    var formattedPrice: String {
        if priceRedacted == true {
            return "Premium"
        }
        if let price {
            return "$\(String(format: "%.2f", price))"
        }
        if let priceCents {
            return "$\(String(format: "%.2f", Double(priceCents) / 100.0))"
        }
        return "Check venue"
    }
}

struct MissionListResponse: Codable {
    let missions: [Mission]
}

struct Mission: Codable, Identifiable, Hashable {
    let id: String
    let venueId: String?
    let venueName: String
    let suburb: String?
    let reason: String?
    let priority: String?
    let points: Double?
    let multiplier: Double?
}

struct EventRequest: Codable {
    let anonymousSessionId: String?
    let eventType: String
    let venueId: String?
    let beerId: String?
    let suburb: String?
    let metadata: [String: JSONValue]
}

struct SaveItemRequest: Codable {
    let itemType: String
    let itemId: String
    let label: String
    let suburb: String?
    let metadata: [String: JSONValue]
}

struct FeedbackRequest: Codable {
    let anonymousSessionId: String?
    let feedbackType: String
    let message: String
    let venueId: String?
    let venueName: String?
}

struct VenuePortalData: Codable {
    let accessState: String?
    let assignments: [VenueAssignment]?
    let selectedVenue: SelectedVenue?
    var profile: BarProfile?
    let tier: TierCapabilities?
    let inventory: VenueInventory?
    let pendingChanges: [PendingChange]?
    let insights: JSONValue?
    let analytics: VenueAnalytics?
    let monthlyReport: JSONValue?
    let businessToolkit: JSONValue?
    let demandDashboard: JSONValue?
    let updateLink: String?
    let message: String?
    let privacyCopy: String?
}

struct VenueAssignment: Codable, Identifiable, Hashable {
    let id: String?
    let venueId: String
    let venueName: String
    let suburb: String?

    var stableId: String { id ?? venueId }
}

struct SelectedVenue: Codable, Hashable {
    let venueId: String
    let venueName: String
    let suburb: String?
}

struct BarProfile: Codable, Hashable {
    var name: String
    var address: String?
    var suburb: String?
    var area: String?
    var phone: String?
    var website: String?
    var instagram: String?
    var description: String?
    var openingHours: [String: JSONValue]?
    var venueTags: [String]?
    var membershipTier: String?
    var active: Bool?
}

struct TierCapabilities: Codable, Hashable {
    let tierLabel: String?
    let canManageSpecials: Bool?
    let analytics: Bool?
    let monthlyReports: Bool?
    let featuredSpecials: Bool?
    let discoveryBoost: Bool?
    let analyticsLocked: Bool?
    let upgradeCopy: String?
}

struct VenueInventory: Codable, Hashable {
    let beers: [BarBeer]?
    let happyHours: [BarHappyHour]?
    let specials: [BarSpecial]?
}

struct BarBeer: Codable, Identifiable, Hashable {
    var id: String?
    var beerName: String
    var brewery: String?
    var style: String?
    var abv: Double?
    var serveSize: String?
    var price: Double?
    var onTap: Bool
    var inStock: Bool
    var notes: String?

    var stableId: String { id ?? beerName }
}

struct BarHappyHour: Codable, Identifiable, Hashable {
    var id: String?
    var title: String
    var daysOfWeek: [String]
    var startTime: String
    var endTime: String
    var description: String
    var active: Bool

    var stableId: String { id ?? "\(title)-\(startTime)" }
}

struct BarSpecial: Codable, Identifiable, Hashable {
    var id: String?
    var title: String
    var description: String
    var price: Double?
    var discount: String?
    var startsAt: String?
    var endsAt: String?
    var startTime: String
    var endTime: String
    var scheduleNote: String?
    var exclusive: Bool
    var active: Bool

    var stableId: String { id ?? "\(title)-\(startTime)" }
}

struct PendingChange: Codable, Identifiable, Hashable {
    let id: String
    let section: String?
    let status: String?
    let createdAt: String?
    let summary: String?
}

struct VenueAnalytics: Codable, Hashable {
    let barLookups: Int?
    let profileViews: Int?
    let beerListViews: Int?
    let specialsViews: Int?
    let priceReveals: Int?
    let directionsClicks: Int?
    let privacyFloorMet: Bool?
    let privacyThreshold: Int?
}

struct AccountDeletionRequest: Codable {
    let message: String?
}

struct PrivacySettingsRequest: Codable {
    let optionalAnalyticsEnabled: Bool
    let venueReportInclusionEnabled: Bool
    let productResearchEnabled: Bool
    let emailUpdatesEnabled: Bool
}

extension Optional where Wrapped == String {
    var nilIfBlank: String? {
        guard let trimmed = self?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
