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
- [ ] Create a signed archive, run Organizer validation, upload to TestFlight, and clear all warnings.
- [ ] Run the full device/accessibility/provider matrix and attach evidence.
- [ ] Provide screenshots, review notes, demo account, privacy answers, export-compliance answers, and phased-release owner.

## Android submission

- [x] Display name is Pint Path; version code/name are `2`/`1.0.0`.
- [x] OAuth activity uses `singleTop` and declares the callback intent filter.
- [x] CI runs debug/release lint, unit tests, and assemblies with JDK 17.
- [ ] Create/protect the upload key and configure Play App Signing without committing secrets.
- [ ] Build and inspect the signed AAB; run Play pre-launch and internal-testing reports.
- [ ] Validate adaptive icon, screenshots, phone/tablet/foldable layouts, and target-SDK policy.
- [ ] Complete Data Safety, content rating, alcohol framing, ads declaration, app-access instructions, and staged-rollout owner.

## Release gate

- [ ] Repository tests and native CI are green at the exact release commit.
- [ ] TestFlight and Play internal tracks use that same commit/version.
- [ ] Zero unresolved critical/high security, privacy, crash, auth, data-loss, or accessibility findings.
- [ ] Rollback/kill-switch, support escalation, crash/ANR monitoring, and first-72-hour ownership are documented.
- [ ] Release owner records final go/no-go approval with evidence links.
