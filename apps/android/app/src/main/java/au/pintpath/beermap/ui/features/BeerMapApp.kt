@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package au.pintpath.beermap.ui.features

import android.app.TimePickerDialog
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Analytics
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LocalBar
import androidx.compose.material.icons.filled.Map
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
import androidx.compose.material3.Divider
import androidx.compose.material3.FilterChip
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import au.pintpath.beermap.BuildConfig
import au.pintpath.beermap.data.AccountDashboard
import au.pintpath.beermap.data.BarBeer
import au.pintpath.beermap.data.BarHappyHour
import au.pintpath.beermap.data.BarProfile
import au.pintpath.beermap.data.BarSpecial
import au.pintpath.beermap.data.BeerMapApiClient
import au.pintpath.beermap.data.Mission
import au.pintpath.beermap.data.PortalData
import au.pintpath.beermap.data.PriceRecord
import au.pintpath.beermap.data.PrivacySettings
import au.pintpath.beermap.data.RotatingCodeResult
import au.pintpath.beermap.data.SessionStore
import au.pintpath.beermap.data.Venue
import au.pintpath.beermap.ui.components.AppCard
import au.pintpath.beermap.ui.components.EmptyState
import au.pintpath.beermap.ui.components.FeatureCard
import au.pintpath.beermap.ui.components.FormField
import au.pintpath.beermap.ui.components.LoadingView
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
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale

class BeerMapState(context: Context) {
    private val api = BeerMapApiClient()
    private val sessions = SessionStore(context)

    val anonymousSessionId: String = sessions.anonymousSessionId()
    var token by mutableStateOf(sessions.loadToken())
    var config by mutableStateOf(JSONObject())
    var venues by mutableStateOf<List<Venue>>(emptyList())
    var missions by mutableStateOf<List<Mission>>(emptyList())
    var accountDashboard by mutableStateOf<AccountDashboard?>(null)
    var portal by mutableStateOf<PortalData?>(null)
    var discountPass by mutableStateOf<RotatingCodeResult?>(null)
    var freePintReward by mutableStateOf<RotatingCodeResult?>(null)
    var selectedVenue by mutableStateOf<Venue?>(null)
    var selectedPrices by mutableStateOf<List<PriceRecord>>(emptyList())
    var loading by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var optionalAnalytics by mutableStateOf(true)

