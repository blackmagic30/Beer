@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package au.pintpath.beermap.ui.features

import android.app.TimePickerDialog
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
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
import au.pintpath.beermap.data.SessionStore
import au.pintpath.beermap.data.Venue
import au.pintpath.beermap.ui.components.AppCard
import au.pintpath.beermap.ui.components.EmptyState
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
    Discover("Discover"),
    Account("Account"),
    Bars("Bars"),
    Settings("Settings")
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
                    icon = { Icon(Icons.Filled.Map, contentDescription = null) },
                    label = { Text(AppTab.Discover.label) }
                )
                NavigationBarItem(
                    selected = tab == AppTab.Account,
                    onClick = { tab = AppTab.Account },
                    icon = { Icon(Icons.Filled.AccountCircle, contentDescription = null) },
                    label = { Text(AppTab.Account.label) }
                )
                NavigationBarItem(
                    selected = tab == AppTab.Bars,
                    onClick = { tab = AppTab.Bars },
                    icon = { Icon(Icons.Filled.Storefront, contentDescription = null) },
                    label = { Text(AppTab.Bars.label) }
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
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    CircularProgressIndicator(Modifier.padding(top = 2.dp))
                    Text("Updating BeerMap", style = MaterialTheme.typography.bodyMedium)
                }
            }
            state.error?.let { StatusBanner(it, isError = true) }
            state.message?.let { StatusBanner(it) }

            when (tab) {
                AppTab.Discover -> DiscoverScreen(state, scope)
                AppTab.Account -> AccountScreen(state, scope)
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
                            subtitle = "Melbourne beer prices, happy hours, and venue updates using the same server-gated data as the website."
                        )
                    }
                    Icon(Icons.Filled.LocalBar, contentDescription = null, tint = Amber)
                }
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
            item { EmptyState("No venues loaded", "Refresh or check the backend connection.") }
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
        SectionHeader("Venue", venue.name, venue.address ?: venue.location)
        if (state.selectedPrices.isEmpty()) {
            EmptyState("No price rows yet", "This venue needs a trusted update.", Icons.Filled.Lock)
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
        SecondaryAction("Refresh prices") {
            scope.launch { state.revealPrices(venue) }
        }
    }
}

@Composable
private fun AccountScreen(state: BeerMapState, scope: CoroutineScope) {
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
            SectionHeader("Account", dashboard.account.displayName ?: dashboard.account.email, "Contribution progress, privacy, and session controls.")
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
            PrivacyCard(state, scope, dashboard.privacySettings)
            AppCard {
                SecondaryAction("Refresh account") { scope.launch { state.refreshAccount() } }
                SecondaryAction("Request account deletion review") { scope.launch { state.requestDeletion() } }
                PrimaryAction("Log out") { scope.launch { state.logout() } }
            }
        }
    }
}

