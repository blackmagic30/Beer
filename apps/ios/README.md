# Pint Path iOS

Native SwiftUI app for Pint Path. The existing Xcode target and source module retain the internal `BeerMap` name; the installed app is displayed as **Pint Path**. Continue this project in place.

## Run

1. Install full Xcode.
2. Open `apps/ios/BeerMap.xcodeproj`.
3. Select the `BeerMap` scheme and an iPhone simulator.
4. Run.

The hosted API defaults to `https://pintpath.au`. For local development, copy `Config.example.xcconfig` to the ignored `Config.xcconfig`, set `PINT_PATH_API_BASE_URL`, and attach it to the target if required.

```xcconfig
PINT_PATH_API_BASE_URL = http:/$()/127.0.0.1:3000
```

## Current integration

- Email/password signup, login, refresh, password recovery, and logout use Supabase Auth REST endpoints.
- Apple uses `AuthenticationServices` and exchanges its ID token directly for Supabase tokens. Google uses an `ASWebAuthenticationSession` PKCE flow that captures `pintpath://auth-callback`, closes the authentication sheet, and creates the same Pint Path app session.
- Supabase access tokens are exchanged at `POST /api/business/auth/supabase-session` for the scoped Pint Path app session.
- Sensitive session/export/deletion actions require a fresh provider sign-in token; a rejected action is never reported as complete.
- A suspended paid account receives billing-only recovery without an app session, including personal-versus-managed-venue selection when needed.
- App, Supabase refresh, and Supabase access tokens are stored in Keychain as `WhenUnlockedThisDeviceOnly`; a non-Keychain installation marker clears surviving Keychain sessions after reinstall.
- No service-role key is bundled, and the app never reads private Supabase tables directly.

Google login requires `pintpath://auth-callback` in Supabase's redirect allow list. Apple login requires the Sign in with Apple capability for the same App ID. The production Supabase project must have the corresponding Google and Apple providers enabled.

## Native coverage

- Venue search, MapKit pins, fixed free price preview or entitled full prices, wrong-price reporting, venue saving, and external directions.
- Reviewed price, photo, and happy-hour submissions with optional one-time location proof.
- Missing venue/beer requests and mission reserve/release.
- Account dashboard, privacy controls, sessions, JSON export, deletion request/status/cancel, rewards, and counter-staff invitations.
- Venue profile, beer/stock, happy hours, eligible specials, counter/POS tools, analytics, planner, and monthly report export for assigned roles.
- A server-authority-gated Admin tab that hands verified admins to the secure web workspace.
- Claim-required accounts are handed to the secure web claim workflow because business evidence and admin review remain web-managed.

## Deliberate remaining boundaries

The photo library supports one image per native submission. Direct camera capture, multiple images, PDF evidence, offline upload queues, general plan/checkout changes, and admin moderation remain outside this native release. The narrow suspended-account billing-recovery portal is implemented. Signing, real-device/provider testing, screenshots, reviewer accounts, and App Store metadata/disclosures require release-owner credentials.

## Validation

```bash
swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')
plutil -lint apps/ios/BeerMap/Info.plist apps/ios/BeerMap/BeerMap.entitlements apps/ios/BeerMap/PrivacyInfo.xcprivacy
xcodebuild -project apps/ios/BeerMap.xcodeproj -scheme BeerMap -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The final command requires full Xcode. CI also performs unsigned simulator and Release archive builds.
