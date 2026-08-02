import CoreLocation
import ImageIO
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ContributeView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @StateObject private var locationProof = OneTimeLocationProof()
    @AppStorage("au.pintpath.app.lastContributionVenueId") private var lastVenueId = ""
    @State private var selectedMode: ContributionMode = .price
    @State private var selectedVenueId = ""
    @State private var showingVenuePicker = false
    @State private var showingCamera = false
    @State private var showingAdvancedPriceOptions = false
    @State private var beerName = ""
    @State private var selectedTrackedBeerId: String?
    @State private var confirmedCustomBeerName = false
    @State private var priceText = ""
    @State private var servingSize = "pint"
    @State private var notes = ""
    @State private var sourcePhotoItem: PhotosPickerItem?
    @State private var sourcePhotoDataURL: String?
    @State private var sourcePhotoPreview: UIImage?
    @State private var sourcePhotoStatus = "Fill the frame, hold the camera square, and avoid glare. OCR will read the beer rows and pint prices."
    @State private var sourcePhotoPreparationTask: Task<Void, Never>?
    @State private var requestVenueName = ""
    @State private var requestBeerName = ""
    @State private var requestSuburb = ""
    @State private var requestNotes = ""
    @State private var requestKind: MissingRequestKind = .venue
    @State private var priceSubmissionId = "ios-\(UUID().uuidString)"
    @State private var photoSubmissionId = "ios-photo-\(UUID().uuidString)"
    @State private var acceptedMissionId: String?
    @State private var attachLocationProof = false
    @FocusState private var focusedPriceField: PriceField?

    private let servingSizes = ["pint", "pot", "schooner", "jug", "bottle", "can", "other"]

    enum ContributionMode: String, CaseIterable, Identifiable {
        case price = "Price"
        case source = "Scan menu"
        case request = "Request"
        case missions = "Missions"

        var id: String { rawValue }

        var systemImage: String {
            switch self {
            case .price: return "plus.circle.fill"
            case .source: return "doc.viewfinder"
            case .request: return "paperplane.fill"
            case .missions: return "target"
            }
        }
    }

    private enum PriceField: Hashable {
        case beer
        case price
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
                if acceptedMissionId != nil {
                    StatusBanner(
                        message: "Mission reserved for this update.",
                        systemImage: "checkmark.seal.fill"
                    )
                }

                switch selectedMode {
                case .price:
                    priceCard
                case .source:
                    sourcePhotoCard
                case .request:
                    requestCard
                case .missions:
                    missionsCard
                }
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle(selectedMode == .price ? "Add price" : selectedMode.rawValue)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    focusedPriceField = nil
                    model.selectedTab = .explore
                } label: {
                    Label("Back", systemImage: "chevron.left")
                }
                .accessibilityLabel("Back to map")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ForEach(ContributionMode.allCases) { mode in
                        Button {
                            selectedMode = mode
                        } label: {
                            if mode == .price {
                                Label {
                                    Text("Quick price")
                                } icon: {
                                    BeerPintIcon(size: 17)
                                }
                            } else {
                                Label(mode.rawValue, systemImage: mode.systemImage)
                            }
                        }
                    }
                } label: {
                    Label("More updates", systemImage: "ellipsis.circle")
                }
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    focusedPriceField = nil
                }
            }
        }
        .onAppear {
            ensureVenueSelection()
            applyPendingVenueSelection()
            syncAcceptedMission()
        }
        .refreshable {
            await model.loadHome()
            ensureVenueSelection()
        }
        .onChange(of: model.venues) { _, _ in
            ensureVenueSelection()
            applyPendingVenueSelection()
        }
        .onChange(of: model.missions) { _, _ in
            syncAcceptedMission()
        }
        .onChange(of: model.pendingContributionVenueId) { _, _ in
            applyPendingVenueSelection()
        }
        .onChange(of: sourcePhotoItem) { _, item in
            sourcePhotoPreparationTask?.cancel()
            guard item != nil else { return }
            sourcePhotoPreparationTask = Task { await loadSourcePhoto(item) }
        }
        .onDisappear { sourcePhotoPreparationTask?.cancel() }
        .fullScreenCover(isPresented: $showingCamera) {
            CameraPhotoPicker { image in
                showingCamera = false
                sourcePhotoPreparationTask?.cancel()
                sourcePhotoPreparationTask = Task { await loadCameraPhoto(image) }
            } onCancel: {
                showingCamera = false
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showingVenuePicker) {
            VenueSelectionSheet(
                venues: model.venues,
                selectedVenueId: selectedVenueId,
                recentVenueId: lastVenueId
            ) { venue in
                selectedVenueId = venue.id
                lastVenueId = venue.id
                showingVenuePicker = false
            }
        }
    }

    private var priceCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !model.isSignedIn {
                Label("Sign in from Account to submit a price.", systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            priceStep(number: 1, title: "Venue") {
                venuePicker
            }

            priceStep(number: 2, title: "Beer") {
                TextField("Start typing a beer", text: $beerName)
                    .textFieldStyle(.roundedBorder)
                    .frame(minHeight: 44)
                    .textContentType(.none)
                    .submitLabel(.next)
                    .focused($focusedPriceField, equals: .beer)
                    .onSubmit { focusedPriceField = .price }
                    .onChange(of: beerName) { _, value in
                        selectedTrackedBeerId = exactTrackedBeer(for: value)?.id
                        confirmedCustomBeerName = false
                    }

                if !beerSuggestions.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(beerSuggestions) { beer in
                                Button(beer.name) {
                                    beerName = beer.name
                                    selectedTrackedBeerId = beer.id
                                    confirmedCustomBeerName = false
                                    focusedPriceField = .price
                                }
                                .buttonStyle(.bordered)
                                .buttonBorderShape(.capsule)
                                .frame(minHeight: 44)
                                .accessibilityHint("Selects this catalogue beer")
                            }
                        }
                    }
                }

                if selectedTrackedBeer == nil && !beerName.trimmed.isEmpty {
                    Toggle(isOn: $confirmedCustomBeerName) {
                        Text("Use this new beer name")
                            .font(.caption.weight(.semibold))
                    }
                    .tint(BeerMapTheme.primaryAction)
                    .frame(minHeight: 44)
                }

                if beerName.count > 120 {
                    Label("Beer names can be up to 120 characters.", systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(BeerMapTheme.danger)
                }
            }

            priceStep(number: 3, title: "Price") {
                HStack(spacing: 8) {
                    Text("$")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    TextField("0.00", text: $priceText)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .frame(minHeight: 44)
                        .focused($focusedPriceField, equals: .price)
                        .accessibilityLabel("Observed price in Australian dollars")
                }
                .frame(minHeight: 44)
                if let priceValidationMessage {
                    Label(priceValidationMessage, systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(BeerMapTheme.danger)
                }
            }

            priceStep(number: 4, title: "Serving") {
                servingPicker
            }

            DisclosureGroup("Optional details", isExpanded: $showingAdvancedPriceOptions) {
                VStack(alignment: .leading, spacing: 12) {
                    sourcePhotoActions(cameraTitle: "Take evidence photo", libraryTitle: "Choose photo")

                    sourcePhotoPreviewView

                    if sourcePhotoStatus.hasPrefix("Preparing") || sourcePhotoStatus.hasPrefix("Could not") {
                        Text(sourcePhotoStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    TextField("Review note, optional", text: $notes, axis: .vertical)
                        .lineLimit(2...4)
                        .textFieldStyle(.roundedBorder)
                    locationProofToggle
                }
                .padding(.top, 10)
            }
            .font(.subheadline.weight(.semibold))

            PrimaryButton(title: "Submit price", systemImage: "paperplane.fill", isLoading: model.isLoading) {
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
                        sourcePhotoDataUrl: sourcePhotoDataURL,
                        uploadLocation: location
                    )
                    if submitted {
                        await model.refreshMissions()
                        clearPriceFields()
                    }
                }
            }
            .disabled(priceSubmitDisabled)
        }
        .beerMapCard()
    }

    private var sourcePhotoCard: some View {
        return VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Fastest bulk update",
                title: "Scan a menu or tap board",
                subtitle: model.isSignedIn ? "Choose the venue and take one clear photo. OCR reads the beer rows and pint prices automatically, then a reviewer confirms them." : "Sign in first so the menu can be read and reviewed.",
                systemImage: "doc.viewfinder"
            )
            venuePicker
            sourcePhotoActions(cameraTitle: "Take menu photo", libraryTitle: "Choose existing")
            sourcePhotoPreviewView

            StatusBanner(
                message: sourcePhotoStatus,
                isError: sourcePhotoDataURL == nil && sourcePhotoStatus.hasPrefix("Could not"),
                systemImage: sourcePhotoDataURL == nil ? "photo" : "checkmark.seal.fill"
            )
            TextField("What should reviewers look for?", text: $notes, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            locationProofToggle
            PrimaryButton(title: "Scan and submit menu", systemImage: "arrow.up.doc.fill", isLoading: model.isLoading) {
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
                    if submitted {
                        await model.refreshMissions()
                        clearPhotoFields()
                    }
                }
            }
            .disabled(!model.isSignedIn || selectedVenueId.isEmpty || sourcePhotoDataURL == nil)
            StatusBanner(message: "Location proof is optional, requested only when you send, and used only for submission review and points eligibility.")
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
                subtitle: "Pick one nearby, then use Price or Scan menu to send the update.",
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
                            VStack(alignment: .leading, spacing: 8) {
                                StatusBanner(message: "Reserved until \(mission.reservationExpiresAt ?? "24 hours after acceptance")", systemImage: "clock.badge.checkmark.fill")
                                if mission.venueId != nil {
                                    PrimaryButton(
                                        title: acceptedMissionId == mission.id ? "Continue reserved mission" : "Use reserved mission",
                                        systemImage: "arrow.right.circle.fill",
                                        isLoading: false
                                    ) {
                                        activateMission(mission)
                                    }
                                }
                                Button(role: .destructive) {
                                    Task {
                                        if await model.releaseMission(mission) {
                                            if acceptedMissionId == mission.id { acceptedMissionId = nil }
                                        }
                                    }
                                } label: {
                                    Label("Release mission", systemImage: "xmark.circle")
                                        .frame(maxWidth: .infinity, minHeight: 44)
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
                                    activateMission(mission, venueId: venueId)
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

    @ViewBuilder
    private var venuePicker: some View {
        let currentVenue = selectedVenue

        Group {
            if model.venues.isEmpty {
                StatusBanner(message: "Venues are not available yet. Refresh and try again.", isError: true)
            } else if let mission = activeMission {
                HStack(spacing: 12) {
                    Image(systemName: "lock.fill")
                        .font(.headline)
                        .foregroundStyle(BeerMapTheme.primaryAction)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(currentVenue?.name ?? mission.venueName)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                        Text("Locked to the reserved mission venue")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(BeerMapTheme.leaf)
                }
                .padding(12)
                .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(BeerMapTheme.primaryAction.opacity(0.35), lineWidth: 1)
                )
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Mission venue, \(currentVenue?.name ?? mission.venueName), locked")
            } else {
                Button {
                    showingVenuePicker = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "mappin.and.ellipse")
                            .font(.headline)
                            .foregroundStyle(BeerMapTheme.primaryAction)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(currentVenue?.name ?? "Choose a venue")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(currentVenue?.displayLocation.nilIfBlank ?? "Choose venue")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                }
                .buttonStyle(.plain)
                .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(currentVenue == nil ? Color.orange.opacity(0.55) : BeerMapTheme.separator.opacity(0.4), lineWidth: 1)
                )
                .accessibilityLabel(currentVenue.map { "Venue, \($0.name)" } ?? "Choose a venue")
                .accessibilityHint("Opens searchable venue selection")
            }
        }
    }

    private var selectedVenue: Venue? {
        model.venues.first { $0.id == selectedVenueId }
    }

    private var activeMission: Mission? {
        guard let acceptedMissionId else { return nil }
        return model.missions.first { mission in
            mission.id == acceptedMissionId && mission.userProgress == "accepted"
        }
    }

    private func activateMission(_ mission: Mission, venueId explicitVenueId: String? = nil) {
        guard let venueId = explicitVenueId ?? mission.venueId else { return }
        acceptedMissionId = mission.id
        selectedVenueId = venueId
        lastVenueId = venueId
        selectedMode = .price
    }

    private func syncAcceptedMission() {
        if let acceptedMissionId,
           let current = model.missions.first(where: {
               $0.id == acceptedMissionId && $0.userProgress == "accepted"
           }) {
            if let venueId = current.venueId {
                selectedVenueId = venueId
                lastVenueId = venueId
            }
            return
        }

        guard let reserved = model.missions.first(where: { $0.userProgress == "accepted" }) else {
            acceptedMissionId = nil
            return
        }
        activateMission(reserved)
    }

    private var selectedTrackedBeer: TrackedBeer? {
        guard let selectedTrackedBeerId else { return nil }
        return model.config?.trackedBeers?.first { $0.id == selectedTrackedBeerId }
    }

    private func exactTrackedBeer(for value: String) -> TrackedBeer? {
        let normalized = value.trimmed
        guard !normalized.isEmpty else { return nil }
        return model.config?.trackedBeers?.first {
            $0.name.compare(normalized, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }
    }

    private var beerSuggestions: [TrackedBeer] {
        let query = beerName.trimmed
        guard !query.isEmpty else { return [] }
        let beers = model.config?.trackedBeers ?? []
        return beers
            .filter { $0.name.localizedStandardContains(query) }
            .sorted { lhs, rhs in
                let lhsPrefix = lhs.name.lowercased().hasPrefix(query.lowercased())
                let rhsPrefix = rhs.name.lowercased().hasPrefix(query.lowercased())
                if lhsPrefix != rhsPrefix { return lhsPrefix }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
            .prefix(6)
            .map { $0 }
    }

    private var cleanedPriceText: String {
        priceText
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: ".")
            .trimmed
    }

    private var validPrice: Double? {
        ObservedPriceParser.parse(cleanedPriceText)
    }

    private var priceValidationMessage: String? {
        guard !priceText.trimmed.isEmpty, validPrice == nil else { return nil }
        return "Enter a price from $0.01 to $250 with no more than two decimal places."
    }

    private var priceSubmitDisabled: Bool {
        let hasConfirmedBeer = selectedTrackedBeer != nil || confirmedCustomBeerName
        return !model.isSignedIn
            || selectedVenue == nil
            || beerName.trimmed.isEmpty
            || beerName.count > 120
            || !hasConfirmedBeer
            || validPrice == nil
    }

    private var servingPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(servingSizes.prefix(4), id: \.self) { size in
                    if let assetImage = servingAssetImage(size) {
                        FilterChip(
                            title: size.capitalized,
                            assetImage: assetImage,
                            isSelected: servingSize == size
                        ) {
                            servingSize = size
                        }
                    } else {
                        FilterChip(
                            title: size.capitalized,
                            systemImage: servingSystemImage(size),
                            isSelected: servingSize == size
                        ) {
                            servingSize = size
                        }
                    }
                }

                Menu {
                    ForEach(servingSizes.dropFirst(4), id: \.self) { size in
                        Button {
                            servingSize = size
                        } label: {
                            Label(size.capitalized, systemImage: servingSystemImage(size))
                        }
                    }
                } label: {
                    Label(
                        servingSizes.dropFirst(4).contains(servingSize) ? servingSize.capitalized : "More",
                        systemImage: "ellipsis.circle"
                    )
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 13)
                    .frame(minHeight: 44)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
            }
        }
    }

    private func servingSystemImage(_ serving: String) -> String {
        switch serving {
        case "bottle": return "waterbottle.fill"
        case "can": return "cylinder.fill"
        case "jug": return "wineglass.fill"
        case "other": return "ellipsis"
        default: return "wineglass.fill"
        }
    }

    private func servingAssetImage(_ serving: String) -> String? {
        switch serving {
        case "pint": return BeerMapAsset.beerPint
        case "pot": return BeerMapAsset.beerPot
        case "schooner": return BeerMapAsset.beerSchooner
        case "jug": return BeerMapAsset.beerJug
        default: return nil
        }
    }

    private func priceStep<Content: View>(
        number: Int,
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text("\(number)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(BeerMapTheme.primaryActionForeground)
                    .frame(width: 24, height: 24)
                    .background(BeerMapTheme.primaryAction, in: Circle())
                    .accessibilityHidden(true)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
            }
            content()
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
        guard selectedVenueId.isEmpty || !model.venues.contains(where: { $0.id == selectedVenueId }) else { return }
        if model.venues.count == 1 {
            selectedVenueId = model.venues[0].id
        } else {
            selectedVenueId = ""
        }
    }

    private func applyPendingVenueSelection() {
        guard
            activeMission == nil,
            let venueId = model.pendingContributionVenueId,
            model.venues.contains(where: { $0.id == venueId })
        else { return }

        selectedMode = .price
        selectedVenueId = venueId
        lastVenueId = venueId
        _ = model.takePendingContributionVenueId()
    }

    private func sourcePhotoActions(cameraTitle: String, libraryTitle: String) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 148), spacing: 10)], spacing: 10) {
            Button {
                showingCamera = true
            } label: {
                Label(cameraTitle, systemImage: "camera.fill")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(BeerMapTheme.primaryAction)
            .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            .accessibilityHint("Opens the camera for a private evidence photo")

            PhotosPicker(selection: $sourcePhotoItem, matching: .images) {
                Label(libraryTitle, systemImage: "photo.on.rectangle")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .accessibilityHint("Chooses one existing photo for private review")
        }
    }

    @ViewBuilder
    private var sourcePhotoPreviewView: some View {
        if let sourcePhotoPreview {
            ZStack(alignment: .topTrailing) {
                Image(uiImage: sourcePhotoPreview)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity)
                    .frame(height: 168)
                    .clipped()
                    .accessibilityLabel("Selected evidence photo preview")

                Button {
                    clearSourcePhoto()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(Color.white, Color.black.opacity(0.72))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Remove selected photo")
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
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
                sourcePhotoPreview = nil
                sourcePhotoStatus = "Could not read this photo. Try a JPEG, PNG, HEIC, or WebP image."
                return
            }
            await loadSourcePhotoData(data)
        } catch is CancellationError {
            return
        } catch {
            sourcePhotoDataURL = nil
            sourcePhotoPreview = nil
            sourcePhotoStatus = "Could not prepare this photo. \(error.localizedDescription)"
        }
    }

    @MainActor
    private func loadSourcePhotoData(_ data: Data) async {
        sourcePhotoStatus = "Preparing photo for review..."
        do {
            try Task<Never, Never>.checkCancellation()
            let worker = Task.detached(priority: .userInitiated) {
                try prepareSourcePhoto(data)
            }
            let preparedPhoto = try await withTaskCancellationHandler {
                try await worker.value
            } onCancel: {
                worker.cancel()
            }
            try Task<Never, Never>.checkCancellation()
            sourcePhotoDataURL = preparedPhoto.dataURL
            sourcePhotoPreview = UIImage(data: preparedPhoto.jpegData)
            sourcePhotoStatus = "Photo ready for private review (\(ByteCountFormatter.string(fromByteCount: Int64(preparedPhoto.byteCount), countStyle: .file)))."
        } catch is CancellationError {
            return
        } catch {
            sourcePhotoDataURL = nil
            sourcePhotoPreview = nil
            sourcePhotoStatus = "Could not prepare this photo. \(error.localizedDescription)"
        }
    }

    @MainActor
    private func loadCameraPhoto(_ image: CameraPhotoPayload) async {
        sourcePhotoStatus = "Preparing photo for review..."
        do {
            try Task<Never, Never>.checkCancellation()
            let worker = Task.detached(priority: .userInitiated) {
                try prepareCameraPhoto(image)
            }
            let preparedPhoto = try await withTaskCancellationHandler {
                try await worker.value
            } onCancel: {
                worker.cancel()
            }
            try Task<Never, Never>.checkCancellation()
            sourcePhotoDataURL = preparedPhoto.dataURL
            sourcePhotoPreview = UIImage(data: preparedPhoto.jpegData)
            sourcePhotoStatus = "Photo ready for private review (\(ByteCountFormatter.string(fromByteCount: Int64(preparedPhoto.byteCount), countStyle: .file)))."
        } catch is CancellationError {
            return
        } catch {
            sourcePhotoDataURL = nil
            sourcePhotoPreview = nil
            sourcePhotoStatus = "Could not prepare this photo. \(error.localizedDescription)"
        }
    }

    private func clearSourcePhoto() {
        sourcePhotoPreparationTask?.cancel()
        sourcePhotoItem = nil
        sourcePhotoDataURL = nil
        sourcePhotoPreview = nil
        sourcePhotoStatus = "Fill the frame, hold the camera square, and avoid glare. OCR will read the beer rows and pint prices."
    }

    private func clearPriceFields() {
        beerName = ""
        selectedTrackedBeerId = nil
        confirmedCustomBeerName = false
        priceText = ""
        notes = ""
        clearSourcePhoto()
        showingAdvancedPriceOptions = false
        priceSubmissionId = "ios-\(UUID().uuidString)"
        acceptedMissionId = nil
    }

    private func clearPhotoFields() {
        clearSourcePhoto()
        notes = ""
        photoSubmissionId = "ios-photo-\(UUID().uuidString)"
        acceptedMissionId = nil
    }

    private func clearRequestFields() {
        requestVenueName = ""
        requestBeerName = ""
        requestSuburb = ""
        requestNotes = ""
    }
}

