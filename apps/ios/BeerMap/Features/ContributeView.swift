import CoreLocation
import ImageIO
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ContributeView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @StateObject private var locationProof = OneTimeLocationProof()
    @State private var selectedMode: ContributionMode = .price
    @State private var selectedVenueId = ""
    @State private var beerName = ""
    @State private var priceText = ""
    @State private var servingSize = "pint"
    @State private var notes = ""
    @State private var sourcePhotoItem: PhotosPickerItem?
    @State private var sourcePhotoDataURL: String?
    @State private var sourcePhotoStatus = "Choose a clear menu, receipt, tap-list, or happy-hour board photo."
    @State private var sourcePhotoPreparationTask: Task<Void, Never>?
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
    @State private var priceSubmissionId = "ios-\(UUID().uuidString)"
    @State private var photoSubmissionId = "ios-photo-\(UUID().uuidString)"
    @State private var happyHourSubmissionId = "ios-happy-\(UUID().uuidString)"
    @State private var acceptedMissionId: String?
    @State private var attachLocationProof = false

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
                    subtitle: "Pick the shortest path. Pint Path sends everything through the same reviewed backend as the website.",
                    systemImage: "square.and.arrow.up.fill"
                )
                .beerMapCard()

                modePicker

                if acceptedMissionId != nil {
                    StatusBanner(
                        message: "Mission reserved. The next update you send from this form will be linked for review.",
                        systemImage: "checkmark.seal.fill"
                    )
                }

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
            sourcePhotoPreparationTask?.cancel()
            guard item != nil else { return }
            sourcePhotoPreparationTask = Task { await loadSourcePhoto(item) }
        }
        .onDisappear { sourcePhotoPreparationTask?.cancel() }
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
            locationProofToggle
            PrimaryButton(title: "Send price for review", systemImage: "paperplane.fill", isLoading: model.isLoading) {
                Task {
                    let location = await requestedLocationProof()
                    if attachLocationProof && location == nil { return }
                    let submitted = await model.submitPriceUpdate(
                        clientSubmissionId: priceSubmissionId,
                        missionId: acceptedMissionId,
                        venueId: selectedVenueId,
                        beerName: beerName,
                        servingSize: servingSize,
                        priceText: priceText,
                        notes: notes,
                        uploadLocation: location
                    )
                    if submitted { clearPriceFields() }
                }
            }
            .disabled(!model.isSignedIn || selectedVenueId.isEmpty || beerName.trimmed.isEmpty || priceText.trimmed.isEmpty)
            StatusBanner(message: "For a full menu or board, use Photo. Reviewers keep source evidence private.")
        }
        .beerMapCard()
    }

    private var sourcePhotoCard: some View {
        let photoButtonTitle = sourcePhotoDataURL == nil ? "Choose photo" : "Replace photo"

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
                isError: sourcePhotoDataURL == nil && sourcePhotoStatus.hasPrefix("Could not"),
                systemImage: sourcePhotoDataURL == nil ? "photo" : "checkmark.seal.fill"
            )
            TextField("What should reviewers look for?", text: $notes, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            locationProofToggle
            PrimaryButton(title: "Upload source for review", systemImage: "arrow.up.doc.fill", isLoading: model.isLoading) {
                guard let dataURL = sourcePhotoDataURL else {
                    model.errorMessage = "Choose a source photo before uploading."
                    return
                }
                Task {
                    let location = await requestedLocationProof()
                    if attachLocationProof && location == nil { return }
                    let submitted = await model.submitSourcePhotoUpdate(
                        clientSubmissionId: photoSubmissionId,
                        missionId: acceptedMissionId,
                        venueId: selectedVenueId,
                        sourcePhotoDataUrl: dataURL,
                        notes: notes,
                        uploadLocation: location
                    )
                    if submitted { clearPhotoFields() }
                }
            }
            .disabled(!model.isSignedIn || selectedVenueId.isEmpty || sourcePhotoDataURL == nil)
            StatusBanner(message: "Location proof is optional, requested only when you send, and used only for submission review and points eligibility.")
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
            locationProofToggle
            PrimaryButton(title: "Send happy-hour update", systemImage: "clock.badge.checkmark.fill", isLoading: model.isLoading) {
                Task {
                    let location = await requestedLocationProof()
                    if attachLocationProof && location == nil { return }
                    let submitted = await model.submitHappyHourUpdate(
                        clientSubmissionId: happyHourSubmissionId,
                        missionId: acceptedMissionId,
                        venueId: selectedVenueId,
                        days: Array(happyDays).sorted(),
                        startTime: contributionTime(happyStart),
                        endTime: contributionTime(happyEnd),
                        offerText: happyOffer,
                        notes: happyNotes,
                        uploadLocation: location
                    )
                    if submitted { clearHappyHourFields() }
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
                    let submitted = await model.requestMissing(
                        requestType: requestKind.requestType,
                        venueName: requestVenueName,
                        beerName: requestBeerName,
                        suburb: requestSuburb,
                        notes: requestNotes
                    )
                    if submitted { clearRequestFields() }
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
                        if mission.userProgress == "accepted" || acceptedMissionId == mission.id {
                            HStack {
                                StatusBanner(message: "Reserved until \(mission.reservationExpiresAt ?? "24 hours after acceptance")", systemImage: "clock.badge.checkmark.fill")
                                Button("Release", role: .destructive) {
                                    Task {
                                        if await model.releaseMission(mission) {
                                            if acceptedMissionId == mission.id { acceptedMissionId = nil }
                                        }
                                    }
                                }
                                .buttonStyle(.bordered)
                            }
                        } else if let venueId = mission.venueId {
                            PrimaryButton(
                                title: model.isSignedIn ? "Reserve mission" : "Sign in to reserve",
                                systemImage: "checkmark.seal.fill",
                                isLoading: model.isLoading
                            ) {
                                Task {
                                    guard await model.acceptMission(mission) else { return }
                                    acceptedMissionId = mission.id
                                    selectedVenueId = venueId
                                    selectedMode = mission.reason?.localizedCaseInsensitiveContains("happy") == true ? .happyHour : .price
                                }
                            }
                            .disabled(!model.isSignedIn)
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

    private var locationProofToggle: some View {
        Toggle(isOn: $attachLocationProof) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Attach one-time location proof")
                    .font(.subheadline.weight(.semibold))
                Text("Optional. Requested only at submit time; never tracked in the background.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @MainActor
    private func requestedLocationProof() async -> UploadLocationRequest? {
        guard attachLocationProof else { return nil }
        do {
            return try await locationProof.request()
        } catch {
            model.errorMessage = error.localizedDescription
            return nil
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

    @MainActor
    private func loadSourcePhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        sourcePhotoStatus = "Preparing photo for review..."
        do {
            guard
                let data = try await item.loadTransferable(type: Data.self)
            else {
                sourcePhotoDataURL = nil
                sourcePhotoStatus = "Could not read this photo. Try a JPEG, PNG, HEIC, or WebP image."
                return
            }
            try Task<Never, Never>.checkCancellation()
            let preparedPhoto = try await Task.detached(priority: .userInitiated) {
                try prepareSourcePhoto(data)
            }.value
            try Task<Never, Never>.checkCancellation()
            sourcePhotoDataURL = preparedPhoto.dataURL
            sourcePhotoStatus = "Photo ready for private review (\(ByteCountFormatter.string(fromByteCount: Int64(preparedPhoto.byteCount), countStyle: .file)))."
        } catch is CancellationError {
            return
        } catch {
            sourcePhotoDataURL = nil
            sourcePhotoStatus = "Could not prepare this photo. \(error.localizedDescription)"
        }
    }

    private func clearPriceFields() {
        beerName = ""
        priceText = ""
        notes = ""
        servingSize = "pint"
        priceSubmissionId = "ios-\(UUID().uuidString)"
        acceptedMissionId = nil
    }

    private func clearPhotoFields() {
        sourcePhotoItem = nil
        sourcePhotoDataURL = nil
        sourcePhotoStatus = "Choose a clear menu, receipt, tap-list, or happy-hour board photo."
        notes = ""
        photoSubmissionId = "ios-photo-\(UUID().uuidString)"
        acceptedMissionId = nil
    }

    private func clearHappyHourFields() {
        happyOffer = ""
        happyNotes = ""
        happyDays = ["fri"]
        happyHourSubmissionId = "ios-happy-\(UUID().uuidString)"
        acceptedMissionId = nil
    }

    private func clearRequestFields() {
        requestVenueName = ""
        requestBeerName = ""
        requestSuburb = ""
        requestNotes = ""
    }
}

@MainActor
private final class OneTimeLocationProof: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<UploadLocationRequest, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func request() async throws -> UploadLocationRequest {
        guard continuation == nil else { throw LocationProofError.requestInProgress }
        switch manager.authorizationStatus {
        case .denied, .restricted:
            throw LocationProofError.permissionDenied
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
            finish(.failure(LocationProofError.permissionDenied))
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else {
            finish(.failure(LocationProofError.unavailable))
            return
        }
        finish(.success(UploadLocationRequest(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracyMeters: max(0, location.horizontalAccuracy),
            capturedAt: ISO8601DateFormatter().string(from: location.timestamp)
        )))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(.failure(error))
    }

    private func finish(_ result: Result<UploadLocationRequest, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
}

private enum LocationProofError: LocalizedError {
    case permissionDenied
    case requestInProgress
    case unavailable

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Location access is off. Enable While Using the App in Settings, or turn off location proof and submit without it."
        case .requestInProgress:
            return "A location request is already in progress."
        case .unavailable:
            return "A location fix was not available. Try again outside, or submit without location proof."
        }
    }
}

private enum SourcePhotoPreparationError: LocalizedError {
    case tooLarge
    case invalidImage
    case outputFailed
    case outputTooLarge

    var errorDescription: String? {
        switch self {
        case .tooLarge:
            return "Choose an image smaller than 24MB."
        case .invalidImage:
            return "Try a JPEG, PNG, HEIC, or WebP photo with valid image dimensions."
        case .outputFailed:
            return "The image could not be compressed. Try a different photo."
        case .outputTooLarge:
            return "The photo is still larger than 6MB after compression. Try a different photo."
        }
    }
}

private struct PreparedSourcePhoto: Sendable {
    let dataURL: String
    let byteCount: Int
}

private func prepareSourcePhoto(_ data: Data) throws -> PreparedSourcePhoto {
    try Task<Never, Never>.checkCancellation()
    guard data.count <= 24 * 1024 * 1024 else { throw SourcePhotoPreparationError.tooLarge }
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
        throw SourcePhotoPreparationError.invalidImage
    }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let width = properties?[kCGImagePropertyPixelWidth] as? Int ?? 0
    let height = properties?[kCGImagePropertyPixelHeight] as? Int ?? 0
    guard width > 0, height > 0, width <= 100_000, height <= 100_000 else {
        throw SourcePhotoPreparationError.invalidImage
    }
    try Task<Never, Never>.checkCancellation()
    let thumbnailOptions: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 2_200,
        kCGImageSourceShouldCacheImmediately: true
    ]
    guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
        throw SourcePhotoPreparationError.invalidImage
    }
    try Task<Never, Never>.checkCancellation()
    let jpeg = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
        jpeg,
        UTType.jpeg.identifier as CFString,
        1,
        nil
    ) else {
        throw SourcePhotoPreparationError.outputFailed
    }
    CGImageDestinationAddImage(
        destination,
        thumbnail,
        [kCGImageDestinationLossyCompressionQuality: 0.84] as CFDictionary
    )
    guard CGImageDestinationFinalize(destination) else {
        throw SourcePhotoPreparationError.outputFailed
    }
    try Task<Never, Never>.checkCancellation()
    let jpegData = jpeg as Data
    guard jpegData.count <= 6 * 1024 * 1024 else {
        throw SourcePhotoPreparationError.outputTooLarge
    }
    let dataURL = "data:image/jpeg;base64,\(jpegData.base64EncodedString())"
    try Task<Never, Never>.checkCancellation()
    return PreparedSourcePhoto(dataURL: dataURL, byteCount: jpegData.count)
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
