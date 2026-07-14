import SwiftUI

struct VenuePortalView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var selectedVenueId = ""
    @State private var selectedSection: PortalSection = .dashboard

    enum PortalSection: String, CaseIterable, Identifiable {
        case dashboard = "Dashboard"
        case counter = "Counter"
        case profile = "Profile"
        case beers = "Beers"
        case happyHours = "Happy hours"
        case specials = "Specials"
        case reports = "Reports"

        var id: String { rawValue }

        var systemImage: String {
            switch self {
            case .dashboard: return "chart.bar.fill"
            case .counter: return "barcode.viewfinder"
            case .profile: return "building.2.fill"
            case .beers: return "mug.fill"
            case .happyHours: return "clock.badge.checkmark.fill"
            case .specials: return "tag.fill"
            case .reports: return "doc.text.fill"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if !model.isSignedIn {
                    EmptyStateView(
                        title: "Venue access is verified",
                        message: "Sign in, then request access from the Pint Path web venue portal if this venue is not assigned yet.",
                        systemImage: "building.2.crop.circle"
                    )
                } else if let portal = model.venuePortal {
                    if portal.accessState == "claim_required" {
                        claimAccessView(portal)
                    } else {
                        portalView(portal)
                    }
                } else {
                    EmptyStateView(
                        title: "No venue dashboard yet",
                        message: "Pull to refresh, or request access from the Pint Path web venue portal.",
                        systemImage: "person.2.badge.key.fill"
                    )
                }
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle("Bars")
        .refreshable {
            await model.refreshVenuePortal(venueId: selectedVenueId.isEmpty ? nil : selectedVenueId)
        }
        .task {
            await model.refreshVenuePortal()
        }
    }

    private func claimAccessView(_ portal: VenuePortalData) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Verified access",
                title: "Connect your venue",
                subtitle: portal.message ?? "Venue access is manually verified before management tools are enabled.",
                systemImage: "person.2.badge.key.fill"
            )
            Link(destination: AppConfig.apiBaseURL.appending(path: "venue-portal.html")) {
                Label("Request or review venue access", systemImage: "safari.fill")
                    .font(.headline.weight(.bold))
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            StatusBanner(
                message: "The secure web claim form is used because it includes the business-verification evidence and admin review trail.",
                systemImage: "checkmark.shield.fill"
            )
        }
        .beerMapCard()
    }

    private func portalView(_ portal: VenuePortalData) -> some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    eyebrow: portal.tier?.tierLabel ?? portal.profile?.membershipTier ?? "Venue",
                    title: portal.selectedVenue?.venueName ?? "Venue dashboard",
                    subtitle: portal.privacyCopy ?? "Venue insights are aggregate and privacy-safe.",
                    systemImage: "building.2.fill"
                )

                if let message = portal.message {
                    StatusBanner(message: message)
                }

                if let assignments = portal.assignments, assignments.count > 1 {
                    Picker("Assigned venue", selection: $selectedVenueId) {
                        ForEach(assignments, id: \.stableId) { assignment in
                            Text(assignment.venueName).tag(assignment.venueId)
                        }
                    }
                    .pickerStyle(.menu)
                    .onAppear {
                        selectedVenueId = portal.selectedVenue?.venueId ?? assignments.first?.venueId ?? ""
                    }
                    .onChange(of: selectedVenueId) { _, newValue in
                        if newValue != portal.selectedVenue?.venueId {
                            Task { await model.refreshVenuePortal(venueId: newValue) }
                        }
                    }
                }
            }
            .beerMapCard()

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(portal.accessLevel == "counter_staff" ? [.counter] : PortalSection.allCases) { section in
                        Button {
                            selectedSection = section
                        } label: {
                            Label(section.rawValue, systemImage: section.systemImage)
                                .font(.caption.weight(.bold))
                                .lineLimit(1)
                                .padding(.horizontal, 12)
                                .frame(height: 42)
                                .background(
                                    selectedSection == section ? BeerMapTheme.ink : BeerMapTheme.card,
                                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                                )
                                .foregroundStyle(selectedSection == section ? Color.white : Color.primary)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .stroke(BeerMapTheme.hairline, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Show \(section.rawValue)")
                    }
                }
                .padding(.vertical, 2)
            }
            .accessibilityElement(children: .contain)

            switch portal.accessLevel == "counter_staff" ? .counter : selectedSection {
            case .dashboard:
                PortalDashboard(portal: portal)
            case .counter:
                CounterToolsView(portal: portal)
                    .id("counter-\(portal.selectedVenue?.venueId ?? "none")")
            case .profile:
                if let profile = portal.profile {
                    ProfileEditor(profile: profile)
                        .id("profile-\(portal.selectedVenue?.venueId ?? "none")")
                }
            case .beers:
                BeerInventoryView(beers: portal.inventory?.beers ?? [])
                    .id("beers-\(portal.selectedVenue?.venueId ?? "none")")
            case .happyHours:
                HappyHourInventoryView(happyHours: portal.inventory?.happyHours ?? [])
                    .id("happy-\(portal.selectedVenue?.venueId ?? "none")")
            case .specials:
                SpecialInventoryView(specials: portal.inventory?.specials ?? [], canManage: portal.tier?.canManageSpecials == true)
                    .id("specials-\(portal.selectedVenue?.venueId ?? "none")")
            case .reports:
                PortalReportsView(portal: portal)
                    .id("reports-\(portal.selectedVenue?.venueId ?? "none")")
            }
        }
        .onChange(of: portal.selectedVenue?.venueId, initial: true) { _, venueId in
            selectedVenueId = venueId ?? ""
        }
    }
}