@Composable
private fun AuthCard(state: BeerMapState, scope: CoroutineScope) {
    var createAccount by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var age by remember { mutableStateOf(true) }
    var terms by remember { mutableStateOf(true) }
    var privacy by remember { mutableStateOf(true) }

    AppCard {
        SectionHeader("BeerMap account", if (createAccount) "Create account" else "Welcome back", "Use the same account and venue assignments as the website.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !createAccount, onClick = { createAccount = false }, label = { Text("Sign in") })
            FilterChip(selected = createAccount, onClick = { createAccount = true }, label = { Text("Create") })
        }
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(password, { password = it }, label = { Text("Password") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
        if (createAccount) {
            OutlinedTextField(displayName, { displayName = it }, label = { Text("Display name, optional") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
            CheckRow("I confirm I am 18 or older", age) { age = it }
            CheckRow("I accept the Terms", terms) { terms = it }
            CheckRow("I accept the Privacy Policy", privacy) { privacy = it }
        }
        PrimaryAction(if (createAccount) "Create account" else "Sign in", email.isNotBlank() && password.isNotBlank()) {
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
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Checkbox(checked = checked, onCheckedChange = onChecked)
        Text(label, modifier = Modifier.padding(top = 12.dp))
    }
}

@Composable
private fun PrivacyCard(state: BeerMapState, scope: CoroutineScope, settings: PrivacySettings?) {
    var optional by remember(settings) { mutableStateOf(settings?.optionalAnalyticsEnabled ?: true) }
    var reports by remember(settings) { mutableStateOf(settings?.venueReportInclusionEnabled ?: true) }
    var research by remember(settings) { mutableStateOf(settings?.productResearchEnabled ?: true) }
    var emails by remember(settings) { mutableStateOf(settings?.emailUpdatesEnabled ?: false) }

    AppCard {
        SectionHeader("Privacy", "Data controls", "Optional analytics and venue-report inclusion match the website.")
        CheckRow("Optional analytics", optional) { optional = it }
        CheckRow("Include my activity in aggregate venue reports", reports) { reports = it }
        CheckRow("Product research contact", research) { research = it }
        CheckRow("Email product updates", emails) { emails = it }
        PrimaryAction("Save privacy settings") {
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
                    SectionHeader(portal.tier?.tierLabel ?: portal.profile?.membershipTier ?: "Venue", portal.selectedVenue?.venueName ?: "Venue dashboard", portal.privacyCopy)
                    portal.message?.let { StatusBanner(it) }
                    if (portal.assignments.size > 1) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                            portal.assignments.take(3).forEach { assignment ->
                                AssistChip(onClick = { scope.launch { state.refreshPortal(assignment.venueId) } }, label = { Text(assignment.venueName) })
                            }
                        }
                    }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                    listOf("Dashboard", "Profile", "Beers", "Happy", "Specials", "Reports").forEach { label ->
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
        portal.analytics?.let {
            AppCard {
                SectionHeader("Analytics", if (it.privacyFloorMet) "Demand snapshot" else "Demand snapshot building", "Aggregate venue insights only.")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) { MetricCard("Lookups", it.barLookups.toString(), Icons.Filled.Search, Sky) }
                    Column(Modifier.weight(1f)) { MetricCard("Beer views", it.beerListViews.toString(), Icons.Filled.Analytics, Leaf) }
                }
            }
        } ?: EmptyState("Pro analytics are locked", portal.tier?.upgradeCopy ?: "Pro unlocks privacy-safe analytics and monthly reports.", Icons.Filled.Analytics)
    }
}

@Composable
private fun ProfileEditor(state: BeerMapState, scope: CoroutineScope, profile: BarProfile?) {
    var name by remember(profile) { mutableStateOf(profile?.name.orEmpty()) }
    var address by remember(profile) { mutableStateOf(profile?.address.orEmpty()) }
    var suburb by remember(profile) { mutableStateOf(profile?.suburb.orEmpty()) }
    var phone by remember(profile) { mutableStateOf(profile?.phone.orEmpty()) }
    var website by remember(profile) { mutableStateOf(profile?.website.orEmpty()) }
    var description by remember(profile) { mutableStateOf(profile?.description.orEmpty()) }

    AppCard {
        SectionHeader("Profile", "Bar profile", "Keep public venue details accurate.")
        OutlinedTextField(name, { name = it }, label = { Text("Venue name") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(address, { address = it }, label = { Text("Address") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(suburb, { suburb = it }, label = { Text("Suburb") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(phone, { phone = it }, label = { Text("Phone") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(website, { website = it }, label = { Text("Website") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(description, { description = it }, label = { Text("Description") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
        PrimaryAction("Save profile", name.isNotBlank()) {
            val next = BarProfile(
                name = name,
                address = address.blankToNull(),
                suburb = suburb.blankToNull(),
                area = profile?.area,
                phone = phone.blankToNull(),
                website = website.blankToNull(),
                instagram = profile?.instagram,
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
        SectionHeader("Stock", "Beers and prices", "Venue updates stay server-reviewed where required.")
        beers.take(8).forEach {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(it.beerName, fontWeight = FontWeight.Bold)
                    Text(listOfNotNull(it.style, it.serveSize, if (it.onTap) "On tap" else null).joinToString(" · "), style = MaterialTheme.typography.labelMedium)
                }
                Text(it.price?.let { value -> "$" + "%.2f".format(value) } ?: "")
            }
        }
        Divider()
        OutlinedTextField(beerName, { beerName = it }, label = { Text("Beer name") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(brewery, { brewery = it }, label = { Text("Brewery") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(style, { style = it }, label = { Text("Style") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(price, { price = it }, label = { Text("Price") }, modifier = Modifier.fillMaxWidth())
        PrimaryAction("Save beer row", beerName.isNotBlank()) {
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
        SectionHeader("Happy hours", "Current specials", "Use native time pickers for staff-friendly updates.")
        happyHours.take(6).forEach {
            Text("${it.title} · ${it.daysOfWeek.joinToString(", ")} · ${it.startTime}-${it.endTime}", fontWeight = FontWeight.SemiBold)
        }
        Divider()
        OutlinedTextField(title, { title = it }, label = { Text("Title") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(description, { description = it }, label = { Text("Description") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { showTimePicker(context, start) { start = it } }) { Text("Starts $start") }
            Button(onClick = { showTimePicker(context, end) { end = it } }) { Text("Ends $end") }
        }
        CheckRow("Friday", friday) { friday = it }
        CheckRow("Saturday", saturday) { saturday = it }
        PrimaryAction("Save happy hour", title.isNotBlank() && description.isNotBlank() && (friday || saturday)) {
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
        SectionHeader("Specials", "Pint Path specials", if (canManage) "Pro venues can submit reviewed specials." else "Upgrade to Pro to add reviewed specials.")
        if (!canManage) StatusBanner("Free venues can manage beers and happy hours. Pro unlocks reviewed specials.")
        specials.take(6).forEach {
            Text("${it.title} · ${it.discount.orEmpty()} · ${it.startTime}-${it.endTime}", fontWeight = FontWeight.SemiBold)
        }
        if (canManage) {
            Divider()
            OutlinedTextField(title, { title = it }, label = { Text("Special title") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(description, { description = it }, label = { Text("Description") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
            OutlinedTextField(discount, { discount = it }, label = { Text("Discount copy") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(price, { price = it }, label = { Text("Price, optional") }, modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { showTimePicker(context, start) { start = it } }) { Text("Starts $start") }
                Button(onClick = { showTimePicker(context, end) { end = it } }) { Text("Ends $end") }
            }
            PrimaryAction("Save special", title.isNotBlank() && description.isNotBlank()) {
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
        SectionHeader("Reports", if (portal.tier?.monthlyReports == true) "Monthly report" else "Reports locked", portal.tier?.upgradeCopy)
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
            SectionHeader("Configuration", "Backend connection", "The native app reuses the existing BeerMap/Pint Path API and data.")
            Text("API base URL: ${BuildConfig.PINT_PATH_API_BASE_URL}", style = MaterialTheme.typography.bodyMedium)
            Text("Supabase native OAuth: ${if (BuildConfig.SUPABASE_URL.isBlank()) "Not configured" else "Public config present"}", style = MaterialTheme.typography.bodyMedium)
            Text("Field-test mode: ${if (state.config.optBoolean("fieldTestMode", false)) "On" else "Off"}", style = MaterialTheme.typography.bodyMedium)
        }
        AppCard {
            SectionHeader("Support", "Need help?", "Use this for privacy, billing, venue account, or moderation support.")
            OutlinedTextField(support, { support = it }, label = { Text("Message") }, minLines = 4, modifier = Modifier.fillMaxWidth())
            PrimaryAction("Send support note", support.trim().length >= 3) {
                scope.launch {
                    state.sendFeedback(support)
                    support = ""
                }
            }
        }
        AppCard {
            SectionHeader("Safety", "Responsible use", "BeerMap is 18+ only. Prices and availability can change, and venues may refuse service under RSA obligations.")
            Text("Location is opt-in and one-time where used.")
            Text("Venue reports use aggregate privacy-safe analytics.")
            Text("Private source evidence is handled by the backend.")
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

private fun Double.roundLabel(): String =
    if (this % 1.0 == 0.0) toInt().toString() else String.format(Locale.US, "%.1f", this)

private fun String.blankToNull(): String? = trim().takeIf { it.isNotBlank() }