    val signedIn: Boolean get() = token != null

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
        missions = api.missions()
        track("map_viewed")
    }

    suspend fun login(email: String, password: String) = busy {
        val result = api.login(email, password)
        sessions.saveToken(result.token)
        token = result.token
        message = "Signed in as ${result.account.email}."
        refreshAccount()
        refreshPortal()
    }

    suspend fun signup(email: String, password: String, displayName: String?) = busy {
        val result = api.signup(email, password, displayName?.trim()?.takeIf { it.isNotBlank() })
        sessions.saveToken(result.token)
        token = result.token
        message = "Account created. Welcome to BeerMap."
        refreshAccount()
    }

    suspend fun logout() = busy {
        token?.let { runCatching { api.logout(it) } }
        sessions.clearToken()
        token = null
        accountDashboard = null
        portal = null
        discountPass = null
        freePintReward = null
        message = "Signed out."
    }

    suspend fun refreshAccount() {
        val current = token ?: return
        runCatching {
            accountDashboard = api.account(current)
            optionalAnalytics = accountDashboard?.privacySettings?.optionalAnalyticsEnabled ?: true
        }.onFailure { error = it.message ?: "Could not load account." }
    }

    suspend fun savePrivacy(settings: PrivacySettings) = busy {
        val current = token ?: error("Login required.")
        accountDashboard = api.savePrivacy(settings, current)
        optionalAnalytics = settings.optionalAnalyticsEnabled
        message = "Privacy settings saved."
    }

    suspend fun requestDeletion() = busy {
        val current = token ?: error("Login required.")
        api.requestAccountDeletion(current)
        message = "Account deletion review requested."
    }

    suspend fun generateDiscountPass() = busy {
        val current = token ?: error("Sign in before generating a Pint Path special code.")
        discountPass = api.discountPass(current)
        message = "Pint Path special code generated. Show it only when staff are ready."
        refreshAccount()
    }

    suspend fun generateFreePintReward() = busy {
        val current = token ?: error("Sign in before creating a Free Pint Reward code.")
        freePintReward = api.freePintRewardCode(current)
        message = "Free Pint Reward code created. Venue staff still complete age, ID, and RSA checks."
        refreshAccount()
    }

    suspend fun revealPrices(venue: Venue) = busy {
        selectedVenue = venue
        selectedPrices = api.priceRecords(venue.id, anonymousSessionId, token)
        track("venue_detail_opened", venue.id, venue.suburb)
    }

    suspend fun saveVenue(venue: Venue) = busy {
        val current = token ?: error("Sign in to save venues.")
        api.saveVenue(venue, current)
        message = "Saved ${venue.name}."
        refreshAccount()
    }

    suspend fun submitPriceUpdate(
        venueId: String,
        beerName: String,
        servingSize: String,
        priceText: String,
        notes: String
    ) = busy {
        val current = token ?: error("Sign in before submitting venue data.")
        val venue = venues.firstOrNull { it.id == venueId } ?: error("Choose a venue before submitting.")
        val trimmedBeer = beerName.trim()
        if (trimmedBeer.isBlank()) error("Add the beer name before submitting.")
        val price = priceText.replace("$", "").trim().toDoubleOrNull()
            ?: error("Add a valid observed price.")
        api.submitPriceUpdate(venue, trimmedBeer, servingSize, price, notes.blankToNull(), current)
        message = "Price update sent for review."
        track("submission_completed", venue.id, venue.suburb)
        refreshAccount()
    }

    suspend fun submitPhotoUpload(venueId: String, sourcePhotoDataUrl: String, notes: String) = busy {
        val current = token ?: error("Sign in before uploading source evidence.")
        val venue = venues.firstOrNull { it.id == venueId } ?: error("Choose a venue before uploading.")
        api.submitPhotoUpload(venue, sourcePhotoDataUrl, notes.blankToNull(), current)
        message = "Source photo sent for review."
        track("data_upload_created", venue.id, venue.suburb)
        refreshAccount()
    }

    suspend fun submitHappyHourUpdate(
        venueId: String,
        days: List<String>,
        startTime: String,
        endTime: String,
        offerText: String,
        notes: String
    ) = busy {
        val current = token ?: error("Sign in before submitting happy-hour updates.")
        val venue = venues.firstOrNull { it.id == venueId } ?: error("Choose a venue before submitting.")
        if (days.isEmpty()) error("Choose at least one day.")
        if (offerText.isBlank()) error("Add the offer details before submitting.")
        api.submitHappyHourUpdate(venue, days, startTime, endTime, offerText.trim(), notes.blankToNull(), current)
        message = "Happy-hour update sent for review."
        track("submission_completed", venue.id, venue.suburb)
        refreshAccount()
    }

    suspend fun reportWrongPrice(venueId: String, beerName: String, notes: String) = busy {
        val venue = venues.firstOrNull { it.id == venueId } ?: error("Choose a venue before reporting.")
        api.reportWrongPrice(venue, beerName.blankToNull(), notes.blankToNull(), anonymousSessionId, token)
        message = "Wrong-price report sent."
        track("wrong_price_reported", venue.id, venue.suburb)
    }

    suspend fun requestMissing(requestType: String, venueName: String, beerName: String, suburb: String, notes: String) = busy {
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
        track(if (requestType == "missing_beer") "beer_requested" else "venue_requested", suburb = suburb.blankToNull())
    }

    suspend fun refreshPortal(venueId: String? = null) {
        val current = token ?: return
        runCatching { portal = api.portal(current, venueId) }
            .onFailure { error = it.message ?: "Could not load venue dashboard." }
    }

    suspend fun saveProfile(profile: BarProfile) = busy {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("No selected venue.")
        api.saveProfile(profile, venueId, current)
        refreshPortal(venueId)
        message = "Venue profile saved."
    }

    suspend fun saveBeer(beer: BarBeer) = busy {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("No selected venue.")
        api.saveBeer(beer, venueId, current)
        refreshPortal(venueId)
        message = "Beer row saved."
    }

    suspend fun saveHappyHour(happyHour: BarHappyHour) = busy {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("No selected venue.")
        api.saveHappyHour(happyHour, venueId, current)
        refreshPortal(venueId)
        message = "Happy hour saved."
    }

    suspend fun saveSpecial(special: BarSpecial) = busy {
        val current = token ?: error("Login required.")
        val venueId = portal?.selectedVenue?.venueId ?: error("No selected venue.")
        api.saveSpecial(special, venueId, current)
        refreshPortal(venueId)
        message = "Pint Path special saved."
    }

    suspend fun sendFeedback(text: String) = busy {
        api.feedback(text, anonymousSessionId, token)
        message = "Support note sent."
    }

    private suspend fun track(eventType: String, venueId: String? = null, suburb: String? = null) {
        if (optionalAnalytics) api.track(eventType, anonymousSessionId, token, venueId, suburb)
    }

    private suspend fun busy(block: suspend () -> Unit) {
        loading = true
        error = null
        try {
            block()
        } catch (throwable: Throwable) {
            error = throwable.message ?: "Something went wrong."
        } finally {
            loading = false
        }
    }
}