struct CounterToolsView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    let portal: VenuePortalData

    @State private var memberCode = ""
    @State private var transactionReference = ""
    @State private var checkedReference: String?
    @State private var itemName = ""
    @State private var category = "alcoholic"
    @State private var quantity = 1
    @State private var notes = ""
    @State private var voidReason = ""
    @State private var rewardCode = ""
    @State private var rewardReason = ""

    var body: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    eyebrow: "Counter",
                    title: portal.selectedVenue?.venueName ?? "Member checkout",
                    subtitle: "Check a short-lived member code before recording the exact paid item.",
                    systemImage: "barcode.viewfinder"
                )
                TextField("6-character member code", text: Binding(
                    get: { memberCode },
                    set: { memberCode = String($0.uppercased().prefix(6)); checkedReference = nil }
                ))
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                TextField("Receipt or order reference", text: Binding(
                    get: { transactionReference },
                    set: { transactionReference = $0; checkedReference = nil }
                ))
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.asciiCapable)
                    .autocorrectionDisabled()
                PrimaryButton(title: "Check member", systemImage: "checkmark.shield.fill", isLoading: model.isLoading) {
                    Task {
                        if await model.previewCounterMember(code: memberCode, transactionReference: transactionReference.trimmed) {
                            checkedReference = transactionReference.trimmed
                        }
                    }
                }
                .disabled(!validCode(memberCode) || transactionReference.trimmed.count < 4)

                if let preview = model.counterMemberPreview {
                    StatusBanner(
                        message: "Eligible member \(preview.accountId). \(preview.pointsRemainingToday ?? 0) Pint Points remain in today's cap.",
                        systemImage: "checkmark.seal.fill"
                    )
                    if let privacyCopy = preview.privacyCopy {
                        Text(privacyCopy)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    TextField("Purchased item", text: $itemName)
                        .textFieldStyle(.roundedBorder)
                    Picker("Category", selection: $category) {
                        Text("Alcoholic").tag("alcoholic")
                        Text("Non-alcoholic").tag("non_alcoholic")
                        Text("Food").tag("food")
                    }
                    .pickerStyle(.segmented)
                    Stepper("Quantity: \(quantity)", value: $quantity, in: 1...4)
                    TextField("Notes, optional", text: $notes)
                        .textFieldStyle(.roundedBorder)
                    PrimaryButton(title: "Record purchase", systemImage: "plus.circle.fill", isLoading: model.isLoading) {
                        Task {
                            if await model.recordCounterPurchase(
                                itemName: itemName,
                                category: category,
                                quantity: quantity,
                                transactionReference: transactionReference.trimmed,
                                notes: notes
                            ) {
                                memberCode = ""
                                checkedReference = nil
                                itemName = ""
                                notes = ""
                                quantity = 1
                            }
                        }
                    }
                    .disabled(itemName.trimmed.isEmpty || checkedReference != transactionReference.trimmed)
                }
            }
            .beerMapCard()

            if let result = model.counterPurchaseResult {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(eyebrow: "Correction", title: "Most recent purchase", subtitle: result.copy, systemImage: "arrow.uturn.backward.circle.fill")
                    if let progress = result.progressCopy { Text(progress) }
                    if let reward = result.rewardCopy { Text(reward) }
                    TextField("Reason for reversal", text: $voidReason)
                        .textFieldStyle(.roundedBorder)
                    SecondaryButton(title: "Reverse this purchase", systemImage: "arrow.uturn.backward", isDestructive: true) {
                        Task {
                            if await model.voidCounterPurchase(reason: voidReason.trimmed) { voidReason = "" }
                        }
                    }
                    .disabled(voidReason.trimmed.count < 4)
                }
                .beerMapCard()
            }

            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(
                    eyebrow: "Reward",
                    title: "Free Pint Reward",
                    subtitle: "Confirm only after age, ID, and responsible-service checks.",
                    systemImage: "gift.fill"
                )
                TextField("6-character reward code", text: Binding(
                    get: { rewardCode },
                    set: { rewardCode = String($0.uppercased().prefix(6)) }
                ))
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                PrimaryButton(title: "Confirm reward", systemImage: "checkmark.seal.fill", isLoading: model.isLoading) {
                    Task { await model.decideFreePintReward(code: rewardCode, action: "confirm", reason: nil) }
                }
                .disabled(!validCode(rewardCode))
                TextField("Rejection reason", text: $rewardReason)
                    .textFieldStyle(.roundedBorder)
                SecondaryButton(title: "Reject reward", systemImage: "xmark.seal.fill", isDestructive: true) {
                    Task { await model.decideFreePintReward(code: rewardCode, action: "reject", reason: rewardReason.trimmed) }
                }
                .disabled(!validCode(rewardCode) || rewardReason.trimmed.count < 4)
                if let result = model.counterRewardResult {
                    StatusBanner(message: result.copy ?? "Reward \(result.status ?? "updated").", systemImage: "checkmark.shield.fill")
                    if let instruction = result.instruction {
                        Text(instruction).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .beerMapCard()
        }
    }

    private func validCode(_ value: String) -> Bool {
        value.range(of: #"^[A-Z0-9]{6}$"#, options: .regularExpression) != nil
    }
}

