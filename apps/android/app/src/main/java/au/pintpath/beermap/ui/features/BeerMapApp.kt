@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package au.pintpath.beermap.ui.features

import android.Manifest
import android.app.TimePickerDialog
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Analytics
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LocalBar
import androidx.compose.material.icons.filled.Map
import androidx.compose.material.icons.filled.OpenInBrowser
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.annotation.RequiresApi
import androidx.exifinterface.media.ExifInterface
import au.pintpath.beermap.BuildConfig
import au.pintpath.beermap.data.AccountDashboard
import au.pintpath.beermap.data.AccountDeletionStatus
import au.pintpath.beermap.data.AccountSession
import au.pintpath.beermap.data.ApiException
import au.pintpath.beermap.data.BarBeer
import au.pintpath.beermap.data.BarHappyHour
import au.pintpath.beermap.data.BarProfile
import au.pintpath.beermap.data.BarSpecial
import au.pintpath.beermap.data.BeerMapApiClient
import au.pintpath.beermap.data.BillingRecoveryVenue
import au.pintpath.beermap.data.CounterMemberPreview
import au.pintpath.beermap.data.CounterPurchaseResult
import au.pintpath.beermap.data.CounterRewardResult
import au.pintpath.beermap.data.CounterStaffInvitation
import au.pintpath.beermap.data.Mission
import au.pintpath.beermap.data.PortalData
import au.pintpath.beermap.data.PendingOAuthState
import au.pintpath.beermap.data.PriceRecord
import au.pintpath.beermap.data.PriceRecordsResult
import au.pintpath.beermap.data.PrivacySettings
import au.pintpath.beermap.data.RotatingCodeResult
import au.pintpath.beermap.data.SessionStore
import au.pintpath.beermap.data.UploadLocation
import au.pintpath.beermap.data.Venue
import au.pintpath.beermap.data.stringOrNull
import au.pintpath.beermap.ui.components.AppCard
import au.pintpath.beermap.ui.components.EmptyState
import au.pintpath.beermap.ui.components.FeatureCard
import au.pintpath.beermap.ui.components.FormField
import au.pintpath.beermap.ui.components.LoadingView
import au.pintpath.beermap.ui.components.LocalActionsEnabled
import au.pintpath.beermap.ui.components.MetricCard
import au.pintpath.beermap.ui.components.PrimaryAction
import au.pintpath.beermap.ui.components.SecondaryAction
import au.pintpath.beermap.ui.components.SectionHeader
import au.pintpath.beermap.ui.components.StatusBanner
import au.pintpath.beermap.ui.components.VenueCard
import au.pintpath.beermap.ui.theme.Amber
import au.pintpath.beermap.ui.theme.Leaf
import au.pintpath.beermap.ui.theme.Plum
import au.pintpath.beermap.ui.theme.Sky
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.YearMonth
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private data class PendingLegalAcceptance(
    val accessToken: String,
    val refreshToken: String?
)

class BeerMapState(context: Context) {
    private val api = BeerMapApiClient()
    private val sessions = SessionStore(context)

    val anonymousSessionId: String = sessions.anonymousSessionId()
    var token by mutableStateOf(sessions.loadToken())
    var config by mutableStateOf(JSONObject())
    var venues by mutableStateOf<List<Venue>>(emptyList())
    var missions by mutableStateOf<List<Mission>>(emptyList())
    var accountDashboard by mutableStateOf<AccountDashboard?>(null)
    var accountSessions by mutableStateOf<List<AccountSession>>(emptyList())
    var accountSessionsLoaded by mutableStateOf(false)
        private set
    var accountDeletionRequest by mutableStateOf<AccountDeletionStatus?>(null)
    var portal by mutableStateOf<PortalData?>(null)
    var discountPass by mutableStateOf<RotatingCodeResult?>(null)
    var freePintReward by mutableStateOf<RotatingCodeResult?>(null)
    var counterMemberPreview by mutableStateOf<CounterMemberPreview?>(null)
    var counterPurchaseResult by mutableStateOf<CounterPurchaseResult?>(null)
    var counterRewardResult by mutableStateOf<CounterRewardResult?>(null)
    var selectedVenue by mutableStateOf<Venue?>(null)
    var selectedPrices by mutableStateOf<List<PriceRecord>>(emptyList())
    var selectedPriceResult by mutableStateOf<PriceRecordsResult?>(null)
    var loading by mutableStateOf(false)
    var mutationInFlight by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var reauthenticationContext by mutableStateOf<String?>(null)
    var billingRecoveryGuidance by mutableStateOf<String?>(null)
        private set
    var billingRecoveryUsesProvider by mutableStateOf(false)
        private set
    var billingRecoveryConsumer by mutableStateOf(false)
        private set
    var billingRecoveryVenues by mutableStateOf<List<BillingRecoveryVenue>>(emptyList())
        private set
    var legalAcceptanceRequired by mutableStateOf(false)
        private set
    var legalAcceptanceVersion by mutableStateOf<String?>(null)
        private set
    var optionalAnalytics by mutableStateOf(false)
    private var activeRequests = 0
    private var billingRecoveryAccessToken: String? = null
    private var pendingLegalAcceptance: PendingLegalAcceptance? = null

    val signedIn: Boolean get() = token != null
    val hasAdminAccess: Boolean
        get() = signedIn && accountDashboard?.access?.isAdmin == true
    val hasVenueAccess: Boolean
        get() {
            val currentPortal = portal ?: return false
            if (currentPortal.accessState == "claim_required") return false
            val hasCurrentAdminAuthority = accountDashboard?.access?.isAdmin == true && currentPortal.isAdmin
            val hasAssignedVenue = !currentPortal.isAdmin && currentPortal.assignments.isNotEmpty()
            return hasCurrentAdminAuthority || hasAssignedVenue
        }

    suspend fun start() {
        loadHome()
        token?.let {
            refreshAccount()
            refreshPortal()
        }
    }

    suspend fun loadHome(search: String? = null) = busy {
        config = api.config()
        venues = api.venues(search)
        missions = api.missions(token)
        track("map_viewed")
    }

    suspend fun login(email: String, password: String) = mutate {
        clearBillingRecoveryState()
        clearLegalAcceptanceState()
        try {
            val outcome = api.login(email, password, config)
            val result = outcome.authResult ?: error("Secure sign-in did not return an account session.")
            storeSession(result.token, outcome.refreshToken, outcome.accessToken)
            finishSignIn("Signed in as ${result.account.email}.")
            refreshAccount()
            refreshPortal()
        } catch (throwable: Throwable) {
            if (!presentBillingRecovery(throwable) && !presentLegalAcceptance(throwable)) throw throwable
        }
    }

    suspend fun signup(
        email: String,
        password: String,
        displayName: String?,
        ageConfirmed: Boolean,
        termsAccepted: Boolean,
        privacyAccepted: Boolean
    ) = mutate {
        clearLegalAcceptanceState()
        val outcome = api.signup(
            email,
            password,
            displayName?.trim()?.takeIf { it.isNotBlank() },
            config,
            ageConfirmed,
            termsAccepted,
            privacyAccepted
        )
        val result = outcome.authResult
        if (result == null) {
            message = "Check your email to verify the account, then return here to sign in."
        } else {
            storeSession(result.token, outcome.refreshToken, outcome.accessToken)
            finishSignIn("Account created. Welcome to Pint Path.")
            refreshAccount()
        }
    }

    suspend fun requestPasswordReset(email: String) = mutate {
        require(email.isNotBlank()) { "Enter your email first." }
        api.requestPasswordReset(email.trim(), config)
        message = "If that email has an account, a secure reset link is on its way."
    }

    suspend fun openBillingRecovery(email: String, password: String, venueId: String?): Uri? {
        var portal: Uri? = null
        val providerAccessToken = billingRecoveryAccessToken
        mutate {
            try {
                checkNotNull(billingRecoveryGuidance) { "Billing recovery is not available for this sign-in." }
                val selectedVenueId = venueId?.trim()?.takeIf { it.isNotEmpty() }
                val result = providerAccessToken?.let { accessToken ->
                    api.billingRecoveryPortal(accessToken, selectedVenueId)
                } ?: run {
                    val normalizedEmail = email.trim()
                    require(normalizedEmail.isNotEmpty() && password.isNotEmpty()) {
                        "Enter the suspended account email and password, then choose Manage billing only."
                    }
                    api.billingRecoveryPortal(normalizedEmail, password, selectedVenueId)
                }
                val candidate = Uri.parse(result.portalUrl)
                require(candidate.scheme.equals("https", ignoreCase = true) && !candidate.host.isNullOrBlank()) {
                    "The billing provider did not return a secure portal link."
                }
                portal = candidate
                message = result.message ?: "Billing portal opened without restoring application access."
                clearBillingRecoveryState()
            } catch (throwable: Throwable) {
                if (!presentBillingRecovery(throwable, providerAccessToken)) throw throwable
            }
        }
        return portal
    }

    fun beginOAuth(provider: String): Uri {
        val normalizedProvider = provider.lowercase().takeIf { it == "google" || it == "apple" }
            ?: error("Unsupported sign-in provider.")
        val supabaseUrl = config.stringOrNull("supabaseUrl")?.trimEnd('/')
            ?: BuildConfig.SUPABASE_URL.trimEnd('/').takeIf { it.isNotBlank() }
            ?: error("Secure provider sign-in is temporarily unavailable.")
        val verifierBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val codeVerifier = Base64.encodeToString(verifierBytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val codeChallenge = Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(codeVerifier.toByteArray(Charsets.US_ASCII)),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
        )
        sessions.savePendingOAuth(PendingOAuthState(codeVerifier))
        return Uri.parse("$supabaseUrl/auth/v1/authorize").buildUpon()
            .appendQueryParameter("provider", normalizedProvider)
            .appendQueryParameter("redirect_to", "pintpath://auth-callback")
            .appendQueryParameter("code_challenge", codeChallenge)
            .appendQueryParameter("code_challenge_method", "s256")
            .build()
    }

    suspend fun completeOAuthCallback(uri: Uri) = mutate {
        require(uri.scheme == "pintpath" && uri.host == "auth-callback") { "Invalid sign-in callback." }
        val consent = sessions.loadPendingOAuth()
            ?: error("This provider sign-in was not started in Pint Path. Please try again.")
        val fragment = Uri.parse("https://callback.invalid/?${uri.fragment.orEmpty()}")
        fun callbackParameter(name: String): String? = uri.getQueryParameter(name) ?: fragment.getQueryParameter(name)
        val errorDescription = callbackParameter("error_description") ?: callbackParameter("error")
        if (!errorDescription.isNullOrBlank()) {
            sessions.clearPendingOAuth()
            error(errorDescription.replace('+', ' '))
        }
        val authCode = callbackParameter("code") ?: error("Secure sign-in did not return a one-time authorization code.")
        val tokens = api.exchangeSupabasePKCE(authCode, consent.codeVerifier, config)
        val accessToken = tokens.accessToken ?: error("Secure sign-in did not return a session.")
        sessions.clearPendingOAuth()
        clearBillingRecoveryState()
        clearLegalAcceptanceState()
        try {
            val outcome = api.completeOAuthSession(
                accessToken = accessToken,
                refreshToken = tokens.refreshToken,
                config = config
            )
            val result = outcome.authResult ?: error("Secure sign-in did not return an account.")
            storeSession(result.token, outcome.refreshToken, outcome.accessToken)
            finishSignIn("Signed in as ${result.account.email}.")
            refreshAccount()
            refreshPortal()
        } catch (throwable: Throwable) {
            if (!presentBillingRecovery(throwable, accessToken) &&
                !presentLegalAcceptance(throwable, accessToken, tokens.refreshToken)
            ) throw throwable
        }
    }

    suspend fun acceptCurrentPolicies(ageConfirmed: Boolean, termsAccepted: Boolean, privacyAccepted: Boolean) = mutate {
        require(ageConfirmed && termsAccepted && privacyAccepted) {
            "Confirm 18+ and accept the current Terms and Privacy Policy to continue."
        }
        val pending = pendingLegalAcceptance ?: error(
            "Your verified sign-in expired. Sign in again to review the current policies."
        )
        try {
            val outcome = api.acceptCurrentPolicies(pending.accessToken, config)
            val result = outcome.authResult ?: error("Secure sign-in did not return an account.")
            clearLegalAcceptanceState()
            storeSession(result.token, pending.refreshToken, pending.accessToken)
            finishSignIn("Current Terms and Privacy Policy accepted. Signed in as ${result.account.email}.")
            refreshAccount()
            refreshPortal()
        } catch (throwable: Throwable) {
            if (!presentBillingRecovery(throwable, pending.accessToken)) throw throwable
        }
    }

    fun cancelPendingLegalAcceptance() {
        clearLegalAcceptanceState()
        error = null
        message = "Sign-in cancelled. No Pint Path session was created."
    }

    suspend fun logout() = mutate {
        sessions.loadSupabaseAccessToken()?.let { accessToken ->
            runCatching { api.supabaseLogout(accessToken, config) }
        }
        token?.let { runCatching { api.logout(it) } }
        clearLocalSession()
        message = "Signed out."
    }

    suspend fun logoutAllSessions() = mutate {
        val current = token ?: error("Login required.")
        sensitiveAction("sign out all devices") {
            api.logoutAll(currentReauthenticationToken(), current)
        }
        clearLocalSession()
        message = "Signed out on every device."
    }

    suspend fun signOutForReauthentication() = mutate {
        val pendingContext = reauthenticationContext ?: "complete the sensitive account action"
        sessions.loadSupabaseAccessToken()?.let { accessToken ->
            runCatching { api.supabaseLogout(accessToken, config) }
        }
        token?.let { runCatching { api.logout(it) } }
        clearLocalSession()
        reauthenticationContext = pendingContext
        message = "Sign back in to $pendingContext. Pint Path will not complete it until you retry."
    }

