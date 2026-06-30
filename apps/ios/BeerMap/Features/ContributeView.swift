import SwiftUI

struct ContributeView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var selectedMode: ContributionMode = .submit
    @State private var selectedVenueId = ""
    @State private var beerName = ""
    @State private var priceText = ""
    @State private var servingSize = "pint"
    @State private var notes = ""
    @State private var requestVenueName = ""
    @State private var requestBeerName = ""
    @State private var requestSuburb = ""
    @State private var requestNotes = ""
    @State private var requestKind: MissingRequestKind = .venue

    private let servingSizes = ["pint", "pot", "schooner", "jug", "bottle", "can", "other"]

    enum ContributionMode: String, CaseIterable, Identifiable {
        case submit = "Submit"
        case report = "Report"
        case request = "Request"
        case missions = "Missions"

        var id: String { rawValue }
    }

    enum MissingRequestKind: String, CaseIterable, Identifiable {
        case venue = "Missing venue"
        case beer = "Missing beer"

        var id: String { rawValue }
        var requestType: String { self == .beer ? "missing_beer" : "missing_venue" }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                SectionHeader(
                    eyebrow: "Contribute",
                    title: "Keep BeerMap current",
                    subtitle: "Send venue data through the same reviewed backend workflow as the website.",
                    systemImage: "square.and.arrow.up.fill"
                )
                .beerMapCard()

                Picker("Contribution mode", selection: $selectedMode) {
                    ForEach(ContributionMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                switch selectedMode {
                case .submit:
                    submitCard
                case .report:
                    reportCard
                case .request:
                    requestCard
                case .missions:
                    missionsCard
                }
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle("Contribute")
        .onAppear(perform: ensureVenueSelection)
        .refreshable {
            await model.loadHome()
            ensureVenueSelection()
        }
        .onChange(of: model.venues) { _, _ in
            ensureVenueSelection()
        }
    }

    private var submitCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Price update",
                title: "Submit an observed beer price",
                subtitle: model.isSignedIn ? "Submissions stay pending until reviewed." : "Sign in first so the update can be attached to your account.",
                systemImage: "mug.fill"
            )
            venuePicker
            TextField("Beer name", text: $beerName)
                .textFieldStyle(.roundedBorder)
            TextField("Observed price", text: $priceText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
            Picker("Serving", selection: $servingSize) {
                ForEach(servingSizes, id: \.self) { size in
                    Text(size.capitalized).tag(size)
                }
            }
            .pickerStyle(.menu)
            TextField("Notes, optional", text: $notes, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            PrimaryButton(title: "Send for review", systemImage: "square.and.arrow.up.fill", isLoading: model.isLoading) {
                Task {
                    await model.submitPriceUpdate(
                        venueId: selectedVenueId,
                        beerName: beerName,
                        servingSize: servingSize,
                        priceText: priceText,
                        notes: notes
                    )
                    clearSubmissionFields()
                }
            }
            .disabled(!model.isSignedIn || selectedVenueId.isEmpty || beerName.trimmed.isEmpty || priceText.trimmed.isEmpty)
            StatusBanner(message: "Photo evidence and saved upload-location proof are still website-only in this native pass.")
        }
        .beerMapCard()
    }

    private var reportCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Correction",
                title: "Report wrong venue data",
                subtitle: "Use this when a displayed price, beer, or happy-hour detail looks off.",
                systemImage: "exclamationmark.bubble.fill"
            )
            venuePicker
            TextField("Beer or item, optional", text: $beerName)
                .textFieldStyle(.roundedBorder)
            TextField("What should admin know?", text: $notes, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            PrimaryButton(title: "Send report", systemImage: "exclamationmark.bubble.fill", isLoading: model.isLoading) {
                Task {
                    await model.reportWrongPrice(venueId: selectedVenueId, beerName: beerName, notes: notes)
                    notes = ""
                }
            }
            .disabled(selectedVenueId.isEmpty || notes.trimmed.count < 3)
        }
        .beerMapCard()
    }

    private var requestCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Request",
                title: "Ask Pint Path to add something",
                subtitle: "Missing venue and missing beer requests use the same queue as the website.",
                systemImage: "paperplane.fill"
            )
            Picker("Request type", selection: $requestKind) {
                ForEach(MissingRequestKind.allCases) { kind in
                    Text(kind.rawValue).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            if requestKind == .venue {
                TextField("Venue name", text: $requestVenueName)
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField("Beer name", text: $requestBeerName)
                    .textFieldStyle(.roundedBorder)
                TextField("Venue name, optional", text: $requestVenueName)
                    .textFieldStyle(.roundedBorder)
            }
            TextField("Suburb, optional", text: $requestSuburb)
                .textFieldStyle(.roundedBorder)
            TextField("Notes, optional", text: $requestNotes, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            PrimaryButton(title: "Send request", systemImage: "paperplane.fill", isLoading: model.isLoading) {
                Task {
                    await model.requestMissing(
                        requestType: requestKind.requestType,
                        venueName: requestVenueName,
                        beerName: requestBeerName,
                        suburb: requestSuburb,
                        notes: requestNotes
                    )
                    clearRequestFields()
                }
            }
            .disabled(requestDisabled)
        }
        .beerMapCard()
    }

    private var missionsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Missions",
                title: "Venues needing data",
                subtitle: "These are pulled from the existing mission endpoint.",
                systemImage: "target"
            )
            if model.missions.isEmpty {
                EmptyStateView(
                    title: "No missions loaded yet",
                    message: "Pull to refresh or check the backend connection.",
                    systemImage: "target",
                    isFramed: false
                )
            } else {
                ForEach(model.missions.prefix(12)) { mission in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(mission.venueName)
                            .font(.headline)
                        Text([mission.suburb, mission.reason].compactMap { $0 }.joined(separator: " - "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let points = mission.points {
                            Text("\(String(format: "%.1f", points)) pts")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(BeerMapTheme.amber)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .beerMapCard()
    }

    private var venuePicker: some View {
        Group {
            if model.venues.isEmpty {
                StatusBanner(message: "No venues loaded yet. Refresh discovery before sending venue-specific updates.", isError: true)
            } else {
                Picker("Venue", selection: $selectedVenueId) {
                    ForEach(model.venues) { venue in
                        Text(venue.name).tag(venue.id)
                    }
                }
                .pickerStyle(.menu)
            }
        }
    }

    private var requestDisabled: Bool {
        if requestKind == .beer {
            return requestBeerName.trimmed.isEmpty
        }
        return requestVenueName.trimmed.isEmpty
    }

    private func ensureVenueSelection() {
        if selectedVenueId.isEmpty || !model.venues.contains(where: { $0.id == selectedVenueId }) {
            selectedVenueId = model.venues.first?.id ?? ""
        }
    }

    private func clearSubmissionFields() {
        beerName = ""
        priceText = ""
        notes = ""
        servingSize = "pint"
    }

    private func clearRequestFields() {
        requestVenueName = ""
        requestBeerName = ""
        requestSuburb = ""
        requestNotes = ""
    }
}

private extension String {
    var trimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
