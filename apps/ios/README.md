# Pint Path iOS

Native SwiftUI app for Pint Path. The existing Xcode target and source module retain the internal `BeerMap` name; the installed app is displayed as **Pint Path**. Continue this project in place.

## Run

1. Install full Xcode.
2. Open `apps/ios/BeerMap.xcodeproj`.
3. Select the `BeerMap` scheme and an iPhone simulator.
4. Run.

The hosted API defaults to `https://pintpath.au`. For local development, copy
`Config.example.xcconfig` to the ignored `Config.xcconfig` and set
`PINT_PATH_API_BASE_URL`.

```xcconfig
PINT_PATH_API_BASE_URL = http:/$()/127.0.0.1:3000
```

`Config.xcconfig` is loaded automatically; do not attach it to the project or
commit it. Debug builds can omit the Supabase values when authentication is not
being exercised. Any nonblank `SUPABASE_ANON_KEY` in any build configuration
must use the publishable-key format below; secret, legacy, or malformed values
fail the build before they can be packaged.

## Release configuration

Every Release build and archive fails before compilation unless it has the
exact production API origin, the independently pinned Supabase custom origin
`https://auth.pintpath.au`, and an `sb_publishable_...` key with a 20–220
character URL-safe suffix. Legacy JWTs, `sb_secret_...` keys, and server
credentials are rejected.

1. Obtain the production publishable key from the approved production
   environment. Confirm its public origin is exactly `https://auth.pintpath.au`.
2. Generate the ignored config without printing its values:

   ```bash
   PINT_PATH_API_BASE_URL=https://pintpath.au \
   SUPABASE_URL=https://auth.pintpath.au \
   SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
   apps/ios/Scripts/write-build-config.sh
   ```

3. Archive from the repository root. The `Validate Release Configuration`
   build phase stops with a clear error if a value is missing, unexpanded,
   placeholder-like, non-production, or a private/service-role key.
4. Inspect the compiled archive values without printing the key:

   ```bash
   EXPECTED_PINT_PATH_API_BASE_URL=https://pintpath.au \
   EXPECTED_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
   apps/ios/Scripts/inspect-release-archive.sh /path/to/BeerMap.xcarchive
   ```

5. Remove `apps/ios/Config.xcconfig` when the release session is finished.

Native Apps CI builds an unsigned Release archive with clearly synthetic
key material and the pinned production origin on every pull request and main
push, then inspects the archived `Info.plist`. A manual `workflow_dispatch`
additionally runs the protected
`production` environment job using `SUPABASE_URL` and `SUPABASE_ANON_KEY`
secrets. That unsigned CI artifact validates configuration only; it is not the
signed App Store candidate.

### App Store release evidence

The `ios_release` gate passes only for one build bound to the exact frozen
candidate SHA. The release evidence must include the source SHA, version/build,
signed archive and exported IPA SHA-256 values, Organizer validation, and the
signed physical-device matrix. An unsigned CI archive or an internal TestFlight
upload is not release evidence.

Distribute that same signed build to an external TestFlight group and pass Beta
App Review before submitting it for full App Review. The final gate requires
full App Review approval for the same build, the Australia storefront selected,
manual release selected, and phased release configured. Keep the approved build
held in App Store Connect until every web-and-iOS gate passes and the release
owner authorizes the manual launch; do not replace the binary or change its
frozen backend contract during review.

## Current integration

- Email/password signup, login, refresh, password recovery, and logout use the
  Supabase Auth REST endpoints compiled into the app. The public API config is
  not allowed to redirect native credentials, and there is no legacy-password
  fallback.
- Social provider login is not compiled into the first App Store release; authentication is email/password only.
- Supabase access tokens are exchanged at `POST /api/business/auth/supabase-session`; the scoped Pint Path app credential is delivered only as the `HttpOnly` `Set-Cookie` value and is never returned in JSON.
- Sensitive session/export/deletion actions require fresh authentication; a rejected action is never reported as complete.
- Purchase, checkout, subscription-management, and billing-recovery code is not compiled into the iOS release.
- The Pint Path session-cookie credential plus Supabase refresh and access tokens are stored in Keychain as `WhenUnlockedThisDeviceOnly`. Pint Path API calls send the stored app credential only as a cookie; a non-Keychain installation marker clears surviving Keychain sessions after reinstall.
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
