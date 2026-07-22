import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var supportMessage = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
#if DEBUG
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(
                        eyebrow: "Configuration",
                        title: "Backend connection",
                        subtitle: "The native app reuses the existing Pint Path API and data.",
                        systemImage: "server.rack"
                    )
                    row("API base URL", AppConfig.apiBaseURL.absoluteString)
                    row("Supabase native OAuth", supabaseConfigurationStatus)
                    row("Field-test mode", model.config?.fieldTestMode == true ? "On" : "Off")
                }
                .beerMapCard()
#endif

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
                        subtitle: "Pint Path is 18+ only. Prices and availability can change, and venues may refuse service under RSA obligations.",
                        systemImage: "checkmark.shield.fill"
                    )
                    Label("Location is opt-in and one-time where used.", systemImage: "location.circle.fill")
                    Label("Venue reports use aggregate privacy-safe analytics.", systemImage: "chart.bar.xaxis")
                    Label("Private source evidence is handled by the backend.", systemImage: "photo.badge.checkmark")
                }
                .font(.subheadline)
                .beerMapCard()

                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(
                        eyebrow: "Legal & contact",
                        title: "Pint Path operator details",
                        subtitle: "Pint Path is operated by Isaac William De Worsop, sole trader · ABN 80 319 578 329.",
                        systemImage: "doc.text.fill"
                    )
                    Text("WOTSO, Level 3, 11–19 Bank Place, Melbourne VIC 3000, Australia")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Link("Email admin@pintpath.au", destination: URL(string: "mailto:admin@pintpath.au")!)
                    Link("Terms and Conditions", destination: AppConfig.apiBaseURL.appending(path: "terms.html"))
                    Link("Privacy Policy", destination: AppConfig.apiBaseURL.appending(path: "privacy.html"))
                    Link("Account export and deletion", destination: AppConfig.apiBaseURL.appending(path: "account.html"))
                    Text("Policy version \(model.config?.legalPolicyVersion ?? "unavailable")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
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

    private var supabaseConfigurationStatus: String {
        let url = model.config?.supabaseUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = model.config?.supabaseAnonKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        return !(url?.isEmpty ?? true) && !(key?.isEmpty ?? true)
            ? "Public config present"
            : "Not configured"
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
