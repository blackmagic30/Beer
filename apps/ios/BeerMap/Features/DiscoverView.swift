import CoreLocation
import MapKit
import SwiftUI

struct DiscoverView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @StateObject private var locationProvider = ExploreLocationProvider()
    @State private var searchText = ""
    @State private var selectedMapVenue: Venue?
    @State private var displayMode: ExploreDisplayMode = .map
    @State private var selectedSuburb: String?
    @State private var partnerOnly = false
    @State private var nearbyOnly = false
    @State private var nearbyRadiusKm = 5.0
    @State private var userLocation: CLLocation?
    @State private var isLocating = false
    @State private var showingFilters = false
    @State private var distanceByVenue: [VenueDistanceKey: CLLocationDistance] = [:]

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

    private enum ExploreDisplayMode: String, CaseIterable, Identifiable {
        case map = "Map"
        case list = "List"

        var id: String { rawValue }

        var systemImage: String {
            self == .map ? "map.fill" : "list.bullet"
        }
    }

    var body: some View {
        let results = makeVenueResults()

        VStack(spacing: 0) {
            controls(resultCount: results.filtered.count)
                .padding(.horizontal)
                .padding(.top, 8)
                .padding(.bottom, 10)

            Divider()

            if model.venues.isEmpty && model.isLoading {
                ProgressView("Loading venues…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if results.filtered.isEmpty {
                VStack(spacing: 16) {
                    EmptyStateView(
                        title: model.venues.isEmpty ? "Venues are unavailable" : "No venues match",
                        message: model.venues.isEmpty
                            ? "Check your connection, then try loading the venue map again."
                            : "Try a different search or clear the active filters.",
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
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if displayMode == .map {
                venueMap(filteredVenues: results.filtered, mappedVenues: results.mapped)
            } else {
                venueList(venues: results.filtered)
            }
        }
        .beerMapScreen()
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Venue, suburb, or postcode"
        )
        .textInputAutocapitalization(.words)
        .autocorrectionDisabled()
        .toolbar {
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
        .sheet(isPresented: $showingFilters) {
            ExploreFilterSheet(
                suburbs: results.suburbs,
                selectedSuburb: $selectedSuburb,
                partnerOnly: $partnerOnly,
                nearbyOnly: Binding(
                    get: { nearbyOnly },
                    set: { enabled in
                        setNearbyEnabled(enabled)
                    }
                ),
                nearbyRadiusKm: $nearbyRadiusKm,
                isLocating: isLocating,
                resultCount: results.filtered.count,
                clear: clearFilterValues
            )
        }
        .onChange(of: model.venues) { _, venues in
            rebuildDistanceCache(for: venues, from: userLocation)
        }
        .navigationDestination(for: Venue.self) { venue in
            VenueDetailView(venue: venue)
        }
        .navigationDestination(item: $selectedMapVenue) { venue in
            VenueDetailView(venue: venue)
        }
    }

    private func controls(resultCount: Int) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                Picker("Display", selection: $displayMode) {
                    ForEach(ExploreDisplayMode.allCases) { mode in
                        Label(mode.rawValue, systemImage: mode.systemImage)
                            .tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                Text("\(resultCount)")
                    .font(.subheadline.monospacedDigit().weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("\(resultCount) venues")
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    FilterChip(
                        title: "Filters",
                        systemImage: "line.3.horizontal.decrease",
                        isSelected: activeFilterCount > 0,
                        badge: activeFilterCount
                    ) {
                        showingFilters = true
                    }

                    FilterChip(
                        title: "Partner venues",
                        systemImage: "checkmark.seal.fill",
                        isSelected: partnerOnly
                    ) {
                        partnerOnly.toggle()
                    }

                    FilterChip(
                        title: isLocating ? "Locating…" : "Near me",
                        systemImage: isLocating ? "location.circle" : "location.fill",
                        isSelected: nearbyOnly
                    ) {
                        setNearbyEnabled(!nearbyOnly)
                    }

                    if let selectedSuburb {
                        FilterChip(
                            title: selectedSuburb,
                            systemImage: "mappin",
                            isSelected: true
                        ) {
                            self.selectedSuburb = nil
                        }
                    }

                    if activeFilterCount > 0 || !searchText.isEmpty {
                        FilterChip(title: "Clear", systemImage: "xmark", action: clearFilters)
                    }
                }
            }
        }
    }

    private func venueList(venues: [Venue]) -> some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(venues) { venue in
                    NavigationLink(value: venue) {
                        VenueCard(venue: venue, detail: distanceText(for: venue))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding()
        }
        .refreshable { await model.loadHome() }
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
            if partnerOnly && venue.membershipTier?.caseInsensitiveCompare("pro") != .orderedSame {
                return false
            }
            if let selectedSuburb,
               venue.suburb?.caseInsensitiveCompare(selectedSuburb) != .orderedSame {
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
        (selectedSuburb == nil ? 0 : 1) + (partnerOnly ? 1 : 0) + (nearbyOnly ? 1 : 0)
    }

    @ViewBuilder
    private func venueMap(filteredVenues: [Venue], mappedVenues: [Venue]) -> some View {
        if mappedVenues.isEmpty {
            VStack(spacing: 14) {
                EmptyStateView(
                    title: "These venues have no map pin",
                    message: "Their details are still available in the venue list.",
                    systemImage: "list.bullet.rectangle"
                )
                SecondaryButton(title: "Show venue list", systemImage: "list.bullet") {
                    displayMode = .list
                }
                .frame(maxWidth: 320)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ClusteredVenueMap(venues: mappedVenues, selectedVenue: $selectedMapVenue)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .bottom) {
                    if mappedVenues.count < filteredVenues.count {
                        Button {
                            displayMode = .list
                        } label: {
                            Label(
                                "\(filteredVenues.count - mappedVenues.count) more in List",
                                systemImage: "list.bullet"
                            )
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(BeerMapTheme.card, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .padding(.bottom, 12)
                        .accessibilityHint("Switches to the complete venue list")
                    }
                }
                .accessibilityLabel("Venue map with \(mappedVenues.count) mapped venues")
        }
    }

    private func clearFilters() {
        searchText = ""
        clearFilterValues()
    }

    private func clearFilterValues() {
        selectedSuburb = nil
        partnerOnly = false
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

    private func distanceText(for venue: Venue) -> String? {
        guard nearbyOnly, userLocation != nil, let meters = cachedDistance(to: venue) else { return nil }
        if meters < 1_000 {
            return "\(Int(meters.rounded())) m away"
        }
        return String(format: "%.1f km away", meters / 1_000)
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
    @Environment(\.dismiss) private var dismiss
    let suburbs: [String]
    @Binding var selectedSuburb: String?
    @Binding var partnerOnly: Bool
    @Binding var nearbyOnly: Bool
    @Binding var nearbyRadiusKm: Double
    let isLocating: Bool
    let resultCount: Int
    let clear: () -> Void
    @State private var suburbSearch = ""

    private var visibleSuburbs: [String] {
        let query = suburbSearch.trimmed
        guard !query.isEmpty else { return suburbs }
        return suburbs.filter { $0.localizedStandardContains(query) }
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

                Section("Venue type") {
                    Toggle("Partner venues only", systemImage: "checkmark.seal.fill", isOn: $partnerOnly)
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
                }
            }
            .searchable(text: $suburbSearch, prompt: "Search suburbs")
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
                    Button("Reset filters", action: clear)
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                }
                .padding()
                .background(BeerMapTheme.background)
            }
        }
        .presentationDetents([.medium, .large])
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
                view.markerTintColor = .systemIndigo
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
            view.markerTintColor = venueAnnotation.snapshot.isPro ? .systemOrange : .systemIndigo
            view.glyphImage = UIImage(systemName: venueAnnotation.snapshot.isPro ? "star.fill" : "mug.fill")
            view.displayPriority = venueAnnotation.snapshot.isPro ? .defaultHigh : .defaultLow
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
    let isPro: Bool

    init?(venue: Venue) {
        guard let latitude = venue.latitude, let longitude = venue.longitude else { return nil }
        id = venue.id
        self.venue = venue
        title = venue.name
        location = venue.displayLocation
        coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        isPro = venue.membershipTier?.caseInsensitiveCompare("pro") == .orderedSame
    }

    static func == (lhs: VenueMapSnapshot, rhs: VenueMapSnapshot) -> Bool {
        lhs.id == rhs.id
            && lhs.title == rhs.title
            && lhs.location == rhs.location
            && lhs.coordinate.latitude == rhs.coordinate.latitude
            && lhs.coordinate.longitude == rhs.coordinate.longitude
            && lhs.isPro == rhs.isPro
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(title)
        hasher.combine(location)
        hasher.combine(coordinate.latitude)
        hasher.combine(coordinate.longitude)
        hasher.combine(isPro)
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
    let venue: Venue

    private var priceResponse: PriceRecordsResponse? {
        model.selectedVenuePrices[venue.id]
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(
                        eyebrow: venue.membershipTier == "pro" ? "Pro venue" : "Venue",
                        title: venue.name,
                        subtitle: venue.address ?? venue.displayLocation,
                        systemImage: "building.2.fill"
                    )

                    PrimaryButton(title: "Add or update a price", systemImage: "plus.circle.fill", isLoading: false) {
                        model.startPriceContribution(for: venue)
                    }

                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) {
                            saveVenueButton
                            showPricesButton
                        }
                        VStack(spacing: 10) {
                            saveVenueButton
                            showPricesButton
                        }
                    }
                    if let directionsURL {
                        Link(destination: directionsURL) {
                            Label("Open directions", systemImage: "map.fill")
                                .font(.headline.weight(.bold))
                                .frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityHint("Opens this venue in Apple Maps")
                    }
                }
                .beerMapCard()

                if let response = priceResponse {
                    if (response.preview?.lockedCount ?? 0) > 0 {
                        StatusBanner(message: "Some prices remain Premium outside the fixed preview.", isError: false)
                    }
                    if response.records.isEmpty {
                        EmptyStateView(title: "No price rows yet", message: "This venue needs a trusted update.", systemImage: "tray", isFramed: false)
                    } else {
                        VStack(spacing: 10) {
                            ForEach(response.records) { record in
                                HStack(alignment: .top) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(record.beerName ?? "Beer")
                                            .font(.headline)
                                        Text([record.servingSize, record.happyHour].compactMap { $0 }.joined(separator: " · "))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(record.formattedPrice)
                                        .font(.headline.weight(.bold))
                                        .foregroundStyle(record.priceRedacted == true ? BeerMapTheme.plum : BeerMapTheme.leaf)
                                    if record.priceRedacted != true {
                                        Button {
                                            pendingWrongPriceReport = record
                                        } label: {
                                            Image(systemName: "exclamationmark.bubble")
                                                .frame(width: 44, height: 44)
                                        }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(.secondary)
                                        .accessibilityLabel("Report \(record.beerName ?? "this price") as wrong")
                                    }
                                }
                                .padding(12)
                                .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                        .beerMapCard()
                    }
                } else {
                    EmptyStateView(title: "Prices are server-gated", message: "Tap Show prices to load the same free-preview or account access that the website uses.", systemImage: "lock.shield")
                }
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle(venue.name)
        .navigationBarTitleDisplayMode(.inline)
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

    private var directionsURL: URL? {
        guard let latitude = venue.latitude, let longitude = venue.longitude else { return nil }
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [
            URLQueryItem(name: "daddr", value: "\(latitude),\(longitude)"),
            URLQueryItem(name: "q", value: venue.name)
        ]
        return components?.url
    }

    private var saveVenueButton: some View {
        SecondaryButton(title: "Save", systemImage: "bookmark.fill") {
            Task { await model.saveVenue(venue) }
        }
    }

    private var showPricesButton: some View {
        SecondaryButton(title: "Show prices", systemImage: "eye.fill") {
            Task { await model.loadPrices(for: venue) }
        }
    }
}
