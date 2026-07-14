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
    let code: String?
    let recovery: APIErrorRecovery?
    let details: APIErrorDetails?
}

struct APIErrorRecovery: Decodable {
    let eligible: Bool?
    let endpoint: String?
    let consumer: Bool?
    let venues: [BillingRecoveryVenue]?
}

struct APIErrorDetails: Decodable {
    let reauthenticationRequired: Bool?
    let billingRecoveryEligible: Bool?
    let billingRecoveryEndpoint: String?
}

struct EmptyResponse: Codable {}

struct LogoutAllRequest: Codable {
    let accessToken: String?
}

struct PublicConfig: Codable {
    let pricing: JSONValue?
    let contributorUnlockPoints: Int?
    let contributorUnlockDays: Int?
    let supabaseUrl: String?
    let supabaseAnonKey: String?
    let supabaseOauthProviders: [String]?
    let demoBillingMode: Bool?
    let fieldTestMode: Bool?
    let trackedBeers: [TrackedBeer]?
    let legalPolicyVersion: String?
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

struct SupabaseSignupRequest: Codable {
    let email: String
    let password: String
    let data: [String: JSONValue]
}

struct LoginRequest: Codable {
    let email: String
    let password: String
}

struct BillingRecoveryProviderRequest: Codable {
    let accessToken: String
    let venueId: String?
}

struct BillingRecoveryPasswordRequest: Codable {
    let email: String
    let password: String
    let venueId: String?
}

struct BillingRecoveryVenue: Codable, Identifiable, Hashable {
    let venueId: String
    let venueName: String

    var id: String { venueId }
}

struct BillingRecoveryResult: Codable {
    let portalUrl: String
    let accountId: String?
    let message: String?
}

struct PasswordRecoveryRequest: Codable {
    let email: String
    let redirectTo: String

    enum CodingKeys: String, CodingKey {
        case email
        case redirectTo = "redirect_to"
    }
}

struct SupabaseRefreshRequest: Codable {
    let refreshToken: String

    enum CodingKeys: String, CodingKey {
        case refreshToken = "refresh_token"
    }
}

struct SupabasePKCERequest: Codable {
    let authCode: String
    let codeVerifier: String

    enum CodingKeys: String, CodingKey {
        case authCode = "auth_code"
        case codeVerifier = "code_verifier"
    }
}

struct SupabaseSessionRequest: Codable {
    let accessToken: String
    let ageConfirmed: Bool?
    let termsAccepted: Bool?
    let privacyAccepted: Bool?
    let termsVersion: String?
    let privacyVersion: String?
    let consentSource: String?
}

struct SupabaseAuthTokens: Codable {
    let accessToken: String?
    let refreshToken: String?
    let expiresIn: Int?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }
}

struct SupabaseSignupOutcome {
    let authResult: AuthResult?
    let refreshToken: String?
    let accessToken: String?
    let confirmationRequired: Bool
}

struct AccountDashboard: Codable {
    let account: Account
    let stats: AccountStats?
    let savedItems: [SavedItem]?
    let submissions: [SubmissionSummary]?
    let privacySettings: PrivacySettings?
    let access: AccessState?
    let leaderboard: LeaderboardContext?
    let discounts: AccountDiscountSummary?
    let pintPoints: AccountPintPoints?
    let counterStaffInvitations: [CounterStaffInvitation]?

    enum CodingKeys: String, CodingKey {
        case account
        case stats = "dashboardStats"
        case savedItems
        case submissions
        case privacySettings
        case access
        case leaderboard
        case discounts
        case pintPoints
        case counterStaffInvitations
    }
}

struct CounterStaffInvitation: Codable, Identifiable, Hashable {
    let id: String
    let venueId: String
    let venueName: String
    let suburb: String?
    let invitedAt: String?
    let expiresAt: String?
}

struct CounterStaffInvitationResponse: Codable {
    let assignment: VenueAssignment?
    let account: Account?
    let message: String?
}

struct CounterStaffInvitationDecision: Codable {
    let decision: String
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

    enum CodingKeys: String, CodingKey {
        case totalSubmissions = "totalUploads"
        case approvedSubmissions = "verifiedCount"
        case pendingSubmissions = "pendingVerificationCount"
        case totalSavingsCents
        case trustScore
    }
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

struct PrivacySettingsSaveResult: Codable, Hashable {
    let privacySettings: PrivacySettings
}

struct AccountDeletionStatusResponse: Codable, Hashable {
    let request: AccountDeletionStatus?
}

struct AccountDeletionStatus: Codable, Identifiable, Hashable {
    let id: String
    let status: String
    let userMessage: String?
    let requestedAt: String?
    let executeAfter: String?
    let reviewedAt: String?
    let completedAt: String?
    let lastError: String?