    suspend fun refreshAccount() {
        val current = token ?: return
        optionalAnalytics = false
        try {
            accountDashboard = api.account(current)
            if (accountDashboard?.access?.isAdmin != true && portal?.isAdmin == true) portal = null
            accountDeletionRequest = runCatching { api.accountDeletionStatus(current) }.getOrNull()
            optionalAnalytics = accountDashboard?.privacySettings?.optionalAnalyticsEnabled ?: false
        } catch (throwable: Throwable) {
            if (throwable is ApiException && throwable.status == 401 && refreshSession()) {
                try {
                    val refreshed = token ?: error("Your refreshed session is unavailable.")
                    accountDashboard = api.account(refreshed)
                    if (accountDashboard?.access?.isAdmin != true && portal?.isAdmin == true) portal = null
                    accountDeletionRequest = runCatching { api.accountDeletionStatus(refreshed) }.getOrNull()
                    optionalAnalytics = accountDashboard?.privacySettings?.optionalAnalyticsEnabled ?: false
                } catch (refreshError: Throwable) {
                    accountDashboard = null
                    portal = null
                    optionalAnalytics = false
                    error = refreshError.message ?: "Could not reload account authority."
                }
            } else {
                portal = null
                optionalAnalytics = false
                error = throwable.message ?: "Could not load account."
            }
        }
    }

    suspend fun loadAccountSessions() = busy {
        val current = token ?: error("Login required.")
        accountSessions = emptyList()
        accountSessionsLoaded = false
        accountSessions = sensitiveAction("review signed-in sessions") {
            api.accountSessions(current, currentReauthenticationToken())
        }
        accountSessionsLoaded = true
        clearReauthenticationContext("review signed-in sessions")
    }

    suspend fun savePrivacy(settings: PrivacySettings) = mutate {
        val current = token ?: error("Login required.")
        api.savePrivacy(settings, current)
        accountDashboard = api.account(current)
        optionalAnalytics = settings.optionalAnalyticsEnabled
        message = "Privacy settings saved."
    }

    suspend fun requestDeletion() = mutate {
        val current = token ?: error("Login required.")
        sensitiveAction("request account deletion") {
            api.requestAccountDeletion(current, currentReauthenticationToken())
        }
        accountDeletionRequest = api.accountDeletionStatus(current)
        message = "Account deletion review requested. You can cancel while it remains pending."
        clearReauthenticationContext("request account deletion")
    }

    suspend fun cancelDeletion() = mutate {
        val current = token ?: error("Login required.")
        val request = accountDeletionRequest ?: error("No deletion request is available.")
        sensitiveAction("cancel account deletion") {
            api.cancelAccountDeletion(request.id, current, currentReauthenticationToken())
        }
        accountDeletionRequest = api.accountDeletionStatus(current)
        message = "Account deletion request cancelled."
        clearReauthenticationContext("cancel account deletion")
    }

    suspend fun respondToCounterStaffInvitation(assignmentId: String, venueId: String, decision: String) = mutate {
        val current = token ?: error("Login required.")
        val response = api.respondToCounterStaffInvitation(assignmentId, decision, current)
        accountDashboard = api.account(current)
        if (decision == "accept") refreshPortal(venueId)
        message = response.stringOrNull("message")
            ?: if (decision == "accept") "Counter access accepted." else "Invitation declined."
    }

    suspend fun prepareAccountExport(): String? {
        var export: String? = null
        mutate {
            val current = token ?: error("Login required.")
            export = sensitiveAction("prepare your account export") {
                api.accountExport(current, currentReauthenticationToken()).toString(2)
            }
            message = "Your private account export is ready to save."
            clearReauthenticationContext("prepare your account export")
        }
        return export
    }

    suspend fun revokeSession(session: AccountSession) = mutate {
        val current = token ?: error("Login required.")
        sensitiveAction("revoke a signed-in session") {
            api.revokeAccountSession(session.id, current, currentReauthenticationToken())
        }
        if (session.current) {
            clearLocalSession()
            message = "This session was revoked. Sign in again to continue."
        } else {
            accountSessions = api.accountSessions(current, currentReauthenticationToken())
            accountSessionsLoaded = true
            message = "Session revoked."
            clearReauthenticationContext("revoke a signed-in session")
        }
    }

    suspend fun generateDiscountPass() = mutate {
        val current = token ?: error("Sign in before generating a Pint Path special code.")
        discountPass = api.discountPass(current)
        message = "Pint Path special code generated. Show it only when staff are ready."
        refreshAccount()
    }

    suspend fun generateFreePintReward() = mutate {
        val current = token ?: error("Sign in before creating a Free Pint Reward code.")
        freePintReward = api.freePintRewardCode(current)
        message = "Free Pint Reward code created. Venue staff still complete age, ID, and RSA checks."
        refreshAccount()
    }

    suspend fun loadPrices(venue: Venue) = mutate {
        selectedVenue = venue
        selectedPrices = emptyList()
        selectedPriceResult = null
        selectedPriceResult = api.priceRecords(venue.id, anonymousSessionId, token)
        selectedPrices = selectedPriceResult?.records.orEmpty()
        track("venue_detail_opened", venue.id, venue.suburb)
    }

    suspend fun saveVenue(venue: Venue) = mutate {
        val current = token ?: error("Sign in to save venues.")
        api.saveVenue(venue, current)
        message = "Saved ${venue.name}."
        refreshAccount()
    }

    suspend fun submitPriceUpdate(
        clientSubmissionId: String,
        missionId: String?,
        venueId: String,
        beerName: String,
        servingSize: String,
        priceText: String,
        notes: String,
        uploadLocation: UploadLocation?
    ) = mutate {
        val current = token ?: error("Sign in before submitting venue data.")
        val venue = venues.firstOrNull { it.id == venueId } ?: error("Choose a venue before submitting.")
        val trimmedBeer = beerName.trim()
        if (trimmedBeer.isBlank()) error("Add the beer name before submitting.")
        val price = priceText.replace("$", "").trim().toDoubleOrNull()
            ?: error("Add a valid observed price.")
        api.submitPriceUpdate(clientSubmissionId, missionId, venue, trimmedBeer, servingSize, price, notes.blankToNull(), uploadLocation, current)
        message = "Price update sent for review."
        refreshAccount()
    }

    suspend fun submitPhotoUpload(clientSubmissionId: String, missionId: String?, venueId: String, sourcePhotoDataUrl: String, notes: String, uploadLocation: UploadLocation?) = mutate {
        val current = token ?: error("Sign in before uploading source evidence.")
        val venue = venues.firstOrNull { it.id == venueId } ?: error("Choose a venue before uploading.")
        api.submitPhotoUpload(clientSubmissionId, missionId, venue, sourcePhotoDataUrl, notes.blankToNull(), uploadLocation, current)
        message = "Source photo sent for review."
        refreshAccount()
    }

    suspend fun submitHappyHourUpdate(
        clientSubmissionId: String,
        missionId: String?,
        venueId: String,
        days: List<String>,
        startTime: String,
        endTime: String,
        offerText: String,
        notes: String,
        uploadLocation: UploadLocation?
    ) = mutate {
        val current = token ?: error("Sign in before submitting happy-hour updates.")
        val venue = venues.firstOrNull { it.id == venueId } ?: error("Choose a venue before submitting.")
        if (days.isEmpty()) error("Choose at least one day.")
        if (offerText.isBlank()) error("Add the offer details before submitting.")
        api.submitHappyHourUpdate(clientSubmissionId, missionId, venue, days, startTime, endTime, offerText.trim(), notes.blankToNull(), uploadLocation, current)
        message = "Happy-hour update sent for review."
        refreshAccount()
    }

    suspend fun reportWrongPrice(venueId: String, beerName: String, notes: String, priceRecordId: String? = null) = mutate {
        val venue = venues.firstOrNull { it.id == venueId } ?: error("Choose a venue before reporting.")
        api.reportWrongPrice(venue, beerName.blankToNull(), notes.blankToNull(), anonymousSessionId, token, priceRecordId)
        message = "Wrong-price report sent."
    }

    suspend fun requestMissing(requestType: String, venueName: String, beerName: String, suburb: String, notes: String) = mutate {
        val trimmedVenue = venueName.trim()
        val trimmedBeer = beerName.trim()
        if (requestType == "missing_beer" && trimmedBeer.isBlank()) error("Add the beer name before sending the request.")
        if (requestType != "missing_beer" && trimmedVenue.isBlank()) error("Add the venue name before sending the request.")
        api.requestMissing(
            requestType = requestType,
            venueName = trimmedVenue.blankToNull(),
            beerName = trimmedBeer.blankToNull(),
            suburb = suburb.blankToNull(),
            notes = notes.blankToNull(),
            anonymousSessionId = anonymousSessionId,
            token = token
        )
        message = if (requestType == "missing_beer") "Beer request sent." else "Venue request sent."
    }

    suspend fun acceptMission(mission: Mission) = mutate {
        val current = token ?: error("Sign in before reserving a mission.")
        api.acceptMission(mission.id, current)
        missions = api.missions(current)
        message = "Mission reserved for 24 hours. Submit the linked update before it expires."
    }

    suspend fun releaseMission(mission: Mission) = mutate {
        val current = token ?: error("Sign in before releasing a mission.")
        api.releaseMission(mission.id, current)
        missions = api.missions(current)
        message = "Mission released for another contributor."
    }

    suspend fun refreshPortal(venueId: String? = null) {
        val current = token ?: return
        runCatching { api.portal(current, venueId) }
            .recoverCatching { throwable ->
                if (throwable is ApiException && throwable.status == 401 && refreshSession()) {
                    api.portal(token ?: error("Your refreshed session is unavailable."), venueId)
                } else {
                    throw throwable
                }
            }
            .onSuccess { portal = it }
            .onFailure {
                portal = null
                error = it.message ?: "Could not load venue dashboard."
            }
    }

    suspend fun saveProfile(profile: BarProfile) = mutate {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("No selected venue.")
        api.saveProfile(profile, venueId, current)
        refreshPortal(venueId)
        message = "Venue profile saved."
    }

    suspend fun saveBeer(beer: BarBeer) = mutate {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("No selected venue.")
        api.saveBeer(beer, venueId, current)
        refreshPortal(venueId)
        message = "Beer row saved."
    }

    suspend fun saveHappyHour(happyHour: BarHappyHour) = mutate {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("No selected venue.")
        api.saveHappyHour(happyHour, venueId, current)
        refreshPortal(venueId)
        message = "Happy hour saved."
    }

    suspend fun saveSpecial(special: BarSpecial) = mutate {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("No selected venue.")
        api.saveSpecial(special, venueId, current)
        refreshPortal(venueId)
        message = "Pint Path special saved."
    }

    suspend fun prepareVenueReportExport(month: String, format: String): String? {
        var export: String? = null
        mutate {
            val current = token ?: error("Login required.")
            val venueId = portal?.selectedVenue?.venueId ?: error("Choose an assigned venue first.")
            export = api.exportVenueMonthlyReport(venueId, month, format, current)
            message = "Monthly report ready to save."
        }
        return export
    }

    suspend fun previewCounterMember(code: String, transactionReference: String) = mutate {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("Choose an assigned venue first.")
        counterMemberPreview = api.previewCounterMember(venueId, code.trim().uppercase(), transactionReference.trim(), current)
        counterPurchaseResult = null
        message = "Member code checked. Confirm the purchase details before recording."
    }

    suspend fun recordCounterPurchase(itemName: String, category: String, quantity: Int, transactionReference: String, notes: String) = mutate {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("Choose an assigned venue first.")
        val preview = counterMemberPreview ?: error("Check the member code first.")
        counterPurchaseResult = api.recordCounterPurchase(
            venueId,
            preview.checkoutToken,
            itemName.blankToNull(),
            category,
            quantity,
            transactionReference.trim(),
            notes.blankToNull(),
            current
        )
        counterMemberPreview = null
        refreshPortal(venueId)
        message = counterPurchaseResult?.copy ?: "Purchase recorded."
    }

    suspend fun voidCounterPurchase(reason: String) = mutate {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("Choose an assigned venue first.")
        val recordId = counterPurchaseResult?.recordId ?: error("No recent purchase is available to reverse.")
        api.voidCounterPurchase(venueId, recordId, reason.trim(), current)
        counterPurchaseResult = null
        refreshPortal(venueId)
        message = "Purchase reversed with an audit record."
    }

    suspend fun decideFreePintReward(code: String, action: String, reason: String) = mutate {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("Choose an assigned venue first.")
        counterRewardResult = api.decideFreePintReward(
            venueId,
            code.trim().uppercase(),
            action,
            reason.blankToNull(),
            current
        )
        refreshPortal(venueId)
        message = counterRewardResult?.copy ?: "Reward decision recorded."
    }

    suspend fun sendFeedback(text: String) = mutate {
        api.feedback(text, anonymousSessionId, token)
        message = "Support note sent."
    }

    private suspend fun track(eventType: String, venueId: String? = null, suburb: String? = null) {
        val current = token
        if (optionalAnalytics && current != null) api.track(eventType, anonymousSessionId, current, venueId, suburb)
    }

    private fun presentBillingRecovery(throwable: Throwable, providerAccessToken: String? = null): Boolean {
        val apiError = throwable as? ApiException
        if (apiError?.billingRecoveryEligible != true) return false
        // Billing recovery is deliberately not authentication: discard any old app
        // authority before retaining the short-lived provider credential in memory.
        clearLocalSession()
        billingRecoveryAccessToken = providerAccessToken ?: apiError.billingRecoveryAccessToken
        billingRecoveryUsesProvider = billingRecoveryAccessToken != null
        billingRecoveryConsumer = apiError.billingRecoveryConsumer
        billingRecoveryVenues = apiError.billingRecoveryVenues
        billingRecoveryGuidance = apiError.message
            ?: "Account access is suspended. Billing-only recovery remains available."
        error = billingRecoveryGuidance
        message = null
        return true
    }

    private fun clearBillingRecoveryState() {
        billingRecoveryAccessToken = null
        billingRecoveryGuidance = null
        billingRecoveryUsesProvider = false
        billingRecoveryConsumer = false
        billingRecoveryVenues = emptyList()
    }

