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
                } else if model.isSignedIn {
                    signedInRecoveryView
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

    private var signedInRecoveryView: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                eyebrow: "Session retained",
                title: "Account details are temporarily unavailable",
                subtitle: "You are still signed in. Check your connection and retry; there is no need to sign in again.",
                systemImage: "person.crop.circle.badge.clock"
            )
            PrimaryButton(
                title: "Retry account details",
                systemImage: "arrow.clockwise",
                isLoading: model.isLoading
            ) {
                Task {
                    await model.refreshAccount()
                    await model.refreshVenuePortal()
                }
            }
            SecondaryButton(
                title: "Log out or switch account",
                systemImage: "rectangle.portrait.and.arrow.right",
                isDestructive: true
            ) {
                showLogoutConfirmation = true
            }
        }
        .beerMapCard()
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
            accountPassport(dashboard)

            privacyCard(dashboard.privacySettings)

            sessionCard

            deletionStatusCard

            if let submissions = dashboard.submissions, !submissions.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(eyebrow: "Recent", title: "Your submissions", subtitle: nil)
                    ForEach(Array(submissions.prefix(5).enumerated()), id: \.element.id) { index, item in
                        HStack(spacing: 12) {
                            Circle()
                                .fill(submissionTint(item.status))
                                .frame(width: 9, height: 9)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.venueName ?? "Venue update")
                                    .font(.subheadline.weight(.semibold))
                                Text([humanized(item.status), humanized(item.submissionType)].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let status = humanized(item.status) {
                                Text(status.uppercased())
                                    .font(.system(size: 8, weight: .black))
                                    .tracking(0.6)
                                    .foregroundStyle(submissionTint(item.status))
                            }
                        }
                        .padding(.vertical, 9)
                        if index < min(submissions.count, 5) - 1 {
                            Rectangle()
                                .fill(BeerMapTheme.hairline)
                                .frame(height: 1)
                                .padding(.leading, 21)
                        }
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

                SecondaryButton(title: "Log out", systemImage: "rectangle.portrait.and.arrow.right", isDestructive: true) {
                    showLogoutConfirmation = true
                }
            }
            .beerMapCard()
        }
    }

    private func accountPassport(_ dashboard: AccountDashboard) -> some View {
        let points = dashboard.account.contributionPointsCurrentMonth ?? 0
        let target = Double(max(model.config?.contributorUnlockPoints ?? 10, 1))
        let progress = min(max(points / target, 0), 1)

        return ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(BeerMapTheme.brandInk)
            PintPathRouteShape()
                .stroke(
                    BeerMapTheme.brandGold.opacity(0.32),
                    style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [2, 8])
                )
                .frame(width: 250, height: 150)
                .offset(x: 60, y: -28)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 15) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.hasContributorAccess ? "CONTRIBUTOR PASS" : "PINT PATH PASS")
                            .font(.system(size: 10, weight: .black))
                            .tracking(1.35)
                            .foregroundStyle(BeerMapTheme.brandGold)
                        Text(dashboard.account.displayName ?? dashboard.account.email)
                            .font(.system(.title2, design: .serif, weight: .bold))
                            .foregroundStyle(BeerMapTheme.paper)
                            .fixedSize(horizontal: false, vertical: true)
                        if dashboard.account.displayName != nil {
                            Text(dashboard.account.email)
                                .font(.caption)
                                .foregroundStyle(BeerMapTheme.paper.opacity(0.62))
                        }
                    }
                    Spacer(minLength: 10)
                    PintPathMark(size: 42)
                }

                HStack(spacing: 8) {
                    passportBadge(
                        dashboard.account.emailVerifiedAt == nil ? "Email pending" : "Email verified",
                        systemImage: "envelope.fill"
                    )
                    passportBadge(
                        dashboard.account.ageConfirmedAt == nil ? "18+ pending" : "18+ confirmed",
                        systemImage: "checkmark.seal.fill"
                    )
                }

                Rectangle()
                    .fill(BeerMapTheme.paper.opacity(0.13))
                    .frame(height: 1)

                HStack(alignment: .lastTextBaseline, spacing: 7) {
                    Text(numberString(points))
                        .font(.system(size: 39, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(BeerMapTheme.paper)
                    Text("POINTS THIS MONTH")
                        .font(.system(size: 9, weight: .black))
                        .tracking(0.9)
                        .foregroundStyle(BeerMapTheme.paper.opacity(0.62))
                    Spacer(minLength: 0)
                }

                ProgressView(value: progress)
                    .tint(BeerMapTheme.brandGold)
                    .background(BeerMapTheme.paper.opacity(0.16))
                    .clipShape(Capsule())
                    .accessibilityLabel("Contributor unlock progress")
                    .accessibilityValue("\(Int(progress * 100)) percent")

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
                    passportStat(
                        value: numberString(dashboard.stats?.trustScore ?? dashboard.account.trustScore),
                        title: "Trust"
                    )
                    passportStat(
                        value: "\(dashboard.stats?.totalSubmissions ?? dashboard.submissions?.count ?? 0)",
                        title: "Uploads"
                    )
                    passportStat(value: "\(dashboard.savedItems?.count ?? 0)", title: "Saved")
                }
            }
            .padding(20)
        }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: Color.black.opacity(0.17), radius: 18, x: 0, y: 9)
    }

    private func passportBadge(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(BeerMapTheme.paper.opacity(0.82))
            .padding(.horizontal, 9)
            .frame(minHeight: 28)
            .background(BeerMapTheme.paper.opacity(0.09), in: Capsule())
    }

    private func passportStat(value: String, title: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.headline.monospacedDigit().weight(.bold))
                .foregroundStyle(BeerMapTheme.paper)
            Text(title.uppercased())
                .font(.system(size: 8, weight: .bold))
                .tracking(0.65)
                .foregroundStyle(BeerMapTheme.paper.opacity(0.56))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(BeerMapTheme.paper.opacity(0.07), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    private func humanized(_ value: String?) -> String? {
        value?.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func submissionTint(_ status: String?) -> Color {
        switch status?.lowercased() {
        case "approved", "verified": return BeerMapTheme.leaf
        case "rejected", "failed": return BeerMapTheme.danger
        default: return BeerMapTheme.amber
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
                        emailUpdatesEnabled: emailUpdates,
                        expectedUpdatedAt: settings.consentedAt == nil ? nil : settings.updatedAt
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
