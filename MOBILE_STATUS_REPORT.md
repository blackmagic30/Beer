# Pint Path Mobile Status Report

Status date: 29 July 2026

## Executive status

The repository contains one native iOS app and one native Android app. Both are branded **Pint Path** to users while retaining the existing `BeerMap` target/package names for source compatibility. The apps now cover the main public, account, contributor, counter-staff, and venue-manager journeys against the current `/api/business/*` contract.

This is not a claim that the binaries are already store-approved. Code-level and static validation can be completed in this checkout; signing, provider consoles, live-device testing, screenshots, reviewer access, and store declarations depend on external credentials and release-owner action.

## Role coverage

| Role | iOS | Android | Notes |
| --- | --- | --- | --- |
| Anonymous visitor | Venue discovery, map, price access, reports/requests | Venue discovery, list, external maps, price access, reports/requests | Server remains authoritative for gated price access. |
| Signed-in member | Saved venues, privacy, sessions, export, deletion controls, codes/rewards | Same | Account deletion includes status and pending-request cancellation. |
| Contributor | Price/photo/happy-hour evidence, optional one-time location, missions | Same | Submissions remain review-first. |
| Counter staff | Invitation acceptance, member-code preview, purchase/reward actions | Same | Server verifies venue assignment and permissions. |
| Venue manager | Profile, beers/stock, happy hours, entitled specials, analytics/planner/reports | Same | Claim-required users are handed to the secure web verification workflow. |
| Admin | Authority-gated Admin quick-bar tab with secure web workspace handoff | Same | The tab is derived only from current server-verified admin access; moderation remains in the full web workspace. |

## Remediation completed in this pass

- Corrected session refresh so consent fields and versions are sent only with a complete consent set.
- Normalized native consent sources to backend-supported `ios` and `android` values.
- Added native Apple sign-in with direct Supabase ID-token exchange on iOS. Google now uses a constrained `ASWebAuthenticationSession` PKCE flow that captures and validates the exact app callback, dismisses the authentication sheet, and creates the app session. Android retains authorization-code PKCE with the same callback checks.
- Added Supabase access-token storage and best-effort Supabase logout alongside Pint Path session logout.
- Added fresh-provider proof for session review/revocation, account export/deletion, and global logout, with explicit retry guidance and no false success after a rejected action.
- Added billing-only recovery for suspended paid users without issuing an app session, including selection between personal and assigned-venue billing profiles.
- Added the required location `capturedAt` field on both platforms.
- Corrected privacy-save, profile-save, beer-save, happy-hour-save, and special-save response models to match endpoint envelopes.
- Added account deletion status/cancel and counter-staff invitation decisions.
- Preserved profile hours/tags and beer ABV/optimistic timestamps instead of overwriting unseen server fields.
- Reset venue editor state when switching assigned venues and cleared stale price rows while loading a new venue.
- Added Android external-map directions, safer bounded/downsampled image processing, coarse-location provider handling, and successful-form reset behavior.
- Protected iOS tokens with `WhenUnlockedThisDeviceOnly` and cleared surviving Keychain sessions on a genuinely fresh install.
- Protected Android tokens with Android-Keystore AES-GCM and excluded session preferences from backup/device transfer.
- Added iOS privacy-manifest coverage for linked account IDs, email, selected photos, optional location, and UserDefaults access.
- Aligned installed-app branding and user copy to Pint Path.
- Removed native first-page ceilings: venues, missions, account sessions, and venue prices now follow every offset/cursor page with deduplication and non-progress/repeated-cursor guards.
- Added an Admin quick-bar tab on both platforms that appears only while the signed-in account has current server-verified admin authority, then hands off to the secure web workspace.

## Native behavior by area

### Authentication

Email/password, signup confirmation handling, password recovery, token refresh, provider login, logout, app-session synchronization, recent-authentication prompts, and suspended-account billing-only recovery are implemented. The iOS app now captures the provider return and creates the Pint Path session instead of leaving the user signed in only inside a browser. All provider flows still require matching Supabase/provider settings and signed-device tests.

### Contributions

Both platforms support reviewed price, selected-photo, and happy-hour submissions, wrong-price reports, missing venue/beer requests, and mission reserve/release. Optional location is captured only after a user action and attached only to that submission. The native apps do not provide direct camera capture, multi-image/PDF upload, or offline queues.

### Account and privacy

Both platforms expose privacy preferences, sessions and revocation, account export, deletion request/status/cancel, rewards/codes, and counter-staff invitations. Sensitive account controls require a fresh provider credential. Suspended paid accounts can reach only the secure billing portal and do not receive an app session. Optional analytics remain opt-in.

### Venue operations

Assigned venue managers can edit core venue data, inventory, happy hours, eligible specials, counter operations, and reports. Writes refresh server state and send optimistic timestamps where the contract supports them. Claim evidence/admin review remains a web handoff.

## Platform differences

- iOS uses MapKit inside the app.
- Android avoids adding a private map API key and opens coordinates in an installed map app, with a browser fallback.
- iOS exports through the system share sheet; Android uses the Storage Access Framework document picker.

## External release blockers

1. Apple/Google signing identities and final store records.
2. Live Google/Apple provider-console and Supabase verification; Android additionally requires its redirect allow-list entry.
3. Physical-device tests for provider return, permissions, photo input, location, export, accessibility, rotation, interruption, and poor networks.
4. Final icons/screenshots/store copy, reviewer accounts/instructions, support and marketing URLs.
5. App Store privacy answers and Play Data Safety declarations verified against production policy and retention behavior.
6. TestFlight and Play internal-testing approval, crash/ANR monitoring, and staged rollout ownership.

The remaining items require external systems or product scope. They are not hidden code TODOs.