private enum class AppTab(val label: String) {
    Discover("Find"),
    Contribute("Add"),
    Bars("Bars"),
    Account("Account"),
    Settings("Help")
}

@Composable
fun BeerMapApp() {
    val context = LocalContext.current.applicationContext
    val state = remember { BeerMapState(context) }
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(AppTab.Discover) }

    LaunchedEffect(Unit) {
        state.start()
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == AppTab.Discover,
                    onClick = { tab = AppTab.Discover },
                    icon = { Icon(Icons.Filled.Map, contentDescription = AppTab.Discover.label) },
                    label = { Text(AppTab.Discover.label) }
                )
                NavigationBarItem(
                    selected = tab == AppTab.Contribute,
                    onClick = { tab = AppTab.Contribute },
                    icon = { Icon(Icons.Filled.Add, contentDescription = AppTab.Contribute.label) },
                    label = { Text(AppTab.Contribute.label) }
                )
                NavigationBarItem(
                    selected = tab == AppTab.Bars,
                    onClick = { tab = AppTab.Bars },
                    icon = { Icon(Icons.Filled.Storefront, contentDescription = AppTab.Bars.label) },
                    label = { Text(AppTab.Bars.label) }
                )
                NavigationBarItem(
                    selected = tab == AppTab.Account,
                    onClick = { tab = AppTab.Account },
                    icon = { Icon(Icons.Filled.AccountCircle, contentDescription = AppTab.Account.label) },
                    label = { Text(AppTab.Account.label) }
                )
                NavigationBarItem(
                    selected = tab == AppTab.Settings,
                    onClick = { tab = AppTab.Settings },
                    icon = { Icon(Icons.Filled.Settings, contentDescription = AppTab.Settings.label) },
                    label = { Text(AppTab.Settings.label) }
                )
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (state.loading) {
                LoadingView("Updating BeerMap")
            }
            state.error?.let { StatusBanner(it, isError = true) }
            state.message?.let { StatusBanner(it) }

            when (tab) {
                AppTab.Discover -> DiscoverScreen(state, scope)
                AppTab.Account -> AccountScreen(state, scope)
                AppTab.Contribute -> ContributeScreen(state, scope)
                AppTab.Bars -> VenuePortalScreen(state, scope)
                AppTab.Settings -> SettingsScreen(state, scope)
            }
        }
    }
}

