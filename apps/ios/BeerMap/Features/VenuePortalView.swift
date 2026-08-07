import SwiftUI

struct VenuePortalView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var selectedVenueId = ""
    @State private var selectedSection: PortalSection = .dashboard

    enum PortalSection: String, CaseIterable, Identifiable {
        case dashboard = "Dashboard"
        case profile = "Profile"
        case beers = "Beers"

        var id: String { rawValue }

        var systemImage: String {
            switch self {
            case .dashboard: return "chart.bar.fill"
            case .profile: return "building.2.fill"
            case .beers: return "list.bullet"
            }
        }

        var usesBeerPintIcon: Bool { self == .beers }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if !model.isSignedIn {
                    EmptyStateView(
                        title: "Venue access is verified",
                        message: "Sign in with an approved venue-manager account. Contact Pint Path support if this venue is not assigned yet.",
                        systemImage: "building.2.crop.circle"
                    )
                } else if let portal = model.venuePortal {
                    if portal.accessState == "claim_required" {
                        claimAccessView()
                    } else {
                        portalView(portal)
                    }
                } else {
                    EmptyStateView(
                        title: "No venue dashboard yet",
                        message: "Pull to refresh, or contact Pint Path support to request verified venue access.",
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

    private func claimAccessView() -> some View {
        VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    eyebrow: "Verified access",
                    title: "Connect your venue",
                    subtitle: "Venue access is manually verified before management tools are enabled.",
                systemImage: "person.2.badge.key.fill"
            )
            StatusBanner(
                message: "Venue access requests are handled by Pint Path support outside this consumer iOS release.",
                systemImage: "checkmark.shield.fill"
            )
        }
        .beerMapCard()
    }

    private func portalView(_ portal: VenuePortalData) -> some View {
        let sections = PortalSection.allCases
        let activeSection = sections.contains(selectedSection) ? selectedSection : sections[0]
        return VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    eyebrow: "Venue tools",
                    title: portal.selectedVenue?.venueName ?? "Venue dashboard",
                    subtitle: "Manage the public profile and beer list for this venue.",
                    systemImage: "building.2.fill"
                )

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
                    ForEach(sections) { section in
                        Button {
                            selectedSection = section
                        } label: {
                            HStack(spacing: 6) {
                                if section.usesBeerPintIcon {
                                    BeerPintIcon(size: 16)
                                } else {
                                    Image(systemName: section.systemImage)
                                        .accessibilityHidden(true)
                                }
                                Text(section.rawValue)
                            }
                                .font(.caption.weight(.bold))
                                .lineLimit(1)
                                .padding(.horizontal, 12)
                                .frame(height: 42)
                                .background(
                                    activeSection == section ? BeerMapTheme.ink : BeerMapTheme.card,
                                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                                )
                                .foregroundStyle(activeSection == section ? Color.white : Color.primary)
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

            switch activeSection {
            case .dashboard:
                PortalDashboard(portal: portal)
            case .profile:
                if let profile = portal.profile {
                    ProfileEditor(profile: profile)
                        .id("profile-\(portal.selectedVenue?.venueId ?? "none")")
                }
            case .beers:
                BeerInventoryView(beers: portal.inventory?.beers ?? [])
                    .id("beers-\(portal.selectedVenue?.venueId ?? "none")")
            }
        }
        .onChange(of: portal.selectedVenue?.venueId, initial: true) { _, venueId in
            selectedVenueId = venueId ?? ""
        }
    }

}

struct PortalDashboard: View {
    let portal: VenuePortalData

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            MetricPill(title: "Beers", value: "\(portal.inventory?.beers?.count ?? 0)", assetImage: BeerMapAsset.beerPint, tint: BeerMapTheme.amber)
            MetricPill(title: "Pending", value: "\(portal.pendingChanges?.count ?? 0)", systemImage: "tray.full.fill", tint: BeerMapTheme.sky)
        }
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
            SectionHeader(eyebrow: "Profile", title: "Bar profile", subtitle: "Keep public venue details accurate for the map.", systemImage: "building.2.fill")
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
            SectionHeader(
                eyebrow: "Stock",
                title: "Beers and prices",
                subtitle: "Venue updates stay server-reviewed where required.",
                systemImage: nil,
                assetImage: BeerMapAsset.beerPint
            )
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
