import CoreLocation
import MapKit
import SwiftUI

private struct ExploreBeerOption: Identifiable, Hashable {
    let id: String
    let name: String
}

private enum ExploreBeerFilterAccess {
    static let freeOptions = [
        ExploreBeerOption(id: "guinness", name: "Guinness"),
        ExploreBeerOption(id: "carlton_draft", name: "Carlton Draught"),
        ExploreBeerOption(id: "stone_and_wood_pacific_ale", name: "Stone & Wood Pacific Ale"),
    ]

    private static let freeKeys = Set(freeOptions.map(\.id))

    static func canonicalKey(_ value: String) -> String {
        let folded = value.folding(
            options: [.caseInsensitive, .diacriticInsensitive],
            locale: Locale(identifier: "en_AU")
        )
        let normalized = folded
            .replacingOccurrences(of: "&", with: " and ")
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
            .joined(separator: "_")

        switch normalized {
        case "carlton_draught":
            return "carlton_draft"
        case "stone_wood", "stone_and_wood", "stone_wood_pacific_ale":
            return "stone_and_wood_pacific_ale"
        default:
            return normalized
        }
    }

    static func isFree(_ key: String) -> Bool {
        freeKeys.contains(canonicalKey(key))
    }

    static func venueMatches(beerKey: String, venueBeerKeys: [String]?) -> Bool {
        let selectedKey = canonicalKey(beerKey)
        return venueBeerKeys?.contains {
            canonicalKey($0) == selectedKey
        } == true
    }
}

