import SwiftUI

struct AccountView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var showDeleteConfirmation = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if model.isSignedIn, let dashboard = model.accountDashboard {
                    signedInView(dashboard)
                } else {
                    AuthView()
                }
            }
            .padding()
        }
        .background(BeerMapTheme.background)
        .navigationTitle("Account")
        .refreshable {
            await model.refreshAccount()
        }
        .confirmationDialog(
            "Request account deletion review?",
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Request deletion review", role: .destructive) {
                Task { await model.requestAccountDeletion() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("BeerMap will create the same manual deletion review used by the website. Legal, security, billing, and moderation records may be retained when required.")
        }
    }

    private func signedInView(_ dashboard: AccountDashboard) -> some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    eyebrow: dashboard.account.subscriptionStatus ?? "Free",
                    title: dashboard.account.displayName ?? dashboard.account.email,
                    subtitle: "Manage access, contribution progress, privacy, and session controls."
                )
                HStack {
                    Label(dashboard.account.emailVerifiedAt == nil ? "Email pending" : "Email verified", systemImage: "envelope.badge.shield.half.filled")
                    Spacer()
                    Label(dashboard.account.ageConfirmedAt == nil ? "18+ pending" : "18+ confirmed", systemImage: "checkmark.seal.fill")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            }
            .beerMapCard()

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                MetricPill(
                    title: "Monthly points",
                    value: numberString(dashboard.account.contributionPointsCurrentMonth),
                    systemImage: "sparkles",
                    tint: BeerMapTheme.amber
                )
                MetricPill(
                    title: "Trust score",
                    value: numberString(dashboard.stats?.trustScore ?? dashboard.account.trustScore),
                    systemImage: "shield.lefthalf.filled",
                    tint: BeerMapTheme.leaf
                )
                MetricPill(
                    title: "Uploads",
                    value: "\(dashboard.stats?.totalSubmissions ?? dashboard.submissions?.count ?? 0)",
                    systemImage: "square.and.arrow.up.fill",
                    tint: BeerMapTheme.sky
                )
                MetricPill(
                    title: "Saved",
                    value: "\(dashboard.savedItems?.count ?? 0)",
                    systemImage: "bookmark.fill",
                    tint: BeerMapTheme.plum
                )
            }

            privacyCard(dashboard.privacySettings)

            if let submissions = dashboard.submissions, !submissions.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(eyebrow: "Recent", title: "Your submissions", subtitle: nil)
                    ForEach(submissions.prefix(5)) { item in
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.venueName ?? "Venue update")
                                    .font(.subheadline.weight(.bold))
                                Text([item.status, item.submissionType].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .padding(10)
                        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
                .beerMapCard()
            }

            VStack(spacing: 10) {
                Button {
                    Task { await model.refreshAccount() }
                } label: {
                    Label("Refresh account", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button(role: .destructive) {
                    showDeleteConfirmation = true
                } label: {
                    Label("Request account deletion", systemImage: "person.crop.circle.badge.xmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await model.logout() }
                } label: {
                    Label("Log out", systemImage: "rectangle.portrait.and.arrow.right")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .beerMapCard()
        }
    }

    private func privacyCard(_ settings: PrivacySettings?) -> some View {
        PrivacySettingsCard(
            settings: settings ?? PrivacySettings(
                optionalAnalyticsEnabled: true,
                venueReportInclusionEnabled: true,
                productResearchEnabled: true,
                emailUpdatesEnabled: false
            )
        )
    }

    private func numberString(_ value: Double?) -> String {
        guard let value else { return "0" }
        if value.rounded() == value {
            return "\(Int(value))"
        }
        return String(format: "%.1f", value)
    }
}

struct PrivacySettingsCard: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var optionalAnalytics: Bool
    @State private var venueReports: Bool
    @State private var productResearch: Bool
    @State private var emailUpdates: Bool

    init(settings: PrivacySettings) {
        _optionalAnalytics = State(initialValue: settings.optionalAnalyticsEnabled ?? true)
        _venueReports = State(initialValue: settings.venueReportInclusionEnabled ?? true)
        _productResearch = State(initialValue: settings.productResearchEnabled ?? true)
        _emailUpdates = State(initialValue: settings.emailUpdatesEnabled ?? false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Privacy",
                title: "Data controls",
                subtitle: "Optional analytics and venue insight inclusion match the website account controls."
            )

            Toggle("Optional analytics", isOn: $optionalAnalytics)
            Toggle("Include my activity in aggregate venue reports", isOn: $venueReports)
            Toggle("Product research contact", isOn: $productResearch)
            Toggle("Email product updates", isOn: $emailUpdates)

            PrimaryButton(title: "Save privacy settings", systemImage: "lock.shield.fill", isLoading: model.isLoading) {
                Task {
                    await model.savePrivacy(settings: PrivacySettingsRequest(
                        optionalAnalyticsEnabled: optionalAnalytics,
                        venueReportInclusionEnabled: venueReports,
                        productResearchEnabled: productResearch,
                        emailUpdatesEnabled: emailUpdates
                    ))
                }
            }
        }
        .beerMapCard()
    }
}