    private fun presentLegalAcceptance(
        throwable: Throwable,
        providerAccessToken: String? = null,
        providerRefreshToken: String? = null
    ): Boolean {
        val apiError = throwable as? ApiException
        if (apiError?.legalAcceptanceRequired != true) return false
        val accessToken = providerAccessToken ?: apiError.legalAcceptanceAccessToken ?: return false
        // No Pint Path authority is kept until this exact verified provider credential
        // accepts the version currently advertised by the backend.
        clearLocalSession()
        pendingLegalAcceptance = PendingLegalAcceptance(
            accessToken,
            providerRefreshToken ?: apiError.legalAcceptanceRefreshToken
        )
        legalAcceptanceRequired = true
        legalAcceptanceVersion = config.stringOrNull("legalPolicyVersion")
        error = apiError.message ?: "Accept the current Terms and Privacy Policy before continuing."
        message = null
        return true
    }

    private fun clearLegalAcceptanceState() {
        pendingLegalAcceptance = null
        legalAcceptanceRequired = false
        legalAcceptanceVersion = null
    }

    private fun currentReauthenticationToken(): String =
        sessions.loadSupabaseAccessToken()?.takeIf { it.isNotBlank() }
            ?: throw ApiException(
                403,
                "A fresh provider sign-in is required for this sensitive action.",
                reauthenticationRequired = true
            )

    private suspend fun <T> sensitiveAction(action: String, block: suspend () -> T): T {
        return try {
            block()
        } catch (throwable: Throwable) {
            if (throwable is ApiException && throwable.reauthenticationRequired) {
                reauthenticationContext = action
                throw ApiException(
                    403,
                    "For your security, sign out and sign back in to $action. Nothing was completed; retry after signing in.",
                    reauthenticationRequired = true
                )
            }
            throw throwable
        }
    }

    private fun clearReauthenticationContext(action: String) {
        if (reauthenticationContext == action) {
            reauthenticationContext = null
            error = null
        }
    }

    private fun finishSignIn(defaultMessage: String) {
        message = reauthenticationContext?.let { pendingContext ->
            "Signed in. You can now $pendingContext; Pint Path has not run it automatically."
        } ?: defaultMessage
        reauthenticationContext = null
        error = null
    }

    private suspend fun busy(block: suspend () -> Unit): Boolean {
        activeRequests += 1
        loading = true
        error = null
        return try {
            block()
            true
        } catch (throwable: Throwable) {
            if (throwable is ApiException && throwable.status == 401 && refreshSession()) {
                runCatching { block() }.fold(
                    onSuccess = { true },
                    onFailure = {
                        if (it is ApiException && it.status == 401) clearLocalSession()
                        error = it.message ?: "Something went wrong."
                        false
                    }
                )
            } else {
                if (throwable is ApiException && throwable.status == 401) clearLocalSession()
                error = throwable.message ?: "Something went wrong."
                false
            }
        } finally {
            activeRequests = (activeRequests - 1).coerceAtLeast(0)
            loading = activeRequests > 0
        }
    }

    private suspend fun mutate(block: suspend () -> Unit): Boolean {
        if (mutationInFlight) return false
        mutationInFlight = true
        return try {
            busy(block)
        } finally {
            mutationInFlight = false
        }
    }

    private suspend fun refreshSession(): Boolean {
        val refreshToken = sessions.loadSupabaseRefreshToken() ?: run {
            clearLocalSession()
            return false
        }
        val currentAppToken = token ?: run {
            clearLocalSession()
            return false
        }
        return runCatching {
            val outcome = api.refreshSupabaseSession(refreshToken, config, currentAppToken)
            val result = outcome.authResult ?: return@runCatching false
            storeSession(result.token, outcome.refreshToken ?: refreshToken, outcome.accessToken, resetAuthority = false)
            true
        }.getOrDefault(false).also { refreshed ->
            if (!refreshed) {
                clearLocalSession()
            }
        }
    }

    private fun storeSession(
        appToken: String,
        refreshToken: String?,
        accessToken: String?,
        resetAuthority: Boolean = true
    ) {
        clearBillingRecoveryState()
        clearLegalAcceptanceState()
        sessions.saveToken(appToken)
        sessions.saveSupabaseRefreshToken(refreshToken)
        sessions.saveSupabaseAccessToken(accessToken)
        token = appToken
        if (resetAuthority) {
            // A newly authenticated account must fetch fresh authority and consent.
            accountDashboard = null
            accountSessions = emptyList()
            accountSessionsLoaded = false
            portal = null
            optionalAnalytics = false
        }
    }

    private fun clearLocalSession() {
        sessions.clearToken()
        token = null
        clearBillingRecoveryState()
        clearLegalAcceptanceState()
        accountDashboard = null
        accountSessions = emptyList()
        accountSessionsLoaded = false
        accountDeletionRequest = null
        portal = null
        discountPass = null
        freePintReward = null
        counterMemberPreview = null
        counterPurchaseResult = null
        counterRewardResult = null
        selectedPrices = emptyList()
        selectedPriceResult = null
        optionalAnalytics = false
        reauthenticationContext = null
    }

}

private enum class AppTab(val label: String) {
    Discover("Find"),
    Contribute("Add"),
    Bars("Bars"),
    Admin("Admin"),
    Account("Account"),
    Settings("Help")
}

@Composable
fun BeerMapApp(oauthCallback: Uri? = null, onOAuthCallbackConsumed: () -> Unit = {}) {
    val context = LocalContext.current.applicationContext
    val state = remember { BeerMapState(context) }
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(AppTab.Discover) }

    LaunchedEffect(Unit) {
        state.start()
    }
    LaunchedEffect(oauthCallback) {
        oauthCallback?.let {
            state.completeOAuthCallback(it)
            onOAuthCallbackConsumed()
        }
    }
    LaunchedEffect(state.hasVenueAccess) {
        if (!state.hasVenueAccess && tab == AppTab.Bars) tab = AppTab.Account
    }
    LaunchedEffect(state.hasAdminAccess) {
        if (!state.hasAdminAccess && tab == AppTab.Admin) tab = AppTab.Account
    }

    CompositionLocalProvider(LocalActionsEnabled provides !state.loading) {
    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == AppTab.Discover,
                    onClick = { tab = AppTab.Discover },
                    icon = { Icon(Icons.Filled.Search, contentDescription = null) },
                    label = { Text(AppTab.Discover.label) }
                )
                NavigationBarItem(
                    selected = tab == AppTab.Contribute,
                    onClick = { tab = AppTab.Contribute },
                    icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                    label = { Text(AppTab.Contribute.label) }
                )
                if (state.hasVenueAccess) {
                    NavigationBarItem(
                        selected = tab == AppTab.Bars,
                        onClick = { tab = AppTab.Bars },
                        icon = { Icon(Icons.Filled.Storefront, contentDescription = null) },
                        label = { Text(AppTab.Bars.label) }
                    )
                }
                if (state.hasAdminAccess) {
                    NavigationBarItem(
                        selected = tab == AppTab.Admin,
                        onClick = { tab = AppTab.Admin },
                        icon = { Icon(Icons.Filled.AdminPanelSettings, contentDescription = null) },
                        label = { Text(AppTab.Admin.label) }
                    )
                }
                NavigationBarItem(
                    selected = tab == AppTab.Account,
                    onClick = { tab = AppTab.Account },
                    icon = { Icon(Icons.Filled.AccountCircle, contentDescription = null) },
                    label = { Text(AppTab.Account.label) }
                )
                NavigationBarItem(
                    selected = tab == AppTab.Settings,
                    onClick = { tab = AppTab.Settings },
                    icon = { Icon(Icons.Filled.Settings, contentDescription = null) },
                    label = { Text(AppTab.Settings.label) }
                )
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (state.loading) {
                LoadingView("Updating Pint Path")
            }
            state.error?.let { StatusBanner(it, isError = true) }
            state.message?.let { StatusBanner(it) }

            when (tab) {
                AppTab.Discover -> DiscoverScreen(state, scope)
                AppTab.Account -> AccountScreen(state, scope)
                AppTab.Contribute -> ContributeScreen(state, scope)
                AppTab.Bars -> if (state.hasVenueAccess) VenuePortalScreen(state, scope) else AccountScreen(state, scope)
                AppTab.Admin -> if (state.hasAdminAccess) AdminQuickAccessScreen() else AccountScreen(state, scope)
                AppTab.Settings -> SettingsScreen(state, scope)
            }
        }
    }
    }
}

@Composable
private fun AdminQuickAccessScreen() {
    val context = LocalContext.current
    val adminSignInUri = remember {
        Uri.parse("${BuildConfig.PINT_PATH_API_BASE_URL.trimEnd('/')}/account.html?returnTo=%2Fadmin.html")
    }

    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            AppCard {
                SectionHeader(
                    eyebrow = "Admin access",
                    title = "Open Pint Path admin",
                    subtitle = "Your current app account has server-verified admin authority. Administration remains in the full secure web workspace.",
                    icon = Icons.Filled.AdminPanelSettings
                )
                StatusBanner(
                    "Only accounts confirmed as admins by the Pint Path server receive this tab.",
                    icon = Icons.Filled.Lock
                )
                PrimaryAction("Open admin workspace", icon = Icons.Filled.OpenInBrowser) {
                    context.startActivity(Intent(Intent.ACTION_VIEW, adminSignInUri))
                }
                Text(
                    "Your browser may ask you to sign in again before returning directly to the Admin workspace.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun DiscoverScreen(state: BeerMapState, scope: CoroutineScope) {
    var search by remember { mutableStateOf("") }
    val submitSearch: () -> Unit = {
        scope.launch { state.loadHome(search.takeIf { it.isNotBlank() }) }
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            AppCard {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        SectionHeader(
                            eyebrow = "Pint Path",
                            title = "Find the right bar faster",
                            subtitle = "Melbourne beer prices, happy hours, and venue updates using the same server-gated data as the website.",
                            icon = Icons.Filled.LocalBar
                        )
                    }
                }
                FeatureCard("Venue list", "Search Melbourne venues, review server-gated price rows, save favourites, and open directions in your maps app.", Icons.Filled.Search, Sky)
            }
        }
        item {
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = submitSearch) {
                        Icon(Icons.Filled.Search, contentDescription = "Search")
                    }
                },
                label = { Text("Search venue or suburb") },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Text,
                    imeAction = ImeAction.Search
                ),
                keyboardActions = KeyboardActions(onSearch = { submitSearch() }),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    MetricCard("Listed venues", state.venues.size.toString(), Icons.Filled.Business, Sky)
                }
                Column(Modifier.weight(1f)) {
                    MetricCard("Missions", state.missions.size.toString(), Icons.Filled.Star, Leaf)
                }
            }
        }
        state.selectedVenue?.let { venue ->
            item {
                VenueDetailCard(state, scope, venue)
            }
        }
        if (state.venues.isEmpty()) {
            item { EmptyState("No venues found", "Try another venue or suburb, or check the connection.", Icons.Filled.Search) }
        } else {
            items(state.venues, key = { it.id }) { venue ->
                VenueCard(
                    venue = venue,
                    onOpen = { scope.launch { state.loadPrices(venue) } },
                    onSave = { scope.launch { state.saveVenue(venue) } }
                )
            }
        }
    }
}

@Composable
private fun VenueDetailCard(state: BeerMapState, scope: CoroutineScope, venue: Venue) {
    val context = LocalContext.current
    val actionsEnabled = LocalActionsEnabled.current
    var pendingReport by remember(venue.id) { mutableStateOf<PriceRecord?>(null) }
    pendingReport?.let { record ->
        AlertDialog(
            onDismissRequest = { pendingReport = null },
            title = { Text("Report this displayed price?") },
            text = { Text("Pint Path will send the exact price row for review. No public change is made until it is checked.") },
            confirmButton = {
                TextButton(onClick = {
                    pendingReport = null
                    scope.launch {
                        state.reportWrongPrice(
                            venue.id,
                            record.beerName.orEmpty(),
                            "Displayed price looks incorrect.",
                            record.id
                        )
                    }
                }, enabled = actionsEnabled) { Text("Send report") }
            },
            dismissButton = { TextButton(onClick = { pendingReport = null }) { Text("Cancel") } }
        )
    }
    AppCard {
        SectionHeader("Venue", venue.name, venue.address ?: venue.location, Icons.Filled.Business)
        if ((state.selectedPriceResult?.preview?.lockedCount ?: 0) > 0) {
            StatusBanner("Some prices remain Premium outside the fixed preview.", icon = Icons.Filled.Lock)
        }
        if (state.selectedPrices.isEmpty()) {
            EmptyState("No price rows yet", "This venue needs a trusted update.", Icons.Filled.Lock, framed = false)
        } else {
            state.selectedPrices.forEach { record ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text(record.beerName ?: "Beer", fontWeight = FontWeight.Bold)
                        Text(listOfNotNull(record.servingSize, record.happyHour).joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(record.formattedPrice, fontWeight = FontWeight.Black, color = if (record.priceRedacted) Plum else Leaf)
                        if (!record.priceRedacted) {
                            TextButton(onClick = { pendingReport = record }, enabled = actionsEnabled) { Text("Report") }
                        }
                    }
                }
                HorizontalDivider()
            }
        }
        SecondaryAction("Refresh prices", icon = Icons.Filled.Refresh) {
            scope.launch { state.loadPrices(venue) }
        }
        if ((venue.latitude != null && venue.longitude != null) || !venue.address.isNullOrBlank()) {
            SecondaryAction("Open in Maps", icon = Icons.Filled.Map) {
                val mapQuery = if (venue.latitude != null && venue.longitude != null) {
                    "${venue.latitude},${venue.longitude}"
                } else {
                    listOfNotNull(venue.name, venue.address).joinToString(", ")
                }
                val geoUri = Uri.parse("geo:0,0?q=${Uri.encode(mapQuery)}")
                val mapIntent = Intent(Intent.ACTION_VIEW, geoUri)
                if (mapIntent.resolveActivity(context.packageManager) != null) {
                    context.startActivity(mapIntent)
                } else {
                    val browserUri = Uri.parse("https://www.google.com/maps/search/?api=1&query=${Uri.encode(mapQuery)}")
                    context.startActivity(Intent(Intent.ACTION_VIEW, browserUri))
                }
            }
        }
    }
}