@Composable
private fun DiscoverScreen(state: BeerMapState, scope: CoroutineScope) {
    var search by remember { mutableStateOf("") }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            AppCard {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f)) {
                        SectionHeader(
                            eyebrow = "BeerMap",
                            title = "Find the right bar faster",
                            subtitle = "Melbourne beer prices, happy hours, and venue updates using the same server-gated data as the website.",
                            icon = Icons.Filled.LocalBar
                        )
                    }
                }
                FeatureCard("Fast venue checks", "Search, save, and reveal server-gated price rows without leaving the app.", Icons.Filled.Search, Sky)
            }
        }
        item {
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = {
                    IconButton(onClick = { scope.launch { state.loadHome(search.takeIf { it.isNotBlank() }) } }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Search")
                    }
                },
                label = { Text("Search venue or suburb") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    MetricCard("Mapped venues", state.venues.size.toString(), Icons.Filled.Business, Sky)
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
            item { EmptyState("No venues loaded", "Refresh or check the backend connection.", Icons.Filled.Map) }
        } else {
            items(state.venues, key = { it.id }) { venue ->
                VenueCard(
                    venue = venue,
                    onOpen = { scope.launch { state.revealPrices(venue) } },
                    onSave = { scope.launch { state.saveVenue(venue) } }
                )
            }
        }
    }
}

@Composable
private fun VenueDetailCard(state: BeerMapState, scope: CoroutineScope, venue: Venue) {
    AppCard {
        SectionHeader("Venue", venue.name, venue.address ?: venue.location, Icons.Filled.Business)
        if (state.selectedPrices.isEmpty()) {
            EmptyState("No price rows yet", "This venue needs a trusted update.", Icons.Filled.Lock, framed = false)
        } else {
            state.selectedPrices.forEach { record ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(Modifier.weight(1f)) {
                        Text(record.beerName ?: "Beer", fontWeight = FontWeight.Bold)
                        Text(listOfNotNull(record.servingSize, record.happyHour).joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(record.formattedPrice, fontWeight = FontWeight.Black, color = if (record.priceRedacted) Plum else Leaf)
                }
                Divider()
            }
        }
        SecondaryAction("Refresh prices", icon = Icons.Filled.Refresh) {
            scope.launch { state.revealPrices(venue) }
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
    var happyOffer by remember { mutableStateOf("") }
    var happyNotes by remember { mutableStateOf("") }
    var happyStart by remember { mutableStateOf("16:00") }
    var happyEnd by remember { mutableStateOf("18:00") }
    var happyDays by remember { mutableStateOf(setOf("fri")) }
    var requestKind by remember { mutableStateOf("missing_venue") }
    var requestVenue by remember { mutableStateOf("") }
    var requestBeer by remember { mutableStateOf("") }
    var requestSuburb by remember { mutableStateOf("") }
    var requestNotes by remember { mutableStateOf("") }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) {
            runCatching {
                sourcePhotoDataUrlFromUri(context, uri)
            }.onSuccess {
                sourcePhotoDataUrl = it
                sourcePhotoStatus = "Photo ready for private reviewer evidence."
            }.onFailure {
                sourcePhotoDataUrl = null
                sourcePhotoStatus = it.message ?: "Could not prepare this photo."
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
                    title = "Keep BeerMap current",
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
        item {
            when (mode) {
                "Photo" -> PhotoUploadCard(
                    state = state,
                    scope = scope,
                    selectedVenueId = selectedVenueId,
                    onVenueSelected = { selectedVenueId = it },
                    sourcePhotoDataUrl = sourcePhotoDataUrl,
                    sourcePhotoStatus = sourcePhotoStatus,
                    notes = notes,
                    onNotes = { notes = it },
                    onChoosePhoto = {
                        photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    }
                )
                "Happy hour" -> HappyHourSubmissionCard(
                    state = state,
                    scope = scope,
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
                    onNotes = { happyNotes = it }
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
                    onNotes = { requestNotes = it }
                )
                "Missions" -> MissionsCard(state)
                else -> SubmitPriceCard(
                    state = state,
                    scope = scope,
                    selectedVenueId = selectedVenueId,
                    onVenueSelected = { selectedVenueId = it },
                    beerName = beerName,
                    onBeerName = { beerName = it },
                    price = price,
                    onPrice = { price = it },
                    serving = serving,
                    onServing = { serving = it },
                    notes = notes,
                    onNotes = { notes = it }
                )
            }
        }
    }
}

@Composable
private fun PhotoUploadCard(
    state: BeerMapState,
    scope: CoroutineScope,
    selectedVenueId: String,
    onVenueSelected: (String) -> Unit,
    sourcePhotoDataUrl: String?,
    sourcePhotoStatus: String,
    notes: String,
    onNotes: (String) -> Unit,
    onChoosePhoto: () -> Unit
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
                scope.launch { state.submitPhotoUpload(selectedVenueId, dataUrl, notes) }
            }
        }
        StatusBanner("Native location proof is not wired yet. Uploads still work, but location-based points depend on backend review rules.")
    }
}

