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
- Social provider login is not compiled into the first App Store release; authentication is email/password only.
- Supabase access tokens are exchanged at `POST /api/business/auth/supabase-session` for the scoped Pint Path app session.
- Sensitive session/export/deletion actions require fresh authentication; a rejected action is never reported as complete.
- Purchase, checkout, subscription-management, and billing-recovery code is not compiled into the iOS release.
- App, Supabase refresh, and Supabase access tokens are stored in Keychain as `WhenUnlockedThisDeviceOnly`; a non-Keychain installation marker clears surviving Keychain sessions after reinstall.
- No service-role key is bundled, and the app never reads private Supabase tables directly.

## Native coverage

- Venue search, neutral MapKit pins, a fixed free price preview or earned contributor unlock, wrong-price reporting, venue saving, and external directions.
- Reviewed price and photo submissions with optional one-time location proof.
- Missing venue/beer requests and mission reserve/release.
- Account dashboard, contribution progress, privacy controls, sessions, JSON export, and deletion request/status/cancel.
- Free assigned-venue profile and beer/stock management.
- Commerce-safe iOS legal pages and in-app support.

## Deliberate remaining boundaries

The photo library supports one image per native submission. Direct camera capture, multiple images, PDF evidence, offline upload queues, happy-hour discovery/submission/management, all paid consumer entitlements, paid venue Pro trials/features, alcohol-linked rewards/counter tools, plan/checkout changes, social providers, and admin moderation are not compiled into this native release. Signing, real-device testing, screenshots, reviewer accounts, and App Store metadata/disclosures require release-owner credentials.

## Validation

```bash
swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')
plutil -lint apps/ios/BeerMap/Info.plist apps/ios/BeerMap/PrivacyInfo.xcprivacy
xcodebuild -project apps/ios/BeerMap.xcodeproj -scheme BeerMap -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The final command requires full Xcode. CI also performs unsigned simulator and Release archive builds.
