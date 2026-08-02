import SwiftUI

struct AccountView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var showDeleteConfirmation = false
    @State private var showLogoutConfirmation = false
    @State private var showLogoutAllConfirmation = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let context = model.reauthenticationContext {
                    reauthenticationCard(context)
                }
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
        .task {
            await model.refreshAccountIfNeeded()
        }
        .refreshable {
            await model.refreshAccount()
            await model.refreshVenuePortal()
        }
        .confirmationDialog(
            "Log out of Pint Path?",
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
            "Schedule account deletion?",
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Schedule deletion", role: .destructive) {
                Task { await model.requestAccountDeletion() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Pint Path schedules deletion after a seven-day cancellation window. An authorised operator currently completes provider deletion, and the app keeps the status visible. Records that must be retained by law may be kept.")
        }
        .confirmationDialog(
            "Sign out on every device?",
            isPresented: $showLogoutAllConfirmation,
            titleVisibility: .visible
        ) {
            Button("Sign out all devices", role: .destructive) {
                Task { await model.logoutAllSessions() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This revokes every active Pint Path session, including this device. You will need to sign in again everywhere.")
        }
    }

    private func reauthenticationCard(_ context: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                eyebrow: "Security check",
                title: "Sign in again to continue",
                subtitle: "Pint Path did not \(context). A fresh sign-in is required before you retry.",
                systemImage: "lock.shield.fill"
            )
            if model.isSignedIn {
                PrimaryButton(title: "Sign out and sign in again", systemImage: "person.badge.key.fill", isLoading: model.isLoading) {
                    Task { await model.signOutForReauthentication() }
                }
            } else {
                Text("Use the sign-in form below, then retry the action. It will not run automatically.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .beerMapCard()
    }

    private func signedInView(_ dashboard: AccountDashboard) -> some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    eyebrow: model.hasContributorAccess ? "Contributor access" : "Account",
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

            privacyCard(dashboard.privacySettings)

            sessionCard

            deletionStatusCard

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
                    message: "Your reviewed price and venue updates will appear here after you contribute.",
                    systemImage: "tray",
                    isFramed: false
                )
                .beerMapCard()
            }

            VStack(spacing: 10) {
                if let exportURL = model.accountExportURL {
                    ShareLink(item: exportURL) {
                        Label("Share account export", systemImage: "square.and.arrow.up")
                            .font(.headline.weight(.bold))
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 50)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityHint("Opens the system share sheet for your JSON account export")
                } else {
                    SecondaryButton(title: "Prepare account export", systemImage: "arrow.down.doc") {
                        Task { await model.prepareAccountExport() }
                    }
                }

                SecondaryButton(title: "Refresh account", systemImage: "arrow.clockwise") {
                    Task {
                        await model.refreshAccount()
                        await model.refreshVenuePortal()
                    }
                }

                if model.accountDeletionRequest == nil || model.accountDeletionRequest?.status == "cancelled" {
                    SecondaryButton(title: "Schedule account deletion", systemImage: "person.crop.circle.badge.xmark", isDestructive: true) {
                        showDeleteConfirmation = true
                    }
                }

                PrimaryButton(title: "Log out", systemImage: "rectangle.portrait.and.arrow.right", isLoading: model.isLoading) {
                    showLogoutConfirmation = true
                }
            }
            .beerMapCard()
        }
    }

    @ViewBuilder
    private var deletionStatusCard: some View {
        if let request = model.accountDeletionRequest, request.status != "cancelled" {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(
                    eyebrow: "Account deletion",
                    title: deletionStatusLabel(request.status),
                    subtitle: request.executeAfter.map { "Earliest processing date: \($0)" },
                    systemImage: "person.crop.circle.badge.clock"
                )
                if let error = request.lastError, !error.isEmpty {
                    StatusBanner(message: error, isError: true)
                } else {
                    StatusBanner(
                        message: "Your request ID is \(request.id). Pint Path keeps this status visible so you know whether the cancellation window or deletion processing has started.",
                        systemImage: "clock.badge.checkmark.fill"
                    )
                }
                if ["pending_review", "approved", "failed"].contains(request.status) {
                    SecondaryButton(title: "Cancel deletion request", systemImage: "arrow.uturn.backward", isDestructive: true) {
                        Task { await model.cancelAccountDeletion() }
                    }
                }
            }
            .beerMapCard()
        }
    }

    private func deletionStatusLabel(_ status: String) -> String {
        switch status {
        case "pending_review": return "Scheduled — cancellation window"
        case "approved": return "Approved for processing"
        case "processing": return "Processing"
        case "completed": return "Completed"
        case "failed": return "Needs attention"
        case "cancelled": return "Cancelled"
        default: return status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private func privacyCard(_ settings: PrivacySettings?) -> some View {
        PrivacySettingsCard(
            settings: settings ?? PrivacySettings(
                optionalAnalyticsEnabled: false,
                venueReportInclusionEnabled: false,
                productResearchEnabled: false,
                emailUpdatesEnabled: false
            )
        )
    }

    private var sessionCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                eyebrow: "Security",
                title: "Signed-in sessions",
                subtitle: "Review and revoke devices you no longer use.",
                systemImage: "key.horizontal.fill"
            )
            if !model.accountSessionsLoaded {
                Text("Session details are protected. Load them only when you want to review device access.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Review signed-in sessions") {
                    Task { await model.loadAccountSessions() }
                }
                .buttonStyle(.bordered)
            } else if model.accountSessions.isEmpty {
                Text("No active session details are available yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.accountSessions) { session in
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.current == true ? "This device" : "Signed-in device")
                                .font(.subheadline.weight(.bold))
                            Text(session.lastUsedAt.map { "Last used \($0)" } ?? session.createdAt.map { "Created \($0)" } ?? "Session details unavailable")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if session.active == false {
                                Text("Revoked or expired")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if session.active != false {
                            Button(session.current == true ? "Sign out" : "Revoke", role: .destructive) {
                                Task { await model.revokeAccountSession(session) }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(10)
                    .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            if model.accountSessionsLoaded {
                Button("Refresh session list") {
                    Task { await model.loadAccountSessions() }
                }
                .buttonStyle(.bordered)
            }
            Button("Sign out all devices", role: .destructive) {
                showLogoutAllConfirmation = true
            }
            .buttonStyle(.bordered)
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

}

struct PrivacySettingsCard: View {
    @EnvironmentObject private var model: BeerMapAppModel
    let settings: PrivacySettings
    @State private var optionalAnalytics: Bool
    @State private var venueReports: Bool
    @State private var productResearch: Bool
    @State private var emailUpdates: Bool

    init(settings: PrivacySettings) {
        self.settings = settings
        _optionalAnalytics = State(initialValue: settings.optionalAnalyticsEnabled ?? false)
        _venueReports = State(initialValue: settings.venueReportInclusionEnabled ?? false)
        _productResearch = State(initialValue: settings.productResearchEnabled ?? false)
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
        .onChange(of: settings) { _, next in
            optionalAnalytics = next.optionalAnalyticsEnabled ?? false
            venueReports = next.venueReportInclusionEnabled ?? false
            productResearch = next.productResearchEnabled ?? false
            emailUpdates = next.emailUpdatesEnabled ?? false
        }
    }
}