@Composable
private fun HappyHourSubmissionCard(
    state: BeerMapState,
    scope: CoroutineScope,
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
    onNotes: (String) -> Unit
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
            scope.launch { state.submitHappyHourUpdate(selectedVenueId, selectedDays.sorted(), start, end, offer, notes) }
        }
        StatusBanner("If the board has lots of detail, Photo is usually faster and safer.")
    }
}

@Composable
private fun SubmitPriceCard(
    state: BeerMapState,
    scope: CoroutineScope,
    selectedVenueId: String,
    onVenueSelected: (String) -> Unit,
    beerName: String,
    onBeerName: (String) -> Unit,
    price: String,
    onPrice: (String) -> Unit,
    serving: String,
    onServing: (String) -> Unit,
    notes: String,
    onNotes: (String) -> Unit
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
        OutlinedTextField(price, onPrice, label = { Text("Observed price") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(listOf("pint", "pot", "schooner", "jug", "bottle", "can", "other")) { size ->
                FilterChip(selected = serving == size, onClick = { onServing(size) }, label = { Text(size.replaceFirstChar { it.uppercase() }) })
            }
        }
        OutlinedTextField(notes, onNotes, label = { Text("Notes, optional") }, minLines = 3, modifier = Modifier.fillMaxWidth())
        PrimaryAction("Send for review", state.signedIn && selectedVenueId.isNotBlank() && beerName.isNotBlank() && price.isNotBlank(), Icons.Filled.Add) {
            scope.launch { state.submitPriceUpdate(selectedVenueId, beerName, serving, price, notes) }
        }
        StatusBanner("Photo evidence and saved upload-location proof are still website-only in this native pass.")
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
    onNotes: (String) -> Unit
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
            scope.launch { state.requestMissing(requestKind, venueName, beerName, suburb, notes) }
        }
    }
}

