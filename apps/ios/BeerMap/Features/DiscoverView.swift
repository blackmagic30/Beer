import SwiftUI

struct DiscoverView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var searchText = ""

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                hero

                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Search venue, suburb, or beer", text: $searchText)
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
                eyebrow: "BeerMap",
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
                title: "Free reveals/day",
                value: "\(model.config?.freePriceRevealsPerDay ?? 0)",
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
}

struct VenueDetailView: View {
    @EnvironmentObject private var model: BeerMapAppModel
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
                            Task { await model.revealPrices(for: venue) }
                        }
                    }
                }
                .beerMapCard()

                if let response = priceResponse {
                    if response.blocked == true {
                        StatusBanner(message: "Some exact prices stay locked to Premium, contributor, or admin access.", isError: false)
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
        .task {
            if priceResponse == nil {
                await model.revealPrices(for: venue)
            }
        }
    }
}
