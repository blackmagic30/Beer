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
            "Request account deletion review?",
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Request deletion review", role: .destructive) {
                Task { await model.requestAccountDeletion() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Pint Path will create the same manual deletion review used by the website. Legal, security, billing, and moderation records may be retained when required.")
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
                subtitle: "Pint Path did not \(context). A fresh provider sign-in is required before you retry.",
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

            if let invitations = dashboard.counterStaffInvitations, !invitations.isEmpty {
                counterStaffInvitationsCard(invitations)
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
                    message: "Your reviewed price updates and venue reports will appear here after you contribute.",
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
                    SecondaryButton(title: "Request account deletion", systemImage: "person.crop.circle.badge.xmark", isDestructive: true) {
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

    private func counterStaffInvitationsCard(_ invitations: [CounterStaffInvitation]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                eyebrow: "Venue access",
                title: "Counter invitations",
                subtitle: "Accept only invitations from venues you recognise. Counter access cannot edit venue data or view private analytics.",
                systemImage: "person.badge.key.fill"
            )
            ForEach(invitations) { invitation in
                VStack(alignment: .leading, spacing: 8) {
                    Text(invitation.venueName)
                        .font(.headline)
                    Text([invitation.suburb, invitation.expiresAt.map { "Expires \($0)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack {
                        PrimaryButton(title: "Accept", systemImage: "checkmark.circle.fill", isLoading: model.isLoading) {
                            Task { await model.respondToCounterStaffInvitation(invitation, decision: "accept") }
                        }
                        SecondaryButton(title: "Decline", systemImage: "xmark.circle", isDestructive: true) {
                            Task { await model.respondToCounterStaffInvitation(invitation, decision: "decline") }
                        }
                    }
                }
                .padding(10)
                .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .beerMapCard()
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
                        message: "Your request ID is \(request.id). Pint Path keeps this status visible so you know whether review or processing has started.",
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
        case "pending_review": return "Pending review"
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
