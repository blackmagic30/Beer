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
                    Label("Explore", systemImage: "map.fill")
                }
                .tag(AppTab.explore)

                NavigationStack {
                    ContributeView()
                }
                .tabItem {
                    Label("Add Price", systemImage: "plus.circle.fill")
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
                    Label("More", systemImage: "ellipsis.circle.fill")
                }
                .tag(AppTab.more)
            }
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
        List {
            if model.hasVenueAccess && !model.hasAdminAccess {
                Section("Workspaces") {
                    NavigationLink {
                        VenuePortalView()
                    } label: {
                        moreRow(
                            title: "Manage venue",
                            message: "Public profile and beer list",
                            systemImage: "building.2.fill"
                        )
                    }
                }
            }

            Section("Help and information") {
                NavigationLink {
                    SettingsView()
                } label: {
                    moreRow(
                        title: "Help, privacy, and legal",
                        message: "Support, service status, policies, and security",
                        systemImage: "questionmark.circle.fill"
                    )
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("More")
    }

    private func moreRow(title: String, message: String, systemImage: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 4)
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(BeerMapTheme.primaryAction)
        }
    }
}
