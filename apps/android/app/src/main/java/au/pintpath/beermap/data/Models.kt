package au.pintpath.beermap.data

import org.json.JSONArray
import org.json.JSONObject

data class AuthResult(
    val token: String,
    val account: Account
)

data class NativeAuthOutcome(
    val authResult: AuthResult?,
    val refreshToken: String?,
    val accessToken: String?,
    val confirmationRequired: Boolean
)

data class SupabaseAuthTokens(
    val accessToken: String?,
    val refreshToken: String?
)

data class BillingRecoveryResult(
    val portalUrl: String,
    val accountId: String?,
    val message: String?
)

data class BillingRecoveryVenue(
    val venueId: String,
    val venueName: String
)

data class Account(
    val id: String,
    val email: String,
    val displayName: String?,
    val role: String?,
    val status: String?,
    val subscriptionStatus: String?,
    val publicAccountId: String?,
    val contributionPointsCurrentMonth: Double?,
    val trustScore: Double?,
    val ageConfirmedAt: String?,
    val emailVerifiedAt: String?
)

data class AccountDashboard(
    val account: Account,
    val access: AccountAccess?,
    val stats: AccountStats?,
    val savedCount: Int,
    val submissionCount: Int,
    val privacySettings: PrivacySettings?,
    val discounts: DiscountSummary?,
    val pintPoints: PintPoints?,
    val counterStaffInvitations: List<CounterStaffInvitation>
)

data class AccountAccess(
    val accountRole: String?,
    val isAdmin: Boolean,
    val hasFullAccess: Boolean
)

data class CounterStaffInvitation(
    val id: String,
    val venueId: String,
    val venueName: String,
    val suburb: String?,
    val invitedAt: String?,
    val expiresAt: String?
)

data class AccountStats(
    val totalSubmissions: Int?,
    val approvedSubmissions: Int?,
    val pendingSubmissions: Int?,
    val totalSavingsCents: Int?,
    val trustScore: Double?
)

data class AccountSession(
    val id: String,
    val createdAt: String?,
    val expiresAt: String?,
    val lastUsedAt: String?,
    val active: Boolean,
    val current: Boolean
)

data class PrivacySettings(
    val optionalAnalyticsEnabled: Boolean,
    val venueReportInclusionEnabled: Boolean,
    val productResearchEnabled: Boolean,
    val emailUpdatesEnabled: Boolean
)

data class DiscountSummary(
    val eligible: Boolean,
    val estimatedSavingsCents: Int
)

data class PintPoints(
    val available: Int,
    val threshold: Int,
    val pointsUntilReward: Int,
    val rewardAvailable: Boolean
)

data class RotatingCodeResult(
    val accountId: String?,
    val code: String,
    val qrDataUrl: String?,
    val redeemUrl: String?,
    val expiresAt: String?,
    val validMinutes: Int?,
    val pointsReserved: Int?,
    val copy: String?
)

data class Venue(
    val id: String,
    val name: String,
    val address: String?,
    val suburb: String?,
    val state: String?,
    val membershipTier: String?,
    val latitude: Double?,
    val longitude: Double?
) {
    val location: String
        get() = listOfNotNull(suburb, state).joinToString(", ")
}

data class PriceRecord(
    val id: String,
    val venueId: String?,
    val venueName: String?,
    val beerName: String?,
    val normalizedBeerId: String?,
    val servingSize: String?,
    val price: Double?,
    val priceRedacted: Boolean,
    val freePreviewIncluded: Boolean,
    val isHappyHourPrice: Boolean,
    val happyHour: String?
) {
    val formattedPrice: String
        get() = when {
            priceRedacted -> "Premium"
            price != null -> "$" + "%.2f".format(price)
            else -> "Check venue"
        }
}

data class PriceRecordsResult(
    val records: List<PriceRecord>,
    val access: PriceAccessState?,
    val preview: PricePreview?,
    val nextCursor: String?
)

data class PricePreview(
    val model: String,
    val includedCount: Int,
    val lockedCount: Int
)

data class PriceAccessState(
    val status: String?,
    val isAuthenticated: Boolean,
    val accountRole: String?,
    val isAdmin: Boolean,
    val hasFullAccess: Boolean,
    val ageConfirmed: Boolean,
    val priceAccessModel: String?,
    val canViewAllPrices: Boolean,
    val freePreviewScope: String?
)