    enum CodingKeys: String, CodingKey {
        case id
        case status
        case userMessage = "user_message"
        case requestedAt = "requested_at"
        case executeAfter = "execute_after"
        case reviewedAt = "reviewed_at"
        case completedAt = "completed_at"
        case lastError = "last_error"
    }
}

struct AccountSessionsResponse: Codable, Hashable {
    let sessions: [AccountSession]
    let total: Int?
    let pagination: OffsetPagination?
}

struct OffsetPagination: Codable, Hashable {
    let total: Int?
    let limit: Int
    let offset: Int
    let hasMore: Bool
}

struct AccountSession: Codable, Identifiable, Hashable {
    let id: String
    let createdAt: String?
    let expiresAt: String?
    let lastUsedAt: String?
    let active: Bool?
    let revokedAt: String?
    let current: Bool?
    let deviceFingerprint: String?
    let networkFingerprint: String?
}

struct AccessState: Codable, Hashable {
    let status: String?
    let isAuthenticated: Bool?
    let accountRole: String?
    let isAdmin: Bool?
    let hasFullAccess: Bool?
    let ageConfirmed: Bool?
    let priceAccessModel: String?
    let canViewAllPrices: Bool?
    let freePreviewScope: String?
}

struct LeaderboardContext: Codable, Hashable {
    let accountId: String?
    let rank: Int?
}

struct AccountDiscountSummary: Codable, Hashable {
    let eligible: Bool?
    let estimatedSavingsCents: Int?
}

struct AccountPintPoints: Codable, Hashable {
    let available: Int?
    let threshold: Int?
    let pointsUntilReward: Int?
    let rewardAvailable: Bool?
}

struct RotatingCodeResult: Codable, Hashable {
    let accountId: String?
    let code: String
    let qrDataUrl: String?
    let redeemUrl: String?
    let expiresAt: String?
    let validMinutes: Int?
    let pointsReserved: Int?
    let copy: String?
}

struct VenueListResponse: Codable {
    let venues: [Venue]
    let pagination: OffsetPagination?
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
    let preview: PricePreview?
    let nextCursor: String?
}

struct PricePreview: Codable, Hashable {
    let model: String
    let includedCount: Int
    let lockedCount: Int
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
    let pagination: OffsetPagination?
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
    let userProgress: String?
    let reservationAcceptedAt: String?
    let reservationExpiresAt: String?
}

struct MissionActionResponse: Codable {
    let mission: Mission?
    let missionId: String?
    let released: Bool?
    let reservationAcceptedAt: String?
    let reservationExpiresAt: String?
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

struct SubmissionResult: Codable, Hashable {
    let id: String?
    let status: String?
    let idempotentReplay: Bool?
}

struct CreateSubmissionRequest: Codable {
    let clientSubmissionId: String?
    let missionId: String?
    let venueId: String
    let venueName: String
    let suburb: String?
    let newVenue: PendingSubmissionVenue?
    let submissionType: String
    let observedAt: String
    let sourcePhotoDataUrl: String?
    let sourcePhotoDataUrls: [String]
    let sourceDocumentDataUrl: String?
    let sourcePhotoUrl: String?
    let uploadLocation: UploadLocationRequest?
    let notes: String?
    let items: [SubmissionItemRequest]
}

struct PendingSubmissionVenue: Codable, Hashable {
    let googlePlaceId: String?
    let name: String
    let address: String?
    let suburb: String?
    let state: String?
    let postcode: String?
    let phone: String?
    let website: String?
    let latitude: Double?
    let longitude: Double?
}

struct UploadLocationRequest: Codable, Hashable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double?
    let capturedAt: String
}

struct SubmissionItemRequest: Codable, Hashable {
    let beerName: String
    let servingSize: String
    let price: Double?
    let isHappyHourPrice: Bool
    let happyHourDetails: String?
    let isOnTap: String
}

struct WrongPriceReportRequest: Codable {
    let anonymousSessionId: String?
    let venueId: String
    let venueName: String
    let priceRecordId: String?
    let beerName: String?
    let reason: String
    let notes: String?
    let sourcePhotoDataUrl: String?
    let sourcePhotoUrl: String?
}

struct VenueRequestPayload: Codable {
    let anonymousSessionId: String?
    let requestType: String
    let venueId: String?
    let venueName: String?
    let beerName: String?
    let suburb: String?
    let notes: String?
}

struct VenuePortalData: Codable {
    let isAdmin: Bool?
    let accessLevel: String?
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
    let dailySpecialsPlanner: DailySpecialsPlanner?
    let discounts: VenueDiscountSummary?
    let pintPoints: VenuePintPointSummary?
    let updateLink: String?
    let message: String?
    let privacyCopy: String?
    let qrCopy: String?
}

struct VenueAssignment: Codable, Identifiable, Hashable {
    let id: String?
    let venueId: String
    let venueName: String
    let suburb: String?
    let accessLevel: String?

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
    var updatedAt: String?
    var replaceVenueTags: Bool? = nil
    var expectedUpdatedAt: String? = nil
}

struct BarProfileSaveResult: Codable {
    let profile: BarProfile
    let tier: TierCapabilities?
    let message: String?
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
    var updatedAt: String? = nil
    var expectedUpdatedAt: String? = nil
    var priceConfirmed: Bool? = nil
    var stockConfirmed: Bool? = nil

