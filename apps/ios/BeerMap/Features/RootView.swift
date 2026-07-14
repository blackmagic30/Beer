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
