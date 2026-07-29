import AuthenticationServices
import CryptoKit
import Security
import SwiftUI
import UIKit

struct AuthView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @Environment(\.openURL) private var openURL
    @StateObject private var providerSignIn = NativeProviderSignInCoordinator()
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
                let enabledProviders = Set(providers.map { $0.lowercased() })
                VStack(alignment: .leading, spacing: 8) {
                    Label("Or continue securely", systemImage: "checkmark.shield.fill")
                        .font(.subheadline.weight(.semibold))

                    if enabledProviders.contains("apple") {
                        SignInWithAppleButton(.continue) { request in
                            password = ""
                            confirmPassword = ""
                            do {
                                try providerSignIn.prepareAppleRequest(request)
                            } catch {
                                model.errorMessage = error.localizedDescription
                            }
                        } onCompletion: { result in
                            Task {
                                await completeProviderSignIn {
                                    guard let config = model.config else {
                                        throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.")
                                    }
                                    return try await providerSignIn.completeAppleSignIn(
                                        result: result,
                                        config: config
                                    )
                                }
                            }
                        }
                        .signInWithAppleButtonStyle(.whiteOutline)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .disabled(model.isLoading || providerSignIn.isRunning)
                        .accessibilityLabel("Continue with Apple")
                    }

                    if enabledProviders.contains("google") {
                        Button {
                            password = ""
                            confirmPassword = ""
                            Task {
                                await completeProviderSignIn {
                                    guard let config = model.config else {
                                        throw BeerMapAPIError.configuration("Account configuration is still loading. Try again in a moment.")
                                    }
                                    return try await providerSignIn.signInWithGoogle(config: config)
                                }
                            }
                        } label: {
                            Label("Continue with Google", systemImage: "g.circle.fill")
                                .font(.headline.weight(.bold))
                                .frame(maxWidth: .infinity, minHeight: 50)
                        }
                        .buttonStyle(.bordered)
                        .disabled(model.isLoading || providerSignIn.isRunning)
                    }

                    Text("Apple and Google return directly to Pint Path. Supabase verifies the provider token before the app creates its scoped account session.")
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

    @MainActor
    private func completeProviderSignIn(
        _ operation: @escaping @MainActor () async throws -> SupabaseAuthTokens
    ) async {
        do {
            let tokens = try await operation()
            guard let accessToken = tokens.accessToken else {
                throw BeerMapAPIError.missingData
            }
            await model.completeOAuthSignIn(
                accessToken: accessToken,
                refreshToken: tokens.refreshToken
            )
        } catch {
            if !NativeProviderSignInCoordinator.isCancellation(error) {
                model.errorMessage = error.localizedDescription
            }
        }
    }
}