private struct VenueSelectionSheet: View {
    @Environment(\.dismiss) private var dismiss
    let venues: [Venue]
    let selectedVenueId: String
    let recentVenueId: String
    let onSelect: (Venue) -> Void
    @StateObject private var locationProvider = VenuePickerLocationProvider()
    @State private var searchText = ""
    @State private var visibleVenueLimit = 10

    private let venuePageSize = 10

    private var recentVenue: Venue? {
        venues.first { $0.id == recentVenueId }
    }

    private func matchingVenues(excluding recentVenueId: String?) -> [Venue] {
        let query = searchText.trimmed
        let candidates = venues.filter { $0.id != recentVenueId }

        if !query.isEmpty {
            return candidates
                .filter { venue in
                [venue.name, venue.address, venue.suburb, venue.postcode]
                    .compactMap { $0 }
                    .contains { $0.localizedStandardContains(query) }
                }
                .sorted { lhs, rhs in
                    let lhsPrefix = lhs.name.lowercased().hasPrefix(query.lowercased())
                    let rhsPrefix = rhs.name.lowercased().hasPrefix(query.lowercased())
                    if lhsPrefix != rhsPrefix { return lhsPrefix }
                    return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
                }
        }

        guard let origin = locationProvider.location else {
            // Preserve the API order while the one-shot location request finishes so
            // the sheet can present immediately without sorting the full catalogue.
            return candidates
        }

        let ranked = candidates.map { venue in
            (venue: venue, distance: venueLocation(venue).map(origin.distance(from:)))
        }
        return ranked
            .sorted { lhs, rhs in
                switch (lhs.distance, rhs.distance) {
                case let (lhsDistance?, rhsDistance?):
                    if lhsDistance != rhsDistance { return lhsDistance < rhsDistance }
                case (_?, nil):
                    return true
                case (nil, _?):
                    return false
                case (nil, nil):
                    break
                }
                return lhs.venue.name.localizedStandardCompare(rhs.venue.name) == .orderedAscending
            }
            .map { $0.venue }
    }