@Composable
private fun MissionsCard(state: BeerMapState) {
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
                }
                Divider()
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
    var confirmLogout by remember { mutableStateOf(false) }
    var confirmDeletion by remember { mutableStateOf(false) }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Log out of BeerMap?") },
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
            text = { Text("BeerMap will create the same manual deletion review used by the website. Legal, security, billing, and moderation records may be retained when required.") },
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
                    MetricCard("Uploads", dashboard.submissionCount.toString(), Icons.Filled.Add, Leaf)
                }
                Column(Modifier.weight(1f)) {
                    MetricCard("Trust", dashboard.stats?.trustScore?.roundLabel() ?: dashboard.account.trustScore?.roundLabel() ?: "0", Icons.Filled.Lock, Plum)
                }
            }
            SpecialAccessCard(state, scope, dashboard)
            PrivacyCard(state, scope, dashboard.privacySettings)
            AppCard {
                SecondaryAction("Refresh account", icon = Icons.Filled.Refresh) { scope.launch { state.refreshAccount() } }
                SecondaryAction("Request account deletion review", icon = Icons.Filled.Lock) { confirmDeletion = true }
                PrimaryAction("Log out", icon = Icons.Filled.AccountCircle) { confirmLogout = true }
            }
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
    var createAccount by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var age by remember { mutableStateOf(false) }
    var terms by remember { mutableStateOf(false) }
    var privacy by remember { mutableStateOf(false) }

    AppCard {
        SectionHeader("BeerMap account", if (createAccount) "Create account" else "Welcome back", "Use the same account and venue assignments as the website.", Icons.Filled.AccountCircle)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !createAccount, onClick = { createAccount = false }, label = { Text("Sign in") })
            FilterChip(selected = createAccount, onClick = { createAccount = true }, label = { Text("Create") })
        }
        FormField("Email", Icons.Filled.AccountCircle, email, { email = it })
        OutlinedTextField(password, { password = it }, label = { Text("Password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
        if (createAccount) {
            FormField("Display name, optional", Icons.Filled.AccountCircle, displayName, { displayName = it })
            CheckRow("I confirm I am 18 or older", age) { age = it }
            CheckRow("I accept the Terms", terms) { terms = it }
            CheckRow("I accept the Privacy Policy", privacy) { privacy = it }
        }
        PrimaryAction(if (createAccount) "Create account" else "Sign in", email.isNotBlank() && password.isNotBlank(), Icons.Filled.AccountCircle) {
            scope.launch {
                if (createAccount) {
                    if (age && terms && privacy) state.signup(email, password, displayName) else state.error = "Confirm 18+ and accept the Terms and Privacy Policy."
                } else {
                    state.login(email, password)
                }
            }
        }
        StatusBanner("Native Google and Apple sign-in need final app redirect/provider setup. Email/password works through the existing backend today.")
    }
}

@Composable
private fun CheckRow(label: String, checked: Boolean, onChecked: (Boolean) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = checked, onCheckedChange = onChecked)
        Text(label)
    }
}

