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
            PintPathHero(
                eyebrow: model.legalAcceptanceRequired ? "ACCOUNT CHECK" : "PINT PATH",
                title: model.legalAcceptanceRequired
                    ? "Review the current policies"
                    : (mode == .login ? "Find your next good pint" : "Join the local price crew"),
                subtitle: model.legalAcceptanceRequired
                    ? "Accept the latest terms to finish signing in."
                    : (mode == .login
                        ? "Save pubs, share prices and keep your Pint Path progress in one place."
                        : "Help Melbourne find better-value pours. Your web account works here too."),
                systemImage: model.legalAcceptanceRequired
                    ? "checkmark.shield.fill"
                    : (mode == .login ? "person.crop.circle.fill" : "person.badge.plus.fill")
            )

            if model.legalAcceptanceRequired {
                VStack(spacing: 12) {
                    StatusBanner(
                        message: "Policy version \(model.legalAcceptanceVersion ?? "current") is ready for review. Your verified sign-in is held only in memory until you decide; no Pint Path session is created unless you accept.",
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
            VStack(spacing: 12) {
                authModeControl

                FormFieldShell(label: "Email address", systemImage: "envelope.fill") {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .readableForm()
                        .textFieldStyle(PintPathTextFieldStyle())
                        .accessibilityLabel("Email address")
                }

                FormFieldShell(label: "Password", systemImage: "lock.fill") {
                    SecureField("Password", text: $password)
                        .textContentType(mode == .login ? .password : .newPassword)
                        .keyboardType(.asciiCapable)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .readableForm()
                        .textFieldStyle(PintPathTextFieldStyle())
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
                            .textFieldStyle(PintPathTextFieldStyle())
                            .accessibilityLabel("Confirm password")
                    }

                    FormFieldShell(label: "Profile", systemImage: "person.text.rectangle.fill") {
                        TextField("Display name, optional", text: $displayName)
                            .textContentType(.nickname)
                            .textFieldStyle(PintPathTextFieldStyle())
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
                    .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }

                HStack(spacing: 8) {
                    Image(systemName: "lock.shield.fill")
                        .foregroundStyle(BeerMapTheme.leaf)
                    Text("Your account is protected and shared across Pint Path.")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
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

            DisclosureGroup("Used Google on the web?") {
                Text("Enter the same email, then choose Forgot password to add iPhone password access without creating another account.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
            }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)

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

    private var authModeControl: some View {
        HStack(spacing: 5) {
            ForEach(AuthMode.allCases) { item in
                Button {
                    withAnimation(.snappy) {
                        mode = item
                    }
                } label: {
                    Text(item.rawValue)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(mode == item ? BeerMapTheme.brandInk : Color.secondary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(
                            mode == item ? BeerMapTheme.brandGold : Color.clear,
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(mode == item ? .isSelected : [])
            }
        }
        .padding(4)
        .background(BeerMapTheme.softCard, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }

}