    var body: some View {
        let recentVenue = recentVenue
        let allMatches = matchingVenues(excluding: recentVenue?.id)
        let visibleVenues = Array(allMatches.prefix(visibleVenueLimit))
        let remainingVenueCount = max(0, allMatches.count - visibleVenues.count)

        NavigationStack {
            List {
                if let recentVenue {
                    Section("Recent") {
                        venueRow(recentVenue)
                    }
                }

                Section {
                    if searchText.trimmed.isEmpty, locationProvider.isLocating {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Finding venues near you…")
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }

                    if visibleVenues.isEmpty {
                        ContentUnavailableView.search(text: searchText)
                    } else {
                        ForEach(visibleVenues) { venue in
                            venueRow(venue)
                        }
                    }

                    if remainingVenueCount > 0 {
                        Button {
                            visibleVenueLimit = min(allMatches.count, visibleVenueLimit + venuePageSize)
                        } label: {
                            Label(
                                "Load \(min(venuePageSize, remainingVenueCount)) more",
                                systemImage: "arrow.down.circle"
                            )
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .accessibilityHint("\(remainingVenueCount) venues remain")
                    }
                } header: {
                    Text(venueSectionTitle)
                } footer: {
                    if remainingVenueCount > 0 {
                        Text("Search checks every venue, including those not yet shown.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Venue, suburb, or postcode")
            .textInputAutocapitalization(.words)
            .autocorrectionDisabled()
            .onChange(of: searchText) { _, _ in
                visibleVenueLimit = venuePageSize
            }
            .onAppear {
                locationProvider.requestOnce()
            }
            .navigationTitle("Choose venue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var venueSectionTitle: String {
        if !searchText.trimmed.isEmpty { return "Matches" }
        return locationProvider.location == nil ? "Venues" : "Nearby venues"
    }

    private func venueRow(_ venue: Venue) -> some View {
        Button {
            onSelect(venue)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "mappin.circle.fill")
                    .font(.title3)
                    .foregroundStyle(BeerMapTheme.primaryAction)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(venue.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(venueDetail(venue))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if venue.id == selectedVenueId {
                    Image(systemName: "checkmark")
                        .fontWeight(.semibold)
                        .foregroundStyle(BeerMapTheme.primaryAction)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(venue.id == selectedVenueId ? .isSelected : [])
    }

    private func venueDetail(_ venue: Venue) -> String {
        let place = venue.displayLocation.nilIfBlank ?? venue.address ?? "Melbourne"
        guard
            let origin = locationProvider.location,
            let venueLocation = venueLocation(venue)
        else {
            return place
        }

        let distance = origin.distance(from: venueLocation)
        let distanceCopy: String
        if distance < 1_000 {
            distanceCopy = "\(max(50, Int((distance / 50).rounded()) * 50)) m"
        } else {
            distanceCopy = String(format: "%.1f km", distance / 1_000)
        }
        return "\(place) · \(distanceCopy)"
    }

    private func venueLocation(_ venue: Venue) -> CLLocation? {
        guard
            let latitude = venue.latitude,
            let longitude = venue.longitude,
            (-90.0...90.0).contains(latitude),
            (-180.0...180.0).contains(longitude)
        else {
            return nil
        }
        return CLLocation(latitude: latitude, longitude: longitude)
    }
}

@MainActor
private final class VenuePickerLocationProvider: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    @Published private(set) var location: CLLocation?
    @Published private(set) var isLocating = false

    private let manager = CLLocationManager()
    private var hasRequested = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func requestOnce() {
        guard !hasRequested else { return }
        hasRequested = true

        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            isLocating = true
            manager.requestLocation()
        case .notDetermined:
            isLocating = true
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            isLocating = false
        @unknown default:
            isLocating = false
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard hasRequested else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            isLocating = true
            manager.requestLocation()
        case .denied, .restricted:
            isLocating = false
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        location = locations
            .filter { $0.horizontalAccuracy >= 0 }
            .max { $0.timestamp < $1.timestamp }
        isLocating = false
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        isLocating = false
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
            return "The photo is still larger than 5MB after compression. Try a different photo."
        }
    }
}

private struct PreparedSourcePhoto: Sendable {
    let dataURL: String
    let byteCount: Int
    let jpegData: Data
}

private struct CameraPhotoPayload: @unchecked Sendable {
    let cgImage: CGImage
    let orientation: UIImage.Orientation
}

private func prepareCameraPhoto(_ image: CameraPhotoPayload) throws -> PreparedSourcePhoto {
    try Task<Never, Never>.checkCancellation()
    let rotatesDimensions = [
        UIImage.Orientation.left,
        .leftMirrored,
        .right,
        .rightMirrored
    ].contains(image.orientation)
    let sourceWidth = CGFloat(rotatesDimensions ? image.cgImage.height : image.cgImage.width)
    let sourceHeight = CGFloat(rotatesDimensions ? image.cgImage.width : image.cgImage.height)
    guard sourceWidth > 0, sourceHeight > 0, sourceWidth <= 100_000, sourceHeight <= 100_000 else {
        throw SourcePhotoPreparationError.invalidImage
    }
    let longestSide = max(sourceWidth, sourceHeight)
    let resizeScale = min(1, 2_800 / longestSide)
    let targetSize = CGSize(
        width: max(1, (sourceWidth * resizeScale).rounded()),
        height: max(1, (sourceHeight * resizeScale).rounded())
    )
    let sourceImage = UIImage(cgImage: image.cgImage, scale: 1, orientation: image.orientation)
    let format = UIGraphicsImageRendererFormat.preferred()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
    let jpegData = renderer.jpegData(withCompressionQuality: 0.84) { _ in
        sourceImage.draw(in: CGRect(origin: .zero, size: targetSize))
    }
    try Task<Never, Never>.checkCancellation()
    guard !jpegData.isEmpty else { throw SourcePhotoPreparationError.outputFailed }
    guard jpegData.count <= 5 * 1024 * 1024 else { throw SourcePhotoPreparationError.outputTooLarge }
    return PreparedSourcePhoto(
        dataURL: "data:image/jpeg;base64,\(jpegData.base64EncodedString())",
        byteCount: jpegData.count,
        jpegData: jpegData
    )
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
        kCGImageSourceThumbnailMaxPixelSize: 2_800,
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
    guard jpegData.count <= 5 * 1024 * 1024 else {
        throw SourcePhotoPreparationError.outputTooLarge
    }
    let dataURL = "data:image/jpeg;base64,\(jpegData.base64EncodedString())"
    try Task<Never, Never>.checkCancellation()
    return PreparedSourcePhoto(dataURL: dataURL, byteCount: jpegData.count, jpegData: jpegData)
}

private struct CameraPhotoPicker: UIViewControllerRepresentable {
    let onPhoto: (CameraPhotoPayload) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: CameraPhotoPicker

        init(parent: CameraPhotoPicker) {
            self.parent = parent
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard
                let image = info[.originalImage] as? UIImage,
                let cgImage = image.cgImage
            else {
                parent.onCancel()
                return
            }
            parent.onPhoto(CameraPhotoPayload(cgImage: cgImage, orientation: image.imageOrientation))
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }
    }
}

extension String {
    var trimmed: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
