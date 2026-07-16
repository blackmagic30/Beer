import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: BeerMapAppModel

    var body: some View {
        ZStack {
            TabView {
                NavigationStack {
                    DiscoverView()
                }
                .tabItem {
                    Label("Find", systemImage: "map.fill")
                }

                NavigationStack {
                    ContributeView()
                }
                .tabItem {
                    Label("Add", systemImage: "plus.circle.fill")
                }

                if model.hasVenueAccess {
                    NavigationStack {
                        VenuePortalView()
                    }
                    .tabItem {
                        Label("Bars", systemImage: "building.2.fill")
                    }
                }

                if model.hasAdminAccess {
                    NavigationStack {
                        AdminQuickAccessView()
                    }
                    .tabItem {
                        Label("Admin", systemImage: "lock.shield.fill")
                    }
                }

                NavigationStack {
                    AccountView()
                }
                .tabItem {
                    Label("Account", systemImage: "person.crop.circle")
                }

                NavigationStack {
                    SettingsView()
                }
                .tabItem {
                    Label("Help", systemImage: "questionmark.circle.fill")
                }
            }
            .task {
                await model.start()
            }

            if model.isLoading {
                VStack {
                    Spacer()
                    LoadingOverlay(message: "Updating Pint Path")
                        .padding(.bottom, 28)
                }
                .transition(.opacity)
            }
        }
        .alert("Pint Path", isPresented: Binding(
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
