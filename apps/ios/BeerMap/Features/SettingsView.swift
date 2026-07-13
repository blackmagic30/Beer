import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var supportMessage = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(
                        eyebrow: "Configuration",
                        title: "Backend connection",
                        subtitle: "The native app reuses the existing BeerMap/Pint Path API and data.",
                        systemImage: "server.rack"
                    )
                    row("API base URL", AppConfig.apiBaseURL.absoluteString)
                    row("Supabase native OAuth", AppConfig.supabaseURL == nil ? "Not configured" : "Public config present")
                    row("Field-test mode", model.config?.fieldTestMode == true ? "On" : "Off")
                }
                .beerMapCard()

                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(
                        eyebrow: "Support",
                        title: "Need help?",
                        subtitle: "Use this for privacy, billing, abuse, moderation, or venue account support.",
                        systemImage: "lifepreserver.fill"
                    )
                    TextField("Message", text: $supportMessage, axis: .vertical)
                        .lineLimit(4...8)
                        .textFieldStyle(.roundedBorder)
                    PrimaryButton(title: "Send support note", systemImage: "paperplane.fill", isLoading: model.isLoading) {
                        Task { await sendSupport() }
                    }
                    .disabled(supportMessage.trimmingCharacters(in: .whitespacesAndNewlines).count < 3)
                }
                .beerMapCard()

                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(
                        eyebrow: "Safety",
                        title: "Responsible use",
                        subtitle: "BeerMap is 18+ only. Prices and availability can change, and venues may refuse service under RSA obligations.",
                        systemImage: "checkmark.shield.fill"
                    )
                    Label("Location is opt-in and one-time where used.", systemImage: "location.circle.fill")
                    Label("Venue reports use aggregate privacy-safe analytics.", systemImage: "chart.bar.xaxis")
                    Label("Private source evidence is handled by the backend.", systemImage: "photo.badge.checkmark")
                }
                .font(.subheadline)
                .beerMapCard()
            }
            .padding()
        }
        .beerMapScreen()
        .navigationTitle("Help")
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            Spacer()
            Text(value)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }

    private func sendSupport() async {
        do {
            let _: EmptyResponse = try await model.api.send(
                "/api/business/feedback",
                method: "POST",
                body: FeedbackRequest(
                    anonymousSessionId: model.anonymousSessionId,
                    feedbackType: "general_feedback",
                    message: supportMessage,
                    venueId: nil,
                    venueName: nil
                ),
                token: model.sessionToken
            )
            supportMessage = ""
            model.notice = "Support note sent."
        } catch {
            model.errorMessage = error.localizedDescription
        }
    }
}
