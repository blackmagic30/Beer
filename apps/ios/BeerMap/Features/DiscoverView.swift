import MapKit
import SwiftUI

struct DiscoverView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var searchText = ""
    @State private var mapPosition: MapCameraPosition = .automatic

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                hero

                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Search venue, suburb, or beer", text: $searchText)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit {
                            Task { await model.loadHome(search: searchText) }
                        }
                    if !searchText.isEmpty {
                        Button {
                            searchText = ""
                            Task { await model.loadHome() }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(12)
                .background(BeerMapTheme.card, in: RoundedRectangle(cornerRadius: 8))

                quickStats

                if !mappedVenues.isEmpty {
                    venueMap
                }

                if model.venues.isEmpty {
                    EmptyStateView(
                        title: "No venues loaded yet",
                        message: "Pull to refresh or check that the backend is reachable.",
                        systemImage: "map"
                    )
                } else {
                    ForEach(model.venues) { venue in
                        NavigationLink(value: venue) {
                            VenueCard(venue: venue)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle("Find")
        .refreshable {
            await model.loadHome(search: searchText)
        }
        .navigationDestination(for: Venue.self) { venue in
            VenueDetailView(venue: venue)
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeader(
                eyebrow: "Pint Path",
                title: "Find the right bar faster",
                subtitle: "Melbourne beer prices, happy hours, and bar updates in your pocket.",
                systemImage: "mug.fill"
            )

            if model.config?.fieldTestMode == true {
                StatusBanner(message: "Field-test mode is on. Venue data may change during beta.", systemImage: "testtube.2")
            }
        }
        .beerMapCard()
    }

    private var quickStats: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            MetricPill(title: "Mapped venues", value: "\(model.venues.count)", systemImage: "building.2.fill", tint: BeerMapTheme.sky)
            MetricPill(title: "Missions", value: "\(model.missions.count)", systemImage: "target", tint: BeerMapTheme.leaf)
            MetricPill(
                title: "Free price access",
                value: "Fixed preview",
                systemImage: "eye.fill",
                tint: BeerMapTheme.amber
            )
            MetricPill(
                title: "Contributor unlock",
                value: "\(model.config?.contributorUnlockPoints ?? 15) pts",
                systemImage: "sparkles",
                tint: BeerMapTheme.plum
            )
        }
    }

    private var mappedVenues: [Venue] {
        model.venues.filter { $0.latitude != nil && $0.longitude != nil }
    }

    private var venueMap: some View {
        Map(position: $mapPosition) {
            ForEach(mappedVenues) { venue in
                if let latitude = venue.latitude, let longitude = venue.longitude {
                    Annotation(venue.name, coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude)) {
                        NavigationLink(value: venue) {
                            Image(systemName: venue.membershipTier == "pro" ? "mappin.circle.fill" : "mappin.circle")
                                .font(.title2)
                                .foregroundStyle(venue.membershipTier == "pro" ? BeerMapTheme.amber : BeerMapTheme.plum)
                                .background(.thinMaterial, in: Circle())
                        }
                        .accessibilityLabel("Open \(venue.name)")
                    }
                }
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll))
        .frame(height: 280)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(BeerMapTheme.hairline, lineWidth: 1)
        )
        .accessibilityLabel("Venue map with \(mappedVenues.count) mapped venues")
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
                    HStack {
                        SecondaryButton(title: "Save", systemImage: "bookmark.fill") {
                            Task { await model.saveVenue(venue) }
                        }

                        PrimaryButton(title: "Show prices", systemImage: "eye.fill", isLoading: model.isLoading) {
                            Task { await model.loadPrices(for: venue) }
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
}