data class Mission(
    val id: String,
    val venueId: String?,
    val venueName: String,
    val suburb: String?,
    val reason: String?,
    val points: Double?,
    val userProgress: String?,
    val reservationAcceptedAt: String?,
    val reservationExpiresAt: String?
)

data class UploadLocation(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double?,
    val capturedAt: String
) {
    fun toJson(): JSONObject = JSONObject()
        .put("latitude", latitude)
        .put("longitude", longitude)
        .putNullable("accuracyMeters", accuracyMeters)
        .put("capturedAt", capturedAt)
}

data class AccountDeletionStatus(
    val id: String,
    val status: String,
    val userMessage: String?,
    val requestedAt: String?,
    val executeAfter: String?,
    val reviewedAt: String?,
    val completedAt: String?,
    val lastError: String?
)

data class PortalData(
    val isAdmin: Boolean,
    val accessLevel: String?,
    val accessState: String?,
    val assignments: List<VenueAssignment>,
    val selectedVenue: SelectedVenue?,
    val profile: BarProfile?,
    val tier: TierCapabilities?,
    val beers: List<BarBeer>,
    val happyHours: List<BarHappyHour>,
    val specials: List<BarSpecial>,
    val pendingCount: Int,
    val analytics: VenueAnalytics?,
    val dailySpecialsPlanner: DailySpecialsPlanner?,
    val discounts: VenueDiscountSummary?,
    val pintPoints: VenuePintPointSummary?,
    val message: String?,
    val privacyCopy: String?
)

data class VenueAssignment(
    val venueId: String,
    val venueName: String,
    val suburb: String?,
    val accessLevel: String?
)

data class SelectedVenue(
    val venueId: String,
    val venueName: String,
    val suburb: String?
)

data class BarProfile(
    val name: String,
    val address: String?,
    val suburb: String?,
    val area: String?,
    val phone: String?,
    val website: String?,
    val instagram: String?,
    val description: String?,
    val openingHours: JSONObject,
    val venueTags: List<String>,
    val membershipTier: String?,
    val active: Boolean,
    val updatedAt: String?
)

data class TierCapabilities(
    val tierLabel: String?,
    val canManageSpecials: Boolean,
    val analytics: Boolean,
    val monthlyReports: Boolean,
    val analyticsLocked: Boolean,
    val upgradeCopy: String?
)

data class BarBeer(
    val id: String?,
    val beerName: String,
    val brewery: String?,
    val style: String?,
    val abv: Double?,
    val serveSize: String?,
    val price: Double?,
    val onTap: Boolean,
    val inStock: Boolean,
    val notes: String?,
    val updatedAt: String? = null,
    val priceConfirmed: Boolean = false,
    val stockConfirmed: Boolean = false
)

data class BarHappyHour(
    val id: String?,
    val title: String,
    val daysOfWeek: List<String>,
    val startTime: String,
    val endTime: String,
    val description: String,
    val active: Boolean
)

data class BarSpecial(
    val id: String?,
    val title: String,
    val description: String,
    val price: Double?,
    val discount: String?,
    val startTime: String,
    val endTime: String,
    val exclusive: Boolean,
    val active: Boolean
)

data class VenueAnalytics(
    val barLookups: Int,
    val profileViews: Int,
    val beerListViews: Int,
    val specialsViews: Int,
    val pricePreviewViews: Int,
    val privacyFloorMet: Boolean,
    val privacyThreshold: Int
)

data class DailySpecialsPlanner(
    val area: String?,
    val summaryDate: String?,
    val sourcePeriod: String?,
    val privacyFloorMet: Boolean,
    val confidenceCopy: String?,
    val summary: String?,
    val demandSignals: List<PlannerSignal>,
    val recommendations: List<PlannerRecommendation>
)

data class PlannerSignal(
    val label: String,
    val value: String,
    val helper: String?
)

data class PlannerRecommendation(
    val title: String,
    val offerIdea: String?,
    val reason: String?,
    val action: String?,
    val startTime: String?,
    val endTime: String?
)

data class VenueDiscountSummary(
    val totalRedemptions: Int,
    val totalQuantity: Int,
    val uniqueAccounts: Int,
    val estimatedSavingsCents: Int
)

data class VenuePintPointSummary(
    val rewardThreshold: Int,
    val copy: String?
)

data class CounterMemberPreview(
    val accountId: String,
    val checkoutToken: String,
    val authorizationExpiresAt: String?,
    val pointsRemainingToday: Int,
    val privacyCopy: String?
)

