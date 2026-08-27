import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: BeerMapAppModel

    var body: some View {
        ZStack {
            TabView(selection: $model.selectedTab) {
                NavigationStack {
                    DiscoverView()
                }
                .tabItem {
                    Label("Explore", systemImage: "map")
                }
                .tag(AppTab.explore)

                NavigationStack {
                    ContributeView()
                }
                .tabItem {
                    Label {
                        Text("Contribute")
                    } icon: {
                        Image(BeerMapAsset.beerPint)
                    }
                }
                .tag(AppTab.addPrice)

                NavigationStack {
                    AccountView()
                }
                .tabItem {
                    Label("Account", systemImage: "person.crop.circle")
                }
                .tag(AppTab.account)

                NavigationStack {
                    MoreView()
                }
                .tabItem {
                    Label("More", systemImage: "line.3.horizontal")
                }
                .tag(AppTab.more)
            }
            .toolbarBackground(BeerMapTheme.brandInk, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .task {
                await model.start()
            }

            if model.isLoading && model.venues.isEmpty {
                VStack {
                    Spacer()
                    LoadingOverlay(message: "Updating Pint Path")
                        .padding(.bottom, 28)
                }
                .transition(.opacity)
            }
        }
        .alert(model.errorMessage == nil ? "Pint Path" : "Something went wrong", isPresented: Binding(
            get: { model.errorMessage != nil || model.notice != nil },
            set: { if !$0 { model.dismissMessages() } }
        )) {
            Button("OK", role: .cancel) {
                model.dismissMessages()
            }
        } message: {
            Text(model.errorMessage ?? model.notice ?? "")
        }
        .sheet(isPresented: Binding(
            get: { model.mfaStepUpRequired },
            set: { isPresented in
                if !isPresented && model.mfaStepUpRequired {
                    model.cancelPendingMFAStepUp()
                }
            }
        )) {
            MFAStepUpView()
                .environmentObject(model)
        }
    }
}

private struct MFAStepUpView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var factorId = ""
    @State private var code = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Open your authenticator app and enter its current six-digit code. Pint Path will create or upgrade the app session only after Supabase confirms AAL2 for this exact provider session.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if model.mfaFactors.count > 1 {
                    Section("Authenticator") {
                        Picker("Authenticator", selection: $factorId) {
                            ForEach(model.mfaFactors) { factor in
                                Text(factor.displayName).tag(factor.id)
                            }
                        }
                    }
                }
                Section("Verification code") {
                    SecureField("123456", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .onChange(of: code) { _, value in
                            code = String(value.filter(\.isNumber).prefix(6))
                        }
                        .accessibilityLabel("Six-digit authenticator code")
                }
            }
            .navigationTitle("Authenticator check")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) {
                        code = ""
                        model.cancelPendingMFAStepUp()
                    }
                    .disabled(model.isLoading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Verify") {
                        let submittedCode = code
                        code = ""
                        Task {
                            await model.completeMFAStepUp(
                                factorId: selectedFactorId,
                                code: submittedCode
                            )
                        }
                    }
                    .disabled(code.count != 6 || selectedFactorId.isEmpty || model.isLoading)
                }
            }
            .onAppear { selectAvailableFactor() }
            .onChange(of: model.mfaFactors) { _, _ in selectAvailableFactor() }
            .interactiveDismissDisabled(model.isLoading)
        }
    }

    private var selectedFactorId: String {
        if model.mfaFactors.contains(where: { $0.id == factorId }) {
            return factorId
        }
        return model.mfaFactors.first?.id ?? ""
    }

    private func selectAvailableFactor() {
        if !model.mfaFactors.contains(where: { $0.id == factorId }) {
            factorId = model.mfaFactors.first?.id ?? ""
        }
    }
}

private struct MoreView: View {
    @EnvironmentObject private var model: BeerMapAppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                PintPathHero(
                    eyebrow: "FIELD NOTES",
                    title: "The rest of the route",
                    subtitle: "Venue tools, support, privacy and the practical details behind Pint Path.",
                    systemImage: "signpost.right.and.left.fill"
                )

                if model.hasVenueAccess && !model.hasAdminAccess {
                    VStack(alignment: .leading, spacing: 11) {
                        SectionHeader(
                            eyebrow: "WORKSPACE",
                            title: "Your venue",
                            subtitle: "Keep your public listing and tap list current."
                        )
                        NavigationLink {
                            VenuePortalView()
                        } label: {
                            moreRow(
                                title: "Manage venue",
                                message: "Public profile and beer list",
                                systemImage: "building.2.fill"
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    .beerMapCard()
                }

                VStack(alignment: .leading, spacing: 11) {
                    SectionHeader(
                        eyebrow: "PINT PATH",
                        title: "Help & information",
                        subtitle: "Support, privacy, responsible use and legal details."
                    )
                    NavigationLink {
                        SettingsView()
                    } label: {
                        moreRow(
                            title: "Open help & legal",
                            message: "Support, service status, policies and security",
                            systemImage: "questionmark.circle.fill"
                        )
                    }
                    .buttonStyle(.plain)
                }
                .beerMapCard()

                HStack(spacing: 8) {
                    PintPathMark(size: 28)
                    Text("Made for better pub decisions around Melbourne.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle("More")
    }

    private func moreRow(title: String, message: String, systemImage: String) -> some View {
        HStack(spacing: 13) {
            ZStack {
                Circle()
                    .fill(BeerMapTheme.brandGold)
                Image(systemName: systemImage)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(BeerMapTheme.brandInk)
            }
            .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}