@Composable
private fun PrivacyCard(state: BeerMapState, scope: CoroutineScope, settings: PrivacySettings?) {
    var optional by remember(settings) { mutableStateOf(settings?.optionalAnalyticsEnabled ?: true) }
    var reports by remember(settings) { mutableStateOf(settings?.venueReportInclusionEnabled ?: true) }
    var research by remember(settings) { mutableStateOf(settings?.productResearchEnabled ?: true) }
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
    var section by remember { mutableStateOf("Dashboard") }
    val portal = state.portal
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (!state.signedIn) {
            item { EmptyState("Venue dashboard is invite-only", "Sign in with an assigned venue-manager account.", Icons.Filled.Storefront) }
        } else if (portal == null) {
            item {
                EmptyState("No venue dashboard yet", "Refresh or ask admin to assign your account to a venue.", Icons.Filled.Storefront)
                PrimaryAction("Refresh") { scope.launch { state.refreshPortal() } }
            }
        } else {
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
                    items(listOf("Dashboard", "Profile", "Beers", "Happy", "Specials", "Reports")) { label ->
                        FilterChip(selected = section == label, onClick = { section = label }, label = { Text(label) })
                    }
                }
            }
            item {
                when (section) {
                    "Profile" -> ProfileEditor(state, scope, portal.profile)
                    "Beers" -> BeerEditor(state, scope, portal.beers)
                    "Happy" -> HappyHourEditor(state, scope, portal.happyHours)
                    "Specials" -> SpecialEditor(state, scope, portal.specials, portal.tier?.canManageSpecials == true)
                    "Reports" -> ReportsCard(portal)
                    else -> PortalDashboardCard(portal)
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
        FormField("Phone", Icons.Filled.AccountCircle, phone, { phone = it })
        FormField("Website", Icons.Filled.Search, website, { website = it })
        FormField("Instagram URL", Icons.Filled.Tag, instagram, { instagram = it })
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
                membershipTier = profile?.membershipTier,
                active = profile?.active ?: true
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
                Divider()
            }
        }
        Divider()
        FormField("Beer name", Icons.Filled.LocalBar, beerName, { beerName = it })
        FormField("Brewery", Icons.Filled.Business, brewery, { brewery = it })
        FormField("Style", Icons.Filled.Tag, style, { style = it })
        FormField("Price", Icons.Filled.LocalBar, price, { price = it })
        PrimaryAction("Save beer row", beerName.isNotBlank(), Icons.Filled.Add) {
            val beer = BarBeer(null, beerName, brewery.blankToNull(), style.blankToNull(), "pint", price.toDoubleOrNull(), onTap = true, inStock = true, notes = null)
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
        Divider()
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
            Divider()
            FormField("Special title", Icons.Filled.Tag, title, { title = it })
            FormField("Description", Icons.Filled.Settings, description, { description = it }, minLines = 3, singleLine = false)
            FormField("Discount copy", Icons.Filled.Tag, discount, { discount = it })
            FormField("Price, optional", Icons.Filled.LocalBar, price, { price = it })
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
private fun ReportsCard(portal: PortalData) {
    AppCard {
        SectionHeader("Reports", if (portal.tier?.monthlyReports == true) "Monthly report" else "Reports locked", portal.tier?.upgradeCopy, Icons.Filled.Analytics)
        if (portal.tier?.monthlyReports == true) {
            MetricCard("Privacy floor", if (portal.analytics?.privacyFloorMet == true) "Met" else "Building", Icons.Filled.Lock, Leaf)
            Text("CSV and JSON exports use the existing backend route and can be wired to Android share/download handling before release.", style = MaterialTheme.typography.bodyMedium)
        } else {
            EmptyState("Upgrade to Pro", portal.tier?.upgradeCopy ?: "Pro unlocks analytics and monthly reports.", Icons.Filled.Analytics)
        }
    }
}

@Composable
private fun SettingsScreen(state: BeerMapState, scope: CoroutineScope) {
    var support by remember { mutableStateOf("") }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        AppCard {
            SectionHeader("Configuration", "Backend connection", "The native app reuses the existing BeerMap/Pint Path API and data.", Icons.Filled.Settings)
            Text("API base URL: ${BuildConfig.PINT_PATH_API_BASE_URL}", style = MaterialTheme.typography.bodyMedium)
            Text("Supabase native OAuth: ${if (BuildConfig.SUPABASE_URL.isBlank()) "Not configured" else "Public config present"}", style = MaterialTheme.typography.bodyMedium)
            Text("Field-test mode: ${if (state.config.optBoolean("fieldTestMode", false)) "On" else "Off"}", style = MaterialTheme.typography.bodyMedium)
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
            SectionHeader("Safety", "Responsible use", "BeerMap is 18+ only. Prices and availability can change, and venues may refuse service under RSA obligations.", Icons.Filled.Lock)
            FeatureCard("Opt-in location", "Location is one-time where used.", Icons.Filled.Map, Sky)
            FeatureCard("Private reports", "Venue reports use aggregate privacy-safe analytics.", Icons.Filled.Analytics, Leaf)
            FeatureCard("Source evidence", "Private source evidence is handled by the backend.", Icons.Filled.Lock, Amber)
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

private fun sourcePhotoDataUrlFromUri(context: Context, uri: Uri): String {
    val mimeType = context.contentResolver.getType(uri) ?: "image/jpeg"
    require(mimeType.startsWith("image/")) { "Choose an image file for source evidence." }
    val originalBytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        ?: error("Could not read this photo.")
    require(originalBytes.isNotEmpty()) { "Could not read this photo." }

    val bitmap = BitmapFactory.decodeByteArray(originalBytes, 0, originalBytes.size)
    val uploadBytes = if (bitmap != null) {
        ByteArrayOutputStream().use { output ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 84, output)
            output.toByteArray()
        }
    } else {
        originalBytes
    }
    val uploadMimeType = if (bitmap != null) "image/jpeg" else mimeType

    require(uploadBytes.size <= 6 * 1024 * 1024) { "Each upload image must be 6MB or smaller." }
    return "data:$uploadMimeType;base64,${Base64.encodeToString(uploadBytes, Base64.NO_WRAP)}"
}

private fun Double.roundLabel(): String =
    if (this % 1.0 == 0.0) toInt().toString() else String.format(Locale.US, "%.1f", this)

private fun moneyFromCents(cents: Int): String =
    "$" + String.format(Locale.US, "%.2f", cents / 100.0)

private fun String.blankToNull(): String? = trim().takeIf { it.isNotBlank() }
