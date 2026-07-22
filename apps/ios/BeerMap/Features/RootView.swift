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
            if model.hasVenueAccess || model.hasAdminAccess {
                Section("Workspaces") {
                    if model.hasVenueAccess {
                        NavigationLink {
                            VenuePortalView()
                        } label: {
                            moreRow(
                                title: "Manage venue",
                                message: "Prices, happy hours, specials, redemptions, and staff",
                                systemImage: "building.2.fill"
                            )
                        }
                    }

                    if model.hasAdminAccess {
                        NavigationLink {
                            AdminQuickAccessView()
                        } label: {
                            moreRow(
                                title: "Admin workspace",
                                message: "Review data and manage Pint Path",
                                systemImage: "lock.shield.fill"
                            )
                        }
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

private struct AdminQuickAccessView: View {
    @Environment(\.openURL) private var openURL

    private var adminSignInURL: URL {
        var components = URLComponents(
            url: AppConfig.apiBaseURL.appendingPathComponent("account.html"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "returnTo", value: "/admin.html")]
        return components.url!
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(
                        eyebrow: "Admin access",
                        title: "Open Pint Path admin",
                        subtitle: "Your current app account has server-verified admin authority. Administration remains in the full secure web workspace.",
                        systemImage: "lock.shield.fill"
                    )
                    StatusBanner(
                        message: "Only accounts confirmed as admins by the Pint Path server receive this tab.",
                        systemImage: "checkmark.shield.fill"
                    )
                    PrimaryButton(title: "Open admin workspace", systemImage: "safari.fill", isLoading: false) {
                        openURL(adminSignInURL)
                    }
                    Text("Your browser may ask you to sign in again before returning directly to the Admin workspace.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .beerMapCard()
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle("Admin")
    }
}