struct PortalDashboard: View {
    let portal: VenuePortalData

    var body: some View {
        VStack(spacing: 16) {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                MetricPill(title: "Beers", value: "\(portal.inventory?.beers?.count ?? 0)", systemImage: "mug.fill", tint: BeerMapTheme.amber)
                MetricPill(title: "Happy hours", value: "\(portal.inventory?.happyHours?.count ?? 0)", systemImage: "clock.badge.checkmark.fill", tint: BeerMapTheme.leaf)
                MetricPill(title: "Specials", value: "\(portal.inventory?.specials?.count ?? 0)", systemImage: "tag.fill", tint: BeerMapTheme.plum)
                MetricPill(title: "Pending", value: "\(portal.pendingChanges?.count ?? 0)", systemImage: "tray.full.fill", tint: BeerMapTheme.sky)
                MetricPill(title: "Redemptions", value: "\(portal.discounts?.totalRedemptions ?? 0)", systemImage: "qrcode.viewfinder", tint: BeerMapTheme.leaf)
                MetricPill(title: "Reward pts", value: "\(portal.pintPoints?.rewardThreshold ?? 50)", systemImage: "gift.fill", tint: BeerMapTheme.amber)
            }

            if let planner = portal.dailySpecialsPlanner {
                DailySpecialsPlannerCard(planner: planner)
            }

            if let analytics = portal.analytics {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(
                        eyebrow: "Analytics",
                        title: analytics.privacyFloorMet == false ? "Demand snapshot building" : "Demand snapshot",
                        subtitle: analytics.privacyFloorMet == false ? "Area data stays hidden until the privacy floor is met." : nil,
                        systemImage: "chart.xyaxis.line"
                    )
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        MetricPill(title: "Lookups", value: "\(analytics.barLookups ?? 0)", systemImage: "magnifyingglass", tint: BeerMapTheme.sky)
                        MetricPill(title: "Profiles", value: "\(analytics.profileViews ?? 0)", systemImage: "person.text.rectangle.fill", tint: BeerMapTheme.leaf)
                        MetricPill(title: "Beer views", value: "\(analytics.beerListViews ?? 0)", systemImage: "list.bullet.rectangle.fill", tint: BeerMapTheme.amber)
                        MetricPill(title: "Specials intent", value: "\(analytics.specialsViews ?? 0)", systemImage: "tag.fill", tint: BeerMapTheme.plum)
                    }
                }
                .beerMapCard()
            } else {
                EmptyStateView(
                    title: "Pro analytics are locked",
                    message: portal.tier?.upgradeCopy ?? "Free venue accounts can manage beer and happy-hour data. Pro unlocks specials, analytics, and reports.",
                    systemImage: "chart.xyaxis.line"
                )
            }
        }
    }
}

