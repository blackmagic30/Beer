# Pint Path Mobile Store Checklist

Status date: 14 July 2026

Checkboxes marked complete are repository-backed. Unchecked items require release credentials, live provider configuration, device evidence, or store-console work.

## Shared product and safety

- [x] Installed app name is `Pint Path` on iOS and Android.
- [x] Existing bundle/package ID is `au.pintpath.beermap`.
- [x] User-facing copy includes 18+ and responsible-service framing.
- [x] Public prices/availability are described as changeable and server-gated.
- [x] Native clients contain no service-role or private provider secret.
- [ ] Product owner approves final icon, subtitle, category, description, keywords/tags, and age rating.
- [ ] Support URL, marketing URL, privacy-policy URL, terms URL, and deletion instructions are live and store-console verified.
- [ ] Reviewer account/instructions cover member, contributor, counter-staff, and venue-manager paths without exposing production personal data.

## Authentication

- [x] Email/password uses Supabase Auth REST and scoped Pint Path session exchange.
- [x] Provider login uses authorization-code PKCE and validates the native callback destination.
- [x] Refresh and logout cover both Supabase and Pint Path sessions.
- [x] Consent source/version fields match the backend contract.
- [ ] Add `pintpath://auth-callback` to the production Supabase redirect allow list.
- [ ] Complete and verify production Google and Apple provider-console settings.
- [ ] Test success/cancel/error/replay/interruption on signed physical devices.
- [ ] Confirm whether Apple requires Sign in with Apple based on enabled third-party login choices and final review policy.

## Privacy and security

- [x] iOS app/refresh/access tokens use `WhenUnlockedThisDeviceOnly` Keychain protection.
- [x] iOS fresh-install marker clears Keychain sessions surviving uninstall.
- [x] Android session values use Android-Keystore AES-GCM.
- [x] Android session preferences are excluded from backup and device transfer.
- [x] iOS privacy manifest declares linked email/user ID, selected photos, optional precise location, and UserDefaults API access.
- [x] Optional analytics are opt-in and privacy controls are native.
- [x] Account export, session revocation, deletion request/status/cancel are native.
- [ ] Reconcile App Store privacy answers and Play Data Safety with the live privacy policy, processors, retention, support tooling, crash collection, and production analytics configuration.
- [ ] Perform mobile threat-model/penetration review on signed release candidates.

## Permissions and data input

- [x] iOS has a purpose string for user-requested one-time location proof.
- [x] Android requests coarse/fine location only from the contribution action.
- [x] Android declares only Internet and location permissions; the system photo picker needs no broad media permission.
- [x] Selected photos are bounded and downsampled before Android upload.
- [ ] Verify approximate/precise/deny/no-fix behavior on devices.
- [ ] Verify every declared store data type and purpose against live requests and backend retention.

## iOS submission

- [x] `PrivacyInfo.xcprivacy` is included in the Xcode resources phase.
- [x] Display name is Pint Path; version/build are set to `1.0.0`/`2`.
- [x] CI builds an unsigned simulator app and validates an unsigned Release archive.
- [ ] Set the Apple development team, distribution certificate, provisioning profile, and final App Store record.
- [ ] Validate final app icon and launch appearance on supported devices.
- [ ] Create a signed archive, export a signed IPA with private signing/export options, scan it for embedded private secrets/debug configuration, hash it, run Organizer validation, upload to TestFlight, and clear all warnings.
- [ ] Run the full device/accessibility/provider matrix on minimum-supported iOS 17 and the current iOS release; include uninstall/reinstall and encrypted device-backup/restore or device-transfer session checks.
- [ ] Provide screenshots, review notes, demo account, privacy answers, export-compliance answers, and phased-release owner.

## Android submission

- [x] Display name is Pint Path; version code/name are `2`/`1.0.0`.
- [x] OAuth activity uses `singleTop` and declares the callback intent filter.
- [x] CI runs debug/release lint, unit tests, and assemblies with JDK 17.
- [ ] Create the Play upload key in the approved secret manager, keep the keystore outside the checkout, enrol it in Play App Signing, record the certificate fingerprint, recovery owner, and rotation procedure, and confirm no signing value appears in Gradle properties, shell history, CI logs, or screenshots.
- [ ] In a private zsh terminal, follow `apps/android/README.md`: enter all four `PINT_PATH_ANDROID_*` signing values through its interactive prompts, run `./gradlew --no-daemon clean bundleRelease`, and verify its exit trap cleared all four variables.
- [ ] Verify `app/build/outputs/bundle/release/app-release.aab` with non-strict `jarsigner -verify -verbose -certs` and require `jar verified.`; inspect warnings, certificate validity, and algorithms explicitly because a self-signed Android upload certificate can fail `-strict`. Use `keytool -printcert -jarfile`, match its SHA-256 upload certificate fingerprint to Play, and scan the final AAB for private keys, passwords, tokens, and non-public configuration before upload.
- [ ] Upload that exact signed AAB to Play internal testing; install it from Play, exercise authentication/provider/deep-link/session/export/deletion and venue-role journeys on physical devices, then clear the pre-launch and internal-testing reports.
- [ ] Validate adaptive icon, screenshots, phone/tablet/foldable layouts, and target-SDK policy.
- [ ] Complete Data Safety, content rating, alcohol framing, ads declaration, app-access instructions, and staged-rollout owner.

## Release gate

- [ ] Repository tests and native CI are green at the exact release commit.
- [ ] TestFlight and Play internal tracks use that same commit/version.
- [ ] Zero unresolved critical/high security, privacy, crash, auth, data-loss, or accessibility findings.
- [ ] Rollback/kill-switch, support escalation, crash/ANR monitoring, and first-72-hour ownership are documented.
- [ ] Release owner records final go/no-go approval with evidence links.
- [ ] Treat TestFlight and Play internal-track approval as controlled-beta authorization only. Public native launch remains no-go until the applicable App Store review/release and Play production-track review/rollout are approved and live in the intended storefronts/countries.
