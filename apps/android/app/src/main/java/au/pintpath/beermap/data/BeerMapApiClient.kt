package au.pintpath.beermap.data

import android.util.Base64
import au.pintpath.beermap.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.Normalizer
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

class ApiException(
    val status: Int,
    message: String,
    val code: String? = null,
    val reauthenticationRequired: Boolean = false,
    val billingRecoveryEligible: Boolean = false,
    val billingRecoveryAccessToken: String? = null,
    val billingRecoveryConsumer: Boolean = false,
    val billingRecoveryVenues: List<BillingRecoveryVenue> = emptyList(),
    val legalAcceptanceRequired: Boolean = false,
    val legalAcceptanceAccessToken: String? = null,
    val legalAcceptanceRefreshToken: String? = null,
    val mfaStepUpRequired: Boolean = false,
    val mfaAccessToken: String? = null,
    val mfaRefreshToken: String? = null
) : IOException(message)

internal data class SupabasePublicAuthConfiguration(
    val origin: String,
    val publishableKey: String
)

internal object SupabasePublicAuthConfigurationResolver {
    const val APPROVED_ORIGIN = "https://auth.pintpath.au"
    const val UNAVAILABLE_MESSAGE =
        "Secure account sign-in is temporarily unavailable. Update the app or contact support."
    private val publishableKeyPattern = Regex("^sb_publishable_[A-Za-z0-9_-]{20,220}$")

    fun resolve(config: JSONObject): SupabasePublicAuthConfiguration? = resolveValues(
        configuredOriginPublished = config.has("supabaseUrl"),
        configuredOrigin = exactOptionalString(config, "supabaseUrl"),
        configuredKeyPublished = config.has("supabaseAnonKey"),
        configuredKey = exactOptionalString(config, "supabaseAnonKey"),
        embeddedOrigin = BuildConfig.SUPABASE_URL,
        embeddedKey = BuildConfig.SUPABASE_ANON_KEY
    )

    internal fun resolveValues(
        configuredOriginPublished: Boolean,
        configuredOrigin: String?,
        configuredKeyPublished: Boolean,
        configuredKey: String?,
        embeddedOrigin: String?,
        embeddedKey: String?
    ): SupabasePublicAuthConfiguration? {
        if (configuredOriginPublished != configuredKeyPublished) unavailable()

        val selectedConfiguredOrigin = configuredOrigin?.takeIf { it.isNotEmpty() }
        val selectedConfiguredKey = configuredKey?.takeIf { it.isNotEmpty() }
        if (configuredOriginPublished) {
            if (selectedConfiguredOrigin == null && selectedConfiguredKey == null) return null
            return requirePair(selectedConfiguredOrigin, selectedConfiguredKey)
        }

        val selectedEmbeddedOrigin = embeddedOrigin?.takeIf { it.isNotEmpty() }
        val selectedEmbeddedKey = embeddedKey?.takeIf { it.isNotEmpty() }
        if (selectedEmbeddedOrigin != null || selectedEmbeddedKey != null) {
            return requirePair(selectedEmbeddedOrigin, selectedEmbeddedKey)
        }
        return null
    }

    private fun requirePair(origin: String?, key: String?): SupabasePublicAuthConfiguration {
        if (origin != APPROVED_ORIGIN || key == null || !publishableKeyPattern.matches(key)) {
            unavailable()
        }
        return SupabasePublicAuthConfiguration(origin, key)
    }

    private fun exactOptionalString(config: JSONObject, name: String): String? {
        if (!config.has(name) || config.isNull(name)) return null
        val value = config.opt(name)
        if (value !is String) unavailable()
        return value.takeIf { it.isNotEmpty() }
    }

    fun unavailable(): Nothing = throw IOException(UNAVAILABLE_MESSAGE)
}

internal fun openNonRedirectingHttpConnection(url: URL): HttpURLConnection =
    (url.openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
    }