data class CounterPurchaseResult(
    val recordId: String?,
    val accountId: String?,
    val pointsEarned: Int,
    val idempotentReplay: Boolean,
    val copy: String?,
    val progressCopy: String?,
    val rewardCopy: String?
)

data class CounterRewardResult(
    val status: String,
    val accountId: String?,
    val copy: String?,
    val instruction: String?
)

fun JSONObject.stringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotBlank() } else null

fun JSONObject.doubleOrNull(key: String): Double? =
    if (has(key) && !isNull(key)) optDouble(key) else null

fun JSONObject.intOrNull(key: String): Int? =
    if (has(key) && !isNull(key)) optInt(key) else null

fun JSONArray.objects(): List<JSONObject> =
    (0 until length()).mapNotNull { index -> optJSONObject(index) }

fun JSONObject.toAccount(): Account = Account(
    id = optString("id"),
    email = optString("email"),
    displayName = stringOrNull("displayName"),
    role = stringOrNull("role"),
    status = stringOrNull("status"),
    subscriptionStatus = stringOrNull("subscriptionStatus"),
    publicAccountId = stringOrNull("publicAccountId"),
    contributionPointsCurrentMonth = doubleOrNull("contributionPointsCurrentMonth"),
    trustScore = doubleOrNull("trustScore"),
    ageConfirmedAt = stringOrNull("ageConfirmedAt"),
    emailVerifiedAt = stringOrNull("emailVerifiedAt")
)

fun JSONObject.toVenue(): Venue = Venue(
    id = optString("id"),
    name = optString("name", "Venue"),
    address = stringOrNull("address"),
    suburb = stringOrNull("suburb"),
    state = stringOrNull("state"),
    membershipTier = stringOrNull("membershipTier"),
    latitude = doubleOrNull("latitude"),
    longitude = doubleOrNull("longitude")
)

fun JSONObject.toPriceRecord(): PriceRecord = PriceRecord(
    id = optString("id", "${stringOrNull("venueId")}-${stringOrNull("beerName")}"),
    venueId = stringOrNull("venueId"),
    venueName = stringOrNull("venueName"),
    beerName = stringOrNull("beerName"),
    normalizedBeerId = stringOrNull("normalizedBeerId"),
    servingSize = stringOrNull("servingSize"),
    price = doubleOrNull("price"),
    priceRedacted = optBoolean("priceRedacted", false),
    freePreviewIncluded = optBoolean("freePreviewIncluded", false),
    isHappyHourPrice = optBoolean("isHappyHourPrice", false),
    happyHour = stringOrNull("happyHour")
)

fun JSONObject.toMission(): Mission = Mission(
    id = optString("id"),
    venueId = stringOrNull("venueId"),
    venueName = optString("venueName", "Venue mission"),
    suburb = stringOrNull("suburb"),
    reason = stringOrNull("reason"),
    points = doubleOrNull("points"),
    userProgress = stringOrNull("userProgress"),
    reservationAcceptedAt = stringOrNull("reservationAcceptedAt"),
    reservationExpiresAt = stringOrNull("reservationExpiresAt")
)

fun JSONObject.toAccountSession(): AccountSession = AccountSession(
    id = optString("id"),
    createdAt = stringOrNull("createdAt"),
    expiresAt = stringOrNull("expiresAt"),
    lastUsedAt = stringOrNull("lastUsedAt"),
    active = optBoolean("active", false),
    current = optBoolean("current", false)
)

