package au.pintpath.beermap.data

import au.pintpath.beermap.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class BeerMapApiClient(
    private val baseUrl: String = BuildConfig.PINT_PATH_API_BASE_URL
) {
    suspend fun config(): JSONObject = request("/api/business/config")

    suspend fun login(email: String, password: String): AuthResult {
        val data = request(
            path = "/api/business/auth/login",
            method = "POST",
            body = JSONObject().put("email", email).put("password", password)
        )
        return AuthResult(data.getString("token"), data.getJSONObject("account").toAccount())
    }

    suspend fun signup(email: String, password: String, displayName: String?): AuthResult {
        val data = request(
            path = "/api/business/auth/signup",
            method = "POST",
            body = JSONObject()
                .put("email", email)
                .put("password", password)
                .putNullable("displayName", displayName)
                .put("ageConfirmed", true)
                .put("termsAccepted", true)
                .put("privacyAccepted", true)
        )
        return AuthResult(data.getString("token"), data.getJSONObject("account").toAccount())
    }

    suspend fun logout(token: String) {
        request("/api/business/auth/logout", method = "POST", body = JSONObject(), token = token)
    }

    suspend fun account(token: String): AccountDashboard =
        request("/api/business/account", token = token).toAccountDashboard()

    suspend fun savePrivacy(settings: PrivacySettings, token: String): AccountDashboard =
        request(
            path = "/api/business/account/privacy-settings",
            method = "POST",
            body = JSONObject()
                .put("optionalAnalyticsEnabled", settings.optionalAnalyticsEnabled)
                .put("venueReportInclusionEnabled", settings.venueReportInclusionEnabled)
                .put("productResearchEnabled", settings.productResearchEnabled)
                .put("emailUpdatesEnabled", settings.emailUpdatesEnabled),
            token = token
        ).toAccountDashboard()

    suspend fun requestAccountDeletion(token: String) {
        request(
            path = "/api/business/account/delete-request",
            method = "POST",
            body = JSONObject().put("message", "Self-service deletion review requested from the Android app."),
            token = token
        )
    }

    suspend fun venues(query: String? = null): List<Venue> {
        val path = buildString {
            append("/api/business/venues?limit=80")
            if (!query.isNullOrBlank()) append("&q=").append(encode(query))
        }
        return request(path).optJSONArray("venues")?.objects()?.map { it.toVenue() }.orEmpty()
    }

    suspend fun missions(): List<Mission> =
        request("/api/business/missions?limit=50").optJSONArray("missions")?.objects()?.map { it.toMission() }.orEmpty()

    suspend fun priceRecords(venueId: String, anonymousSessionId: String, token: String?): List<PriceRecord> {
        val path = "/api/business/price-records?venueId=${encode(venueId)}&anonymousSessionId=${encode(anonymousSessionId)}&reveal=true&limit=120"
        return request(path, token = token).optJSONArray("records")?.objects()?.map { it.toPriceRecord() }.orEmpty()
    }

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
        token: String? = null
    ): JSONObject = withContext(Dispatchers.IO) {
        val url = URL(baseUrl.trimEnd('/') + path)
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "BeerMap Android/0.1")
            if (!token.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { stream -> stream.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }

        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        val payload = if (text.isBlank()) JSONObject() else JSONObject(text)
        if (status !in 200..299 || payload.optBoolean("ok") == false) {
            val message = payload.optJSONObject("error")?.stringOrNull("message")
                ?: payload.stringOrNull("error")
                ?: "Request failed ($status)."
            throw IOException(message)
        }
        payload.optJSONObject("data") ?: JSONObject()
    }

    private fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name())
}