@Composable
private fun ContributeScreen(state: BeerMapState, scope: CoroutineScope) {
    val context = LocalContext.current
    var mode by remember { mutableStateOf("Price") }
    var selectedVenueId by remember { mutableStateOf("") }
    var beerName by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var serving by remember { mutableStateOf("pint") }
    var notes by remember { mutableStateOf("") }
    var sourcePhotoDataUrl by remember { mutableStateOf<String?>(null) }
    var sourcePhotoStatus by remember { mutableStateOf("Choose a clear menu, receipt, tap-list, or happy-hour board photo.") }
    var sourcePhotoPreparationJob by remember { mutableStateOf<Job?>(null) }
    var happyOffer by remember { mutableStateOf("") }
    var happyNotes by remember { mutableStateOf("") }
    var happyStart by remember { mutableStateOf("16:00") }
    var happyEnd by remember { mutableStateOf("18:00") }
    var happyDays by remember { mutableStateOf(emptySet<String>()) }
    var requestKind by remember { mutableStateOf("missing_venue") }
    var requestVenue by remember { mutableStateOf("") }
    var requestBeer by remember { mutableStateOf("") }
    var requestSuburb by remember { mutableStateOf("") }
    var requestNotes by remember { mutableStateOf("") }
    var priceSubmissionId by remember { mutableStateOf("android-${UUID.randomUUID()}") }
    var photoSubmissionId by remember { mutableStateOf("android-photo-${UUID.randomUUID()}") }
    var happyHourSubmissionId by remember { mutableStateOf("android-happy-${UUID.randomUUID()}") }
    var acceptedMissionId by remember { mutableStateOf<String?>(null) }
    var uploadLocation by remember { mutableStateOf<UploadLocation?>(null) }
    var locationStatus by remember { mutableStateOf("Optional. Attach a one-time location fix only if you want location-based review proof.") }
    val fetchLocation: suspend () -> Unit = {
        runCatching { oneTimeLocation(context) }
            .onSuccess {
                uploadLocation = it
                locationStatus = "One-time location proof ready (${it.accuracyMeters?.roundLabel() ?: "unknown"} m accuracy)."
            }
            .onFailure {
                uploadLocation = null
                locationStatus = it.message ?: "Could not get a one-time location fix."
            }
    }
    val locationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        if (permissions.values.any { it }) scope.launch { fetchLocation() }
        else locationStatus = "Location access was not granted. You can still submit without it."
    }
    val requestLocationProof: () -> Unit = {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (granted) scope.launch { fetchLocation() }
        else locationPermissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            sourcePhotoPreparationJob?.cancel()
            sourcePhotoDataUrl = null
            sourcePhotoStatus = "Preparing photo for review..."
            sourcePhotoPreparationJob = scope.launch {
                runCatching {
                    sourcePhotoDataUrlFromUri(context, uri)
                }.onSuccess {
                    sourcePhotoDataUrl = it
                    sourcePhotoStatus = "Photo ready for private reviewer evidence."
                }.onFailure {
                    if (it is kotlinx.coroutines.CancellationException) return@onFailure
                    sourcePhotoDataUrl = null
                    sourcePhotoStatus = it.message ?: "Could not prepare this photo."
                }
            }
        }
    }

    LaunchedEffect(state.venues) {
        if (selectedVenueId.isBlank() || state.venues.none { it.id == selectedVenueId }) {
            selectedVenueId = state.venues.firstOrNull()?.id.orEmpty()
        }
    }

    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            AppCard {
                SectionHeader(
                    eyebrow = "Contribute",
                    title = "Keep Pint Path current",
                    subtitle = "Send updates through the same reviewed backend workflow as the website.",
                    icon = Icons.Filled.Add
                )
            }
        }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(listOf("Price", "Photo", "Happy hour", "Report", "Request", "Missions")) { label ->
                    FilterChip(selected = mode == label, onClick = { mode = label }, label = { Text(label) })
                }
            }
        }
        if (mode == "Price" || mode == "Photo" || mode == "Happy hour") {
            item {
                LocationProofCard(
                    proof = uploadLocation,
                    status = locationStatus,
                    onAttach = requestLocationProof,
                    onRemove = {
                        uploadLocation = null
                        locationStatus = "Location proof removed. This submission will not include device location."
                    }
                )
            }
        }
        item {
            when (mode) {
                "Photo" -> PhotoUploadCard(
                    state = state,
                    scope = scope,
                    clientSubmissionId = photoSubmissionId,
                    missionId = acceptedMissionId,
                    uploadLocation = uploadLocation,
                    selectedVenueId = selectedVenueId,
                    onVenueSelected = { selectedVenueId = it },
                    sourcePhotoDataUrl = sourcePhotoDataUrl,
                    sourcePhotoStatus = sourcePhotoStatus,
                    notes = notes,
                    onNotes = { notes = it },
                    onChoosePhoto = {
                        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    },
                    onSubmitted = {
                        sourcePhotoDataUrl = null
                        sourcePhotoStatus = "Choose a clear menu, receipt, tap-list, or happy-hour board photo."
                        notes = ""
                        photoSubmissionId = "android-photo-${UUID.randomUUID()}"
                        acceptedMissionId = null
                        uploadLocation = null
                    }
                )
                "Happy hour" -> HappyHourSubmissionCard(
                    state = state,
                    scope = scope,
                    clientSubmissionId = happyHourSubmissionId,
                    missionId = acceptedMissionId,
                    uploadLocation = uploadLocation,
                    selectedVenueId = selectedVenueId,
                    onVenueSelected = { selectedVenueId = it },
                    selectedDays = happyDays,
                    onSelectedDays = { happyDays = it },
                    start = happyStart,
                    onStart = { happyStart = it },
                    end = happyEnd,
                    onEnd = { happyEnd = it },
                    offer = happyOffer,
                    onOffer = { happyOffer = it },
                    notes = happyNotes,
                    onNotes = { happyNotes = it },
                    onSubmitted = {
                        happyOffer = ""
                        happyNotes = ""
                        happyDays = emptySet()
                        happyHourSubmissionId = "android-happy-${UUID.randomUUID()}"
                        acceptedMissionId = null
                        uploadLocation = null
                    }
                )
                "Report" -> ReportWrongPriceCard(state, scope, selectedVenueId, { selectedVenueId = it }, beerName, { beerName = it }, notes, { notes = it })
                "Request" -> MissingRequestCard(
                    state = state,
                    scope = scope,
                    requestKind = requestKind,
                    onRequestKind = { requestKind = it },
                    venueName = requestVenue,
                    onVenueName = { requestVenue = it },
                    beerName = requestBeer,
                    onBeerName = { requestBeer = it },
                    suburb = requestSuburb,
                    onSuburb = { requestSuburb = it },
                    notes = requestNotes,
                    onNotes = { requestNotes = it },
                    onSubmitted = {
                        requestVenue = ""
                        requestBeer = ""
                        requestSuburb = ""
                        requestNotes = ""
                    }
                )
                "Missions" -> MissionsCard(
                    state = state,
                    scope = scope,
                    acceptedMissionId = acceptedMissionId,
                    onAccepted = { mission ->
                        acceptedMissionId = mission.id
                        selectedVenueId = mission.venueId.orEmpty()
                        mode = if (mission.reason?.contains("happy", ignoreCase = true) == true) "Happy hour" else "Price"
                    },
                    onReleased = { mission ->
                        if (acceptedMissionId == mission.id) acceptedMissionId = null
                    }
                )
                else -> SubmitPriceCard(
                    state = state,
                    scope = scope,
                    clientSubmissionId = priceSubmissionId,
                    missionId = acceptedMissionId,
                    uploadLocation = uploadLocation,
                    selectedVenueId = selectedVenueId,
                    onVenueSelected = { selectedVenueId = it },
                    beerName = beerName,
                    onBeerName = { beerName = it },
                    price = price,
                    onPrice = { price = it },
                    serving = serving,
                    onServing = { serving = it },
                    notes = notes,
                    onNotes = { notes = it },
                    onSubmitted = {
                        beerName = ""
                        price = ""
                        serving = "pint"
                        notes = ""
                        priceSubmissionId = "android-${UUID.randomUUID()}"
                        acceptedMissionId = null
                        uploadLocation = null
                    }
                )
            }
        }
    }
}

@Composable
private fun PhotoUploadCard(
    state: BeerMapState,
    scope: CoroutineScope,
    clientSubmissionId: String,
    missionId: String?,
    uploadLocation: UploadLocation?,
    selectedVenueId: String,
    onVenueSelected: (String) -> Unit,
    sourcePhotoDataUrl: String?,
    sourcePhotoStatus: String,
    notes: String,
    onNotes: (String) -> Unit,
    onChoosePhoto: () -> Unit,
    onSubmitted: () -> Unit
) {
    AppCard {
        SectionHeader(
            eyebrow = "Source photo",
            title = "Upload a menu or board",
            subtitle = if (state.signedIn) "The app sends one private reviewer image." else "Sign in first so the source upload can be reviewed.",
            icon = Icons.Filled.PhotoCamera
        )
        VenueChoiceChips(state.venues, selectedVenueId, onVenueSelected)
        SecondaryAction(if (sourcePhotoDataUrl == null) "Choose photo" else "Replace photo", icon = Icons.Filled.PhotoCamera) {
            onChoosePhoto()
        }
        StatusBanner(sourcePhotoStatus, isError = sourcePhotoStatus.startsWith("Could not"), icon = if (sourcePhotoDataUrl == null) Icons.Filled.PhotoCamera else Icons.Filled.CheckCircle)
        OutlinedTextField(notes, onNotes, label = { Text("What should reviewers look for?") }, minLines = 3, modifier = Modifier.fillMaxWidth())
        PrimaryAction("Upload source for review", state.signedIn && selectedVenueId.isNotBlank() && sourcePhotoDataUrl != null, Icons.Filled.Add) {
            sourcePhotoDataUrl?.let { dataUrl ->
                scope.launch {
                    if (state.submitPhotoUpload(clientSubmissionId, missionId, selectedVenueId, dataUrl, notes, uploadLocation)) onSubmitted()
                }
            }
        }
        StatusBanner("One-time location proof is optional and never tracked in the background.")
    }
}

@Composable
private fun LocationProofCard(
    proof: UploadLocation?,
    status: String,
    onAttach: () -> Unit,
    onRemove: () -> Unit
) {
    AppCard {
        SectionHeader(
            eyebrow = "Optional proof",
            title = "One-time location",
            subtitle = "Requested only when you tap attach; Pint Path does not request background location.",
            icon = Icons.Filled.Map
        )
        StatusBanner(status, isError = status.startsWith("Could not") || status.contains("not granted"), icon = Icons.Filled.Map)
        if (proof == null) {
            SecondaryAction("Attach current location", icon = Icons.Filled.Map, onClick = onAttach)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onAttach, modifier = Modifier.weight(1f)) { Text("Refresh") }
                TextButton(onClick = onRemove, modifier = Modifier.weight(1f)) { Text("Remove") }
            }
        }
    }
}