fun JSONObject.toAccountDashboard(): AccountDashboard = AccountDashboard(
    account = getJSONObject("account").toAccount(),
    access = optJSONObject("access")?.let {
        AccountAccess(
            accountRole = it.stringOrNull("accountRole"),
            isAdmin = it.optBoolean("isAdmin", false),
            hasFullAccess = it.optBoolean("hasFullAccess", false)
        )
    },
    stats = (optJSONObject("dashboardStats") ?: optJSONObject("stats"))?.let {
        AccountStats(
            totalSubmissions = it.intOrNull("totalUploads") ?: it.intOrNull("totalSubmissions"),
            approvedSubmissions = it.intOrNull("verifiedCount") ?: it.intOrNull("approvedSubmissions"),
            pendingSubmissions = it.intOrNull("pendingVerificationCount") ?: it.intOrNull("pendingSubmissions"),
            totalSavingsCents = it.intOrNull("totalSavingsCents"),
            trustScore = it.doubleOrNull("trustScore")
        )
    },
    savedCount = optJSONArray("savedItems")?.length() ?: 0,
    submissionCount = optJSONArray("submissions")?.length() ?: 0,
    privacySettings = optJSONObject("privacySettings")?.let {
        PrivacySettings(
            optionalAnalyticsEnabled = it.optBoolean("optionalAnalyticsEnabled", false),
            venueReportInclusionEnabled = it.optBoolean("venueReportInclusionEnabled", false),
            productResearchEnabled = it.optBoolean("productResearchEnabled", false),
            emailUpdatesEnabled = it.optBoolean("emailUpdatesEnabled", false)
        )
    },
    discounts = optJSONObject("discounts")?.let {
        DiscountSummary(
            eligible = it.optBoolean("eligible", false),
            estimatedSavingsCents = it.optInt("estimatedSavingsCents", 0)
        )
    },
    pintPoints = optJSONObject("pintPoints")?.let {
        PintPoints(
            available = it.optInt("available", 0),
            threshold = it.optInt("threshold", 50),
            pointsUntilReward = it.optInt("pointsUntilReward", 50),
            rewardAvailable = it.optBoolean("rewardAvailable", false)
        )
    },
    counterStaffInvitations = optJSONArray("counterStaffInvitations")?.objects()?.map {
        CounterStaffInvitation(
            id = it.optString("id"),
            venueId = it.optString("venueId"),
            venueName = it.optString("venueName", "Venue"),
            suburb = it.stringOrNull("suburb"),
            invitedAt = it.stringOrNull("invitedAt"),
            expiresAt = it.stringOrNull("expiresAt")
        )
    }.orEmpty()
)

fun JSONObject.toAccountDeletionStatus(): AccountDeletionStatus = AccountDeletionStatus(
    id = optString("id"),
    status = optString("status"),
    userMessage = stringOrNull("user_message"),
    requestedAt = stringOrNull("requested_at"),
    executeAfter = stringOrNull("execute_after"),
    reviewedAt = stringOrNull("reviewed_at"),
    completedAt = stringOrNull("completed_at"),
    lastError = stringOrNull("last_error")
)

fun JSONObject.toPortalData(): PortalData {
    val inventory = optJSONObject("inventory") ?: JSONObject()
    return PortalData(
        isAdmin = optBoolean("isAdmin", false),
        accessLevel = stringOrNull("accessLevel"),
        accessState = stringOrNull("accessState"),
        assignments = optJSONArray("assignments")?.objects()?.map { it.toVenueAssignment() }.orEmpty(),
        selectedVenue = optJSONObject("selectedVenue")?.let {
            SelectedVenue(
                venueId = it.optString("venueId"),
                venueName = it.optString("venueName"),
                suburb = it.stringOrNull("suburb")
            )
        },
        profile = optJSONObject("profile")?.toBarProfile(),
        tier = optJSONObject("tier")?.let {
            TierCapabilities(
                tierLabel = it.stringOrNull("tierLabel"),
                canManageSpecials = it.optBoolean("canManageSpecials", false),
                analytics = it.optBoolean("analytics", false),
                monthlyReports = it.optBoolean("monthlyReports", false),
                analyticsLocked = it.optBoolean("analyticsLocked", true),
                upgradeCopy = it.stringOrNull("upgradeCopy")
            )
        },
        beers = inventory.optJSONArray("beers")?.objects()?.map { it.toBarBeer() }.orEmpty(),
        happyHours = inventory.optJSONArray("happyHours")?.objects()?.map { it.toHappyHour() }.orEmpty(),
        specials = inventory.optJSONArray("specials")?.objects()?.map { it.toSpecial() }.orEmpty(),
        pendingCount = optJSONArray("pendingChanges")?.length() ?: 0,
        analytics = optJSONObject("analytics")?.let {
            VenueAnalytics(
                barLookups = it.optInt("barLookups", 0),
                profileViews = it.optInt("profileViews", 0),
                beerListViews = it.optInt("beerListViews", 0),
                specialsViews = it.optInt("specialsViews", 0),
                pricePreviewViews = it.optInt("pricePreviewViews", 0),
                privacyFloorMet = it.optBoolean("privacyFloorMet", false),
                privacyThreshold = it.optInt("privacyThreshold", 10)
            )
        },
        dailySpecialsPlanner = optJSONObject("dailySpecialsPlanner")?.toDailySpecialsPlanner()
            ?: optJSONObject("businessToolkit")?.optJSONObject("dailySpecialsPlanner")?.toDailySpecialsPlanner(),
        discounts = optJSONObject("discounts")?.let {
            VenueDiscountSummary(
                totalRedemptions = it.optInt("totalRedemptions", 0),
                totalQuantity = it.optInt("totalQuantity", 0),
                uniqueAccounts = it.optInt("uniqueAccounts", 0),
                estimatedSavingsCents = it.optInt("estimatedSavingsCents", 0)
            )
        },
        pintPoints = optJSONObject("pintPoints")?.let {
            VenuePintPointSummary(
                rewardThreshold = it.optInt("rewardThreshold", 50),
                copy = it.stringOrNull("copy")
            )
        },
        message = stringOrNull("message"),
        privacyCopy = stringOrNull("privacyCopy")
    )
}

