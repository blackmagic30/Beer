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
                    Label("Discover", systemImage: "map.fill")
                }

                NavigationStack {
                    AccountView()
                }
                .tabItem {
                    Label("Account", systemImage: "person.crop.circle")
                }

                NavigationStack {
                    VenuePortalView()
                }
                .tabItem {
                    Label("Bars", systemImage: "building.2.fill")
                }

                NavigationStack {
                    SettingsView()
                }
                .tabItem {
                    Label("Settings", systemImage: "gearshape.fill")
                }
            }
            .task {
                await model.start()
            }

            if model.isLoading {
                VStack {
                    Spacer()
                    LoadingOverlay(message: "Updating BeerMap")
                        .padding(.bottom, 28)
                }
                .transition(.opacity)
            }
        }
        .alert("BeerMap", isPresented: Binding(
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