@Composable
private fun HappyHourSubmissionCard(
    state: BeerMapState,
    scope: CoroutineScope,
    clientSubmissionId: String,
    missionId: String?,
    uploadLocation: UploadLocation?,
    selectedVenueId: String,
    onVenueSelected: (String) -> Unit,
    selectedDays: Set<String>,
    onSelectedDays: (Set<String>) -> Unit,
    start: String,
    onStart: (String) -> Unit,
    end: String,
    onEnd: (String) -> Unit,
    offer: String,
    onOffer: (String) -> Unit,
    notes: String,
    onNotes: (String) -> Unit,
    onSubmitted: () -> Unit
) {
    val context = LocalContext.current
    val days = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")
    AppCard {
        SectionHeader(
            eyebrow = "Happy hour",
            title = "Submit a special you saw",
            subtitle = if (state.signedIn) "Fast path for signs, boards, and staff-confirmed recurring offers." else "Sign in first to submit happy-hour updates.",
            icon = Icons.Filled.Timer
        )
        VenueChoiceChips(state.venues, selectedVenueId, onVenueSelected)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(days) { day ->
                FilterChip(
                    selected = selectedDays.contains(day),
                    onClick = {
                        onSelectedDays(
                            if (selectedDays.contains(day)) selectedDays - day else selectedDays + day
                        )
                    },
                    label = { Text(day.uppercase()) }
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { showTimePicker(context, start, onStart) }, modifier = Modifier.weight(1f)) { Text("Starts $start") }
            Button(onClick = { showTimePicker(context, end, onEnd) }, modifier = Modifier.weight(1f)) { Text("Ends $end") }
        }
        OutlinedTextField(offer, onOffer, label = { Text("Offer details") }, minLines = 3, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(notes, onNotes, label = { Text("Notes, optional") }, minLines = 2, modifier = Modifier.fillMaxWidth())
        PrimaryAction("Send happy-hour update", state.signedIn && selectedVenueId.isNotBlank() && selectedDays.isNotEmpty() && offer.isNotBlank(), Icons.Filled.Timer) {
            scope.launch {
                if (state.submitHappyHourUpdate(clientSubmissionId, missionId, selectedVenueId, selectedDays.sorted(), start, end, offer, notes, uploadLocation)) onSubmitted()
            }
        }
        StatusBanner("If the board has lots of detail, Photo is usually faster and safer.")
    }
}

@Composable
private fun SubmitPriceCard(
    state: BeerMapState,
    scope: CoroutineScope,
    clientSubmissionId: String,
    missionId: String?,
    uploadLocation: UploadLocation?,
    selectedVenueId: String,
    onVenueSelected: (String) -> Unit,
    beerName: String,
    onBeerName: (String) -> Unit,
    price: String,
    onPrice: (String) -> Unit,
    serving: String,
    onServing: (String) -> Unit,
    notes: String,
    onNotes: (String) -> Unit,
    onSubmitted: () -> Unit
) {
    AppCard {
        SectionHeader(
            eyebrow = "Price update",
            title = "Submit an observed beer price",
            subtitle = if (state.signedIn) "Submissions stay pending until reviewed." else "Sign in first so the update can be attached to your account.",
            icon = Icons.Filled.LocalBar
        )
        VenueChoiceChips(state.venues, selectedVenueId, onVenueSelected)
        OutlinedTextField(beerName, onBeerName, label = { Text("Beer name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(
            price,
            onPrice,
            label = { Text("Observed price") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(listOf("pint", "pot", "schooner", "jug", "bottle", "can", "other")) { size ->
                FilterChip(selected = serving == size, onClick = { onServing(size) }, label = { Text(size.replaceFirstChar { it.uppercase() }) })
            }
        }
        OutlinedTextField(notes, onNotes, label = { Text("Notes, optional") }, minLines = 3, modifier = Modifier.fillMaxWidth())
        PrimaryAction("Send for review", state.signedIn && selectedVenueId.isNotBlank() && beerName.isNotBlank() && price.isNotBlank(), Icons.Filled.Add) {
            scope.launch {
                if (state.submitPriceUpdate(clientSubmissionId, missionId, selectedVenueId, beerName, serving, price, notes, uploadLocation)) onSubmitted()
            }
        }
        StatusBanner("For stronger evidence, add a source photo or optional one-time location proof.")
    }
}

@Composable
private fun ReportWrongPriceCard(
    state: BeerMapState,
    scope: CoroutineScope,
    selectedVenueId: String,
    onVenueSelected: (String) -> Unit,
    beerName: String,
    onBeerName: (String) -> Unit,
    notes: String,
    onNotes: (String) -> Unit
) {
    AppCard {
        SectionHeader("Correction", "Report wrong venue data", "Use this when a displayed price, beer, or happy-hour detail looks off.", Icons.Filled.Refresh)
        VenueChoiceChips(state.venues, selectedVenueId, onVenueSelected)
        OutlinedTextField(beerName, onBeerName, label = { Text("Beer or item, optional") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(notes, onNotes, label = { Text("What should admin know?") }, minLines = 3, modifier = Modifier.fillMaxWidth())
        PrimaryAction("Send report", selectedVenueId.isNotBlank() && notes.trim().length >= 3, Icons.Filled.Refresh) {
            scope.launch { state.reportWrongPrice(selectedVenueId, beerName, notes) }
        }
    }
}

@Composable
private fun MissingRequestCard(
    state: BeerMapState,
    scope: CoroutineScope,
    requestKind: String,
    onRequestKind: (String) -> Unit,
    venueName: String,
    onVenueName: (String) -> Unit,
    beerName: String,
    onBeerName: (String) -> Unit,
    suburb: String,
    onSuburb: (String) -> Unit,
    notes: String,
    onNotes: (String) -> Unit,
    onSubmitted: () -> Unit
) {
    AppCard {
        SectionHeader("Request", "Ask Pint Path to add something", "Missing venue and missing beer requests use the same queue as the website.", Icons.Filled.Storefront)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = requestKind == "missing_venue", onClick = { onRequestKind("missing_venue") }, label = { Text("Venue") })
            FilterChip(selected = requestKind == "missing_beer", onClick = { onRequestKind("missing_beer") }, label = { Text("Beer") })
        }
        if (requestKind == "missing_beer") {
            OutlinedTextField(beerName, onBeerName, label = { Text("Beer name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            OutlinedTextField(venueName, onVenueName, label = { Text("Venue name, optional") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        } else {
            OutlinedTextField(venueName, onVenueName, label = { Text("Venue name") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        }
        OutlinedTextField(suburb, onSuburb, label = { Text("Suburb, optional") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(notes, onNotes, label = { Text("Notes, optional") }, minLines = 3, modifier = Modifier.fillMaxWidth())
        PrimaryAction("Send request", if (requestKind == "missing_beer") beerName.isNotBlank() else venueName.isNotBlank(), Icons.Filled.Add) {
            scope.launch {
                if (state.requestMissing(requestKind, venueName, beerName, suburb, notes)) onSubmitted()
            }
        }
    }
}

@Composable
private fun MissionsCard(
    state: BeerMapState,
    scope: CoroutineScope,
    acceptedMissionId: String?,
    onAccepted: (Mission) -> Unit,
    onReleased: (Mission) -> Unit
) {
    AppCard {
        SectionHeader("Missions", "Venues needing data", "These are pulled from the existing mission endpoint.", Icons.Filled.Star)
        if (state.missions.isEmpty()) {
            EmptyState("No missions loaded yet", "Refresh discovery or check the backend connection.", Icons.Filled.Star, framed = false)
        } else {
            state.missions.take(12).forEach { mission ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(mission.venueName, fontWeight = FontWeight.Bold)
                    Text(listOfNotNull(mission.suburb, mission.reason).joinToString(" - "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    mission.points?.let { Text("${it.roundLabel()} pts", color = Amber, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium) }
                    if (mission.userProgress == "accepted" || acceptedMissionId == mission.id) {
                        StatusBanner("Reserved until ${mission.reservationExpiresAt ?: "24 hours after acceptance"}", icon = Icons.Filled.Timer)
                        TextButton(onClick = {
                            scope.launch {
                                if (state.releaseMission(mission)) onReleased(mission)
                            }
                        }) { Text("Release mission") }
                    } else {
                        PrimaryAction(
                            if (state.signedIn) "Reserve mission" else "Sign in to reserve",
                            state.signedIn && !mission.venueId.isNullOrBlank(),
                            Icons.Filled.CheckCircle
                        ) {
                            scope.launch {
                                if (state.acceptMission(mission)) onAccepted(mission)
                            }
                        }
                    }
                }
                HorizontalDivider()
            }
        }
    }
}

@Composable
private fun VenueChoiceChips(venues: List<Venue>, selectedVenueId: String, onSelected: (String) -> Unit) {
    if (venues.isEmpty()) {
        StatusBanner("No venues loaded yet. Refresh discovery before sending venue-specific updates.", isError = true)
        return
    }

    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(venues.take(12), key = { it.id }) { venue ->
            AssistChip(
                onClick = { onSelected(venue.id) },
                label = { Text(if (venue.id == selectedVenueId) "${venue.name} (selected)" else venue.name) }
            )
        }
    }
}

@Composable
private fun AccountScreen(state: BeerMapState, scope: CoroutineScope) {
    val context = LocalContext.current
    var confirmLogout by remember { mutableStateOf(false) }
    var confirmDeletion by remember { mutableStateOf(false) }
    var pendingExport by remember { mutableStateOf<String?>(null) }
    val exportLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) {
            runCatching {
                context.contentResolver.openOutputStream(uri)?.bufferedWriter()?.use { writer ->
                    writer.write(pendingExport.orEmpty())
                } ?: error("Could not open the selected export file.")
            }.onSuccess {
                state.message = "Account export saved."
            }.onFailure {
                state.error = it.message ?: "Could not save the account export."
            }
        }
        pendingExport = null
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Log out of Pint Path?") },
            text = { Text("Your saved session will be removed from this device. You can sign back in any time.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogout = false
                    scope.launch { state.logout() }
                }) {
                    Text("Log out")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmLogout = false }) { Text("Cancel") }
            }
        )
    }

    if (confirmDeletion) {
        AlertDialog(
            onDismissRequest = { confirmDeletion = false },
            title = { Text("Request account deletion review?") },
            text = { Text("Pint Path will create the same manual deletion review used by the website. Legal, security, billing, and moderation records may be retained when required.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDeletion = false
                    scope.launch { state.requestDeletion() }
                }) {
                    Text("Request review")
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDeletion = false }) { Text("Cancel") }
            }
        )
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        state.reauthenticationContext?.let { action ->
            AppCard {
                SectionHeader(
                    "Security check",
                    "Sign in again to continue",
                    "Pint Path did not $action. A fresh provider sign-in is required before you retry.",
                    Icons.Filled.Lock
                )
                if (state.signedIn) {
                    PrimaryAction("Sign out and sign in again", icon = Icons.Filled.Lock) {
                        scope.launch { state.signOutForReauthentication() }
                    }
                } else {
                    Text(
                        "Use the sign-in form below, then retry the action. It will not run automatically.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
        val dashboard = state.accountDashboard
        if (!state.signedIn || dashboard == null) {
            AuthCard(state, scope)
        } else {
            SectionHeader("Account", dashboard.account.displayName ?: dashboard.account.email, "Contribution progress, privacy, and session controls.", Icons.Filled.AccountCircle)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    MetricCard("Monthly points", dashboard.account.contributionPointsCurrentMonth?.roundLabel() ?: "0", Icons.Filled.Star, Amber)
                }
                Column(Modifier.weight(1f)) {
                    MetricCard("Saved", dashboard.savedCount.toString(), Icons.Filled.Bookmark, Sky)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    MetricCard("Uploads", (dashboard.stats?.totalSubmissions ?: dashboard.submissionCount).toString(), Icons.Filled.Add, Leaf)
                }
                Column(Modifier.weight(1f)) {
                    MetricCard("Trust", dashboard.stats?.trustScore?.roundLabel() ?: dashboard.account.trustScore?.roundLabel() ?: "0", Icons.Filled.Lock, Plum)
                }
            }
            SpecialAccessCard(state, scope, dashboard)
            if (dashboard.counterStaffInvitations.isNotEmpty()) {
                CounterStaffInvitationsCard(state, scope, dashboard.counterStaffInvitations)
            }
            PrivacyCard(state, scope, dashboard.privacySettings)
            AccountSessionsCard(state, scope)
            AccountDeletionStatusCard(state, scope)
            AppCard {
                SecondaryAction("Save account export", icon = Icons.Filled.Bookmark) {
                    scope.launch {
                        state.prepareAccountExport()?.let { json ->
                            pendingExport = json
                            exportLauncher.launch("pint-path-account-export.json")
                        }
                    }
                }
                SecondaryAction("Refresh account", icon = Icons.Filled.Refresh) {
                    scope.launch {
                        state.refreshAccount()
                        state.refreshPortal()
                    }
                }
                if (state.accountDeletionRequest == null || state.accountDeletionRequest?.status == "cancelled") {
                    SecondaryAction("Request account deletion review", icon = Icons.Filled.Lock) { confirmDeletion = true }
                }
                PrimaryAction("Log out", icon = Icons.Filled.AccountCircle) { confirmLogout = true }
            }
        }
    }
}

@Composable
private fun CounterStaffInvitationsCard(
    state: BeerMapState,
    scope: CoroutineScope,
    invitations: List<CounterStaffInvitation>
) {
    AppCard {
        SectionHeader(
            "Venue access",
            "Counter invitations",
            "Accept only invitations from venues you recognise. Counter access cannot edit venue data or view private analytics.",
            Icons.Filled.Storefront
        )
        invitations.forEach { invitation ->
            Text(invitation.venueName, fontWeight = FontWeight.Bold)
            Text(
                listOfNotNull(invitation.suburb, invitation.expiresAt?.let { "Expires $it" }).joinToString(" · "),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    onClick = { scope.launch { state.respondToCounterStaffInvitation(invitation.id, invitation.venueId, "accept") } },
                    modifier = Modifier.weight(1f)
                ) { Text("Accept") }
                TextButton(
                    onClick = { scope.launch { state.respondToCounterStaffInvitation(invitation.id, invitation.venueId, "decline") } },
                    modifier = Modifier.weight(1f)
                ) { Text("Decline") }
            }
            HorizontalDivider()
        }
    }
}

@Composable
private fun AccountDeletionStatusCard(state: BeerMapState, scope: CoroutineScope) {
    val request = state.accountDeletionRequest ?: return
    if (request.status == "cancelled") return
    val label = when (request.status) {
        "pending_review" -> "Pending review"
        "approved" -> "Approved for processing"
        "processing" -> "Processing"
        "completed" -> "Completed"
        "failed" -> "Needs attention"
        else -> request.status.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
    AppCard {
        SectionHeader(
            "Account deletion",
            label,
            request.executeAfter?.let { "Earliest processing date: $it" },
            Icons.Filled.Lock
        )
        StatusBanner(
            request.lastError ?: "Request ID ${request.id}. This status stays visible while review and processing progress.",
            isError = !request.lastError.isNullOrBlank(),
            icon = Icons.Filled.Lock
        )
        if (request.status in setOf("pending_review", "approved", "failed")) {
            SecondaryAction("Cancel deletion request", icon = Icons.Filled.Refresh) {
                scope.launch { state.cancelDeletion() }
            }
        }
    }
}

@Composable
private fun AccountSessionsCard(state: BeerMapState, scope: CoroutineScope) {
    val actionsEnabled = LocalActionsEnabled.current
    var confirmLogoutAll by remember { mutableStateOf(false) }
    if (confirmLogoutAll) {
        AlertDialog(
            onDismissRequest = { confirmLogoutAll = false },
            title = { Text("Sign out on every device?") },
            text = { Text("This revokes every active Pint Path session, including this device. You will need to sign in again everywhere.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogoutAll = false
                    scope.launch { state.logoutAllSessions() }
                }, enabled = actionsEnabled) { Text("Sign out all devices") }
            },
            dismissButton = {
                TextButton(onClick = { confirmLogoutAll = false }) { Text("Cancel") }
            }
        )
    }
    AppCard {
        SectionHeader("Security", "Signed-in sessions", "Review and revoke devices you no longer use.", Icons.Filled.Lock)
        if (!state.accountSessionsLoaded) {
            Text(
                "Session details are protected. Load them only when you want to review device access.",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            SecondaryAction("Review signed-in sessions", icon = Icons.Filled.Lock) {
                scope.launch { state.loadAccountSessions() }
            }
        } else if (state.accountSessions.isEmpty()) {
            Text("No active session details are available yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            state.accountSessions.forEach { session ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(if (session.current) "This device" else "Signed-in device", fontWeight = FontWeight.Bold)
                        Text(
                            session.lastUsedAt?.let { "Last used $it" }
                                ?: session.createdAt?.let { "Created $it" }
                                ?: "Session details unavailable",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (session.active) {
                        TextButton(onClick = { scope.launch { state.revokeSession(session) } }, enabled = actionsEnabled) {
                            Text(if (session.current) "Sign out" else "Revoke")
                        }
                    }
                }
                HorizontalDivider()
            }
        }
        if (state.accountSessionsLoaded) {
            SecondaryAction("Refresh session list", icon = Icons.Filled.Refresh) {
                scope.launch { state.loadAccountSessions() }
            }
        }
        SecondaryAction("Sign out all devices", icon = Icons.Filled.Lock) {
            confirmLogoutAll = true
        }
    }
}

@Composable
private fun SpecialAccessCard(state: BeerMapState, scope: CoroutineScope, dashboard: AccountDashboard) {
    AppCard {
        SectionHeader(
            eyebrow = "Member specials",
            title = "Codes and Pint Points",
            subtitle = "Generate a short-lived code only when venue staff are ready to redeem it.",
            icon = Icons.Filled.Star
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) {
                MetricCard("Estimated saved", moneyFromCents(dashboard.discounts?.estimatedSavingsCents ?: 0), Icons.Filled.Bookmark, Leaf)
            }
            Column(Modifier.weight(1f)) {
                MetricCard("Pint Points", "${dashboard.pintPoints?.available ?: 0}/${dashboard.pintPoints?.threshold ?: 50}", Icons.Filled.Star, Amber)
            }
        }
        state.discountPass?.let { RotatingCodeCard("Pint Path special", it) }
        state.freePintReward?.let { RotatingCodeCard("Free Pint Reward", it) }
        SecondaryAction(if (dashboard.discounts?.eligible == true) "Generate special" else "Special locked", dashboard.discounts?.eligible == true, Icons.Filled.Tag) {
            scope.launch { state.generateDiscountPass() }
        }
        PrimaryAction(if (dashboard.pintPoints?.rewardAvailable == true) "Create Free Pint Reward" else "Reward locked", dashboard.pintPoints?.rewardAvailable == true, Icons.Filled.Star) {
            scope.launch { state.generateFreePintReward() }
        }
    }
}

@Composable
private fun RotatingCodeCard(title: String, result: RotatingCodeResult) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = Amber, fontWeight = FontWeight.Black)
        Text(
            result.code,
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Black,
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(8.dp))
                .padding(vertical = 12.dp),
            color = MaterialTheme.colorScheme.onPrimary
        )
        result.copy?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        result.expiresAt?.let { Text("Expires $it", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun AuthCard(state: BeerMapState, scope: CoroutineScope) {
    val context = LocalContext.current
    val actionsEnabled = LocalActionsEnabled.current
    var createAccount by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var age by remember { mutableStateOf(false) }
    var terms by remember { mutableStateOf(false) }
    var privacy by remember { mutableStateOf(false) }
    var billingRecoveryVenueId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(
        state.billingRecoveryGuidance,
        state.billingRecoveryConsumer,
        state.billingRecoveryVenues
    ) {
        val selectedStillAvailable = state.billingRecoveryVenues.any {
            it.venueId == billingRecoveryVenueId
        }
        if (!selectedStillAvailable) {
            billingRecoveryVenueId = if (!state.billingRecoveryConsumer && state.billingRecoveryVenues.size == 1) {
                state.billingRecoveryVenues.first().venueId
            } else {
                null
            }
        }
    }

    AppCard {
        if (state.legalAcceptanceRequired) {
            SectionHeader(
                "Verified account",
                "Review the current policies",
                "Your provider identity is verified. Accept the current version before Pint Path creates an app session.",
                Icons.Filled.Lock
            )
            StatusBanner(
                "Policy version ${state.legalAcceptanceVersion ?: "current"} is required. Your sign-in credential is held only in memory until you decide.",
                icon = Icons.Filled.CheckCircle
            )
            CheckRow("I confirm I am 18 or older", age) { age = it }
            CheckRow("I accept the current Terms", terms) { terms = it }
            CheckRow("I accept the current Privacy Policy", privacy) { privacy = it }
            PolicyLinks(context)
            PrimaryAction(
                "Accept and continue",
                age && terms && privacy,
                Icons.Filled.CheckCircle
            ) {
                scope.launch {
                    state.acceptCurrentPolicies(age, terms, privacy)
                    if (!state.legalAcceptanceRequired) {
                        age = false
                        terms = false
                        privacy = false
                    }
                }
            }
            SecondaryAction("Cancel sign-in", icon = Icons.Filled.Lock) {
                age = false
                terms = false
                privacy = false
                state.cancelPendingLegalAcceptance()
            }
        } else {
            SectionHeader("Pint Path account", if (createAccount) "Create account" else "Welcome back", "Use the same account and venue assignments as the website.", Icons.Filled.AccountCircle)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !createAccount, onClick = {
                    createAccount = false
                    password = ""
                    confirmPassword = ""
                    age = false
                    terms = false
                    privacy = false
                }, label = { Text("Sign in") })
                FilterChip(selected = createAccount, onClick = {
                    createAccount = true
                    password = ""
                    confirmPassword = ""
                }, label = { Text("Create") })
            }
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("Email") },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    imeAction = ImeAction.Next,
                    autoCorrectEnabled = false
                ),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Password") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = if (createAccount) ImeAction.Next else ImeAction.Done,
                    autoCorrectEnabled = false
                ),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            if (createAccount) {
                OutlinedTextField(
                    value = confirmPassword,
                    onValueChange = { confirmPassword = it },
                    label = { Text("Confirm password") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                        autoCorrectEnabled = false
                    ),
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true
                )
                FormField("Display name, optional", Icons.Filled.AccountCircle, displayName, { displayName = it })
                CheckRow("I confirm I am 18 or older", age) { age = it }
                CheckRow("I accept the current Terms", terms) { terms = it }
                CheckRow("I accept the current Privacy Policy", privacy) { privacy = it }
                PolicyLinks(context)
            }
            PrimaryAction(
                if (createAccount) "Create account" else "Sign in",
                email.isNotBlank() && password.isNotBlank() && (!createAccount || (
                    confirmPassword.isNotBlank() && age && terms && privacy
                )),
                Icons.Filled.AccountCircle
            ) {
                val submittedPassword = password
                val submittedConfirmation = confirmPassword
                password = ""
                confirmPassword = ""
                if (createAccount && submittedPassword != submittedConfirmation) {
                    state.error = "The password and confirmation do not match. Re-enter both fields."
                } else {
                    scope.launch {
                        if (createAccount) {
                            state.signup(email, submittedPassword, displayName, age, terms, privacy)
                        } else {
                            state.login(email, submittedPassword)
                        }
                    }
                }
            }
            state.billingRecoveryGuidance?.let { guidance ->
                StatusBanner(guidance, isError = true, icon = Icons.Filled.Lock)
                Text(
                    if (state.billingRecoveryUsesProvider) {
                        "Your verified provider token can open billing. Pint Path will not create an app session or restore suspended access."
                    } else {
                        "Re-enter the suspended account email and password above. They are sent only to the billing-recovery endpoint."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (state.billingRecoveryConsumer || state.billingRecoveryVenues.isNotEmpty()) {
                    Text("Billing profile", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (state.billingRecoveryConsumer) {
                            item {
                                FilterChip(
                                    selected = billingRecoveryVenueId == null,
                                    onClick = { billingRecoveryVenueId = null },
                                    label = { Text("Personal subscription") }
                                )
                            }
                        }
                        items(state.billingRecoveryVenues, key = { it.venueId }) { venue ->
                            FilterChip(
                                selected = billingRecoveryVenueId == venue.venueId,
                                onClick = { billingRecoveryVenueId = venue.venueId },
                                label = { Text(venue.venueName) }
                            )
                        }
                    }
                }
                SecondaryAction(
                    "Manage billing only",
                    (state.billingRecoveryUsesProvider || (email.isNotBlank() && password.isNotBlank())) &&
                        (state.billingRecoveryConsumer || billingRecoveryVenueId != null),
                    Icons.Filled.Lock
                ) {
                    val submittedPassword = password
                    password = ""
                    confirmPassword = ""
                    scope.launch {
                        state.openBillingRecovery(email, submittedPassword, billingRecoveryVenueId)?.let { portal ->
                            context.startActivity(Intent(Intent.ACTION_VIEW, portal))
                        }
                    }
                }
            }
            if (!createAccount) {
                TextButton(
                    onClick = { scope.launch { state.requestPasswordReset(email) } },
                    enabled = email.isNotBlank() && actionsEnabled
                ) {
                    Text("Forgot password?")
                }
            }
            StatusBanner("Email/password uses Supabase Auth and the same verified Pint Path session contract as the website.")
            val providers = state.config.optJSONArray("supabaseOauthProviders")?.let { array ->
                (0 until array.length()).mapNotNull { index -> array.optString(index).lowercase().takeIf { it == "google" || it == "apple" } }
            }.orEmpty()
            providers.forEach { provider ->
                SecondaryAction("Continue with ${provider.replaceFirstChar { it.uppercase() }}", icon = Icons.Filled.AccountCircle) {
                    password = ""
                    confirmPassword = ""
                    runCatching { state.beginOAuth(provider) }
                        .onSuccess { context.startActivity(Intent(Intent.ACTION_VIEW, it)) }
                        .onFailure { state.error = it.message ?: "Could not start provider sign-in." }
                }
            }
        }
    }
}

@Composable
private fun PolicyLinks(context: Context) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${BuildConfig.PINT_PATH_API_BASE_URL.trimEnd('/')}/terms.html"))) }) {
            Text("Read Terms")
        }
        TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${BuildConfig.PINT_PATH_API_BASE_URL.trimEnd('/')}/privacy.html"))) }) {
            Text("Read Privacy")
        }
    }
}

