import AuthenticationServices
import CryptoKit
import Security
import SwiftUI
import UIKit

struct AuthView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @Environment(\.openURL) private var openURL
    @StateObject private var oauth = NativeOAuthCoordinator()
    @State private var mode: AuthMode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var displayName = ""
    @State private var ageConfirmed = false
    @State private var termsAccepted = false
    @State private var privacyAccepted = false
    @State private var billingRecoveryVenueId = ""

    enum AuthMode: String, CaseIterable, Identifiable {
        case login = "Sign in"
        case signup = "Create account"

        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 16) {
            SectionHeader(
                eyebrow: "Pint Path account",
                title: model.legalAcceptanceRequired
                    ? "Review the current policies"
                    : (mode == .login ? "Welcome back" : "Create your contributor account"),
                subtitle: model.legalAcceptanceRequired
                    ? "Your provider identity is verified. Accept the current version before Pint Path creates an app session."
                    : "Use the same account, access rules, and venue assignments as the website.",
                systemImage: model.legalAcceptanceRequired
                    ? "checkmark.shield.fill"
                    : (mode == .login ? "person.crop.circle.fill" : "person.badge.plus.fill")
            )

            if model.legalAcceptanceRequired {
                VStack(spacing: 12) {
                    StatusBanner(
                        message: "Policy version \(model.legalAcceptanceVersion ?? "current") is required for this verified account. Your sign-in credential is held only in memory until you decide.",
                        systemImage: "checkmark.shield.fill"
                    )
                    Toggle("I confirm I am 18 or older", isOn: $ageConfirmed)
                    Link("Read the Terms", destination: AppConfig.apiBaseURL.appending(path: "terms.html"))
                    Toggle("I accept the current Terms", isOn: $termsAccepted)
                    Link("Read the Privacy Policy", destination: AppConfig.apiBaseURL.appending(path: "privacy.html"))
                    Toggle("I accept the current Privacy Policy", isOn: $privacyAccepted)
                    PrimaryButton(
                        title: "Accept and continue",
                        systemImage: "checkmark.shield.fill",
                        isLoading: model.isLoading
                    ) {
                        Task {
                            await model.acceptCurrentPolicies(
                                ageConfirmed: ageConfirmed,
                                termsAccepted: termsAccepted,
                                privacyAccepted: privacyAccepted
                            )
                            if !model.legalAcceptanceRequired {
                                ageConfirmed = false
                                termsAccepted = false
                                privacyAccepted = false
                            }
                        }
                    }
                    .disabled(!ageConfirmed || !termsAccepted || !privacyAccepted)
                    SecondaryButton(
                        title: "Cancel sign-in",
                        systemImage: "xmark.circle",
                        isDestructive: true
                    ) {
                        ageConfirmed = false
                        termsAccepted = false
                        privacyAccepted = false
                        model.cancelPendingLegalAcceptance()
                    }
                    .disabled(model.isLoading)
                }
                .beerMapCard()
            } else {

            Picker("Mode", selection: $mode) {
                ForEach(AuthMode.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.segmented)

            VStack(spacing: 12) {
                FormFieldShell(label: "Email address", systemImage: "envelope.fill") {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .readableForm()
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Email address")
                }

                FormFieldShell(label: "Password", systemImage: "lock.fill") {
                    SecureField("Password", text: $password)
                        .textContentType(mode == .login ? .password : .newPassword)
                        .keyboardType(.asciiCapable)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .readableForm()
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Password")
                }

                if mode == .signup {
                    FormFieldShell(label: "Confirm password", systemImage: "lock.fill") {
                        SecureField("Confirm password", text: $confirmPassword)
                            .textContentType(.newPassword)
                            .keyboardType(.asciiCapable)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .readableForm()
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Confirm password")
                    }

                    FormFieldShell(label: "Profile", systemImage: "person.text.rectangle.fill") {
                        TextField("Display name, optional", text: $displayName)
                            .textContentType(.nickname)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Display name")
                    }
                    Toggle("I confirm I am 18 or older", isOn: $ageConfirmed)

                    VStack(spacing: 10) {
                        Link("Read the Terms", destination: AppConfig.apiBaseURL.appending(path: "terms.html"))
                        Toggle("I accept the current Terms", isOn: $termsAccepted)
                        Link("Read the Privacy Policy", destination: AppConfig.apiBaseURL.appending(path: "privacy.html"))
                        Toggle("I accept the current Privacy Policy", isOn: $privacyAccepted)
                    }
                    .padding(12)
                    .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }

                StatusBanner(
                    message: "Pint Path uses verified Supabase authentication and the same safety, privacy, and account rules as the website.",
                    systemImage: "checkmark.shield.fill"
                )
            }
            .beerMapCard()

            PrimaryButton(
                title: mode == .login ? "Sign in" : "Create account",
                systemImage: mode == .login ? "arrow.right.circle.fill" : "person.badge.plus.fill",
                isLoading: model.isLoading
            ) {
                Task {
                    if mode == .login {
                        let submittedPassword = password
                        password = ""
                        confirmPassword = ""
                        await model.login(email: email, password: submittedPassword)
                    } else if ageConfirmed && termsAccepted && privacyAccepted {
                        let submittedPassword = password
                        let submittedConfirmation = confirmPassword
                        password = ""
                        confirmPassword = ""
                        guard submittedPassword == submittedConfirmation else {
                            model.errorMessage = "The password and confirmation do not match. Re-enter both fields."
                            return
                        }
                        await model.signup(
                            email: email,
                            password: submittedPassword,
                            displayName: displayName,
                            ageConfirmed: ageConfirmed,
                            termsAccepted: termsAccepted,
                            privacyAccepted: privacyAccepted
                        )
                    } else {
                        model.errorMessage = "Confirm 18+ and accept the Terms and Privacy Policy before creating an account."
                    }
                }
            }
            .disabled(
                email.isEmpty || password.isEmpty ||
                (mode == .signup && (
                    confirmPassword.isEmpty || !ageConfirmed || !termsAccepted || !privacyAccepted
                ))
            )

            if let guidance = model.billingRecoveryGuidance {
                let venues = model.billingRecoveryVenues
                let requiresVenueSelection = !model.billingRecoveryConsumer && venues.count > 1
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(
                        eyebrow: "Billing only",
                        title: "Manage a suspended subscription",
                        subtitle: guidance,
                        systemImage: "creditcard.and.123"
                    )
                    Text(
                        model.billingRecoveryUsesProvider
                            ? "Your verified provider token can open billing. Pint Path will not create an app session or restore suspended access."
                            : "Re-enter the suspended account email and password above. They are sent only to the billing-recovery endpoint."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    if model.billingRecoveryConsumer || venues.count > 1 {
                        Picker("Billing profile", selection: $billingRecoveryVenueId) {
                            if model.billingRecoveryConsumer {
                                Text("Personal subscription").tag("")
                            } else {
                                Text("Choose a managed venue").tag("")
                            }
                            ForEach(venues) { venue in
                                Text(venue.venueName).tag(venue.venueId)
                            }
                        }
                        .pickerStyle(.menu)
                    } else if let venue = venues.first {
                        Label("Venue billing: \(venue.venueName)", systemImage: "building.2.fill")
                            .font(.subheadline.weight(.semibold))
                    }
                    PrimaryButton(
                        title: "Manage billing only",
                        systemImage: "arrow.up.right.square.fill",
                        isLoading: model.isLoading
                    ) {
                        Task {
                            let selectedVenueId = billingRecoveryVenueId.isEmpty
                                ? (!model.billingRecoveryConsumer ? venues.first?.venueId : nil)
                                : billingRecoveryVenueId
                            if let portalURL = await model.openBillingRecovery(
                                email: email,
                                password: password,
                                venueId: selectedVenueId
                            ) {
                                password = ""
                                openURL(portalURL)
                            }
                        }
                    }
                    .disabled(
                        (!model.billingRecoveryUsesProvider && (email.isEmpty || password.isEmpty)) ||
                        (requiresVenueSelection && billingRecoveryVenueId.isEmpty)
                    )
                }
                .beerMapCard()
            }

            Button("Forgot password?") {
                guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    model.errorMessage = "Enter your email address first."
                    return
                }
                Task { await model.requestPasswordReset(email: email) }
            }
            .buttonStyle(.plain)
            .font(.subheadline.weight(.semibold))

            if let providers = model.config?.supabaseOauthProviders, !providers.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Or continue securely", systemImage: "link.badge.plus")
                        .font(.subheadline.weight(.semibold))
                    ForEach(providers.filter { ["google", "apple"].contains($0.lowercased()) }, id: \.self) { provider in
                        Button {
                            password = ""
                            confirmPassword = ""
                            Task {
                                do {
                                    guard let config = model.config else {
                                        throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.")
                                    }
                                    let tokens = try await oauth.signIn(provider: provider.lowercased(), config: config)
                                    guard let accessToken = tokens.accessToken else { throw BeerMapAPIError.missingData }
                                    await model.completeOAuthSignIn(
                                        accessToken: accessToken,
                                        refreshToken: tokens.refreshToken
                                    )
                                } catch {
                                    let nsError = error as NSError
                                    let cancelled = nsError.domain == ASWebAuthenticationSessionErrorDomain
                                        && nsError.code == ASWebAuthenticationSessionError.Code.canceledLogin.rawValue
                                    if !cancelled {
                                        model.errorMessage = error.localizedDescription
                                    }
                                }
                            }
                        } label: {
                            Label("Continue with \(provider.capitalized)", systemImage: provider.lowercased() == "apple" ? "apple.logo" : "globe")
                                .font(.headline.weight(.bold))
                                .frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.bordered)
                        .disabled(model.isLoading || oauth.isRunning)
                    }
                    Text("The provider signs you in through Supabase, then Pint Path creates the same scoped app session used by email sign-in.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .beerMapCard()
            }
            }
        }
        .onChange(of: mode) { _, _ in
            password = ""
            confirmPassword = ""
            ageConfirmed = false
            termsAccepted = false
            privacyAccepted = false
        }
        .onChange(of: model.billingRecoveryGuidance) { _, guidance in
            guard guidance != nil else {
                billingRecoveryVenueId = ""
                return
            }
            billingRecoveryVenueId = !model.billingRecoveryConsumer && model.billingRecoveryVenues.count == 1
                ? model.billingRecoveryVenues[0].venueId
                : ""
        }
    }
}

