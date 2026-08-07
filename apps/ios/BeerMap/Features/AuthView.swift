import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var model: BeerMapAppModel
    @State private var mode: AuthMode = .login
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
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
                eyebrow: "Pint Path account",
                title: model.legalAcceptanceRequired
                    ? "Review the current policies"
                    : (mode == .login ? "Welcome back" : "Create your contributor account"),
                subtitle: model.legalAcceptanceRequired
                    ? "Your email identity is verified. Accept the current version before Pint Path creates an app session."
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
                    Link("Read the Terms", destination: AppConfig.termsURL)
                    Toggle("I accept the current Terms", isOn: $termsAccepted)
                    Link("Read the Privacy Policy", destination: AppConfig.privacyURL)
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
                        Link("Read the Terms", destination: AppConfig.termsURL)
                        Toggle("I accept the current Terms", isOn: $termsAccepted)
                        Link("Read the Privacy Policy", destination: AppConfig.privacyURL)
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

            Button("Forgot password?") {
                guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    model.errorMessage = "Enter your email address first."
                    return
                }
                Task { await model.requestPasswordReset(email: email) }
            }
            .buttonStyle(.plain)
            .font(.subheadline.weight(.semibold))

            Text("Already use Google on the Pint Path website? Enter that same email and choose Forgot password to add iOS password access without creating another account.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .accessibilityLabel("Existing website Google users should enter the same email and use Forgot password for iOS access.")

            }
        }
        .onChange(of: mode) { _, _ in
            password = ""
            confirmPassword = ""
            ageConfirmed = false
            termsAccepted = false
            privacyAccepted = false
        }
    }

}