struct DailySpecialsPlannerCard: View {
    let planner: DailySpecialsPlanner

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Specials planner",
                title: "Daily summary for \(planner.area ?? "your area")",
                subtitle: planner.summary ?? planner.confidenceCopy,
                systemImage: "sparkles"
            )

            if let signals = planner.demandSignals, !signals.isEmpty {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    ForEach(signals.prefix(4)) { signal in
                        MetricPill(
                            title: signal.label,
                            value: signal.displayValue,
                            systemImage: "chart.bar.fill",
                            tint: BeerMapTheme.sky
                        )
                    }
                }
            }

            if let recommendations = planner.recommendations, !recommendations.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Recommended specials")
                        .font(.caption.weight(.black))
                        .foregroundStyle(BeerMapTheme.amber)
                    ForEach(recommendations.prefix(3)) { recommendation in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(recommendation.title)
                                .font(.headline)
                            Text(recommendation.offerIdea ?? recommendation.action ?? "Use one clear staff-friendly special.")
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                            if let reason = recommendation.reason {
                                Text(reason)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }

            if planner.privacyFloorMet == false, let confidence = planner.confidenceCopy {
                StatusBanner(message: confidence, systemImage: "lock.shield.fill")
            }
        }
        .beerMapCard()
    }
}

struct ProfileEditor: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var draft: BarProfile

    init(profile: BarProfile) {
        _draft = State(initialValue: profile)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(eyebrow: "Profile", title: "Bar profile", subtitle: "Keep public venue details accurate for the map and reports.", systemImage: "building.2.fill")
            TextField("Venue name", text: $draft.name)
                .textFieldStyle(.roundedBorder)
            TextField("Address", text: binding("address"))
                .textFieldStyle(.roundedBorder)
            TextField("Suburb", text: binding("suburb"))
                .textFieldStyle(.roundedBorder)
            TextField("Phone", text: binding("phone"))
                .textFieldStyle(.roundedBorder)
                .keyboardType(.phonePad)
            TextField("Website", text: binding("website"))
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Instagram URL", text: binding("instagram"))
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Description", text: binding("description"), axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
            Toggle("Active listing", isOn: Binding(
                get: { draft.active ?? true },
                set: { draft.active = $0 }
            ))
            PrimaryButton(title: "Save profile", systemImage: "checkmark.circle.fill", isLoading: model.isLoading) {
                Task { await model.saveProfile(draft) }
            }
            .disabled(draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .beerMapCard()
    }

    private func binding(_ keyPath: String) -> Binding<String> {
        Binding {
            switch keyPath {
            case "address": return draft.address ?? ""
            case "suburb": return draft.suburb ?? ""
            case "phone": return draft.phone ?? ""
            case "website": return draft.website ?? ""
            case "instagram": return draft.instagram ?? ""
            case "description": return draft.description ?? ""
            default: return ""
            }
        } set: { newValue in
            let value = newValue.nilIfBlank
            switch keyPath {
            case "address": draft.address = value
            case "suburb": draft.suburb = value
            case "phone": draft.phone = value
            case "website": draft.website = value
            case "instagram": draft.instagram = value
            case "description": draft.description = value
            default: break
            }
        }
    }
}