@MainActor
private final class NativeOAuthCoordinator: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    @Published var isRunning = false
    private var session: ASWebAuthenticationSession?

    func signIn(provider: String, config: PublicConfig) async throws -> SupabaseAuthTokens {
        guard !isRunning else { throw BeerMapAPIError.server("An account sign-in is already open.") }
        guard
            let baseText = config.supabaseUrl,
            var components = URLComponents(string: baseText.trimmingCharacters(in: .whitespacesAndNewlines) + "/auth/v1/authorize")
        else {
            throw BeerMapAPIError.configuration("Secure provider sign-in is temporarily unavailable.")
        }
        let codeVerifier = try Self.pkceVerifier()
        let challengeDigest = SHA256.hash(data: Data(codeVerifier.utf8))
        let codeChallenge = Data(challengeDigest).base64URLEncodedString()
        components.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "redirect_to", value: "pintpath://auth-callback"),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "s256")
        ]
        guard let url = components.url else { throw BeerMapAPIError.invalidURL("Supabase OAuth") }

        isRunning = true
        defer {
            isRunning = false
            session = nil
        }

        let callbackURL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "pintpath") { callbackURL, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: BeerMapAPIError.missingData)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                continuation.resume(throwing: BeerMapAPIError.server("Could not open secure provider sign-in."))
            }
        }

        guard callbackURL.scheme == "pintpath", callbackURL.host == "auth-callback" else {
            throw BeerMapAPIError.server("The provider returned an invalid sign-in callback.")
        }

        var values: [String: String] = [:]
        if let queryItems = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems {
            queryItems.forEach { values[$0.name] = $0.value }
        }
        if let fragment = callbackURL.fragment,
           let fragmentItems = URLComponents(string: "?\(fragment)")?.queryItems {
            fragmentItems.forEach { values[$0.name] = $0.value }
        }
        if let errorDescription = values["error_description"] ?? values["error"] {
            throw BeerMapAPIError.server(errorDescription.replacingOccurrences(of: "+", with: " "))
        }
        guard let authCode = values["code"], !authCode.isEmpty else {
            throw BeerMapAPIError.server("Secure provider sign-in did not return a one-time authorization code.")
        }
        return try await BeerMapAPI().exchangeSupabasePKCE(
            authCode: authCode,
            codeVerifier: codeVerifier,
            config: config
        )
    }

    private static func pkceVerifier() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw BeerMapAPIError.server("Secure provider sign-in could not start. Please try again.")
        }
        return Data(bytes).base64URLEncodedString()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
