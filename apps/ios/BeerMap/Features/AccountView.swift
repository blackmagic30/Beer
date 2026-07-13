import SwiftUI

struct AccountView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var showDeleteConfirmation = false
    @State private var showLogoutConfirmation = false

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
        .beerMapScreen()
        .navigationTitle("Account")
        .refreshable {
            await model.refreshAccount()
        }
        .confirmationDialog(
            "Log out of BeerMap?",
            isPresented: $showLogoutConfirmation,
            titleVisibility: .visible
        ) {
            Button("Log out", role: .destructive) {
                Task { await model.logout() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your saved session will be removed from this device. You can sign back in any time.")
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
                    subtitle: "Manage access, contribution progress, privacy, and session controls.",
                    systemImage: "person.crop.circle.fill"
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

            specialsCard(dashboard)

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
            } else {
                EmptyStateView(
                    title: "No recent submissions",
                    message: "Your reviewed price updates and venue reports will appear here after you contribute.",
                    systemImage: "tray",
                    isFramed: false
                )
                .beerMapCard()
            }

            VStack(spacing: 10) {
                SecondaryButton(title: "Refresh account", systemImage: "arrow.clockwise") {
                    Task { await model.refreshAccount() }
                }

                SecondaryButton(title: "Request account deletion", systemImage: "person.crop.circle.badge.xmark", isDestructive: true) {
                    showDeleteConfirmation = true
                }

                PrimaryButton(title: "Log out", systemImage: "rectangle.portrait.and.arrow.right", isLoading: model.isLoading) {
                    showLogoutConfirmation = true
                }
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

    private func specialsCard(_ dashboard: AccountDashboard) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(
                eyebrow: "Member specials",
                title: "Codes and Pint Points",
                subtitle: "Generate a short-lived code only when venue staff are ready to redeem it.",
                systemImage: "qrcode.viewfinder"
            )

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                MetricPill(
                    title: "Estimated saved",
                    value: moneyString(cents: dashboard.discounts?.estimatedSavingsCents),
                    systemImage: "dollarsign.circle.fill",
                    tint: BeerMapTheme.leaf
                )
                MetricPill(
                    title: "Pint Points",
                    value: "\(dashboard.pintPoints?.available ?? 0)/\(dashboard.pintPoints?.threshold ?? 50)",
                    systemImage: "sparkles",
                    tint: BeerMapTheme.amber
                )
            }

            if let pass = model.discountPass {
                RotatingCodeCard(title: "Pint Path special", result: pass)
            }

            if let reward = model.freePintReward {
                RotatingCodeCard(title: "Free Pint Reward", result: reward)
            }

            HStack(spacing: 10) {
                SecondaryButton(title: dashboard.discounts?.eligible == true ? "Generate special" : "Special locked", systemImage: "qrcode") {
                    Task { await model.generateDiscountPass() }
                }
                .disabled(dashboard.discounts?.eligible != true)

                PrimaryButton(
                    title: dashboard.pintPoints?.rewardAvailable == true ? "Free Pint" : "Reward locked",
                    systemImage: "gift.fill",
                    isLoading: model.isLoading
                ) {
                    Task { await model.generateFreePintReward() }
                }
                .disabled(dashboard.pintPoints?.rewardAvailable != true)
            }
        }
        .beerMapCard()
    }

    private func numberString(_ value: Double?) -> String {
        guard let value else { return "0" }
        if value.rounded() == value {
            return "\(Int(value))"
        }
        return String(format: "%.1f", value)
    }

    private func moneyString(cents: Int?) -> String {
        guard let cents else { return "$0" }
        return "$\(String(format: "%.2f", Double(cents) / 100.0))"
    }
}

private struct RotatingCodeCard: View {
    let title: String
    let result: RotatingCodeResult

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.black))
                .foregroundStyle(BeerMapTheme.amber)
            Text(result.code)
                .font(.system(.largeTitle, design: .rounded).weight(.black))
                .tracking(4)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 10)
                .background(BeerMapTheme.ink, in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(Color.white)
                .accessibilityLabel("\(title) code \(result.code)")
            if let copy = result.copy {
                Text(copy)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let expiresAt = result.expiresAt {
                Label("Expires \(expiresAt)", systemImage: "clock.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
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
                subtitle: "Optional analytics and venue insight inclusion match the website account controls.",
                systemImage: "lock.shield.fill"
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