struct BeerInventoryView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var draft = BarBeer(id: nil, beerName: "", brewery: nil, style: nil, abv: nil, serveSize: "pint", price: nil, onTap: true, inStock: true, notes: nil)
    @State private var priceText = ""

    let beers: [BarBeer]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(eyebrow: "Stock", title: "Beers and prices", subtitle: "Venue updates stay server-reviewed where required.", systemImage: "mug.fill")
            if beers.isEmpty {
                EmptyStateView(
                    title: "No beer rows yet",
                    message: "Add the beers staff want visible first. You can expand stock detail after the first save.",
                    systemImage: "tray",
                    isFramed: false
                )
            } else {
                ForEach(beers, id: \.stableId) { beer in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(beer.beerName)
                                .font(.headline)
                            Text([beer.style, beer.serveSize, beer.onTap ? "On tap" : nil].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                        if let price = beer.price {
                            Text("$\(String(format: "%.2f", price))")
                                .font(.headline.weight(.bold))
                        }
                    }
                    .padding(10)
                    .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                }
            }

            Divider()
            TextField("Beer name", text: $draft.beerName)
                .textFieldStyle(.roundedBorder)
            TextField("Brewery", text: optionalBinding(\.brewery))
                .textFieldStyle(.roundedBorder)
            TextField("Style", text: optionalBinding(\.style))
                .textFieldStyle(.roundedBorder)
            TextField("Price", text: $priceText)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.decimalPad)
            Toggle("On tap", isOn: $draft.onTap)
            Toggle("In stock", isOn: $draft.inStock)
            PrimaryButton(title: "Save beer row", systemImage: "plus.circle.fill", isLoading: model.isLoading) {
                draft.price = Double(priceText)
                Task { await model.saveBeer(draft) }
            }
            .disabled(draft.beerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .beerMapCard()
    }

    private func optionalBinding(_ keyPath: WritableKeyPath<BarBeer, String?>) -> Binding<String> {
        Binding {
            draft[keyPath: keyPath] ?? ""
        } set: { value in
            draft[keyPath: keyPath] = value.nilIfBlank
        }
    }
}

struct HappyHourInventoryView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var draftTitle = ""
    @State private var draftDescription = ""
    @State private var start = Calendar.current.date(bySettingHour: 16, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var end = Calendar.current.date(bySettingHour: 18, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var selectedDays: Set<String> = ["fri"]

    let happyHours: [BarHappyHour]
    private let days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(eyebrow: "Happy hours", title: "Current specials", subtitle: "Use native time pickers so staff can update quickly.", systemImage: "clock.badge.checkmark.fill")
            if happyHours.isEmpty {
                EmptyStateView(
                    title: "No happy hours yet",
                    message: "Add the recurring windows your team wants customers to find quickly.",
                    systemImage: "clock",
                    isFramed: false
                )
            } else {
                ForEach(happyHours, id: \.stableId) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.headline)
                        Text("\(item.daysOfWeek.joined(separator: ", ")) · \(item.startTime)-\(item.endTime)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(item.description)
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                }
            }

            Divider()
            TextField("Title", text: $draftTitle)
                .textFieldStyle(.roundedBorder)
            TextField("Description", text: $draftDescription, axis: .vertical)
                .lineLimit(3...5)
                .textFieldStyle(.roundedBorder)
            DatePicker("Starts", selection: $start, displayedComponents: .hourAndMinute)
            DatePicker("Ends", selection: $end, displayedComponents: .hourAndMinute)
            dayPicker
            PrimaryButton(title: "Save happy hour", systemImage: "clock.badge.checkmark.fill", isLoading: model.isLoading) {
                let happyHour = BarHappyHour(
                    id: nil,
                    title: draftTitle,
                    daysOfWeek: Array(selectedDays).sorted(),
                    startTime: formatTime(start),
                    endTime: formatTime(end),
                    description: draftDescription,
                    active: true
                )
                Task { await model.saveHappyHour(happyHour) }
            }
            .disabled(draftTitle.isEmpty || draftDescription.isEmpty || selectedDays.isEmpty)
        }
        .beerMapCard()
    }

    private var dayPicker: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 8) {
            ForEach(days, id: \.self) { day in
                Button {
                    if selectedDays.contains(day) {
                        selectedDays.remove(day)
                    } else {
                        selectedDays.insert(day)
                    }
                } label: {
                    Text(day.uppercased())
                        .font(.caption.weight(.bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .background(selectedDays.contains(day) ? BeerMapTheme.amber.opacity(0.28) : BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityLabel("\(day.uppercased()) \(selectedDays.contains(day) ? "selected" : "not selected")")
            }
        }
    }
}

struct SpecialInventoryView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    let specials: [BarSpecial]
    let canManage: Bool

    @State private var title = ""
    @State private var description = ""
    @State private var discount = ""
    @State private var priceText = ""
    @State private var start = Calendar.current.date(bySettingHour: 17, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var end = Calendar.current.date(bySettingHour: 21, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var exclusive = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(eyebrow: "Specials", title: "Pint Path specials", subtitle: canManage ? "Pro venues can submit reviewed specials." : "Upgrade to Pro to add reviewed specials.", systemImage: "tag.fill")
            if !canManage {
                StatusBanner(message: "Free venue accounts can manage beers and happy hours. Pro unlocks reviewed Pint Path specials.")
            }

            if specials.isEmpty {
                EmptyStateView(
                    title: canManage ? "No specials yet" : "Specials are locked",
                    message: canManage ? "Add a reviewed Pint Path special for peak service windows." : "Pro unlocks reviewed Pint Path specials for this venue.",
                    systemImage: "tag",
                    isFramed: false
                )
            } else {
                ForEach(specials, id: \.stableId) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.headline)
                        Text([item.discount, item.startTime + "-" + item.endTime].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(item.description)
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                }
            }

            if canManage {
                Divider()
                TextField("Special title", text: $title)
                    .textFieldStyle(.roundedBorder)
                TextField("Description", text: $description, axis: .vertical)
                    .lineLimit(3...5)
                    .textFieldStyle(.roundedBorder)
                TextField("Discount copy", text: $discount)
                    .textFieldStyle(.roundedBorder)
                TextField("Price, optional", text: $priceText)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.decimalPad)
                DatePicker("Starts", selection: $start, displayedComponents: .hourAndMinute)
                DatePicker("Ends", selection: $end, displayedComponents: .hourAndMinute)
                Toggle("Exclusive Pint Path special", isOn: $exclusive)
                PrimaryButton(title: "Save special", systemImage: "tag.fill", isLoading: model.isLoading) {
                    let special = BarSpecial(
                        id: nil,
                        title: title,
                        description: description,
                        price: Double(priceText),
                        discount: discount.nilIfBlank,
                        startsAt: nil,
                        endsAt: nil,
                        startTime: formatTime(start),
                        endTime: formatTime(end),
                        scheduleNote: nil,
                        exclusive: exclusive,
                        active: true
                    )
                    Task { await model.saveSpecial(special) }
                }
                .disabled(title.isEmpty || description.isEmpty)
            }
        }
        .beerMapCard()
    }
}