fun JSONObject.toRotatingCodeResult(): RotatingCodeResult = RotatingCodeResult(
    accountId = stringOrNull("accountId"),
    code = optString("code"),
    qrDataUrl = stringOrNull("qrDataUrl"),
    redeemUrl = stringOrNull("redeemUrl"),
    expiresAt = stringOrNull("expiresAt"),
    validMinutes = intOrNull("validMinutes"),
    pointsReserved = intOrNull("pointsReserved"),
    copy = stringOrNull("copy")
)

fun JSONObject.toCounterMemberPreview(): CounterMemberPreview = CounterMemberPreview(
    accountId = optString("accountId"),
    checkoutToken = optString("checkoutToken"),
    authorizationExpiresAt = stringOrNull("authorizationExpiresAt"),
    pointsRemainingToday = optInt("pointsRemainingToday", 0),
    privacyCopy = stringOrNull("privacyCopy")
)

fun JSONObject.toCounterPurchaseResult(): CounterPurchaseResult = CounterPurchaseResult(
    recordId = optJSONObject("record")?.stringOrNull("id"),
    accountId = stringOrNull("accountId"),
    pointsEarned = optInt("pointsEarned", 0),
    idempotentReplay = optBoolean("idempotentReplay", false),
    copy = stringOrNull("copy"),
    progressCopy = stringOrNull("progressCopy"),
    rewardCopy = stringOrNull("rewardCopy")
)

fun JSONObject.toCounterRewardResult(): CounterRewardResult = CounterRewardResult(
    status = optString("status"),
    accountId = stringOrNull("accountId"),
    copy = stringOrNull("copy"),
    instruction = stringOrNull("instruction")
)

fun JSONObject.toDailySpecialsPlanner(): DailySpecialsPlanner = DailySpecialsPlanner(
    area = stringOrNull("area"),
    summaryDate = stringOrNull("summaryDate"),
    sourcePeriod = stringOrNull("sourcePeriod"),
    privacyFloorMet = optBoolean("privacyFloorMet", false),
    confidenceCopy = stringOrNull("confidenceCopy"),
    summary = stringOrNull("summary"),
    demandSignals = optJSONArray("demandSignals")?.objects()?.map { it.toPlannerSignal() }.orEmpty(),
    recommendations = optJSONArray("recommendations")?.objects()?.map { it.toPlannerRecommendation() }.orEmpty()
)

fun JSONObject.toPlannerSignal(): PlannerSignal = PlannerSignal(
    label = optString("label", "Signal"),
    value = plannerValue("value"),
    helper = stringOrNull("helper")
)

fun JSONObject.toPlannerRecommendation(): PlannerRecommendation = PlannerRecommendation(
    title = optString("title", "Recommended special"),
    offerIdea = stringOrNull("offerIdea"),
    reason = stringOrNull("reason"),
    action = stringOrNull("action"),
    startTime = stringOrNull("startTime"),
    endTime = stringOrNull("endTime")
)

private fun JSONObject.plannerValue(key: String): String {
    if (!has(key) || isNull(key)) return "-"
    val value = opt(key)
    return when (value) {
        is Number -> {
            val double = value.toDouble()
            if (double % 1.0 == 0.0) double.toInt().toString() else "%.1f".format(double)
        }
        is Boolean -> if (value) "Yes" else "No"
        else -> value.toString()
    }
}

fun JSONObject.toVenueAssignment(): VenueAssignment = VenueAssignment(
    venueId = optString("venueId"),
    venueName = optString("venueName", "Assigned venue"),
    suburb = stringOrNull("suburb"),
    accessLevel = stringOrNull("accessLevel")
)