class BeerMapApiClient(
    private val sessionStore: SessionStore,
    private val baseUrl: String = BuildConfig.PINT_PATH_API_BASE_URL
) {
    private companion object {
        const val APPROVED_PRODUCTION_API_BASE_URL = "https://pintpath.au"
        const val API_CONFIGURATION_UNAVAILABLE =
            "The secure Pint Path service is unavailable. Update the app or contact support."
    }

    suspend fun config(): JSONObject = request("/api/business/config")

    suspend fun login(email: String, password: String, config: JSONObject): NativeAuthOutcome {
        if (!hasSupabaseConfiguration(config)) {
            val data = request(
                path = "/api/business/auth/login",
                method = "POST",
                body = JSONObject().put("email", email).put("password", password)
            )
            return NativeAuthOutcome(
                AuthResult(data.stringOrNull("token"), data.getJSONObject("account").toAccount()),
                null,
                null,
                confirmationRequired = false
            )
        }
        val tokens = supabaseRequest(
            path = "/auth/v1/token?grant_type=password",
            body = JSONObject().put("email", email).put("password", password),
            config = config
        )
        val accessToken = tokens.stringOrNull("access_token") ?: throw IOException("Secure sign-in did not return a session.")
        return try {
            val result = syncSupabase(accessToken, config, null, null, null)
            NativeAuthOutcome(result, tokens.stringOrNull("refresh_token"), accessToken, confirmationRequired = false)
        } catch (error: ApiException) {
            when {
                error.mfaStepUpRequired -> throw ApiException(
                    error.status,
                    error.message ?: "Enter the six-digit code from your authenticator app.",
                    code = "MFA_STEP_UP_REQUIRED",
                    reauthenticationRequired = true,
                    mfaStepUpRequired = true,
                    mfaAccessToken = accessToken,
                    mfaRefreshToken = tokens.stringOrNull("refresh_token")
                )
                error.billingRecoveryEligible -> throw ApiException(
                    error.status,
                    error.message ?: "Account access is suspended. Billing-only recovery remains available.",
                    billingRecoveryEligible = true,
                    billingRecoveryAccessToken = accessToken,
                    billingRecoveryConsumer = error.billingRecoveryConsumer,
                    billingRecoveryVenues = error.billingRecoveryVenues
                )
                error.legalAcceptanceRequired -> throw ApiException(
                    error.status,
                    error.message ?: "Accept the current Terms and Privacy Policy before continuing.",
                    legalAcceptanceRequired = true,
                    legalAcceptanceAccessToken = accessToken,
                    legalAcceptanceRefreshToken = tokens.stringOrNull("refresh_token")
                )
                else -> throw error
            }
        }
    }

    suspend fun billingRecoveryPortal(accessToken: String, venueId: String?): BillingRecoveryResult {
        val data = request(
            path = "/api/business/billing/recovery-portal",
            method = "POST",
            body = JSONObject().put("accessToken", accessToken).apply {
                if (!venueId.isNullOrBlank()) put("venueId", venueId)
            }
        )
        return BillingRecoveryResult(
            portalUrl = data.getString("portalUrl"),
            accountId = data.stringOrNull("accountId"),
            message = data.stringOrNull("message")
        )
    }

    suspend fun billingRecoveryPortal(email: String, password: String, venueId: String?): BillingRecoveryResult {
        val data = request(
            path = "/api/business/billing/recovery-portal",
            method = "POST",
            body = JSONObject()
                .put("email", email)
                .put("password", password)
                .apply {
                    if (!venueId.isNullOrBlank()) put("venueId", venueId)
                }
        )
        return BillingRecoveryResult(
            portalUrl = data.getString("portalUrl"),
            accountId = data.stringOrNull("accountId"),
            message = data.stringOrNull("message")
        )
    }

    suspend fun signup(
        email: String,
        password: String,
        displayName: String?,
        config: JSONObject,
        ageConfirmed: Boolean,
        termsAccepted: Boolean,
        privacyAccepted: Boolean
    ): NativeAuthOutcome {
        val policyVersion = requiredLegalPolicyVersion(config)
        val tokens = supabaseRequest(
            path = "/auth/v1/signup",
            body = JSONObject()
                .put("email", email)
                .put("password", password)
                .put("data", JSONObject()
                    .putNullable("display_name", displayName)
                    .put("age_confirmed", ageConfirmed)
                    .put("terms_accepted", termsAccepted)
                    .put("privacy_accepted", privacyAccepted)
                    .put("legal_policy_version", policyVersion)
                    .put("consent_source", "android")),
            config = config
        )
        val accessToken = tokens.stringOrNull("access_token")
            ?: return NativeAuthOutcome(null, null, null, confirmationRequired = true)
        val result = try {
            syncSupabase(accessToken, config, ageConfirmed, termsAccepted, privacyAccepted)
        } catch (error: ApiException) {
            if (!error.mfaStepUpRequired) throw error
            throw ApiException(
                error.status,
                error.message ?: "Enter the six-digit code from your authenticator app.",
                code = "MFA_STEP_UP_REQUIRED",
                reauthenticationRequired = true,
                mfaStepUpRequired = true,
                mfaAccessToken = accessToken,
                mfaRefreshToken = tokens.stringOrNull("refresh_token")
            )
        }
        return NativeAuthOutcome(result, tokens.stringOrNull("refresh_token"), accessToken, confirmationRequired = false)
    }

    suspend fun refreshSupabaseSession(
        refreshToken: String,
        config: JSONObject,
        existingAppToken: String
    ): NativeAuthOutcome {
        val tokens = supabaseRequest(
            path = "/auth/v1/token?grant_type=refresh_token",
            body = JSONObject().put("refresh_token", refreshToken),
            config = config
        )
        val accessToken = tokens.stringOrNull("access_token") ?: throw IOException("Your session could not be refreshed.")
        val result = try {
            syncSupabase(accessToken, config, null, null, null, existingAppToken)
        } catch (error: ApiException) {
            if (!error.mfaStepUpRequired) throw error
            throw ApiException(
                error.status,
                error.message ?: "Enter the six-digit code from your authenticator app.",
                code = "MFA_STEP_UP_REQUIRED",
                reauthenticationRequired = true,
                mfaStepUpRequired = true,
                mfaAccessToken = accessToken,
                mfaRefreshToken = tokens.stringOrNull("refresh_token") ?: refreshToken
            )
        }
        return NativeAuthOutcome(result, tokens.stringOrNull("refresh_token"), accessToken, confirmationRequired = false)
    }

    suspend fun completeOAuthSession(
        accessToken: String,
        refreshToken: String?,
        config: JSONObject
    ): NativeAuthOutcome {
        val result = syncSupabase(accessToken, config, null, null, null)
        return NativeAuthOutcome(result, refreshToken, accessToken, confirmationRequired = false)
    }

    suspend fun acceptCurrentPolicies(accessToken: String, config: JSONObject): NativeAuthOutcome {
        val result = syncSupabase(accessToken, config, true, true, true)
        return NativeAuthOutcome(result, null, accessToken, confirmationRequired = false)
    }

    suspend fun exchangeSupabasePKCE(authCode: String, codeVerifier: String, config: JSONObject): SupabaseAuthTokens {
        val tokens = supabaseRequest(
            path = "/auth/v1/token?grant_type=pkce",
            body = JSONObject()
                .put("auth_code", authCode)
                .put("code_verifier", codeVerifier),
            config = config
        )
        return SupabaseAuthTokens(
            accessToken = tokens.stringOrNull("access_token"),
            refreshToken = tokens.stringOrNull("refresh_token")
        )
    }

    suspend fun completeMfaSession(
        accessToken: String,
        refreshToken: String?,
        config: JSONObject,
        ageConfirmed: Boolean? = null,
        termsAccepted: Boolean? = null,
        privacyAccepted: Boolean? = null,
        existingAppToken: String? = null,
        reauthPurpose: String? = null
    ): NativeAuthOutcome {
        val result = syncSupabase(
            accessToken,
            config,
            ageConfirmed,
            termsAccepted,
            privacyAccepted,
            existingAppToken,
            reauthPurpose
        )
        return NativeAuthOutcome(result, refreshToken, accessToken, confirmationRequired = false)
    }

    suspend fun requestPasswordReset(email: String, config: JSONObject) {
        supabaseRequest(
            path = "/auth/v1/recover",
            body = JSONObject()
                .put("email", email)
                .put("redirect_to", effectiveApiBaseUrl() + "/auth/callback"),
            config = config
        )
    }

    suspend fun supabaseLogout(accessToken: String, config: JSONObject) {
        supabaseRequest("/auth/v1/logout?scope=local", JSONObject(), config, accessToken)
    }

    suspend fun verifiedSupabaseTotpFactors(
        accessToken: String,
        config: JSONObject
    ): List<SupabaseMfaFactor> {
        val binding = supabaseTokenBinding(accessToken)
        val user = supabaseRequest(
            path = "/auth/v1/user",
            body = JSONObject(),
            config = config,
            accessToken = accessToken,
            method = "GET"
        )
        if (user.stringOrNull("id") != binding.userId) {
            throw IOException("The authenticator belongs to a different provider session. Sign in again.")
        }
        return user.optJSONArray("factors")?.objects().orEmpty().mapNotNull { factor ->
            val id = factor.stringOrNull("id")
            val type = factor.stringOrNull("factor_type")
            val status = factor.stringOrNull("status")
            if (id.isNullOrBlank() || type != "totp" || status != "verified") null
            else SupabaseMfaFactor(id, factor.stringOrNull("friendly_name"))
        }
    }

    suspend fun challengeAndVerifySupabaseMfa(
        accessToken: String,
        refreshToken: String?,
        factorId: String,
        code: String,
        config: JSONObject
    ): SupabaseAuthTokens {
        val normalizedCode = code.trim()
        require(Regex("^[0-9]{6}$").matches(normalizedCode)) {
            "Enter the six-digit code from your authenticator app."
        }
        val originalBinding = supabaseTokenBinding(accessToken)
        val verifiedFactors = verifiedSupabaseTotpFactors(accessToken, config)
        if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(factorId) || verifiedFactors.none { it.id == factorId }) {
            throw IOException("That verified authenticator is no longer available. Sign in again.")
        }
        val challenge = supabaseRequest(
            path = "/auth/v1/factors/$factorId/challenge",
            body = JSONObject(),
            config = config,
            accessToken = accessToken
        )
        val challengeId = challenge.stringOrNull("id")
            ?: throw IOException("The sign-in provider did not create an authenticator challenge.")
        val verified = supabaseRequest(
            path = "/auth/v1/factors/$factorId/verify",
            body = JSONObject().put("challenge_id", challengeId).put("code", normalizedCode),
            config = config,
            accessToken = accessToken
        )
        val upgradedAccessToken = verified.stringOrNull("access_token")
            ?: throw IOException("The sign-in provider did not return an upgraded session.")
        val upgradedBinding = supabaseTokenBinding(upgradedAccessToken)
        if (
            upgradedBinding.userId != originalBinding.userId ||
            upgradedBinding.sessionId != originalBinding.sessionId ||
            upgradedBinding.aal != "aal2"
        ) {
            throw IOException("Authenticator verification did not upgrade this exact provider session. Sign in again.")
        }
        return SupabaseAuthTokens(
            accessToken = upgradedAccessToken,
            refreshToken = verified.stringOrNull("refresh_token") ?: refreshToken
        )
    }

    private suspend fun syncSupabase(
        accessToken: String,
        config: JSONObject,
        ageConfirmed: Boolean?,
        termsAccepted: Boolean?,
        privacyAccepted: Boolean?,
        existingAppToken: String? = null,
        reauthPurpose: String? = null
    ): AuthResult {
        val hasCompleteConsent = ageConfirmed == true && termsAccepted == true && privacyAccepted == true
        val body = JSONObject().apply {
            put("accessToken", accessToken)
            if (!reauthPurpose.isNullOrBlank()) {
                put("credentialCeremony", "native_memory_v1")
                put("reauthPurpose", reauthPurpose)
            }
            if (hasCompleteConsent) {
                val policyVersion = requiredLegalPolicyVersion(config)
                put("ageConfirmed", true)
                put("termsAccepted", true)
                put("privacyAccepted", true)
                put("termsVersion", policyVersion)
                put("privacyVersion", policyVersion)
                put("consentSource", "android")
            }
        }
        val data = try {
            request(
                path = "/api/business/auth/supabase-session",
                method = "POST",
                body = body,
                token = existingAppToken,
                nativeReauthenticationClient = !reauthPurpose.isNullOrBlank()
            )
        } catch (error: ApiException) {
            if (reauthPurpose != null || error.code != "PROVIDER_GLOBAL_REVOCATION_PENDING") throw error
            val recovery = request(
                path = "/api/business/auth/provider-global-signout-resume",
                method = "POST",
                body = JSONObject().put("accessToken", accessToken)
            )
            if (!recovery.optBoolean("providerSessionsRevoked", false)) throw error
            sessionStore.clearToken()
            throw ApiException(
                401,
                "Security cleanup is complete. Wait one minute, then sign in again.",
                code = "PROVIDER_GLOBAL_REVOCATION_COMPLETED"
            )
        }
        // Hosted provider exchanges are cookie-only. Even if a future server
        // regression adds a JSON token, never let that value replace the
        // platform-protected Set-Cookie credential with a bearer credential.
        return AuthResult(null, data.getJSONObject("account").toAccount())
    }

    suspend fun reauthenticateSupabaseSession(
        accessToken: String,
        purpose: String,
        config: JSONObject,
        existingAppToken: String
    ): AuthResult = syncSupabase(
        accessToken,
        config,
        null,
        null,
        null,
        existingAppToken,
        purpose
    )

    suspend fun logout(token: String) {
        request("/api/business/auth/logout", method = "POST", body = JSONObject(), token = token)
    }

    suspend fun logoutAll(accessToken: String, token: String): Boolean =
        request(
            "/api/business/auth/logout-all",
            method = "POST",
            body = JSONObject().apply {
                if (!accessToken.isNullOrBlank()) put("accessToken", accessToken)
            },
            token = token
        ).optBoolean("providerSessionsRevoked", false)

    suspend fun account(token: String): AccountDashboard =
        request("/api/business/account", token = token).toAccountDashboard()

    suspend fun accountSessions(token: String): List<AccountSession> {
        val pageSize = 100
        var offset = 0L
        val sessions = linkedMapOf<String, AccountSession>()
        while (true) {
            val response = request(
                "/api/business/account/sessions?limit=$pageSize&offset=$offset",
                token = token
            )
            val page = response.optJSONArray("sessions")?.objects()?.map { it.toAccountSession() }.orEmpty()
            page.forEach { sessions.putIfAbsent(it.id, it) }
            val pagination = response.optJSONObject("pagination")
            val hasMore = pagination?.optBoolean("hasMore", page.size == pageSize) ?: (page.size == pageSize)
            if (!hasMore) break
            if (page.isEmpty()) throw IOException("Session pagination stopped making progress. Refresh and try again.")
            val pageOffset = pagination?.optLong("offset", offset) ?: offset
            val nextOffset = runCatching { Math.addExact(pageOffset, page.size.toLong()) }
                .getOrElse { throw IOException("Session pagination returned an invalid next page.") }
            if (nextOffset <= offset) throw IOException("Session pagination returned an invalid next page.")
            offset = nextOffset
        }
        return sessions.values.toList()
    }

    suspend fun revokeAccountSession(sessionId: String, token: String) {
        request("/api/business/account/sessions/${encode(sessionId)}", method = "DELETE", body = JSONObject(), token = token)
    }

    suspend fun accountExport(token: String): JSONObject =
        request("/api/business/account/export", token = token)

    suspend fun savePrivacy(settings: PrivacySettings, token: String): PrivacySettings =
        request(
            path = "/api/business/account/privacy-settings",
            method = "POST",
            body = JSONObject()
                .put("optionalAnalyticsEnabled", settings.optionalAnalyticsEnabled)
                .put("venueReportInclusionEnabled", settings.venueReportInclusionEnabled)
                .put("productResearchEnabled", settings.productResearchEnabled)
                .put("emailUpdatesEnabled", settings.emailUpdatesEnabled),
            token = token
        ).getJSONObject("privacySettings").let {
            PrivacySettings(
                optionalAnalyticsEnabled = it.optBoolean("optionalAnalyticsEnabled", false),
                venueReportInclusionEnabled = it.optBoolean("venueReportInclusionEnabled", false),
                productResearchEnabled = it.optBoolean("productResearchEnabled", false),
                emailUpdatesEnabled = it.optBoolean("emailUpdatesEnabled", false)
            )
        }

    suspend fun requestAccountDeletion(token: String) {
        request(
            path = "/api/business/account/delete-request",
            method = "POST",
            body = JSONObject().put("message", "Self-service deletion review requested from the Android app."),
            token = token
        )
    }

    suspend fun accountDeletionStatus(token: String): AccountDeletionStatus? =
        request("/api/business/account/delete-request", token = token)
            .optJSONObject("request")
            ?.toAccountDeletionStatus()

    suspend fun cancelAccountDeletion(requestId: String, token: String) {
        request(
            "/api/business/account/delete-request/${encode(requestId)}",
            method = "DELETE",
            body = JSONObject(),
            token = token
        )
    }

    suspend fun respondToCounterStaffInvitation(assignmentId: String, decision: String, token: String): JSONObject =
        request(
            "/api/business/account/counter-staff-invitations/${encode(assignmentId)}/respond",
            method = "POST",
            body = JSONObject().put("decision", decision),
            token = token
        )

    suspend fun discountPass(token: String): RotatingCodeResult =
        request("/api/business/account/discount-pass", method = "POST", body = JSONObject(), token = token)
            .toRotatingCodeResult()

    suspend fun freePintRewardCode(token: String): RotatingCodeResult =
        request("/api/business/account/free-pint-reward-code", method = "POST", body = JSONObject(), token = token)
            .toRotatingCodeResult()

    suspend fun venues(query: String? = null): List<Venue> {
        val pageSize = 500
        var offset = 0L
        val venues = linkedMapOf<String, Venue>()
        while (true) {
            val path = buildString {
                append("/api/business/venues?limit=$pageSize&offset=$offset")
                if (!query.isNullOrBlank()) append("&q=").append(encode(query.trim()))
            }
            val response = request(path)
            val page = response.optJSONArray("venues")?.objects()?.map { it.toVenue() }.orEmpty()
            page.forEach { venues.putIfAbsent(it.id, it) }
            val pagination = response.optJSONObject("pagination")
            val hasMore = pagination?.optBoolean("hasMore", page.size == pageSize) ?: (page.size == pageSize)
            if (!hasMore) break
            if (page.isEmpty()) throw IOException("Venue pagination stopped making progress. Refresh and try again.")
            val pageOffset = pagination?.optLong("offset", offset) ?: offset
            val nextOffset = runCatching { Math.addExact(pageOffset, page.size.toLong()) }
                .getOrElse { throw IOException("Venue pagination returned an invalid next page.") }
            if (nextOffset <= offset) throw IOException("Venue pagination returned an invalid next page.")
            offset = nextOffset
        }
        return venues.values.toList()
    }

    suspend fun missions(token: String? = null): List<Mission> {
        val pageSize = 200
        var offset = 0L
        val missions = linkedMapOf<String, Mission>()
        while (true) {
            val response = request("/api/business/missions?limit=$pageSize&offset=$offset", token = token)
            val page = response.optJSONArray("missions")?.objects()?.map { it.toMission() }.orEmpty()
            page.forEach { missions.putIfAbsent(it.id, it) }
            val pagination = response.optJSONObject("pagination")
            val hasMore = pagination?.optBoolean("hasMore", page.size == pageSize) ?: (page.size == pageSize)
            if (!hasMore) break
            if (page.isEmpty()) throw IOException("Mission pagination stopped making progress. Refresh and try again.")
            val pageOffset = pagination?.optLong("offset", offset) ?: offset
            val nextOffset = runCatching { Math.addExact(pageOffset, page.size.toLong()) }
                .getOrElse { throw IOException("Mission pagination returned an invalid next page.") }
            if (nextOffset <= offset) throw IOException("Mission pagination returned an invalid next page.")
            offset = nextOffset
        }
        return missions.values.toList()
    }

    suspend fun acceptMission(missionId: String, token: String) {
        request("/api/business/missions/${encode(missionId)}/accept", "POST", JSONObject(), token)
    }

    suspend fun releaseMission(missionId: String, token: String) {
        request("/api/business/missions/${encode(missionId)}/release", "POST", JSONObject(), token)
    }

    suspend fun priceRecords(venueId: String, anonymousSessionId: String, token: String?): PriceRecordsResult {
        val records = linkedMapOf<String, PriceRecord>()
        val seenCursors = mutableSetOf<String>()
        var cursor: String? = null
        var access: PriceAccessState? = null
        var preview: PricePreview? = null
        var pageCount = 0
        while (true) {
            pageCount += 1
            if (pageCount > 1_000) {
                throw IOException("Price pagination exceeded its safety limit. Refresh and try again.")
            }
            val path = buildString {
                append("/api/business/price-records?venueId=${encode(venueId)}")
                append("&anonymousSessionId=${encode(anonymousSessionId)}&limit=500")
                cursor?.let { append("&cursor=").append(encode(it)) }
            }
            val response = request(path, token = token)
            val page = response.optJSONArray("records")?.objects()?.map { it.toPriceRecord() }.orEmpty()
            page.forEach { records.putIfAbsent(priceRecordIdentityKey(it), it) }
            if (access == null) access = response.optJSONObject("access")?.let {
                PriceAccessState(
                    status = it.stringOrNull("status"),
                    isAuthenticated = it.optBoolean("isAuthenticated", false),
                    accountRole = it.stringOrNull("accountRole"),
                    isAdmin = it.optBoolean("isAdmin", false),
                    hasFullAccess = it.optBoolean("hasFullAccess", false),
                    ageConfirmed = it.optBoolean("ageConfirmed", false),
                    priceAccessModel = it.stringOrNull("priceAccessModel"),
                    canViewAllPrices = it.optBoolean("canViewAllPrices", false),
                    freePreviewScope = it.stringOrNull("freePreviewScope")
                )
            }
            response.optJSONObject("preview")?.let { pagePreview ->
                preview = PricePreview(
                    model = pagePreview.optString("model", preview?.model ?: "fixed_preview"),
                    includedCount = (preview?.includedCount ?: 0) + pagePreview.optInt("includedCount", 0),
                    lockedCount = (preview?.lockedCount ?: 0) + pagePreview.optInt("lockedCount", 0)
                )
            }
            val nextCursor = response.stringOrNull("nextCursor") ?: break
            if (nextCursor == cursor || !seenCursors.add(nextCursor)) {
                throw IOException("Price pagination returned a repeated cursor. Refresh and try again.")
            }
            cursor = nextCursor
        }
        return PriceRecordsResult(records.values.toList(), access, preview, null)
    }

    private fun priceRecordIdentityKey(record: PriceRecord): String {
        if (record.isHappyHourPrice || record.happyHour != null || record.id.startsWith("venue_special:")) {
            return "record:${record.id}"
        }
        val beer = record.normalizedBeerId?.takeIf { it.isNotBlank() }
            ?: normalizedPriceIdentityPart(record.beerName)
        return listOf(
            "beer",
            record.venueId.orEmpty(),
            beer,
            normalizedPriceIdentityPart(record.servingSize)
        ).joinToString(":")
    }

    private fun normalizedPriceIdentityPart(value: String?): String =
        Normalizer.normalize(value.orEmpty(), Normalizer.Form.NFKD)
            .lowercase(Locale.ROOT)
            .filter { it.isLetterOrDigit() }

    suspend fun saveVenue(venue: Venue, token: String) {
        request(
            path = "/api/business/account/saved-items",
            method = "POST",
            body = JSONObject()
                .put("itemType", "venue")
                .put("itemId", venue.id)
                .put("label", venue.name)
                .putNullable("suburb", venue.suburb)
                .put("metadata", JSONObject().put("source", "android_app")),
            token = token
        )
    }

    suspend fun submitPriceUpdate(
        clientSubmissionId: String,
        missionId: String?,
        venue: Venue,
        beerName: String,
        servingSize: String,
        price: Double,
        notes: String?,
        uploadLocation: UploadLocation?,
        token: String
    ) {
        request(
            path = "/api/business/submissions",
            method = "POST",
            body = JSONObject()
                .put("clientSubmissionId", clientSubmissionId)
                .putNullable("missionId", missionId)
                .put("venueId", venue.id)
                .put("venueName", venue.name)
                .putNullable("suburb", venue.suburb)
                .putNullable("newVenue", null)
                .put("submissionType", "single_beer_price")
                .put("observedAt", isoNow())
                .putNullable("sourcePhotoDataUrl", null)
                .put("sourcePhotoDataUrls", org.json.JSONArray())
                .putNullable("sourceDocumentDataUrl", null)
                .putNullable("sourcePhotoUrl", null)
                .putNullable("uploadLocation", uploadLocation?.toJson())
                .putNullable("notes", notes)
                .put(
                    "items",
                    org.json.JSONArray().put(
                        JSONObject()
                            .put("beerName", beerName)
                            .put("servingSize", servingSize)
                            .put("price", price)
                            .put("isHappyHourPrice", false)
                            .putNullable("happyHourDetails", null)
                            .put("isOnTap", "unknown")
                    )
                ),
            token = token
        )
    }

    suspend fun submitPhotoUpload(
        clientSubmissionId: String,
        missionId: String?,
        venue: Venue,
        sourcePhotoDataUrl: String,
        notes: String?,
        uploadLocation: UploadLocation?,
        token: String
    ): JSONObject {
        return request(
            path = "/api/business/submissions",
            method = "POST",
            body = JSONObject()
                .put("clientSubmissionId", clientSubmissionId)
                .putNullable("missionId", missionId)
                .put("venueId", venue.id)
                .put("venueName", venue.name)
                .putNullable("suburb", venue.suburb)
                .putNullable("newVenue", null)
                .put("submissionType", "photo_upload")
                .put("observedAt", isoNow())
                .put("sourcePhotoDataUrl", sourcePhotoDataUrl)
                .put("sourcePhotoDataUrls", org.json.JSONArray())
                .putNullable("sourceDocumentDataUrl", null)
                .putNullable("sourcePhotoUrl", null)
                .putNullable("uploadLocation", uploadLocation?.toJson())
                .putNullable("notes", notes)
                .put("items", org.json.JSONArray()),
            token = token,
            readTimeoutMs = 300_000
        )
    }

    suspend fun submitHappyHourUpdate(
        clientSubmissionId: String,
        missionId: String?,
        venue: Venue,
        days: List<String>,
        startTime: String,
        endTime: String,
        offerText: String,
        notes: String?,
        uploadLocation: UploadLocation?,
        token: String
    ) {
        val detail = "${days.joinToString(", ") { it.uppercase() }} $startTime-$endTime: $offerText"
        request(
            path = "/api/business/submissions",
            method = "POST",
            body = JSONObject()
                .put("clientSubmissionId", clientSubmissionId)
                .putNullable("missionId", missionId)
                .put("venueId", venue.id)
                .put("venueName", venue.name)
                .putNullable("suburb", venue.suburb)
                .putNullable("newVenue", null)
                .put("submissionType", "happy_hour_update")
                .put("observedAt", isoNow())
                .putNullable("sourcePhotoDataUrl", null)
                .put("sourcePhotoDataUrls", org.json.JSONArray())
                .putNullable("sourceDocumentDataUrl", null)
                .putNullable("sourcePhotoUrl", null)
                .putNullable("uploadLocation", uploadLocation?.toJson())
                .putNullable("notes", notes)
                .put(
                    "items",
                    org.json.JSONArray().put(
                        JSONObject()
                            .put("beerName", "Happy-hour offer")
                            .put("servingSize", "other")
                            .putNullable("price", null)
                            .put("isHappyHourPrice", true)
                            .put("happyHourDetails", detail)
                            .put("isOnTap", "unknown")
                    )
                ),
            token = token
        )
    }

    suspend fun reportWrongPrice(venue: Venue, beerName: String?, notes: String?, anonymousSessionId: String, token: String?, priceRecordId: String? = null) {
        request(
            path = "/api/business/wrong-price-reports",
            method = "POST",
            body = JSONObject()
                .put("anonymousSessionId", anonymousSessionId)
                .put("venueId", venue.id)
                .put("venueName", venue.name)
                .putNullable("priceRecordId", priceRecordId)
                .putNullable("beerName", beerName)
                .put("reason", "other")
                .putNullable("notes", notes)
                .putNullable("sourcePhotoDataUrl", null)
                .putNullable("sourcePhotoUrl", null),
            token = token
        )
    }

    suspend fun requestMissing(
        requestType: String,
        venueName: String?,
        beerName: String?,
        suburb: String?,
        notes: String?,
        anonymousSessionId: String,
        token: String?
    ) {
        request(
            path = "/api/business/requests",
            method = "POST",
            body = JSONObject()
                .put("anonymousSessionId", anonymousSessionId)
                .put("requestType", requestType)
                .putNullable("venueId", null)
                .putNullable("venueName", venueName)
                .putNullable("beerName", beerName)
                .putNullable("suburb", suburb)
                .putNullable("notes", notes),
            token = token
        )
    }

    suspend fun portal(token: String, venueId: String? = null): PortalData {
        val path = if (venueId.isNullOrBlank()) {
            "/api/business/venue-portal"
        } else {
            "/api/business/venue-portal?venueId=${encode(venueId)}"
        }
        return request(path, token = token).toPortalData()
    }

    suspend fun saveProfile(profile: BarProfile, venueId: String, token: String) {
        request("/api/business/venue-portal/${encode(venueId)}/profile", "POST", profile.toJson(), token)
    }

    suspend fun saveBeer(beer: BarBeer, venueId: String, token: String) {
        request("/api/business/venue-portal/${encode(venueId)}/beers", "POST", beer.toJson(), token)
    }

    suspend fun saveHappyHour(happyHour: BarHappyHour, venueId: String, token: String) {
        request("/api/business/venue-portal/${encode(venueId)}/happy-hours", "POST", happyHour.toJson(), token)
    }

    suspend fun saveSpecial(special: BarSpecial, venueId: String, token: String) {
        request("/api/business/venue-portal/${encode(venueId)}/specials", "POST", special.toJson(), token)
    }

    suspend fun previewCounterMember(venueId: String, code: String, transactionReference: String, token: String): CounterMemberPreview =
        request(
            "/api/business/venue-portal/${encode(venueId)}/member-preview",
            "POST",
            JSONObject().put("code", code).put("transactionReference", transactionReference),
            token
        ).toCounterMemberPreview()

    suspend fun recordCounterPurchase(
        venueId: String,
        checkoutToken: String,
        itemName: String?,
        beverageCategory: String,
        quantity: Int,
        transactionReference: String,
        notes: String?,
        token: String
    ): CounterPurchaseResult = request(
        "/api/business/venue-portal/${encode(venueId)}/pint-point-drinks",
        "POST",
        JSONObject()
            .put("checkoutToken", checkoutToken)
            .putNullable("itemName", itemName)
            .put("beverageCategory", beverageCategory)
            .put("quantity", quantity)
            .put("transactionReference", transactionReference)
            .putNullable("notes", notes),
        token
    ).toCounterPurchaseResult()

    suspend fun voidCounterPurchase(venueId: String, recordId: String, reason: String, token: String) {
        request(
            "/api/business/venue-portal/${encode(venueId)}/pint-point-drinks/${encode(recordId)}/void",
            "POST",
            JSONObject().put("reason", reason),
            token
        )
    }

    suspend fun decideFreePintReward(venueId: String, code: String, action: String, reason: String?, token: String): CounterRewardResult =
        request(
            "/api/business/venue-portal/${encode(venueId)}/free-pint-rewards",
            "POST",
            JSONObject().put("code", code).put("action", action).putNullable("reason", reason),
            token
        ).toCounterRewardResult()

    suspend fun exportVenueMonthlyReport(venueId: String, month: String, format: String, token: String): String = withContext(Dispatchers.IO) {
        val path = "/api/business/venue-portal/${encode(venueId)}/reports/${encode(month)}/export?format=${encode(format)}"
        val connection = openNonRedirectingHttpConnection(URL(effectiveApiBaseUrl() + path)).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Accept", if (format == "csv") "text/csv" else "application/json")
            applySessionCredential(this, token, allowLegacyUpgrade = false)
        }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (status !in 200..299) {
            val payload = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            val message = payload.optJSONObject("error")?.stringOrNull("message") ?: "Report export failed ($status)."
            throw ApiException(status, message)
        }
        text
    }

    suspend fun feedback(message: String, anonymousSessionId: String, token: String?) {
        request(
            path = "/api/business/feedback",
            method = "POST",
            body = JSONObject()
                .put("anonymousSessionId", anonymousSessionId)
                .put("feedbackType", "general_feedback")
                .put("message", message)
                .putNullable("venueId", null)
                .putNullable("venueName", null),
            token = token
        )
    }

    suspend fun track(eventType: String, anonymousSessionId: String, token: String?, venueId: String? = null, suburb: String? = null) {
        runCatching {
            request(
                path = "/api/business/events",
                method = "POST",
                body = JSONObject()
                    .put("anonymousSessionId", anonymousSessionId)
                    .put("eventType", eventType)
                    .putNullable("venueId", venueId)
                    .putNullable("beerId", null)
                    .putNullable("suburb", suburb)
                    .put("metadata", JSONObject().put("source", "android_app").put("privacyScope", "optional_analytics")),
                token = token
            )
        }
    }

    private suspend fun request(
        path: String,
        method: String = "GET",
        body: JSONObject? = null,
        token: String? = null,
        readTimeoutMs: Int = 20_000,
        nativeReauthenticationClient: Boolean = false
    ): JSONObject = withContext(Dispatchers.IO) {
        val url = URL(effectiveApiBaseUrl() + path)
        val connection = openNonRedirectingHttpConnection(url).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = readTimeoutMs
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "PintPath Android/1.0.0")
            if (nativeReauthenticationClient) {
                require(path == "/api/business/auth/supabase-session") {
                    "Native reauthentication headers are restricted to the provider exchange."
                }
                setRequestProperty("Sec-Pint-Path-Client", "android-native-v1")
            }
            if (!token.isNullOrBlank()) {
                applySessionCredential(
                    this,
                    token,
                    allowLegacyUpgrade = path == "/api/business/auth/supabase-session"
                )
            }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { stream -> stream.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }

        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        val payload = if (text.isBlank()) JSONObject() else runCatching { JSONObject(text) }.getOrNull()
        if (status !in 200..299) {
            val errorPayload = payload?.optJSONObject("error")
            val message = errorPayload?.stringOrNull("message")
                ?: payload?.stringOrNull("error")
                ?: "Request failed ($status)."
            val normalizedMessage = message.lowercase()
            val recovery = errorPayload?.optJSONObject("recovery")
            val recoveryCode = errorPayload?.stringOrNull("code")
            val recoveryVenues = recovery?.optJSONArray("venues")?.objects()?.mapNotNull { venue ->
                val venueId = venue.stringOrNull("venueId")
                val venueName = venue.stringOrNull("venueName")
                if (venueId == null || venueName == null) null else BillingRecoveryVenue(venueId, venueName)
            }.orEmpty()
            val recoveryHasTarget = recovery?.optBoolean("consumer", false) == true || recoveryVenues.isNotEmpty()
            val productionBillingRecovery = (
                recoveryCode == "ACCOUNT_SUSPENDED_BILLING_RECOVERY" && (
                    recovery == null || (recovery.optBoolean("eligible", false) && recoveryHasTarget)
                )
            ) || (
                recoveryCode == "BILLING_RECOVERY_VENUE_SELECTION_REQUIRED" &&
                    recovery?.optBoolean("eligible", false) == true && recoveryVenues.isNotEmpty()
            )
            val legacyBillingRecovery = recoveryCode == null && recovery == null && (
                errorPayload?.optJSONObject("details")?.optBoolean("billingRecoveryEligible", false) == true ||
                    normalizedMessage.contains("billing recovery") ||
                    normalizedMessage.contains("billing management remains available")
                )
            val billingRecoveryEligible = status == 403 && (
                productionBillingRecovery ||
                    legacyBillingRecovery
                )
            val requiresReauthentication = status == 403 && (
                errorPayload?.optJSONObject("details")?.optBoolean("reauthenticationRequired", false) == true ||
                    normalizedMessage.contains("reauthenticat") ||
                    normalizedMessage.contains("fresh provider sign-in") ||
                    normalizedMessage.contains("recent sign-in")
                )
            val requiresMfaStepUp = recoveryCode == "MFA_STEP_UP_REQUIRED"
            val requiresLegalAcceptance = status == 403 &&
                normalizedMessage.contains("accept the current terms") &&
                normalizedMessage.contains("privacy policy")
            throw ApiException(
                status,
                message,
                code = recoveryCode,
                reauthenticationRequired = requiresReauthentication,
                billingRecoveryEligible = billingRecoveryEligible,
                billingRecoveryConsumer = recovery == null || recovery.optBoolean("consumer", false),
                billingRecoveryVenues = recoveryVenues,
                legalAcceptanceRequired = requiresLegalAcceptance,
                mfaStepUpRequired = requiresMfaStepUp
            )
        }
        val responsePayload = payload ?: throw IOException("The server returned an unreadable response.")
        if (responsePayload.optBoolean("ok") == false) {
            val message = responsePayload.optJSONObject("error")?.stringOrNull("message")
                ?: responsePayload.stringOrNull("error")
                ?: "Request failed ($status)."
            throw ApiException(status, message)
        }
        val responseData = responsePayload.optJSONObject("data") ?: JSONObject()
        if (path == "/api/business/auth/supabase-session") {
            val cookieValue = sessionCookieValue(connection, url)
                ?: throw IOException("The secure session response did not contain one valid app cookie.")
            if (!sessionStore.saveSessionCookie(cookieValue)) {
                throw IOException("The secure session response contained an invalid app cookie.")
            }
        }
        responseData
    }

    private fun applySessionCredential(
        connection: HttpURLConnection,
        credential: String,
        allowLegacyUpgrade: Boolean
    ) {
        sessionStore.cookieValue(credential)?.let { cookieValue ->
            connection.setRequestProperty("Cookie", "pint_path_session=$cookieValue")
            return
        }
        sessionStore.localBearerToken(credential)?.let { bearerToken ->
            connection.setRequestProperty("Authorization", "Bearer $bearerToken")
            return
        }
        if (!allowLegacyUpgrade) return
        sessionStore.legacyBearerToken(credential)?.let { bearerToken ->
            // A pre-cookie hosted credential is sent only to the atomic
            // Supabase exchange that replaces it with a tagged cookie.
            connection.setRequestProperty("Authorization", "Bearer $bearerToken")
        }
    }

    private fun sessionCookieValue(connection: HttpURLConnection, requestUrl: URL): String? {
        val candidates = connection.headerFields.entries
            .filter { (name, _) -> name?.equals("Set-Cookie", ignoreCase = true) == true }
            .flatMap { it.value.orEmpty() }
            .mapNotNull { header ->
                val parts = header.split(';').map { it.trim() }
                val separator = parts.firstOrNull()?.indexOf('=') ?: -1
                if (separator <= 0) return@mapNotNull null
                val name = parts.first().substring(0, separator)
                if (name != "pint_path_session") return@mapNotNull null
                val value = parts.first().substring(separator + 1)
                val attributes = parts.drop(1)
                val hasHttpOnly = attributes.any { it.equals("HttpOnly", ignoreCase = true) }
                val hasSecure = attributes.any { it.equals("Secure", ignoreCase = true) }
                val hasRootPath = attributes.any { it.equals("Path=/", ignoreCase = true) }
                val hasLaxSameSite = attributes.any { it.equals("SameSite=Lax", ignoreCase = true) }
                val hasDomain = attributes.any { it.startsWith("Domain=", ignoreCase = true) }
                if (!hasHttpOnly || !hasRootPath || !hasLaxSameSite || hasDomain) return@mapNotNull null
                if (requestUrl.protocol.equals("https", ignoreCase = true) && !hasSecure) return@mapNotNull null
                value
            }
        return candidates.singleOrNull()
    }

    private fun hasSupabaseConfiguration(config: JSONObject): Boolean {
        return SupabasePublicAuthConfigurationResolver.resolve(config) != null
    }

    private fun effectiveApiBaseUrl(): String {
        if (!BuildConfig.DEBUG && baseUrl != APPROVED_PRODUCTION_API_BASE_URL) {
            throw IOException(API_CONFIGURATION_UNAVAILABLE)
        }
        return baseUrl.trimEnd('/')
    }

    private fun requiredLegalPolicyVersion(config: JSONObject): String =
        config.stringOrNull("legalPolicyVersion")?.trim()?.takeIf { it.isNotEmpty() }
            ?: throw IOException(
                "The current Terms and Privacy Policy version is unavailable. Refresh the app and try again."
            )

    private suspend fun supabaseRequest(
        path: String,
        body: JSONObject,
        config: JSONObject,
        accessToken: String? = null,
        method: String = "POST"
    ): JSONObject = withContext(Dispatchers.IO) {
        val publicConfiguration = SupabasePublicAuthConfigurationResolver.resolve(config)
            ?: SupabasePublicAuthConfigurationResolver.unavailable()
        val connection = openNonRedirectingHttpConnection(URL(publicConfiguration.origin + path)).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("apikey", publicConfiguration.publishableKey)
            if (!accessToken.isNullOrBlank() && accessToken != publicConfiguration.publishableKey) {
                setRequestProperty("Authorization", "Bearer $accessToken")
            }
            if (method != "GET") {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        val payload = if (text.isBlank()) JSONObject() else runCatching { JSONObject(text) }.getOrNull()
        if (status !in 200..299) {
            val message = payload?.stringOrNull("msg")
                ?: payload?.stringOrNull("error_description")
                ?: payload?.stringOrNull("message")
                ?: "Authentication failed ($status)."
            throw IOException(message)
        }
        payload ?: throw IOException("The sign-in provider returned an unreadable response.")
    }

    private data class SupabaseTokenBinding(
        val userId: String,
        val sessionId: String,
        val aal: String
    )

    private fun supabaseTokenBinding(accessToken: String): SupabaseTokenBinding {
        val segments = accessToken.split('.')
        if (segments.size != 3) throw IOException("The sign-in provider returned an invalid session token.")
        val payload = runCatching {
            val decoded = Base64.decode(
                segments[1],
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
            )
            JSONObject(String(decoded, Charsets.UTF_8))
        }.getOrElse {
            throw IOException("The sign-in provider returned an invalid session token.")
        }
        val userId = payload.stringOrNull("sub")
        val sessionId = payload.stringOrNull("session_id")
        val aal = payload.stringOrNull("aal")
        if (userId.isNullOrBlank() || sessionId.isNullOrBlank() || aal.isNullOrBlank()) {
            throw IOException("The sign-in provider returned an invalid session token.")
        }
        return SupabaseTokenBinding(userId, sessionId, aal)
    }

    private fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name())

    private fun isoNow(): String = OffsetDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
}