    var stableId: String { id ?? beerName }
}

struct BarBeerSaveResult: Codable {
    let beer: BarBeer
    let message: String?
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

struct BarHappyHourSaveResult: Codable {
    let happyHour: BarHappyHour
    let message: String?
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

struct BarSpecialSaveResult: Codable {
    let special: BarSpecial
    let message: String?
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
    let pricePreviewViews: Int?
    let directionsClicks: Int?
    let privacyFloorMet: Bool?
    let privacyThreshold: Int?
}

struct DailySpecialsPlanner: Codable, Hashable {
    let title: String?
    let venueName: String?
    let area: String?
    let summaryDate: String?
    let sourcePeriod: String?
    let privacyFloorMet: Bool?
    let confidenceCopy: String?
    let summary: String?
    let demandSignals: [PlannerSignal]?
    let popularWindows: [PlannerWindow]?
    let quietWindows: [PlannerWindow]?
    let localSearchSignals: [PlannerSignal]?
    let recommendations: [PlannerRecommendation]?
}

struct PlannerSignal: Codable, Identifiable, Hashable {
    let label: String
    let value: JSONValue?
    let helper: String?

    var id: String { "\(label)-\(helper ?? "")" }
    var displayValue: String {
        switch value {
        case .string(let value): return value
        case .number(let value):
            return value.rounded() == value ? "\(Int(value))" : String(format: "%.1f", value)
        case .bool(let value): return value ? "Yes" : "No"
        case .none, .null: return "-"
        default: return "View"
        }
    }
}

struct PlannerWindow: Codable, Identifiable, Hashable {
    let label: String
    let startTime: String?
    let endTime: String?
    let count: Int?
    let helper: String?

    var id: String { "\(label)-\(startTime ?? "")-\(endTime ?? "")" }
}

struct PlannerRecommendation: Codable, Identifiable, Hashable {
    let title: String
    let type: String?
    let window: String?
    let startTime: String?
    let endTime: String?
    let offerIdea: String?
    let reason: String?
    let action: String?

    var id: String { "\(title)-\(window ?? "")" }
}

struct VenueDiscountSummary: Codable, Hashable {
    let totalRedemptions: Int?
    let totalQuantity: Int?
    let uniqueAccounts: Int?
    let estimatedSavingsCents: Int?
}

struct VenuePintPointSummary: Codable, Hashable {
    let today: JSONValue?
    let month: JSONValue?
    let rewardThreshold: Int?
    let copy: String?
}

struct CounterMemberPreview: Codable, Hashable {
    let accountId: String
    let checkoutToken: String
    let authorizationExpiresAt: String?
    let pointsRemainingToday: Int?
    let privacyCopy: String?
}

struct CounterPurchaseRecord: Codable, Hashable {
    let id: String?
}

struct CounterPurchaseResult: Codable, Hashable {
    let record: CounterPurchaseRecord?
    let accountId: String?
    let pointsEarned: Int?
    let idempotentReplay: Bool?
    let copy: String?
    let progressCopy: String?
    let rewardCopy: String?
}

struct CounterRewardResult: Codable, Hashable {
    let status: String?
    let accountId: String?
    let copy: String?
    let instruction: String?
}

struct CounterMemberPreviewRequest: Codable {
    let code: String
    let transactionReference: String
}

struct CounterPurchaseRequest: Codable {
    let checkoutToken: String
    let itemName: String?
    let beverageCategory: String
    let quantity: Int
    let transactionReference: String
    let notes: String?
}

struct CounterVoidRequest: Codable {
    let reason: String
}

struct CounterRewardDecisionRequest: Codable {
    let code: String
    let action: String
    let reason: String?
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