struct DiscoverView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @StateObject private var locationProvider = ExploreLocationProvider()
    @State private var searchText = ""
    @State private var selectedMapVenue: Venue?
    @State private var destinationVenue: Venue?
    @State private var selectedSuburb: String?
    @State private var selectedBeerKey: String?
    @State private var nearbyOnly = false
    @State private var nearbyRadiusKm = 5.0
    @State private var userLocation: CLLocation?
    @State private var isLocating = false
    @State private var showingFilters = false
    @State private var distanceByVenue: [VenueDistanceKey: CLLocationDistance] = [:]
    @State private var lastTrackedSearchSignature: String?
    @State private var pendingSearchTrackingTask: Task<Void, Never>?
    @State private var activeSearchMeasurementTask: Task<Void, Never>?

    private struct VenueDistanceKey: Hashable {
        let id: String
        let latitude: Double
        let longitude: Double

        init?(venue: Venue) {
            guard let latitude = venue.latitude, let longitude = venue.longitude else { return nil }
            self.id = venue.id
            self.latitude = latitude
            self.longitude = longitude
        }
    }

    private struct VenueResults {
        let filtered: [Venue]
        let mapped: [Venue]
        let suburbs: [String]
    }

    private var hasFullBeerAccess: Bool {
        model.hasContributorAccess
    }

    private var beerOptions: [ExploreBeerOption] {
        var optionsByKey: [String: ExploreBeerOption] = [:]
        for beer in model.config?.trackedBeers ?? [] {
            let key = ExploreBeerFilterAccess.canonicalKey(beer.id)
            guard !key.isEmpty else { continue }
            optionsByKey[key] = ExploreBeerOption(id: key, name: beer.name)
        }

        let freeOptions = ExploreBeerFilterAccess.freeOptions.map {
            optionsByKey.removeValue(forKey: $0.id) ?? $0
        }
        let lockedOptions = optionsByKey.values.sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        return freeOptions + lockedOptions
    }

    private var selectedBeerName: String? {
        guard let selectedBeerKey else { return nil }
        return beerOptions.first {
            ExploreBeerFilterAccess.canonicalKey($0.id)
                == ExploreBeerFilterAccess.canonicalKey(selectedBeerKey)
        }?.name
    }

    var body: some View {
        let results = makeVenueResults()

        ZStack(alignment: .top) {
            if model.venues.isEmpty && model.isLoading {
                VStack(spacing: 12) {
                    ProgressView()
                        .controlSize(.large)
                        .tint(BeerMapTheme.amber)
                    Text("Drawing the pub map…")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 190)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if results.filtered.isEmpty {
                VStack(spacing: 16) {
                    EmptyStateView(
                        title: model.venues.isEmpty ? "Venues are unavailable" : "No venues match",
                        message: model.venues.isEmpty
                            ? "Check your connection, then draw the pub map again."
                            : "Try another pub, suburb or beer—or clear the route.",
                        systemImage: model.venues.isEmpty ? "wifi.exclamationmark" : "line.3.horizontal.decrease.circle"
                    )
                    .frame(maxWidth: 440)

                    PrimaryButton(
                        title: model.venues.isEmpty ? "Try again" : "Clear filters",
                        systemImage: model.venues.isEmpty ? "arrow.clockwise" : "xmark.circle.fill",
                        isLoading: model.isLoading
                    ) {
                        if model.venues.isEmpty {
                            Task { await model.loadHome() }
                        } else {
                            clearFilters()
                        }
                    }
                    .frame(maxWidth: 320)
                }
                .padding(.horizontal)
                .padding(.top, 170)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                venueMap(filteredVenues: results.filtered, mappedVenues: results.mapped)
            }

            controls(resultCount: results.filtered.count)
                .padding(.horizontal, 12)
                .padding(.top, 10)
        }
        .beerMapScreen()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                PintPathBrandLockup(compact: true)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.loadHome() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(model.isLoading)
                .accessibilityLabel("Refresh venues")
            }
        }
        .sheet(isPresented: $showingFilters, onDismiss: trackCommittedSearch) {
            ExploreFilterSheet(
                suburbs: results.suburbs,
                beers: beerOptions,
                selectedSuburb: $selectedSuburb,
                selectedBeerKey: $selectedBeerKey,
                nearbyOnly: Binding(
                    get: { nearbyOnly },
                    set: { enabled in
                        setNearbyEnabled(enabled)
                    }
                ),
                nearbyRadiusKm: $nearbyRadiusKm,
                isLocating: isLocating,
                hasFullBeerAccess: hasFullBeerAccess,
                resultCount: results.filtered.count,
                clear: clearFilterValues
            )
        }
        .onChange(of: model.venues) { _, venues in
            rebuildDistanceCache(for: venues, from: userLocation)
        }
        .onChange(of: model.accountDashboard?.account.subscriptionStatus) { previousStatus, currentStatus in
            let contributorAccess = currentStatus?.caseInsensitiveCompare("contributor_unlocked") == .orderedSame
            if contributorAccess,
               previousStatus?.caseInsensitiveCompare("contributor_unlocked") != .orderedSame {
                Task { await model.loadHome() }
            } else if !contributorAccess,
                      let selectedBeerKey,
                      !ExploreBeerFilterAccess.isFree(selectedBeerKey) {
                self.selectedBeerKey = nil
            }
        }
        .navigationDestination(for: Venue.self) { venue in
            VenueDetailView(venue: venue)
        }
        .navigationDestination(item: $destinationVenue) { venue in
            VenueDetailView(venue: venue)
        }
        .onDisappear {
            pendingSearchTrackingTask?.cancel()
            activeSearchMeasurementTask?.cancel()
        }
    }

    private func controls(resultCount: Int) -> some View {
        VStack(spacing: 11) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(BeerMapTheme.amber)
                    .accessibilityHidden(true)
                TextField("Pub, suburb or postcode", text: $searchText)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .font(.body.weight(.medium))
                    .accessibilityLabel("Search pubs, suburbs or postcodes")
                    .onSubmit(trackCommittedSearch)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                        scheduleSearchTracking()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.leading, 13)
            .padding(.trailing, searchText.isEmpty ? 13 : 4)
            .frame(minHeight: 48)
            .background(BeerMapTheme.card.opacity(0.92), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(BeerMapTheme.hairline, lineWidth: 1)
            )

            if dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: 10) {
                    Label("\(resultCount) pubs", systemImage: "mappin.and.ellipse")
                        .font(.headline.monospacedDigit().weight(.bold))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    compactExploreButton(
                        systemImage: "line.3.horizontal.decrease",
                        label: "Filters",
                        selected: activeFilterCount > 0,
                        badge: activeFilterCount
                    ) {
                        showingFilters = true
                    }
                    compactExploreButton(
                        systemImage: isLocating ? "location.circle" : "location.fill",
                        label: isLocating ? "Locating" : "Near me",
                        selected: nearbyOnly
                    ) {
                        setNearbyEnabled(!nearbyOnly)
                        scheduleSearchTracking()
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Label("\(resultCount) pubs", systemImage: "mappin.and.ellipse")
                        .font(.subheadline.monospacedDigit().weight(.bold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Spacer(minLength: 2)
                    FilterChip(
                        title: "Filters",
                        systemImage: "line.3.horizontal.decrease",
                        isSelected: activeFilterCount > 0,
                        badge: activeFilterCount
                    ) {
                        showingFilters = true
                    }

                    FilterChip(
                        title: isLocating ? "Locating…" : "Near me",
                        systemImage: isLocating ? "location.circle" : "location.fill",
                        isSelected: nearbyOnly
                    ) {
                        setNearbyEnabled(!nearbyOnly)
                        scheduleSearchTracking()
                    }
                }
            }

            if selectedSuburb != nil || selectedBeerName != nil || activeFilterCount > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    if let selectedSuburb {
                        FilterChip(
                            title: selectedSuburb,
                            systemImage: "mappin",
                            isSelected: true
                        ) {
                            self.selectedSuburb = nil
                            scheduleSearchTracking()
                        }
                    }

                    if let selectedBeerName {
                        FilterChip(
                            title: selectedBeerName,
                            assetImage: BeerMapAsset.beerPint,
                            isSelected: true
                        ) {
                            selectedBeerKey = nil
                            scheduleSearchTracking()
                        }
                    }

                    if activeFilterCount > 0 || !searchText.isEmpty {
                        FilterChip(title: "Clear route", systemImage: "xmark", action: clearFilters)
                    }
                }
            }
            }
        }
        .pintPathFloatingPanel(padding: 11)
    }

    private func compactExploreButton(
        systemImage: String,
        label: String,
        selected: Bool,
        badge: Int? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.headline.weight(.bold))
                .foregroundStyle(selected ? BeerMapTheme.brandInk : BeerMapTheme.primaryAction)
                .frame(width: 52, height: 52)
                .background(selected ? BeerMapTheme.brandGold : BeerMapTheme.card, in: Circle())
                .overlay(
                    Circle().stroke(BeerMapTheme.separator.opacity(selected ? 0 : 0.35), lineWidth: 1)
                )
                .overlay(alignment: .topTrailing) {
                    if let badge, badge > 0 {
                        Text("\(badge)")
                            .font(.caption2.weight(.black))
                            .foregroundStyle(BeerMapTheme.paper)
                            .frame(minWidth: 20, minHeight: 20)
                            .background(BeerMapTheme.brandInk, in: Circle())
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func makeVenueResults() -> VenueResults {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        var seenVenueIDs = Set<String>()
        var uniqueVenues: [Venue] = []
        var suburbNames = Set<String>()
        uniqueVenues.reserveCapacity(model.venues.count)

        for venue in model.venues where seenVenueIDs.insert(venue.id).inserted {
            uniqueVenues.append(venue)
            if let suburb = venue.suburb?.trimmed.nilIfBlank {
                suburbNames.insert(suburb)
            }
        }

        var matches = uniqueVenues.filter { venue in
            if let selectedSuburb,
               venue.suburb?.caseInsensitiveCompare(selectedSuburb) != .orderedSame {
                return false
            }
            if let selectedBeerKey,
               !ExploreBeerFilterAccess.venueMatches(
                   beerKey: selectedBeerKey,
                   venueBeerKeys: venue.beerKeys
               ) {
                return false
            }
            if nearbyOnly, userLocation != nil {
                guard let distance = cachedDistance(to: venue) else { return false }
                guard distance <= nearbyRadiusKm * 1_000 else { return false }
            }
            guard !query.isEmpty else { return true }
            return [venue.name, venue.address, venue.suburb, venue.state, venue.postcode]
                .compactMap { $0 }
                .contains { $0.localizedStandardContains(query) }
        }

        if nearbyOnly, userLocation != nil {
            matches.sort {
                (cachedDistance(to: $0) ?? .greatestFiniteMagnitude)
                    < (cachedDistance(to: $1) ?? .greatestFiniteMagnitude)
            }
        }

        return VenueResults(
            filtered: matches,
            mapped: matches.filter { $0.latitude != nil && $0.longitude != nil },
            suburbs: suburbNames.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        )
    }

    private var activeFilterCount: Int {
        (selectedSuburb == nil ? 0 : 1)
            + (selectedBeerKey == nil ? 0 : 1)
            + (nearbyOnly ? 1 : 0)
    }

    @ViewBuilder
    private func venueMap(filteredVenues: [Venue], mappedVenues: [Venue]) -> some View {
        if mappedVenues.isEmpty {
            VStack(spacing: 14) {
                EmptyStateView(
                    title: "No map pins available",
                    message: "These venues do not have map coordinates yet. Try another filter or refresh the map.",
                    systemImage: "mappin.slash"
                )
                SecondaryButton(title: "Refresh map", systemImage: "arrow.clockwise") {
                    Task { await model.loadHome() }
                }
                .frame(maxWidth: 320)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ClusteredVenueMap(venues: mappedVenues, selectedVenue: $selectedMapVenue)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .bottom) {
                    VStack(spacing: 10) {
                        if let selectedMapVenue {
                            venuePeek(selectedMapVenue)
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                        if mappedVenues.count < filteredVenues.count {
                        Label(
                            "\(filteredVenues.count - mappedVenues.count) pubs are listed without a pin",
                            systemImage: "mappin.slash"
                        )
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                            .background(.regularMaterial, in: Capsule())
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
                    .animation(.snappy, value: selectedMapVenue?.id)
                }
                .accessibilityLabel("Venue map with \(mappedVenues.count) mapped venues")
        }
    }

    private func venuePeek(_ venue: Venue) -> some View {
        HStack(spacing: 13) {
            PintPathMark(size: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(venue.name)
                    .font(.system(.headline, design: .serif, weight: .bold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Text(venue.displayLocation.isEmpty ? "Melbourne pub" : venue.displayLocation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button {
                selectedMapVenue = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 38, height: 38)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Close venue preview")
            Button {
                destinationVenue = venue
            } label: {
                Image(systemName: "arrow.right")
                    .font(.subheadline.weight(.black))
                    .foregroundStyle(BeerMapTheme.brandInk)
                    .frame(width: 42, height: 42)
                    .background(BeerMapTheme.brandGold, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("View \(venue.name)")
        }
        .pintPathFloatingPanel(padding: 12)
    }

    private func clearFilters() {
        searchText = ""
        clearFilterValues()
        scheduleSearchTracking()
    }

    private func clearFilterValues() {
        selectedSuburb = nil
        selectedBeerKey = nil
        nearbyOnly = false
    }

    private func setNearbyEnabled(_ enabled: Bool) {
        guard enabled else {
            nearbyOnly = false
            return
        }
        nearbyOnly = true
        guard userLocation == nil, !isLocating else { return }
        Task { await requestNearbyLocation() }
    }

    @MainActor
    private func requestNearbyLocation() async {
        isLocating = true
        defer { isLocating = false }
        do {
            let location = try await locationProvider.request()
            rebuildDistanceCache(for: model.venues, from: location)
            userLocation = location
            if !showingFilters {
                scheduleSearchTracking()
            }
        } catch {
            nearbyOnly = false
            model.errorMessage = error.localizedDescription
        }
    }

    private func rebuildDistanceCache(for venues: [Venue], from location: CLLocation?) {
        guard let location else {
            distanceByVenue = [:]
            return
        }

        var updated: [VenueDistanceKey: CLLocationDistance] = [:]
        updated.reserveCapacity(venues.count)
        for venue in venues {
            guard let key = VenueDistanceKey(venue: venue), updated[key] == nil else { continue }
            updated[key] = location.distance(
                from: CLLocation(latitude: key.latitude, longitude: key.longitude)
            )
        }
        distanceByVenue = updated
    }

    private func cachedDistance(to venue: Venue) -> CLLocationDistance? {
        guard let key = VenueDistanceKey(venue: venue) else { return nil }
        return distanceByVenue[key]
    }

    private func scheduleSearchTracking() {
        pendingSearchTrackingTask?.cancel()
        pendingSearchTrackingTask = Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 350_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            trackCommittedSearch()
        }
    }

    private func trackCommittedSearch() {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasSearchIntent = !query.isEmpty
            || selectedSuburb != nil
            || selectedBeerKey != nil
            || nearbyOnly
        guard hasSearchIntent else {
            activeSearchMeasurementTask?.cancel()
            return
        }
        guard !nearbyOnly || userLocation != nil else {
            activeSearchMeasurementTask?.cancel()
            return
        }

        let normalizedQuery = query.folding(
            options: [.caseInsensitive, .diacriticInsensitive],
            locale: Locale(identifier: "en_AU")
        ).lowercased()
        let signature = [
            normalizedQuery,
            selectedSuburb?.lowercased() ?? "",
            selectedBeerKey.map(ExploreBeerFilterAccess.canonicalKey) ?? "",
            nearbyOnly ? "nearby" : "all_distances",
            nearbyOnly ? String(format: "%.1f", nearbyRadiusKm) : "",
        ].joined(separator: "|")
        guard signature != lastTrackedSearchSignature else { return }
        lastTrackedSearchSignature = signature

        let results = makeVenueResults()
        activeSearchMeasurementTask?.cancel()
        activeSearchMeasurementTask = Task { @MainActor in
            let measured = await model.trackExploreSearch(
                query: query,
                visibleVenues: results.filtered,
                selectedBeerKey: selectedBeerKey,
                selectedSuburb: selectedSuburb,
                nearbyOnly: nearbyOnly,
                radiusKm: nearbyRadiusKm
            )
            guard !Task.isCancelled else { return }
            if !measured, lastTrackedSearchSignature == signature {
                lastTrackedSearchSignature = nil
            }
        }
    }

}

@MainActor
private final class ExploreLocationProvider: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func request() async throws -> CLLocation {
        guard continuation == nil else { throw ExploreLocationError.requestInProgress }
        switch manager.authorizationStatus {
        case .denied, .restricted:
            throw ExploreLocationError.permissionDenied
        default:
            break
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            if manager.authorizationStatus == .notDetermined {
                manager.requestWhenInUseAuthorization()
            } else {
                manager.requestLocation()
            }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard continuation != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied, .restricted:
            finish(.failure(ExploreLocationError.permissionDenied))
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else {
            finish(.failure(ExploreLocationError.unavailable))
            return
        }
        finish(.success(location))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(.failure(error))
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
}

private enum ExploreLocationError: LocalizedError {
    case permissionDenied
    case requestInProgress
    case unavailable

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Location access is off. Enable While Using the App in Settings to filter nearby venues."
        case .requestInProgress:
            return "Pint Path is already requesting your location."
        case .unavailable:
            return "Your location was unavailable. Try again outdoors or browse by suburb instead."
        }
    }
}

private struct ExploreFilterSheet: View {
    private static let pageSize = 6

    @Environment(\.dismiss) private var dismiss
    let suburbs: [String]
    let beers: [ExploreBeerOption]
    @Binding var selectedSuburb: String?
    @Binding var selectedBeerKey: String?
    @Binding var nearbyOnly: Bool
    @Binding var nearbyRadiusKm: Double
    let isLocating: Bool
    let hasFullBeerAccess: Bool
    let resultCount: Int
    let clear: () -> Void
    @State private var filterSearch = ""
    @State private var visibleSuburbCount = Self.pageSize
    @State private var visibleBeerCount = Self.pageSize
    @State private var showingLockedBeerMessage = false

    private var matchingSuburbs: [String] {
        let query = filterSearch.trimmed
        guard !query.isEmpty else { return suburbs }
        return suburbs.filter { $0.localizedStandardContains(query) }
    }

    private var visibleSuburbs: [String] {
        var values = Array(matchingSuburbs.prefix(visibleSuburbCount))
        if let selectedSuburb,
           matchingSuburbs.contains(selectedSuburb),
           !values.contains(selectedSuburb) {
            values.insert(selectedSuburb, at: 0)
        }
        return values
    }

    private var matchingBeers: [ExploreBeerOption] {
        let query = filterSearch.trimmed
        guard !query.isEmpty else { return beers }
        return beers.filter { beer in
            beer.name.localizedStandardContains(query)
                || beer.id.localizedStandardContains(query)
        }
    }

    private var visibleBeers: [ExploreBeerOption] {
        var values = Array(matchingBeers.prefix(visibleBeerCount))
        if let selectedBeerKey,
           let selected = matchingBeers.first(where: {
               ExploreBeerFilterAccess.canonicalKey($0.id)
                   == ExploreBeerFilterAccess.canonicalKey(selectedBeerKey)
           }),
           !values.contains(selected) {
            values.insert(selected, at: 0)
        }
        return values
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Distance") {
                    Toggle(isOn: $nearbyOnly) {
                        Label(isLocating ? "Finding your location…" : "Only venues near me", systemImage: "location.fill")
                    }
                    .disabled(isLocating)

                    if nearbyOnly {
                        Picker("Within", selection: $nearbyRadiusKm) {
                            Text("1 km").tag(1.0)
                            Text("2 km").tag(2.0)
                            Text("5 km").tag(5.0)
                            Text("10 km").tag(10.0)
                            Text("25 km").tag(25.0)
                        }
                        .pickerStyle(.menu)
                    }
                }

                Section("Beer") {
                    Button {
                        selectedBeerKey = nil
                    } label: {
                        filterRow(title: "All beers", selected: selectedBeerKey == nil)
                    }

                    ForEach(visibleBeers) { beer in
                        let isLocked = !hasFullBeerAccess
                            && !ExploreBeerFilterAccess.isFree(beer.id)
                        Button {
                            if isLocked {
                                showingLockedBeerMessage = true
                            } else {
                                selectedBeerKey = ExploreBeerFilterAccess.canonicalKey(beer.id)
                            }
                        } label: {
                            beerFilterRow(beer, locked: isLocked)
                        }
                        .accessibilityHint(
                            isLocked
                                ? "Available after a contributor unlock"
                                : "Filters the map to venues with this beer"
                        )
                    }

                    if matchingBeers.count > visibleBeerCount {
                        Button {
                            visibleBeerCount += Self.pageSize
                        } label: {
                            Label("Load more beers", systemImage: "chevron.down.circle")
                        }
                    }
                }

                Section("Area") {
                    Button {
                        selectedSuburb = nil
                    } label: {
                        filterRow(title: "All areas", selected: selectedSuburb == nil)
                    }

                    ForEach(visibleSuburbs, id: \.self) { suburb in
                        Button {
                            selectedSuburb = suburb
                        } label: {
                            filterRow(title: suburb, selected: selectedSuburb == suburb)
                        }
                    }

                    if matchingSuburbs.count > visibleSuburbCount {
                        Button {
                            visibleSuburbCount += Self.pageSize
                        } label: {
                            Label("Load more areas", systemImage: "chevron.down.circle")
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(PintPathBackdrop())
            .searchable(text: $filterSearch, prompt: "Search suburbs or beers")
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    PrimaryButton(
                        title: "Show \(resultCount) venues",
                        systemImage: "checkmark",
                        isLoading: false
                    ) {
                        dismiss()
                    }
                    Button("Reset filters", action: resetFilters)
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                }
                .padding()
                .background(BeerMapTheme.background)
            }
            .onChange(of: filterSearch) { _, _ in
                visibleSuburbCount = Self.pageSize
                visibleBeerCount = Self.pageSize
            }
            .alert("More beer filters", isPresented: $showingLockedBeerMessage) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(
                    "Contributor unlocks can filter every beer. Other accounts can filter Guinness, Carlton Draught and Stone & Wood Pacific Ale."
                )
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func resetFilters() {
        clear()
        filterSearch = ""
        visibleSuburbCount = Self.pageSize
        visibleBeerCount = Self.pageSize
    }

    private func filterRow(title: String, selected: Bool) -> some View {
        HStack {
            Text(title)
                .foregroundStyle(.primary)
            Spacer()
            if selected {
                Image(systemName: "checkmark")
                    .fontWeight(.semibold)
                    .foregroundStyle(BeerMapTheme.primaryAction)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func beerFilterRow(_ beer: ExploreBeerOption, locked: Bool) -> some View {
        let selected = selectedBeerKey.map {
            ExploreBeerFilterAccess.canonicalKey($0)
                == ExploreBeerFilterAccess.canonicalKey(beer.id)
        } ?? false

        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(beer.name)
                    .foregroundStyle(.primary)
                if locked {
                    Text("Contributor unlock")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if locked {
                Image(systemName: "lock.fill")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            } else if selected {
                Image(systemName: "checkmark")
                    .fontWeight(.semibold)
                    .foregroundStyle(BeerMapTheme.primaryAction)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct ClusteredVenueMap: UIViewRepresentable {
    let venues: [Venue]
    @Binding var selectedVenue: Venue?

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> MKMapView {
        let mapView = MKMapView(frame: .zero)
        let configuration = MKStandardMapConfiguration()
        configuration.elevationStyle = .flat
        configuration.emphasisStyle = .muted
        configuration.pointOfInterestFilter = .excludingAll

        mapView.preferredConfiguration = configuration
        mapView.delegate = context.coordinator
        mapView.isPitchEnabled = false
        mapView.isRotateEnabled = false
        mapView.showsBuildings = false
        mapView.showsCompass = false
        mapView.showsScale = false
        mapView.register(
            MKMarkerAnnotationView.self,
            forAnnotationViewWithReuseIdentifier: Coordinator.venueReuseIdentifier
        )
        mapView.register(
            MKMarkerAnnotationView.self,
            forAnnotationViewWithReuseIdentifier: Coordinator.clusterReuseIdentifier
        )
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.updateAnnotations(for: venues, on: mapView)
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        static let venueReuseIdentifier = "pint-path-venue"
        static let clusterReuseIdentifier = "pint-path-venue-cluster"
        private static let clusterIdentifier = "pint-path-venue-group"

        var parent: ClusteredVenueMap
        private var annotationsByID: [String: VenueMapAnnotation] = [:]
        private var snapshotsByID: [String: VenueMapSnapshot] = [:]
        private var didFitInitialRegion = false
        private weak var pendingRefitMapView: MKMapView?

        init(parent: ClusteredVenueMap) {
            self.parent = parent
        }

        func updateAnnotations(for venues: [Venue], on mapView: MKMapView) {
            var incomingSnapshots: [String: VenueMapSnapshot] = [:]
            incomingSnapshots.reserveCapacity(venues.count)
            for venue in venues {
                guard let snapshot = VenueMapSnapshot(venue: venue), incomingSnapshots[snapshot.id] == nil else {
                    continue
                }
                incomingSnapshots[snapshot.id] = snapshot
            }
            guard incomingSnapshots != snapshotsByID else { return }

            let viewportChanged = mapViewportChanged(from: snapshotsByID, to: incomingSnapshots)
            let previousIDs = Set(snapshotsByID.keys)
            let incomingIDs = Set(incomingSnapshots.keys)
            let removedIDs = previousIDs.subtracting(incomingIDs)
            let changedIDs = incomingIDs.filter { snapshotsByID[$0] != incomingSnapshots[$0] }
            let annotationsToRemove = removedIDs.compactMap { annotationsByID.removeValue(forKey: $0) }
                + changedIDs.compactMap { annotationsByID.removeValue(forKey: $0) }
            if !annotationsToRemove.isEmpty {
                mapView.removeAnnotations(annotationsToRemove)
            }

            let annotationsToAdd = changedIDs.compactMap { id -> VenueMapAnnotation? in
                guard let snapshot = incomingSnapshots[id] else { return nil }
                let annotation = VenueMapAnnotation(snapshot: snapshot)
                annotationsByID[id] = annotation
                return annotation
            }
            if !annotationsToAdd.isEmpty {
                mapView.addAnnotations(annotationsToAdd)
            }

            snapshotsByID = incomingSnapshots

            if !didFitInitialRegion, !annotationsByID.isEmpty {
                didFitInitialRegion = true
                mapView.showAnnotations(Array(annotationsByID.values), animated: false)
            } else if viewportChanged {
                scheduleRefit(on: mapView)
            }
        }

        private func mapViewportChanged(
            from previous: [String: VenueMapSnapshot],
            to incoming: [String: VenueMapSnapshot]
        ) -> Bool {
            guard previous.count == incoming.count,
                  previous.keys.allSatisfy({ incoming[$0] != nil })
            else { return true }
            return incoming.contains { id, snapshot in
                guard let oldSnapshot = previous[id] else { return true }
                return oldSnapshot.coordinate.latitude != snapshot.coordinate.latitude
                    || oldSnapshot.coordinate.longitude != snapshot.coordinate.longitude
            }
        }

        private func scheduleRefit(on mapView: MKMapView) {
            pendingRefitMapView = mapView
            NSObject.cancelPreviousPerformRequests(
                withTarget: self,
                selector: #selector(performScheduledRefit),
                object: nil
            )
            perform(#selector(performScheduledRefit), with: nil, afterDelay: 0.3)
        }

        @objc private func performScheduledRefit() {
            guard let mapView = pendingRefitMapView, !annotationsByID.isEmpty else { return }
            mapView.showAnnotations(Array(annotationsByID.values), animated: true)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            if let cluster = annotation as? MKClusterAnnotation {
                let view = mapView.dequeueReusableAnnotationView(
                    withIdentifier: Self.clusterReuseIdentifier,
                    for: cluster
                ) as! MKMarkerAnnotationView
                view.annotation = cluster
                view.clusteringIdentifier = nil
                view.markerTintColor = BeerMapTheme.markerInkUIColor
                view.glyphTintColor = BeerMapTheme.markerUIColor
                view.glyphText = "\(cluster.memberAnnotations.count)"
                view.displayPriority = .required
                view.canShowCallout = false
                view.collisionMode = .circle
                view.accessibilityLabel = "\(cluster.memberAnnotations.count) venues"
                view.accessibilityHint = "Double tap to zoom in"
                return view
            }

            guard let venueAnnotation = annotation as? VenueMapAnnotation else { return nil }
            let view = mapView.dequeueReusableAnnotationView(
                withIdentifier: Self.venueReuseIdentifier,
                for: venueAnnotation
            ) as! MKMarkerAnnotationView
            view.annotation = venueAnnotation
            view.clusteringIdentifier = Self.clusterIdentifier
            view.markerTintColor = BeerMapTheme.markerUIColor
            view.glyphTintColor = BeerMapTheme.markerInkUIColor
            view.glyphImage = UIImage(named: BeerMapAsset.beerPint)?.withRenderingMode(.alwaysTemplate)
                ?? UIImage(systemName: "wineglass.fill")
            view.displayPriority = .defaultHigh
            view.canShowCallout = false
            view.collisionMode = .circle
            view.accessibilityLabel = venueAnnotation.snapshot.title
            view.accessibilityHint = "Opens venue details"
            return view
        }

        func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
            if let cluster = view.annotation as? MKClusterAnnotation {
                mapView.showAnnotations(cluster.memberAnnotations, animated: true)
                mapView.deselectAnnotation(cluster, animated: false)
                return
            }

            guard let venueAnnotation = view.annotation as? VenueMapAnnotation else { return }
            parent.selectedVenue = parent.venues.first(where: { $0.id == venueAnnotation.snapshot.id })
                ?? venueAnnotation.snapshot.venue
            mapView.deselectAnnotation(venueAnnotation, animated: false)
        }
    }
}

private struct VenueMapSnapshot: Hashable {
    let id: String
    let venue: Venue
    let title: String
    let location: String
    let coordinate: CLLocationCoordinate2D

    init?(venue: Venue) {
        guard let latitude = venue.latitude, let longitude = venue.longitude else { return nil }
        id = venue.id
        self.venue = venue
        title = venue.name
        location = venue.displayLocation
        coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    static func == (lhs: VenueMapSnapshot, rhs: VenueMapSnapshot) -> Bool {
        lhs.id == rhs.id
            && lhs.title == rhs.title
            && lhs.location == rhs.location
            && lhs.coordinate.latitude == rhs.coordinate.latitude
            && lhs.coordinate.longitude == rhs.coordinate.longitude
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(title)
        hasher.combine(location)
        hasher.combine(coordinate.latitude)
        hasher.combine(coordinate.longitude)
    }
}

private final class VenueMapAnnotation: NSObject, MKAnnotation {
    let snapshot: VenueMapSnapshot
    let coordinate: CLLocationCoordinate2D

    var title: String? { snapshot.title }
    var subtitle: String? {
        snapshot.location.isEmpty ? nil : snapshot.location
    }

    init(snapshot: VenueMapSnapshot) {
        self.snapshot = snapshot
        coordinate = snapshot.coordinate
        super.init()
    }
}

struct VenueDetailView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var pendingWrongPriceReport: PriceRecord?
    @State private var priceConfirmationResults: [String: PriceConfirmationResult] = [:]
    @State private var confirmingPriceKeys = Set<String>()
    let venue: Venue

    private var priceResponse: PriceRecordsResponse? {
        model.selectedVenuePrices[venue.id]
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                PintPathHero(
                    eyebrow: "VENUE STOP",
                    title: venue.name,
                    subtitle: venue.address ?? venue.displayLocation,
                    systemImage: "mappin.and.ellipse"
                )

                HStack(spacing: 8) {
                    Button {
                        Task { await model.saveVenue(venue) }
                    } label: {
                        VenueQuickActionLabel(title: "Save", systemImage: "bookmark.fill")
                    }
                    .buttonStyle(.plain)

                    Button {
                        Task { await model.loadPrices(for: venue) }
                    } label: {
                        VenueQuickActionLabel(title: "Prices", systemImage: "dollarsign.circle.fill")
                    }
                    .buttonStyle(.plain)

                    if let directionsURL {
                        Link(destination: directionsURL) {
                            VenueQuickActionLabel(title: "Directions", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                        }
                        .accessibilityHint("Opens this venue in Apple Maps")
                    }
                }
                .beerMapCard(padding: 10)

                VStack(alignment: .leading, spacing: 14) {
                    SectionHeader(
                        eyebrow: "PRICE BOARD",
                        title: "What a drink costs here",
                        subtitle: "Community prices are checked before they appear.",
                        assetImage: BeerMapAsset.beerPint
                    )

                    if let response = priceResponse {
                        if let lockedCount = response.preview?.lockedCount, lockedCount > 0 {
                            HStack(spacing: 9) {
                                Image(systemName: "lock.fill")
                                    .foregroundStyle(BeerMapTheme.amber)
                                Text("Contribute to unlock \(lockedCount) more price\(lockedCount == 1 ? "" : "s").")
                                    .font(.caption.weight(.semibold))
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 10)
                            .overlay(alignment: .bottom) {
                                Rectangle().fill(BeerMapTheme.hairline).frame(height: 1)
                            }
                        }
                        if response.records.isEmpty {
                            EmptyStateView(
                                title: "No fresh prices yet",
                                message: "This pub is ready for its first checked update.",
                                systemImage: "tray",
                                isFramed: false
                            )
                        } else {
                            VStack(spacing: 0) {
                                ForEach(Array(response.records.enumerated()), id: \.element.id) { index, record in
                                    priceRow(record)
                                    if index < response.records.count - 1 {
                                        Rectangle()
                                            .fill(BeerMapTheme.hairline)
                                            .frame(height: 1)
                                            .padding(.leading, 48)
                                    }
                                }
                            }
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("See the latest available prices for this pub.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            PrimaryButton(
                                title: "See current prices",
                                systemImage: "eye.fill",
                                isLoading: model.isLoading
                            ) {
                                Task { await model.loadPrices(for: venue) }
                            }
                        }
                    }
                }
                .beerMapCard()
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle(venue.name)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            PrimaryButton(
                title: "Add a fresh price",
                systemImage: "plus",
                isLoading: false
            ) {
                model.startPriceContribution(for: venue)
            }
            .padding(.horizontal)
            .padding(.vertical, 9)
            .background(.ultraThinMaterial)
        }
        .confirmationDialog(
            "Report this displayed price?",
            isPresented: Binding(
                get: { pendingWrongPriceReport != nil },
                set: { if !$0 { pendingWrongPriceReport = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let record = pendingWrongPriceReport {
                Button("Send wrong-price report", role: .destructive) {
                    pendingWrongPriceReport = nil
                    Task {
                        await model.reportWrongPrice(
                            venueId: venue.id,
                            priceRecordId: record.id,
                            beerName: record.beerName ?? "",
                            notes: "Displayed price looks incorrect."
                        )
                    }
                }
            }
            Button("Cancel", role: .cancel) {
                pendingWrongPriceReport = nil
            }
        } message: {
            Text("Pint Path will send the exact price row to review. No public change is made until it is checked.")
        }
    }

    private func priceRow(_ record: PriceRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(BeerMapTheme.honey.opacity(0.72))
                    if let asset = servingAsset(record.servingSize) {
                        Image(asset)
                            .renderingMode(.template)
                            .resizable()
                            .scaledToFit()
                            .padding(9)
                            .foregroundStyle(BeerMapTheme.amber)
                    } else {
                        Image(systemName: fallbackServingSystemImage(record.servingSize))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(BeerMapTheme.amber)
                    }
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 3) {
                    Text(record.beerName ?? "Beer")
                        .font(.headline.weight(.semibold))
                        .lineLimit(2)
                    Text((record.servingSize ?? "Serving").capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(record.formattedPrice)
                        .font(.system(.title3, design: .rounded, weight: .bold))
                        .monospacedDigit()
                    if record.priceRedacted == true {
                        Text("Preview")
                            .font(.system(size: 9, weight: .bold))
                            .tracking(0.6)
                            .foregroundStyle(.secondary)
                    }
                }
                if record.priceRedacted != true {
                    Button {
                        pendingWrongPriceReport = record
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 40, height: 40)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Report \(record.beerName ?? "this price") as wrong")
                }
            }

            if model.isSignedIn && record.isActionablePriceConfirmationCandidate {
                priceConfirmationControl(record)
                    .padding(.leading, 52)
            }
        }
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private func priceConfirmationControl(_ record: PriceRecord) -> some View {
        let key = record.confirmationDisplayKey
        if let result = priceConfirmationResults[key] {
            Text(priceConfirmationCopy(result))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityLabel(priceConfirmationCopy(result))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Was this price still correct?")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        priceConfirmationButtons(record, key: key)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        priceConfirmationButtons(record, key: key)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func priceConfirmationButtons(_ record: PriceRecord, key: String) -> some View {
        ForEach(PriceConfirmationOutcome.allCases, id: \.self) { outcome in
            Button(outcome.buttonTitle) {
                submitPriceConfirmation(record, outcome: outcome)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .frame(minHeight: 44)
            .fixedSize(horizontal: true, vertical: false)
            .disabled(confirmingPriceKeys.contains(key))
            .accessibilityHint(
                outcome == .no
                    ? "Sends this exact price for review"
                    : "Records your answer without changing public trust automatically"
            )
        }
    }

    private func submitPriceConfirmation(_ record: PriceRecord, outcome: PriceConfirmationOutcome) {
        let key = record.confirmationDisplayKey
        guard confirmingPriceKeys.insert(key).inserted else { return }
        Task {
            let result = await model.answerPriceConfirmation(record, outcome: outcome)
            confirmingPriceKeys.remove(key)
            if let result {
                priceConfirmationResults[key] = result
            }
        }
    }

    private func priceConfirmationCopy(_ result: PriceConfirmationResult) -> String {
        switch result.outcome {
        case .yes:
            return "Thanks — saved as signal-only evidence."
        case .no:
            return "Thanks — sent for price review."
        case .didntOrder:
            return result.analyticsRecorded
                ? "Got it — optional product signal saved."
                : "Got it — no optional analytics recorded."
        }
    }

    private func servingAsset(_ serving: String?) -> String? {
        switch serving?.lowercased() {
        case "pint": return BeerMapAsset.beerPint
        case "pot": return BeerMapAsset.beerPot
        case "schooner": return BeerMapAsset.beerSchooner
        case "jug": return BeerMapAsset.beerJug
        default: return nil
        }
    }

    private func fallbackServingSystemImage(_ serving: String?) -> String {
        switch serving?.lowercased() {
        case "bottle": return "waterbottle.fill"
        case "can": return "cylinder.fill"
        default: return "wineglass.fill"
        }
    }

    private var directionsURL: URL? {
        guard let latitude = venue.latitude, let longitude = venue.longitude else { return nil }
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [
            URLQueryItem(name: "daddr", value: "\(latitude),\(longitude)"),
            URLQueryItem(name: "q", value: venue.name)
        ]
        return components?.url
    }

}

private struct VenueQuickActionLabel: View {
    let title: String
    let systemImage: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.headline.weight(.bold))
                .foregroundStyle(BeerMapTheme.amber)
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(.primary)
        }
        .frame(maxWidth: .infinity, minHeight: 58)
        .contentShape(Rectangle())
    }
}
