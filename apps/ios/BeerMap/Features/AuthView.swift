import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var mode: AuthMode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""
    @State private var ageConfirmed = false
    @State private var termsAccepted = false
    @State private var privacyAccepted = false

    enum AuthMode: String, CaseIterable, Identifiable {
        case login = "Sign in"
        case signup = "Create account"

        var id: String { rawValue }
    }

    var body: some View {
        VStack(spacing: 16) {
            SectionHeader(
                eyebrow: "BeerMap account",
                title: mode == .login ? "Welcome back" : "Create your contributor account",
                subtitle: "Use the same account, access rules, and venue assignments as the website.",
                systemImage: mode == .login ? "person.crop.circle.fill" : "person.badge.plus.fill"
            )

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
                        .readableForm()
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Email address")
                }

                FormFieldShell(label: "Password", systemImage: "lock.fill") {
                    SecureField("Password", text: $password)
                        .textContentType(mode == .login ? .password : .newPassword)
                        .readableForm()
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Password")
                }

                if mode == .signup {
                    FormFieldShell(label: "Profile", systemImage: "person.text.rectangle.fill") {
                        TextField("Display name, optional", text: $displayName)
                            .textContentType(.nickname)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Display name")
                    }

                    VStack(spacing: 10) {
                        Toggle("I confirm I am 18 or older", isOn: $ageConfirmed)
                        Toggle("I accept the Terms", isOn: $termsAccepted)
                        Toggle("I accept the Privacy Policy", isOn: $privacyAccepted)
                    }
                    .padding(12)
                    .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                    StatusBanner(
                        message: "BeerMap uses the same safety, privacy, and account rules as the website.",
                        systemImage: "checkmark.shield.fill"
                    )
                }
            }
            .beerMapCard()

            PrimaryButton(
                title: mode == .login ? "Sign in" : "Create account",
                systemImage: mode == .login ? "arrow.right.circle.fill" : "person.badge.plus.fill",
                isLoading: model.isLoading
            ) {
                Task {
                    if mode == .login {
                        await model.login(email: email, password: password)
                    } else if ageConfirmed && termsAccepted && privacyAccepted {
                        await model.signup(email: email, password: password, displayName: displayName)
                    } else {
                        model.errorMessage = "Confirm 18+ and accept the Terms and Privacy Policy before creating an account."
                    }
                }
            }
            .disabled(email.isEmpty || password.isEmpty)

            if let providers = model.config?.supabaseOauthProviders, !providers.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Google and Apple sign-in are configured on the web backend.", systemImage: "link.badge.plus")
                        .font(.subheadline.weight(.semibold))
                    Text("Native OAuth needs final app bundle IDs, redirect URLs, and provider console entries before release. Email/password uses the existing backend today.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .beerMapCard()
            }
        }
    }
}