@Composable
private fun CheckRow(label: String, checked: Boolean, onChecked: (Boolean) -> Unit) {
    val actionsEnabled = LocalActionsEnabled.current
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onChecked, enabled = actionsEnabled)
        Text(label)
    }
}

@Composable
private fun PrivacyCard(state: BeerMapState, scope: CoroutineScope, settings: PrivacySettings?) {
    var optional by remember(settings) { mutableStateOf(settings?.optionalAnalyticsEnabled ?: false) }
    var reports by remember(settings) { mutableStateOf(settings?.venueReportInclusionEnabled ?: false) }
    var research by remember(settings) { mutableStateOf(settings?.productResearchEnabled ?: false) }
    var emails by remember(settings) { mutableStateOf(settings?.emailUpdatesEnabled ?: false) }

    AppCard {
        SectionHeader("Privacy", "Data controls", "Optional analytics and venue-report inclusion match the website.", Icons.Filled.Lock)
        CheckRow("Optional analytics", optional) { optional = it }
        CheckRow("Include my activity in aggregate venue reports", reports) { reports = it }
        CheckRow("Product research contact", research) { research = it }
        CheckRow("Email product updates", emails) { emails = it }
        PrimaryAction("Save privacy settings", icon = Icons.Filled.Lock) {
            scope.launch { state.savePrivacy(PrivacySettings(optional, reports, research, emails)) }
        }
    }
}

@Composable
private fun VenuePortalScreen(state: BeerMapState, scope: CoroutineScope) {
    val context = LocalContext.current
    var section by remember { mutableStateOf("Dashboard") }
    val portal = state.portal
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (!state.signedIn) {
            item { EmptyState("Venue access is verified", "Sign in, then request access from the Pint Path web venue portal if this venue is not assigned yet.", Icons.Filled.Storefront) }
        } else if (portal == null) {
            item {
                EmptyState("No venue dashboard yet", "Refresh, or request access from the Pint Path web venue portal.", Icons.Filled.Storefront)
                PrimaryAction("Refresh") { scope.launch { state.refreshPortal() } }
            }
        } else if (portal.accessState == "claim_required") {
            item {
                AppCard {
                    SectionHeader(
                        "Verified access",
                        "Connect your venue",
                        portal.message ?: "Venue access is manually verified before management tools are enabled.",
                        Icons.Filled.Storefront
                    )
                    PrimaryAction("Request or review venue access", icon = Icons.Filled.Storefront) {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${BuildConfig.PINT_PATH_API_BASE_URL.trimEnd('/')}/venue-portal.html")))
                    }
                    StatusBanner("The secure web claim form includes the business-verification evidence and admin review trail.", icon = Icons.Filled.Lock)
                }
            }
        } else {
            val counterOnly = portal.accessLevel == "counter_staff"
            item {
                AppCard {
                    SectionHeader(portal.tier?.tierLabel ?: portal.profile?.membershipTier ?: "Venue", portal.selectedVenue?.venueName ?: "Venue dashboard", portal.privacyCopy, Icons.Filled.Storefront)
                    portal.message?.let { StatusBanner(it) }
                    if (portal.assignments.size > 1) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(portal.assignments.take(8), key = { it.venueId }) { assignment ->
                                AssistChip(onClick = { scope.launch { state.refreshPortal(assignment.venueId) } }, label = { Text(assignment.venueName) })
                            }
                        }
                    }
                }
            }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(if (counterOnly) listOf("Counter") else listOf("Dashboard", "Counter", "Profile", "Beers", "Happy", "Specials", "Reports")) { label ->
                        FilterChip(selected = section == label, onClick = { section = label }, label = { Text(label) })
                    }
                }
            }
            item {
                key(portal.selectedVenue?.venueId) {
                    when (if (counterOnly) "Counter" else section) {
                        "Counter" -> CounterToolsCard(state, scope, portal)
                        "Profile" -> ProfileEditor(state, scope, portal.profile)
                        "Beers" -> BeerEditor(state, scope, portal.beers)
                        "Happy" -> HappyHourEditor(state, scope, portal.happyHours)
                        "Specials" -> SpecialEditor(state, scope, portal.specials, portal.tier?.canManageSpecials == true)
                        "Reports" -> ReportsCard(state, scope, portal)
                        else -> PortalDashboardCard(portal)
                    }
                }
            }
        }
    }
}

