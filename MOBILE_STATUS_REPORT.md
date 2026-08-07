# Pint Path Mobile Status Report

Status date: 3 August 2026

## Executive status

The repository contains one native iOS app and one native Android app. Both are branded **Pint Path** to users while retaining the existing `BeerMap` target/package names for source compatibility. The current release is the web app plus a deliberately narrow first iOS binary; Android is not included.

The first iOS release contains public venue discovery, the free price preview,
reviewed price/photo contribution, account/privacy/deletion controls, and
assigned venue-Free profile plus beer/stock management. It compiles out native
social login, paid entitlement, venue Pro/trial/billing, happy-hour discovery or
submission, specials, rewards/Pub Golf, counter/POS, and admin tools. Broader
source retained for future releases is not current App Store functionality.

This is not a claim that the binaries are already store-approved. Code-level and static validation can be completed in this checkout; signing, provider consoles, live-device testing, screenshots, reviewer access, and store declarations depend on external credentials and release-owner action.

## Role coverage

| Role | iOS | Android | Notes |
| --- | --- | --- | --- |
| Anonymous visitor | Venue discovery, map, price access, reports/requests | Venue discovery, list, external maps, price access, reports/requests | Server remains authoritative for gated price access. |
| Signed-in member | Saved venues, privacy, sessions, export, and deletion controls | Broader retained app; not in this launch | Account deletion includes status and pending-request cancellation. |
| Contributor | Reviewed price/photo evidence, optional one-time location, and non-happy-hour missions | Broader retained app; not in this launch | Submissions remain review-first. |
| Counter staff | Not compiled into the first release | Broader retained app; not in this launch | Counter/reward tooling remains web/future-release only. |
| Venue manager | Assigned venue-Free profile and beer/stock management | Broader retained app; not in this launch | Happy hours, Pro, specials, analytics, reports, counter, and billing are excluded from the first iOS archive. |
| Admin | Not compiled into the first release | Broader retained app; not in this launch | Moderation remains in the secure web workspace. |

## Remediation completed in this pass

- Corrected session refresh so consent fields and versions are sent only with a complete consent set.
- Normalized native consent sources to backend-supported `ios` and `android` values.
- Preserved broader provider-login work outside the submitted iOS scope. The first-release iOS archive compiles out Google/Apple login and custom callback schemes; it uses email/password plus the verified HTTPS web confirmation/recovery callback.
- Added Supabase access-token storage and best-effort Supabase logout alongside Pint Path session logout.
- Added fresh-provider proof for session review/revocation, account export/deletion, and global logout, with explicit retry guidance and no false success after a rejected action.
- Kept billing, paid-entitlement, and suspended-account recovery surfaces outside the first-release iOS archive while pricing is deferred.
- Added the required location `capturedAt` field on both platforms.
- Corrected privacy-save, profile-save, and beer-save response models used by the first iOS release; broader happy-hour/special response work remains outside this binary.
- Added account deletion status/cancel; counter-staff invitation decisions remain outside this binary.
- Preserved profile hours/tags and beer ABV/optimistic timestamps instead of overwriting unseen server fields.
- Reset venue editor state when switching assigned venues and cleared stale price rows while loading a new venue.
- Added Android external-map directions, safer bounded/downsampled image processing, coarse-location provider handling, and successful-form reset behavior.
- Protected iOS tokens with `WhenUnlockedThisDeviceOnly` and cleared surviving Keychain sessions on a genuinely fresh install.
- Protected Android tokens with Android-Keystore AES-GCM and excluded session preferences from backup/device transfer.
- Added iOS privacy-manifest coverage for linked account IDs, email, selected photos, optional location, and UserDefaults access.
- Aligned installed-app branding and user copy to Pint Path.
- Removed native first-page ceilings: venues, missions, account sessions, and venue prices now follow every offset/cursor page with deduplication and non-progress/repeated-cursor guards.
- Kept native admin tooling outside the first iOS archive; admins use the secure web workspace.

## Native behavior by area

### Authentication

Email/password, signup confirmation handling, password recovery, token refresh,
logout, app-session synchronization, and recent-authentication prompts are in
the first iOS release. The binary pins its compiled public authentication origin
to `https://auth.pintpath.au` and has no legacy password fallback. Confirmation
and recovery use the exact HTTPS web callback. Existing Google website users enter the same email and use Forgot
password to add iOS password access to the existing account. Native provider
login and billing recovery are excluded. The same-account bridge still requires
real Supabase/custom-SMTP proof on signed devices.

### Contributions

The first iOS release supports reviewed price and one selected-photo submission,
wrong-price reports, missing venue/beer requests, and non-happy-hour mission
reserve/release. Optional location is captured only after a user action and
attached only to that submission. Happy-hour contribution, direct camera,
multi-image/PDF upload, and offline queues are excluded.

### Account and privacy

The first iOS release exposes privacy preferences, sessions and revocation,
account export, and deletion request/status/cancel. Rewards/codes,
counter-staff invitations, and paid-account billing recovery are excluded.
Sensitive account controls require fresh provider proof. Optional analytics
remain opt-in.

### Venue operations

Assigned venue managers can edit the Free-plan venue profile and beer/stock
inventory. Happy hours, specials, counter operations, analytics, reports, Pro,
trial, and billing are excluded from the first iOS archive. Claim evidence and
admin review remain a web handoff.

## Platform differences

- iOS uses MapKit inside the app.
- Android avoids adding a private map API key and opens coordinates in an installed map app, with a browser fallback.
- iOS exports through the system share sheet; Android uses the Storage Access Framework document picker.

## External release blockers

1. Active Apple Developer membership, Account Holder 2FA/recovery, current agreement, backup App Manager/Admin, exact app record/team/entity, signing, and final store records.
2. Live Google web provider-console and Supabase verification, with proof Apple OAuth and both native social providers remain absent from the signed iOS archive.
3. Physical-device tests for provider return, permissions, photo input, location, export, accessibility, rotation, interruption, and poor networks.
4. Final icons/screenshots/store copy, reviewer accounts/instructions, support and marketing URLs.
5. App Store privacy answers verified against production policy and retention behavior. Play Data Safety belongs to a future Android release.
6. Signed archive inspection, TestFlight/App Review approval, dSYM-symbolicated crash monitoring with alerts, and staged rollout ownership. Play/Android remains a future release.

The remaining items require external systems or product scope. They are not hidden code TODOs.
