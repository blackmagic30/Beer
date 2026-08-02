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