@Composable
private fun PortalDashboardCard(portal: PortalData) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) { MetricCard("Beers", portal.beers.size.toString(), Icons.Filled.LocalBar, Amber) }
            Column(Modifier.weight(1f)) { MetricCard("Happy hours", portal.happyHours.size.toString(), Icons.Filled.Timer, Leaf) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) { MetricCard("Specials", portal.specials.size.toString(), Icons.Filled.Tag, Plum) }
            Column(Modifier.weight(1f)) { MetricCard("Pending", portal.pendingCount.toString(), Icons.Filled.Refresh, Sky) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) { MetricCard("Redemptions", portal.discounts?.totalRedemptions?.toString() ?: "0", Icons.Filled.Bookmark, Leaf) }
            Column(Modifier.weight(1f)) { MetricCard("Reward pts", portal.pintPoints?.rewardThreshold?.toString() ?: "50", Icons.Filled.Star, Amber) }
        }
        portal.dailySpecialsPlanner?.let { DailySpecialsPlannerCard(it) }
        portal.analytics?.let {
            AppCard {
                SectionHeader("Analytics", if (it.privacyFloorMet) "Demand snapshot" else "Demand snapshot building", "Aggregate venue insights only.", Icons.Filled.Analytics)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) { MetricCard("Lookups", it.barLookups.toString(), Icons.Filled.Search, Sky) }
                    Column(Modifier.weight(1f)) { MetricCard("Beer views", it.beerListViews.toString(), Icons.Filled.Analytics, Leaf) }
                }
            }
        } ?: EmptyState("Pro analytics are locked", portal.tier?.upgradeCopy ?: "Pro unlocks privacy-safe analytics and monthly reports.", Icons.Filled.Analytics)
    }
}

@Composable
private fun CounterToolsCard(state: BeerMapState, scope: CoroutineScope, portal: PortalData) {
    var memberCode by remember { mutableStateOf("") }
    var transactionReference by remember { mutableStateOf("") }
    var checkedReference by remember { mutableStateOf<String?>(null) }
    var itemName by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("alcoholic") }
    var quantity by remember { mutableStateOf(1) }
    var notes by remember { mutableStateOf("") }
    var voidReason by remember { mutableStateOf("") }
    var rewardCode by remember { mutableStateOf("") }
    var rewardReason by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        AppCard {
            SectionHeader(
                "Counter",
                portal.selectedVenue?.venueName ?: "Member checkout",
                "Check a short-lived member code before recording the exact paid item.",
                Icons.Filled.Storefront
            )
            OutlinedTextField(
                memberCode,
                { memberCode = it.uppercase().take(6); checkedReference = null },
                label = { Text("6-character member code") },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Ascii,
                    autoCorrectEnabled = false
                ),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            OutlinedTextField(
                transactionReference,
                { transactionReference = it; checkedReference = null },
                label = { Text("Receipt or order reference") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            PrimaryAction("Check member", memberCode.matches(Regex("^[A-Z0-9]{6}$")) && transactionReference.trim().length >= 4, Icons.Filled.CheckCircle) {
                scope.launch {
                    if (state.previewCounterMember(memberCode, transactionReference)) checkedReference = transactionReference.trim()
                }
            }
            state.counterMemberPreview?.let { preview ->
                StatusBanner("Eligible member ${preview.accountId}. ${preview.pointsRemainingToday} Pint Points remain in today's cap.", icon = Icons.Filled.CheckCircle)
                preview.privacyCopy?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                OutlinedTextField(itemName, { itemName = it }, label = { Text("Purchased item") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(listOf("alcoholic", "non_alcoholic", "food")) { value ->
                        FilterChip(selected = category == value, onClick = { category = value }, label = { Text(value.replace('_', ' ')) })
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Quantity", modifier = Modifier.weight(1f))
                    TextButton(onClick = { if (quantity > 1) quantity -= 1 }) { Text("-") }
                    Text(quantity.toString(), fontWeight = FontWeight.Bold)
                    TextButton(onClick = { if (quantity < 4) quantity += 1 }) { Text("+") }
                }
                OutlinedTextField(notes, { notes = it }, label = { Text("Notes, optional") }, modifier = Modifier.fillMaxWidth())
                PrimaryAction("Record purchase", checkedReference == transactionReference.trim() && itemName.isNotBlank(), Icons.Filled.Add) {
                    scope.launch {
                        if (state.recordCounterPurchase(itemName, category, quantity, transactionReference, notes)) {
                            memberCode = ""
                            checkedReference = null
                            itemName = ""
                            notes = ""
                            quantity = 1
                        }
                    }
                }
            }
        }

        state.counterPurchaseResult?.let { result ->
            AppCard {
                SectionHeader("Correction", "Most recent purchase", result.copy, Icons.Filled.Refresh)
                result.progressCopy?.let { Text(it) }
                result.rewardCopy?.let { Text(it) }
                OutlinedTextField(voidReason, { voidReason = it }, label = { Text("Reason for reversal") }, modifier = Modifier.fillMaxWidth())
                SecondaryAction("Reverse this purchase", voidReason.trim().length >= 4, Icons.Filled.Refresh) {
                    scope.launch {
                        if (state.voidCounterPurchase(voidReason)) voidReason = ""
                    }
                }
            }
        }

        AppCard {
            SectionHeader("Reward", "Free Pint Reward", "Confirm only after age, ID, and responsible-service checks.", Icons.Filled.Star)
            OutlinedTextField(
                rewardCode,
                { rewardCode = it.uppercase().take(6) },
                label = { Text("6-character reward code") },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Ascii,
                    autoCorrectEnabled = false
                ),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            PrimaryAction("Confirm reward", rewardCode.matches(Regex("^[A-Z0-9]{6}$")), Icons.Filled.Star) {
                scope.launch { state.decideFreePintReward(rewardCode, "confirm", "") }
            }
            OutlinedTextField(rewardReason, { rewardReason = it }, label = { Text("Rejection reason") }, modifier = Modifier.fillMaxWidth())
            SecondaryAction("Reject reward", rewardCode.matches(Regex("^[A-Z0-9]{6}$")) && rewardReason.trim().length >= 4, Icons.Filled.Lock) {
                scope.launch { state.decideFreePintReward(rewardCode, "reject", rewardReason) }
            }
            state.counterRewardResult?.let { result ->
                StatusBanner(result.copy ?: "Reward ${result.status}.", icon = Icons.Filled.CheckCircle)
                result.instruction?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

@Composable
private fun DailySpecialsPlannerCard(planner: au.pintpath.beermap.data.DailySpecialsPlanner) {
    AppCard {
        SectionHeader(
            eyebrow = "Specials planner",
            title = "Daily summary for ${planner.area ?: "your area"}",
            subtitle = planner.summary ?: planner.confidenceCopy,
            icon = Icons.Filled.Star
        )
        if (planner.demandSignals.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                planner.demandSignals.take(2).forEach { signal ->
                    Column(Modifier.weight(1f)) {
                        MetricCard(signal.label, signal.value, Icons.Filled.Analytics, Sky)
                    }
                }
            }
            if (planner.demandSignals.size > 2) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    planner.demandSignals.drop(2).take(2).forEach { signal ->
                        Column(Modifier.weight(1f)) {
                            MetricCard(signal.label, signal.value, Icons.Filled.Analytics, Leaf)
                        }
                    }
                }
            }
        }
        if (planner.recommendations.isNotEmpty()) {
            Text("Recommended specials", style = MaterialTheme.typography.labelMedium, color = Amber, fontWeight = FontWeight.Black)
            planner.recommendations.take(3).forEach { recommendation ->
                FeatureCard(
                    title = recommendation.title,
                    message = recommendation.offerIdea ?: recommendation.action ?: "Use one clear staff-friendly special.",
                    icon = Icons.Filled.Tag,
                    tint = Amber
                )
                recommendation.reason?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (!planner.privacyFloorMet && !planner.confidenceCopy.isNullOrBlank()) {
            StatusBanner(planner.confidenceCopy, icon = Icons.Filled.Lock)
        }
    }
}

@Composable
private fun ProfileEditor(state: BeerMapState, scope: CoroutineScope, profile: BarProfile?) {
    var name by remember(profile) { mutableStateOf(profile?.name.orEmpty()) }
    var address by remember(profile) { mutableStateOf(profile?.address.orEmpty()) }
    var suburb by remember(profile) { mutableStateOf(profile?.suburb.orEmpty()) }
    var phone by remember(profile) { mutableStateOf(profile?.phone.orEmpty()) }
    var website by remember(profile) { mutableStateOf(profile?.website.orEmpty()) }
    var instagram by remember(profile) { mutableStateOf(profile?.instagram.orEmpty()) }
    var description by remember(profile) { mutableStateOf(profile?.description.orEmpty()) }

    AppCard {
        SectionHeader("Profile", "Bar profile", "Keep public venue details accurate.", Icons.Filled.Business)
        FormField("Venue name", Icons.Filled.Business, name, { name = it })
        FormField("Address", Icons.Filled.Map, address, { address = it })
        FormField("Suburb", Icons.Filled.Map, suburb, { suburb = it })
        FormField(
            "Phone",
            Icons.Filled.AccountCircle,
            phone,
            { phone = it },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone)
        )
        FormField(
            "Website",
            Icons.Filled.Search,
            website,
            { website = it },
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri,
                autoCorrectEnabled = false
            )
        )
        FormField(
            "Instagram URL",
            Icons.Filled.Tag,
            instagram,
            { instagram = it },
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri,
                autoCorrectEnabled = false
            )
        )
        FormField("Description", Icons.Filled.Settings, description, { description = it }, minLines = 3, singleLine = false)
        PrimaryAction("Save profile", name.isNotBlank(), Icons.Filled.Business) {
            val next = BarProfile(
                name = name,
                address = address.blankToNull(),
                suburb = suburb.blankToNull(),
                area = profile?.area,
                phone = phone.blankToNull(),
                website = website.blankToNull(),
                instagram = instagram.blankToNull(),
                description = description.blankToNull(),
                openingHours = profile?.openingHours ?: JSONObject(),
                venueTags = profile?.venueTags.orEmpty(),
                membershipTier = profile?.membershipTier,
                active = profile?.active ?: true,
                updatedAt = profile?.updatedAt
            )
            scope.launch { state.saveProfile(next) }
        }
    }
}

@Composable
private fun BeerEditor(state: BeerMapState, scope: CoroutineScope, beers: List<BarBeer>) {
    var beerName by remember { mutableStateOf("") }
    var brewery by remember { mutableStateOf("") }
    var style by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }

    AppCard {
        SectionHeader("Stock", "Beers and prices", "Venue updates stay server-reviewed where required.", Icons.Filled.LocalBar)
        if (beers.isEmpty()) {
            EmptyState("No beer rows yet", "Add the beers staff want visible first. You can expand stock detail after the first save.", Icons.Filled.LocalBar, framed = false)
        } else {
            beers.take(8).forEach {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text(it.beerName, fontWeight = FontWeight.Bold)
                        Text(listOfNotNull(it.style, it.serveSize, if (it.onTap) "On tap" else null).joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(it.price?.let { value -> "$" + "%.2f".format(value) } ?: "", fontWeight = FontWeight.Bold)
                }
                HorizontalDivider()
            }
        }
        HorizontalDivider()
        FormField("Beer name", Icons.Filled.LocalBar, beerName, { beerName = it })
        FormField("Brewery", Icons.Filled.Business, brewery, { brewery = it })
        FormField("Style", Icons.Filled.Tag, style, { style = it })
        FormField(
            "Price",
            Icons.Filled.LocalBar,
            price,
            { price = it },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
        )
        PrimaryAction("Save beer row", beerName.isNotBlank(), Icons.Filled.Add) {
            val beer = BarBeer(
                id = null,
                beerName = beerName,
                brewery = brewery.blankToNull(),
                style = style.blankToNull(),
                abv = null,
                serveSize = "pint",
                price = price.toDoubleOrNull(),
                onTap = true,
                inStock = true,
                notes = null
            )
            scope.launch { state.saveBeer(beer) }
        }
    }
}

@Composable
private fun HappyHourEditor(state: BeerMapState, scope: CoroutineScope, happyHours: List<BarHappyHour>) {
    val context = LocalContext.current
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var start by remember { mutableStateOf("16:00") }
    var end by remember { mutableStateOf("18:00") }
    var friday by remember { mutableStateOf(true) }
    var saturday by remember { mutableStateOf(false) }

    AppCard {
        SectionHeader("Happy hours", "Current specials", "Use native time pickers for staff-friendly updates.", Icons.Filled.Timer)
        if (happyHours.isEmpty()) {
            EmptyState("No happy hours yet", "Add the recurring windows your team wants customers to find quickly.", Icons.Filled.Timer, framed = false)
        } else {
            happyHours.take(6).forEach {
                FeatureCard(it.title, "${it.daysOfWeek.joinToString(", ")} - ${it.startTime}-${it.endTime}", Icons.Filled.Timer, Leaf)
            }
        }
        HorizontalDivider()
        FormField("Title", Icons.Filled.Timer, title, { title = it })
        FormField("Description", Icons.Filled.Settings, description, { description = it }, minLines = 3, singleLine = false)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { showTimePicker(context, start) { start = it } }) { Text("Starts $start") }
            Button(onClick = { showTimePicker(context, end) { end = it } }) { Text("Ends $end") }
        }
        CheckRow("Friday", friday) { friday = it }
        CheckRow("Saturday", saturday) { saturday = it }
        PrimaryAction("Save happy hour", title.isNotBlank() && description.isNotBlank() && (friday || saturday), Icons.Filled.Timer) {
            val days = buildList {
                if (friday) add("fri")
                if (saturday) add("sat")
            }
            scope.launch { state.saveHappyHour(BarHappyHour(null, title, days, start, end, description, active = true)) }
        }
    }
}