struct PortalReportsView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var month = previousCompletedMonth()
    let portal: VenuePortalData

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Reports",
                title: portal.tier?.monthlyReports == true ? "Monthly report" : "Reports locked",
                subtitle: portal.tier?.monthlyReports == true ? "Generated reports use privacy-safe aggregate data." : portal.tier?.upgradeCopy,
                systemImage: "doc.text.fill"
            )
            if portal.tier?.monthlyReports == true {
                MetricPill(title: "Privacy floor", value: portal.analytics?.privacyFloorMet == true ? "Met" : "Building", systemImage: "lock.shield.fill", tint: BeerMapTheme.leaf)
                TextField("Completed month (YYYY-MM)", text: $month)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                HStack {
                    reportAction(format: "csv", label: "CSV")
                    reportAction(format: "json", label: "JSON")
                }
                Text("Exports use privacy-safe aggregate data and are available only for completed months.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                EmptyStateView(title: "Upgrade to Pro", message: portal.tier?.upgradeCopy ?? "Pro unlocks analytics and monthly reports.", systemImage: "chart.bar.doc.horizontal")
            }
        }
        .beerMapCard()
    }

    @ViewBuilder
    private func reportAction(format: String, label: String) -> some View {
        if let url = model.venueReportExportURLs[format] {
            ShareLink(item: url) {
                Label("Share \(label)", systemImage: "square.and.arrow.up")
                    .font(.subheadline.weight(.bold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
        } else {
            Button {
                Task { await model.prepareVenueReportExport(month: month, format: format) }
            } label: {
                Label("Prepare \(label)", systemImage: "arrow.down.doc")
                    .font(.subheadline.weight(.bold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(!validReportMonth(month) || model.isLoading)
        }
    }
}

private func previousCompletedMonth() -> String {
    let calendar = Calendar(identifier: .gregorian)
    let previous = calendar.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM"
    return formatter.string(from: previous)
}

private func validReportMonth(_ value: String) -> Bool {
    value.range(of: #"^\d{4}-(0[1-9]|1[0-2])$"#, options: .regularExpression) != nil
}

private func formatTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
}