@MainActor
private final class NativeProviderSignInCoordinator: NSObject, ObservableObject,
    ASWebAuthenticationPresentationContextProviding {
    @Published var isRunning = false
    private var appleNonce: String?
    private var browserSession: ASWebAuthenticationSession?
    private var browserOperation: BrowserSignInOperation?

    func signInWithGoogle(config: PublicConfig) async throws -> SupabaseAuthTokens {
        try await signInWithSupabaseBrowser(provider: "google", config: config)
    }

    func prepareAppleRequest(_ request: ASAuthorizationAppleIDRequest) throws {
        guard !isRunning else {
            throw BeerMapAPIError.server("An account sign-in is already open.")
        }
        let nonce = try Self.randomNonce()
        appleNonce = nonce
        isRunning = true
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(nonce)
    }

    func completeAppleSignIn(
        result: Result<ASAuthorization, any Error>,
        config: PublicConfig
    ) async throws -> SupabaseAuthTokens {
        defer {
            appleNonce = nil
            isRunning = false
        }

        let authorization = try result.get()
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let identityTokenData = credential.identityToken,
            let identityToken = String(data: identityTokenData, encoding: .utf8),
            !identityToken.isEmpty,
            let nonce = appleNonce
        else {
            throw BeerMapAPIError.server("Apple did not return a complete identity token. Please start sign-in again.")
        }
        return try await BeerMapAPI().exchangeSupabaseIDToken(
            provider: "apple",
            idToken: identityToken,
            nonce: nonce,
            config: config
        )
    }

    static func isCancellation(_ error: any Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == ASAuthorizationError.errorDomain,
           nsError.code == ASAuthorizationError.canceled.rawValue {
            return true
        }
        if nsError.domain == ASWebAuthenticationSessionErrorDomain,
           nsError.code == ASWebAuthenticationSessionError.Code.canceledLogin.rawValue {
            return true
        }
        return error is CancellationError
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    private func signInWithSupabaseBrowser(
        provider: String,
        config: PublicConfig
    ) async throws -> SupabaseAuthTokens {
        guard !isRunning else {
            throw BeerMapAPIError.server("An account sign-in is already open.")
        }
        guard
            let baseURL = Self.canonicalSupabaseOrigin(config.supabaseUrl),
            var components = URLComponents(
                url: baseURL.appendingPathComponent("auth/v1/authorize"),
                resolvingAgainstBaseURL: false
            )
        else {
            throw BeerMapAPIError.configuration("Secure provider sign-in is temporarily unavailable.")
        }

        let codeVerifier = try Self.pkceVerifier()
        let challengeDigest = SHA256.hash(data: Data(codeVerifier.utf8))
        components.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "redirect_to", value: "pintpath://auth-callback"),
            URLQueryItem(name: "code_challenge", value: Data(challengeDigest).base64URLEncodedString()),
            URLQueryItem(name: "code_challenge_method", value: "s256")
        ]
        guard let authorizationURL = components.url else {
            throw BeerMapAPIError.invalidURL("Supabase OAuth")
        }

        isRunning = true
        defer {
            browserOperation = nil
            browserSession = nil
            isRunning = false
        }

        let operation = BrowserSignInOperation()
        browserOperation = operation
        let session = ASWebAuthenticationSession(
            url: authorizationURL,
            callbackURLScheme: "pintpath"
        ) { [weak operation] callbackURL, error in
            Task { @MainActor in
                if let error {
                    operation?.resolve(.failure(error))
                } else if let callbackURL {
                    operation?.resolve(.success(callbackURL))
                } else {
                    operation?.resolve(.failure(BeerMapAPIError.missingData))
                }
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = true
        browserSession = session

        let callbackURL = try await withTaskCancellationHandler {
            guard session.start() else {
                operation.resolve(
                    .failure(BeerMapAPIError.server("Could not open secure provider sign-in."))
                )
                return try await operation.value()
            }
            return try await operation.value()
        } onCancel: {
            Task { @MainActor [weak self, weak operation] in
                self?.browserSession?.cancel()
                operation?.resolve(.failure(CancellationError()))
            }
        }

        guard
            callbackURL.scheme?.lowercased() == "pintpath",
            callbackURL.host?.lowercased() == "auth-callback",
            callbackURL.user == nil,
            callbackURL.password == nil,
            callbackURL.port == nil,
            callbackURL.path.isEmpty
        else {
            throw BeerMapAPIError.server("The provider returned an invalid sign-in callback.")
        }

        let callbackValues = try Self.callbackValues(from: callbackURL)
        if let providerError = callbackValues["error_description"] ?? callbackValues["error"] {
            throw BeerMapAPIError.server(
                Self.sanitizedProviderError(providerError)
            )
        }
        guard
            let authorizationCode = callbackValues["code"]?
                .trimmingCharacters(in: .whitespacesAndNewlines),
            !authorizationCode.isEmpty
        else {
            throw BeerMapAPIError.server(
                "Secure provider sign-in did not return a one-time authorization code."
            )
        }

        return try await BeerMapAPI().exchangeSupabasePKCE(
            authCode: authorizationCode,
            codeVerifier: codeVerifier,
            config: config
        )
    }

    private static func canonicalSupabaseOrigin(_ rawValue: String?) -> URL? {
        guard
            let rawValue,
            var components = URLComponents(
                string: rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
            ),
            !(components.host?.isEmpty ?? true),
            components.user == nil,
            components.password == nil,
            components.query == nil,
            components.fragment == nil,
            components.path.isEmpty || components.path == "/"
        else {
            return nil
        }
#if DEBUG
        guard ["http", "https"].contains(components.scheme?.lowercased() ?? "") else {
            return nil
        }
#else
        guard components.scheme?.lowercased() == "https" else {
            return nil
        }
#endif
        components.scheme = components.scheme?.lowercased()
        components.path = ""
        return components.url
    }

    private static func callbackValues(from callbackURL: URL) throws -> [String: String] {
        let allowedNames = Set(["code", "error", "error_description"])
        let callbackComponents = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
        var values: [String: String] = [:]

        func include(_ items: [URLQueryItem]?) throws {
            for item in items ?? [] where allowedNames.contains(item.name) {
                guard values[item.name] == nil else {
                    throw BeerMapAPIError.server(
                        "The provider returned an invalid sign-in callback."
                    )
                }
                values[item.name] = item.value ?? ""
            }
        }

        try include(callbackComponents?.queryItems)
        if let fragment = callbackURL.fragment, !fragment.isEmpty {
            try include(URLComponents(string: "?\(fragment)")?.queryItems)
        }
        return values
    }

    private static func sanitizedProviderError(_ value: String) -> String {
        let flattened = value
            .replacingOccurrences(of: "+", with: " ")
            .components(separatedBy: .controlCharacters)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let safeValue = String(flattened.prefix(240))
        return safeValue.isEmpty
            ? "Secure provider sign-in was not completed."
            : safeValue
    }

    private static func pkceVerifier() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw BeerMapAPIError.server("Secure provider sign-in could not start. Please try again.")
        }
        return Data(bytes).base64URLEncodedString()
    }

    private static func randomNonce() throws -> String {
        let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        let acceptanceLimit = (256 / alphabet.count) * alphabet.count
        var result: [Character] = []
        result.reserveCapacity(32)

        while result.count < 32 {
            var bytes = [UInt8](repeating: 0, count: 64)
            let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            guard status == errSecSuccess else {
                throw BeerMapAPIError.server(
                    "Secure provider sign-in could not create a protected request. Please try again."
                )
            }
            for byte in bytes where Int(byte) < acceptanceLimit {
                result.append(alphabet[Int(byte) % alphabet.count])
                if result.count == 32 {
                    break
                }
            }
        }
        return String(result)
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

@MainActor
private final class BrowserSignInOperation {
    private enum Outcome {
        case success(URL)
        case failure(any Error)
    }

    private var continuation: CheckedContinuation<URL, any Error>?
    private var pendingOutcome: Outcome?
    private var isResolved = false

    func value() async throws -> URL {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<URL, any Error>) in
            if let pendingOutcome {
                resume(continuation, with: pendingOutcome)
            } else {
                self.continuation = continuation
            }
        }
    }

    func resolve(_ result: Result<URL, any Error>) {
        guard !isResolved else {
            return
        }
        isResolved = true
        let outcome: Outcome
        switch result {
        case .success(let url):
            outcome = .success(url)
        case .failure(let error):
            outcome = .failure(error)
        }
        if let continuation {
            self.continuation = nil
            resume(continuation, with: outcome)
        } else {
            pendingOutcome = outcome
        }
    }

    private func resume(
        _ continuation: CheckedContinuation<URL, any Error>,
        with outcome: Outcome
    ) {
        switch outcome {
        case .success(let url):
            continuation.resume(returning: url)
        case .failure(let error):
            continuation.resume(throwing: error)
        }
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