fun JSONObject.toBarProfile(): BarProfile = BarProfile(
    name = optString("name", "Venue"),
    address = stringOrNull("address"),
    suburb = stringOrNull("suburb"),
    area = stringOrNull("area"),
    phone = stringOrNull("phone"),
    website = stringOrNull("website"),
    instagram = stringOrNull("instagram"),
    description = stringOrNull("description"),
    openingHours = optJSONObject("openingHours") ?: JSONObject(),
    venueTags = optJSONArray("venueTags")?.let { tags ->
        (0 until tags.length()).mapNotNull { index -> tags.optString(index).takeIf(String::isNotBlank) }
    }.orEmpty(),
    membershipTier = stringOrNull("membershipTier"),
    active = optBoolean("active", true),
    updatedAt = stringOrNull("updatedAt")
)

fun JSONObject.toBarBeer(): BarBeer = BarBeer(
    id = stringOrNull("id"),
    beerName = optString("beerName", "Beer"),
    brewery = stringOrNull("brewery"),
    style = stringOrNull("style"),
    abv = doubleOrNull("abv"),
    serveSize = stringOrNull("serveSize"),
    price = doubleOrNull("price"),
    onTap = optBoolean("onTap", false),
    inStock = optBoolean("inStock", true),
    notes = stringOrNull("notes"),
    updatedAt = stringOrNull("updatedAt")
)

fun JSONObject.toHappyHour(): BarHappyHour = BarHappyHour(
    id = stringOrNull("id"),
    title = optString("title", "Happy hour"),
    daysOfWeek = optJSONArray("daysOfWeek")?.let { days ->
        (0 until days.length()).map { days.optString(it) }
    }.orEmpty(),
    startTime = optString("startTime", "16:00"),
    endTime = optString("endTime", "18:00"),
    description = optString("description", ""),
    active = optBoolean("active", true)
)

fun JSONObject.toSpecial(): BarSpecial = BarSpecial(
    id = stringOrNull("id"),
    title = optString("title", "Special"),
    description = optString("description", ""),
    price = doubleOrNull("price"),
    discount = stringOrNull("discount"),
    startTime = optString("startTime", "17:00"),
    endTime = optString("endTime", "21:00"),
    exclusive = optBoolean("exclusive", false),
    active = optBoolean("active", true)
)

fun BarProfile.toJson(): JSONObject = JSONObject()
    .put("name", name)
    .putNullable("address", address)
    .putNullable("suburb", suburb)
    .putNullable("area", area)
    .putNullable("phone", phone)
    .putNullable("website", website)
    .putNullable("instagram", instagram)
    .putNullable("description", description)
    .put("openingHours", openingHours)
    .put("venueTags", JSONArray(venueTags))
    .put("replaceVenueTags", false)
    .putNullable("expectedUpdatedAt", updatedAt)
    .putNullable("membershipTier", membershipTier)
    .put("active", active)

fun BarBeer.toJson(): JSONObject = JSONObject()
    .putNullable("id", id)
    .put("beerName", beerName)
    .putNullable("brewery", brewery)
    .putNullable("style", style)
    .putNullable("abv", abv)
    .putNullable("serveSize", serveSize)
    .putNullable("price", price)
    .put("onTap", onTap)
    .put("inStock", inStock)
    .putNullable("notes", notes)
    .put("priceConfirmed", priceConfirmed)
    .put("stockConfirmed", stockConfirmed)
    .putNullable("expectedUpdatedAt", updatedAt)

fun BarHappyHour.toJson(): JSONObject = JSONObject()
    .putNullable("id", id)
    .put("title", title)
    .put("daysOfWeek", JSONArray(daysOfWeek))
    .put("startTime", startTime)
    .put("endTime", endTime)
    .put("description", description)
    .put("active", active)

fun BarSpecial.toJson(): JSONObject = JSONObject()
    .putNullable("id", id)
    .put("title", title)
    .put("description", description)
    .putNullable("price", price)
    .putNullable("discount", discount)
    .putNullable("startsAt", null)
    .putNullable("endsAt", null)
    .put("startTime", startTime)
    .put("endTime", endTime)
    .putNullable("scheduleNote", null)
    .put("exclusive", exclusive)
    .put("active", active)

fun JSONObject.putNullable(key: String, value: Any?): JSONObject {
    put(key, value ?: JSONObject.NULL)
    return this
}
