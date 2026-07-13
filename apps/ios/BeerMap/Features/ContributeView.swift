import PhotosUI
import SwiftUI
import UIKit

struct ContributeView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var selectedMode: ContributionMode = .price
    @State private var selectedVenueId = ""
    @State private var beerName = ""
    @State private var priceText = ""
    @State private var servingSize = "pint"
    @State private var notes = ""
    @State private var sourcePhotoItem: PhotosPickerItem?
    @State private var sourcePhotoData: Data?
    @State private var sourcePhotoStatus = "Choose a clear menu, receipt, tap-list, or happy-hour board photo."
    @State private var happyOffer = ""
    @State private var happyNotes = ""
    @State private var happyStart = Calendar.current.date(bySettingHour: 16, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var happyEnd = Calendar.current.date(bySettingHour: 18, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var happyDays: Set<String> = ["fri"]
    @State private var requestVenueName = ""
    @State private var requestBeerName = ""
    @State private var requestSuburb = ""
    @State private var requestNotes = ""
    @State private var requestKind: MissingRequestKind = .venue

    private let servingSizes = ["pint", "pot", "schooner", "jug", "bottle", "can", "other"]
    private let dayCodes = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

    enum ContributionMode: String, CaseIterable, Identifiable {
        case price = "Price"
        case source = "Photo"
        case happyHour = "Happy hour"
        case request = "Request"
        case missions = "Missions"

        var id: String { rawValue }

        var systemImage: String {
            switch self {
            case .price: return "mug.fill"
            case .source: return "photo.on.rectangle.angled"
            case .happyHour: return "clock.badge.checkmark.fill"
            case .request: return "paperplane.fill"
            case .missions: return "target"
            }
        }
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
                    eyebrow: "Add updates",
                    title: "What did you see?",
                    subtitle: "Pick the shortest path. BeerMap sends everything through the same reviewed backend as the website.",
                    systemImage: "square.and.arrow.up.fill"
                )
                .beerMapCard()

                modePicker

                switch selectedMode {
                case .price:
                    priceCard
                case .source:
                    sourcePhotoCard
                case .happyHour:
                    happyHourCard
                case .request:
                    requestCard
                case .missions:
                    missionsCard
                }
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle("Add")
        .onAppear(perform: ensureVenueSelection)
        .refreshable {
            await model.loadHome()
            ensureVenueSelection()
        }
        .onChange(of: model.venues) { _, _ in
            ensureVenueSelection()
        }
        .onChange(of: sourcePhotoItem) { _, item in
            Task { await loadSourcePhoto(item) }
        }
    }

    private var modePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ContributionMode.allCases) { mode in
                    Button {
                        selectedMode = mode
                    } label: {
                        Label(mode.rawValue, systemImage: mode.systemImage)
                            .font(.caption.weight(.bold))
                            .lineLimit(1)
                            .padding(.horizontal, 12)
                            .frame(height: 42)
                            .background(
                                selectedMode == mode ? BeerMapTheme.ink : BeerMapTheme.card,
                                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                            )
                            .foregroundStyle(selectedMode == mode ? Color.white : Color.primary)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .stroke(BeerMapTheme.hairline, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Show \(mode.rawValue) contribution form")
                }
            }
            .padding(.vertical, 2)
        }
    }

    private var priceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Price update",
                title: "Submit one observed price",
                subtitle: model.isSignedIn ? "Best for a quick tap-list or menu check." : "Sign in first so the update can earn review history.",
                systemImage: "mug.fill"
            )
            venuePicker
            TextField("Beer name", text: $beerName)
                .textFieldStyle(.roundedBorder)
                .textContentType(.none)
                .submitLabel(.next)
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
            PrimaryButton(title: "Send price for review", systemImage: "paperplane.fill", isLoading: model.isLoading) {
                Task {
                    await model.submitPriceUpdate(
                        venueId: selectedVenueId,
                        beerName: beerName,
                        servingSize: servingSize,
                        priceText: priceText,
                        notes: notes
                    )
                    clearPriceFields()
                }
            }
            .disabled(!model.isSignedIn || selectedVenueId.isEmpty || beerName.trimmed.isEmpty || priceText.trimmed.isEmpty)
            StatusBanner(message: "For a full menu or board, use Photo. Reviewers keep source evidence private.")
        }
        .beerMapCard()
    }

    private var sourcePhotoCard: some View {
        let photoButtonTitle = sourcePhotoData == nil ? "Choose photo" : "Replace photo"

        return VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Source photo",
                title: "Upload a menu or board",
                subtitle: model.isSignedIn ? "The app sends one compressed image for private reviewer evidence." : "Sign in first so the source upload can be reviewed.",
                systemImage: "photo.on.rectangle.angled"
            )
            venuePicker
            PhotosPicker(selection: $sourcePhotoItem, matching: .images, photoLibrary: .shared()) {
                Label(photoButtonTitle, systemImage: "photo.badge.plus")
                    .font(.headline.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: 50)
            }
            .buttonStyle(.plain)
            .foregroundStyle(BeerMapTheme.ink)
            .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(BeerMapTheme.ink.opacity(0.16), lineWidth: 1)
            )
            .accessibilityLabel("Choose source photo")

            StatusBanner(
                message: sourcePhotoStatus,
                isError: sourcePhotoData == nil && sourcePhotoStatus.hasPrefix("Could not"),
                systemImage: sourcePhotoData == nil ? "photo" : "checkmark.seal.fill"
            )
            TextField("What should reviewers look for?", text: $notes, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            PrimaryButton(title: "Upload source for review", systemImage: "arrow.up.doc.fill", isLoading: model.isLoading) {
                guard let dataURL = sourcePhotoDataURL else {
                    model.errorMessage = "Choose a source photo before uploading."
                    return
                }
                Task {
                    await model.submitSourcePhotoUpdate(venueId: selectedVenueId, sourcePhotoDataUrl: dataURL, notes: notes)
                    clearPhotoFields()
                }
            }
            .disabled(!model.isSignedIn || selectedVenueId.isEmpty || sourcePhotoData == nil)
            StatusBanner(message: "Native location proof is not wired yet. Uploads still work, but location-based points depend on the backend review rules.")
        }
        .beerMapCard()
    }

    private var happyHourCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Happy hour",
                title: "Submit a special you saw",
                subtitle: model.isSignedIn ? "Use this for signs, menu boards, or staff-confirmed recurring offers." : "Sign in first to send happy-hour updates.",
                systemImage: "clock.badge.checkmark.fill"
            )
            venuePicker
            dayPicker
            DatePicker("Starts", selection: $happyStart, displayedComponents: .hourAndMinute)
            DatePicker("Ends", selection: $happyEnd, displayedComponents: .hourAndMinute)
            TextField("Offer details", text: $happyOffer, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            TextField("Notes, optional", text: $happyNotes, axis: .vertical)
                .lineLimit(2...5)
                .textFieldStyle(.roundedBorder)
            PrimaryButton(title: "Send happy-hour update", systemImage: "clock.badge.checkmark.fill", isLoading: model.isLoading) {
                Task {
                    await model.submitHappyHourUpdate(
                        venueId: selectedVenueId,
                        days: Array(happyDays).sorted(),
                        startTime: contributionTime(happyStart),
                        endTime: contributionTime(happyEnd),
                        offerText: happyOffer,
                        notes: happyNotes
                    )
                    clearHappyHourFields()
                }
            }
            .disabled(!model.isSignedIn || selectedVenueId.isEmpty || happyDays.isEmpty || happyOffer.trimmed.isEmpty)
            StatusBanner(message: "If the board has lots of detail, Photo is usually faster and safer.")
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
                subtitle: "Pick one nearby, then use Price, Photo, or Happy hour to send the update.",
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
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(mission.venueName)
                                .font(.headline)
                            Spacer()
                            if let points = mission.points {
                                Text("\(String(format: "%.1f", points)) pts")
                                    .font(.caption.weight(.black))
                                    .foregroundStyle(BeerMapTheme.amber)
                            }
                        }
                        Text([mission.suburb, mission.reason].compactMap { $0 }.joined(separator: " - "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let venueId = mission.venueId {
                            SecondaryButton(title: "Use this venue", systemImage: "mappin.and.ellipse") {
                                selectedVenueId = venueId
                                selectedMode = .price
                            }
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
                StatusBanner(message: "No venues loaded yet. Refresh Find before sending venue-specific updates.", isError: true)
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

    private var dayPicker: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 8) {
            ForEach(dayCodes, id: \.self) { day in
                Button {
                    if happyDays.contains(day) {
                        happyDays.remove(day)
                    } else {
                        happyDays.insert(day)
                    }
                } label: {
                    Text(day.uppercased())
                        .font(.caption.weight(.bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                }
                .buttonStyle(.plain)
                .background(happyDays.contains(day) ? BeerMapTheme.amber.opacity(0.28) : BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("\(day.uppercased()) \(happyDays.contains(day) ? "selected" : "not selected")")
            }
        }
    }

    private var sourcePhotoDataURL: String? {
        guard let sourcePhotoData else { return nil }
        return "data:image/jpeg;base64,\(sourcePhotoData.base64EncodedString())"
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

    @MainActor
    private func loadSourcePhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        sourcePhotoStatus = "Preparing photo for review..."
        do {
            guard
                let data = try await item.loadTransferable(type: Data.self),
                let image = UIImage(data: data),
                let jpeg = compressedJPEGData(from: image)
            else {
                sourcePhotoData = nil
                sourcePhotoStatus = "Could not prepare this image. Try a JPEG, PNG, HEIC, or WebP photo."
                return
            }
            guard jpeg.count <= 6 * 1024 * 1024 else {
                sourcePhotoData = nil
                sourcePhotoStatus = "Could not attach this photo because it is still larger than 6MB after compression."
                return
            }
            sourcePhotoData = jpeg
            sourcePhotoStatus = "Photo ready for private review (\(ByteCountFormatter.string(fromByteCount: Int64(jpeg.count), countStyle: .file)))."
        } catch {
            sourcePhotoData = nil
            sourcePhotoStatus = "Could not prepare this photo. \(error.localizedDescription)"
        }
    }

    private func clearPriceFields() {
        beerName = ""
        priceText = ""
        notes = ""
        servingSize = "pint"
    }

    private func clearPhotoFields() {
        sourcePhotoItem = nil
        sourcePhotoData = nil
        sourcePhotoStatus = "Choose a clear menu, receipt, tap-list, or happy-hour board photo."
        notes = ""
    }

    private func clearHappyHourFields() {
        happyOffer = ""
        happyNotes = ""
        happyDays = ["fri"]
    }

    private func clearRequestFields() {
        requestVenueName = ""
        requestBeerName = ""
        requestSuburb = ""
        requestNotes = ""
    }
}

private func compressedJPEGData(from image: UIImage) -> Data? {
    let maxEdge: CGFloat = 2200
    let longestEdge = max(image.size.width, image.size.height)
    let scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1
    let outputSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let renderer = UIGraphicsImageRenderer(size: outputSize)
    let rendered = renderer.image { _ in
        image.draw(in: CGRect(origin: .zero, size: outputSize))
    }
    return rendered.jpegData(compressionQuality: 0.84)
}

private func contributionTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
}

private extension String {
    var trimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