@Composable
private fun SpecialEditor(state: BeerMapState, scope: CoroutineScope, specials: List<BarSpecial>, canManage: Boolean) {
    val context = LocalContext.current
    var title by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var discount by remember { mutableStateOf("") }
    var price by remember { mutableStateOf("") }
    var start by remember { mutableStateOf("17:00") }
    var end by remember { mutableStateOf("21:00") }

    AppCard {
        SectionHeader("Specials", "Pint Path specials", if (canManage) "Pro venues can submit reviewed specials." else "Upgrade to Pro to add reviewed specials.", Icons.Filled.Tag)
        if (!canManage) StatusBanner("Free venues can manage beers and happy hours. Pro unlocks reviewed specials.")
        if (specials.isEmpty()) {
            EmptyState(if (canManage) "No specials yet" else "Specials are locked", if (canManage) "Add a reviewed Pint Path special for peak service windows." else "Pro unlocks reviewed Pint Path specials for this venue.", Icons.Filled.Tag, framed = false)
        } else {
            specials.take(6).forEach {
                FeatureCard(it.title, "${it.discount.orEmpty()} - ${it.startTime}-${it.endTime}", Icons.Filled.Tag, Plum)
            }
        }
        if (canManage) {
            HorizontalDivider()
            FormField("Special title", Icons.Filled.Tag, title, { title = it })
            FormField("Description", Icons.Filled.Settings, description, { description = it }, minLines = 3, singleLine = false)
            FormField("Discount copy", Icons.Filled.Tag, discount, { discount = it })
            FormField(
                "Price, optional",
                Icons.Filled.LocalBar,
                price,
                { price = it },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { showTimePicker(context, start) { start = it } }) { Text("Starts $start") }
                Button(onClick = { showTimePicker(context, end) { end = it } }) { Text("Ends $end") }
            }
            PrimaryAction("Save special", title.isNotBlank() && description.isNotBlank(), Icons.Filled.Tag) {
                scope.launch {
                    state.saveSpecial(BarSpecial(null, title, description, price.toDoubleOrNull(), discount.blankToNull(), start, end, exclusive = true, active = true))
                }
            }
        }
    }
}

@Composable
private fun ReportsCard(state: BeerMapState, scope: CoroutineScope, portal: PortalData) {
    val context = LocalContext.current
    var month by remember { mutableStateOf(YearMonth.now().minusMonths(1).toString()) }
    var pendingExport by remember { mutableStateOf<String?>(null) }
    val exportLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri != null) {
            runCatching {
                context.contentResolver.openOutputStream(uri)?.bufferedWriter()?.use { it.write(pendingExport.orEmpty()) }
                    ?: error("Could not open the selected report file.")
            }.onSuccess { state.message = "Monthly report saved." }
                .onFailure { state.error = it.message ?: "Could not save the monthly report." }
        }
        pendingExport = null
    }
    AppCard {
        SectionHeader("Reports", if (portal.tier?.monthlyReports == true) "Monthly report" else "Reports locked", portal.tier?.upgradeCopy, Icons.Filled.Analytics)
        if (portal.tier?.monthlyReports == true) {
            MetricCard("Privacy floor", if (portal.analytics?.privacyFloorMet == true) "Met" else "Building", Icons.Filled.Lock, Leaf)
            OutlinedTextField(month, { month = it }, label = { Text("Completed month (YYYY-MM)") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("csv", "json").forEach { format ->
                    Button(
                        onClick = {
                            scope.launch {
                                state.prepareVenueReportExport(month, format)?.let { data ->
                                    pendingExport = data
                                    exportLauncher.launch("pint-path-$month-monthly-report.$format")
                                }
                            }
                        },
                        enabled = month.matches(Regex("^\\d{4}-(0[1-9]|1[0-2])$")),
                        modifier = Modifier.weight(1f)
                    ) { Text("Save ${format.uppercase()}") }
                }
            }
            Text("Exports use privacy-safe aggregate data and are available only for completed months.", style = MaterialTheme.typography.bodySmall)
        } else {
            EmptyState("Upgrade to Pro", portal.tier?.upgradeCopy ?: "Pro unlocks analytics and monthly reports.", Icons.Filled.Analytics)
        }
    }
}

@Composable
private fun SettingsScreen(state: BeerMapState, scope: CoroutineScope) {
    var support by remember { mutableStateOf("") }
    val uriHandler = LocalUriHandler.current
    val publicBaseUrl = BuildConfig.PINT_PATH_API_BASE_URL.trimEnd('/')
    val hasServerSupabaseConfig =
        !state.config.stringOrNull("supabaseUrl").isNullOrBlank() &&
            !state.config.stringOrNull("supabaseAnonKey").isNullOrBlank()
    val hasEmbeddedSupabaseConfig =
        BuildConfig.SUPABASE_URL.isNotBlank() && BuildConfig.SUPABASE_ANON_KEY.isNotBlank()
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        if (BuildConfig.DEBUG) {
            AppCard {
                SectionHeader("Configuration", "Backend connection", "Debug-only connection details.", Icons.Filled.Settings)
                Text("API base URL: ${BuildConfig.PINT_PATH_API_BASE_URL}", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Supabase native OAuth: ${if (hasServerSupabaseConfig || hasEmbeddedSupabaseConfig) "Public config present" else "Not configured"}",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text("Field-test mode: ${if (state.config.optBoolean("fieldTestMode", false)) "On" else "Off"}", style = MaterialTheme.typography.bodyMedium)
            }
        }
        AppCard {
            SectionHeader("Support", "Need help?", "Use this for privacy, billing, venue account, or moderation support.", Icons.Filled.AccountCircle)
            FormField("Message", Icons.Filled.Settings, support, { support = it }, minLines = 4, singleLine = false)
            PrimaryAction("Send support note", support.trim().length >= 3, Icons.Filled.Add) {
                scope.launch {
                    state.sendFeedback(support)
                    support = ""
                }
            }
        }
        AppCard {
            SectionHeader("Safety", "Responsible use", "Pint Path is 18+ only. Prices and availability can change, and venues may refuse service under RSA obligations.", Icons.Filled.Lock)
            FeatureCard("Opt-in location", "Location is one-time where used.", Icons.Filled.Map, Sky)
            FeatureCard("Private reports", "Venue reports use aggregate privacy-safe analytics.", Icons.Filled.Analytics, Leaf)
            FeatureCard("Source evidence", "Private source evidence is handled by the backend.", Icons.Filled.Lock, Amber)
        }
        AppCard {
            SectionHeader(
                "Legal & contact",
                "Pint Path operator details",
                "Pint Path is operated by Isaac William De Worsop, sole trader · ABN 80 319 578 329.",
                Icons.Filled.OpenInBrowser
            )
            Text(
                "WOTSO, Level 3, 11–19 Bank Place, Melbourne VIC 3000, Australia",
                style = MaterialTheme.typography.bodyMedium
            )
            SecondaryAction("Email admin@pintpath.au", icon = Icons.Filled.AccountCircle) {
                uriHandler.openUri("mailto:admin@pintpath.au")
            }
            SecondaryAction("Terms and Conditions", icon = Icons.Filled.OpenInBrowser) {
                uriHandler.openUri("$publicBaseUrl/terms.html")
            }
            SecondaryAction("Privacy Policy", icon = Icons.Filled.Lock) {
                uriHandler.openUri("$publicBaseUrl/privacy.html")
            }
            SecondaryAction("Account export and deletion", icon = Icons.Filled.AccountCircle) {
                uriHandler.openUri("$publicBaseUrl/account.html")
            }
            Text(
                "Policy version ${state.config.stringOrNull("legalPolicyVersion") ?: "unavailable"}",
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

private fun showTimePicker(context: Context, current: String, onPicked: (String) -> Unit) {
    val parts = current.split(":")
    val hour = parts.getOrNull(0)?.toIntOrNull() ?: 16
    val minute = parts.getOrNull(1)?.toIntOrNull() ?: 0
    TimePickerDialog(context, { _, pickedHour, pickedMinute ->
        onPicked(String.format(Locale.US, "%02d:%02d", pickedHour, pickedMinute))
    }, hour, minute, true).show()
}

private suspend fun oneTimeLocation(context: Context): UploadLocation = suspendCancellableCoroutine { continuation ->
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val hasFineLocation = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val providers = if (hasFineLocation) {
        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    } else {
        listOf(LocationManager.NETWORK_PROVIDER)
    }
    val provider = providers
        .firstOrNull { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
    if (provider == null) {
        continuation.resumeWithException(IllegalStateException("Location services are off. Enable them, or submit without location proof."))
        return@suspendCancellableCoroutine
    }

    val listener = object : LocationListener {
        override fun onLocationChanged(location: android.location.Location) {
            if (continuation.isActive) {
                continuation.resume(UploadLocation(
                    location.latitude,
                    location.longitude,
                    location.accuracy.toDouble(),
                    Instant.ofEpochMilli(location.time).toString()
                ))
            }
            manager.removeUpdates(this)
        }

        override fun onProviderDisabled(provider: String) = Unit
        override fun onProviderEnabled(provider: String) = Unit
        @Deprecated("Deprecated in Android")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
    }

    try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            manager.getCurrentLocation(provider, null, context.mainExecutor) { location ->
                if (!continuation.isActive) return@getCurrentLocation
                if (location == null) continuation.resumeWithException(IllegalStateException("No location fix was available. Try again outside, or submit without it."))
                else continuation.resume(UploadLocation(
                    location.latitude,
                    location.longitude,
                    location.accuracy.toDouble(),
                    Instant.ofEpochMilli(location.time).toString()
                ))
            }
        } else {
            @Suppress("DEPRECATION")
            manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
        }
    } catch (error: SecurityException) {
        continuation.resumeWithException(IllegalStateException("Location permission is required only when attaching location proof."))
    }
    continuation.invokeOnCancellation { manager.removeUpdates(listener) }
}

private suspend fun sourcePhotoDataUrlFromUri(context: Context, uri: Uri): String = withContext(Dispatchers.IO) {
    val mimeType = context.contentResolver.getType(uri) ?: "image/jpeg"
    require(mimeType.startsWith("image/")) { "Choose an image file for source evidence." }
    val maximumSourceBytes = 24 * 1024 * 1024
    val cacheFile = File.createTempFile("pint-path-source-", ".image", context.cacheDir)
    try {
        var total = 0
        context.contentResolver.openInputStream(uri)?.use { input ->
            cacheFile.outputStream().buffered().use { output ->
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= maximumSourceBytes) { "Choose an image smaller than 24MB." }
                    output.write(buffer, 0, count)
                }
            }
        } ?: error("Could not read this photo.")
        require(total > 0) { "Could not read this photo." }

        currentCoroutineContext().ensureActive()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(cacheFile.absolutePath, bounds)
        require(
            bounds.outWidth in 1..100_000 && bounds.outHeight in 1..100_000
        ) { "Try a JPEG, PNG, HEIC, or WebP photo with valid image dimensions." }
        var sampleSize = 1
        while (bounds.outWidth / sampleSize > 2_200 || bounds.outHeight / sampleSize > 2_200) {
            sampleSize *= 2
        }

        currentCoroutineContext().ensureActive()
        val bitmap = decodeSourcePhotoBitmap(cacheFile, sampleSize)
        require(bitmap.byteCount <= 24 * 1024 * 1024) { "This image is too large to prepare safely." }
        val uploadBytes = try {
            ByteArrayOutputStream().use { output ->
                require(bitmap.compress(Bitmap.CompressFormat.JPEG, 84, output)) {
                    "Could not compress this image. Try a different photo."
                }
                output.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }

        currentCoroutineContext().ensureActive()
        require(uploadBytes.size <= 6 * 1024 * 1024) { "Each upload image must be 6MB or smaller." }
        "data:image/jpeg;base64,${Base64.encodeToString(uploadBytes, Base64.NO_WRAP)}"
    } finally {
        cacheFile.delete()
    }
}

private fun decodeSourcePhotoBitmap(file: File, sampleSize: Int): Bitmap {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        decodeSourcePhotoWithImageDecoder(file, sampleSize)
    } else {
        val decoded = BitmapFactory.decodeFile(
            file.absolutePath,
            BitmapFactory.Options().apply { inSampleSize = sampleSize }
        ) ?: error("Could not decode this image. Try a JPEG, PNG, HEIC, or WebP photo.")
        applyExifOrientation(decoded, file)
    }
}

@RequiresApi(Build.VERSION_CODES.P)
private fun decodeSourcePhotoWithImageDecoder(file: File, sampleSize: Int): Bitmap {
    val source = ImageDecoder.createSource(file)
    return ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
        // ImageDecoder applies encoded EXIF orientation before the upload JPEG is made.
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        decoder.setTargetSampleSize(sampleSize)
    }
}

private fun applyExifOrientation(bitmap: Bitmap, file: File): Bitmap {
    val orientation = runCatching {
        ExifInterface(file).getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL
        )
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    val matrix = Matrix()
    when (orientation) {
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
        ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> {
            matrix.setRotate(90f)
            matrix.postScale(-1f, 1f)
        }
        ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE -> {
            matrix.setRotate(-90f)
            matrix.postScale(-1f, 1f)
        }
        ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
        else -> return bitmap
    }
    val oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (oriented !== bitmap) bitmap.recycle()
    return oriented
}

private fun Double.roundLabel(): String =
    if (this % 1.0 == 0.0) toInt().toString() else String.format(Locale.US, "%.1f", this)

private fun moneyFromCents(cents: Int): String =
    "$" + String.format(Locale.US, "%.2f", cents / 100.0)

private fun String.blankToNull(): String? = trim().takeIf { it.isNotBlank() }
