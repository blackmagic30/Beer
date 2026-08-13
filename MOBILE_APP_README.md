# Pint Path Native Mobile Apps

This repository contains the existing native Pint Path apps. Do not create duplicate iOS or Android projects.

| Platform | Project | UI | Installed name | Internal identifier |
| --- | --- | --- | --- | --- |
| iOS | `apps/ios/BeerMap.xcodeproj` | SwiftUI | Pint Path | `BeerMap`, `au.pintpath.app` |
| Android | `apps/android` | Jetpack Compose | Pint Path | `BeerMap`, `au.pintpath.beermap` |

These are native apps, not WebView, React Native, Expo, or Capacitor wrappers.

## Architecture and authentication

The Express `/api/business/*` API is the product source of truth. Both apps use Supabase Auth REST for email/password, then exchange the Supabase access token for a scoped Pint Path app session at `/api/business/auth/supabase-session`. The iOS release reads the public Supabase origin/key from its compiled configuration, pins the origin to `https://auth.pintpath.au`, and never falls back to sending a password to the Express login endpoint. Android retains Google/Apple authorization-code PKCE code but is outside this launch; launch web OAuth is Google-only, and Apple must remain disabled until authorization-token revocation is implemented and tested. The first-release iOS target compiles provider login out and declares no custom callback scheme. Apps do not access private Supabase tables and never contain service-role keys.

Session storage is device-protected:

- iOS: Keychain with `WhenUnlockedThisDeviceOnly`, plus a fresh-install marker so an uninstalled app cannot silently resurrect an old Keychain session.
- Android: AES-GCM encrypted values backed by Android Keystore; session preferences are excluded from backup and device transfer.

## Current feature coverage

The first-release iOS binary is deliberately limited to:

- public venue discovery, MapKit directions, free price preview, wrong-price reports, and missing-data requests;
- email/password account access, session/privacy controls, export/deletion, support, saved venues, and reviewed price/photo contribution;
- assigned venue-Free profile and beer/stock management.

The iOS Release archive excludes Google/Apple social login, custom auth schemes,
consumer paid entitlement, venue Pro/trial/billing and upgrade links, happy-hour
discovery/submission, rewards/Pub Golf, counter/POS, and admin tooling.

Android retains the broader provider-login and role surfaces described in its own
project README, but Android is not part of the current web plus iOS launch.

## Configuration

Only public configuration belongs in native builds:

- `PINT_PATH_API_BASE_URL`
- `SUPABASE_URL` containing the exact reviewed `https://auth.pintpath.au` origin
- `SUPABASE_ANON_KEY` containing an exact
  `sb_publishable_[A-Za-z0-9_-]{20,220}` value

Both projects reject other Auth origins, legacy JWTs, `sb_secret_` values,
malformed keys, and whitespace before configured values can be packaged. Debug
builds may leave the Supabase fields blank. iOS Release archives and Android
signed release bundles (`bundleRelease`) require the reviewed origin and
publishable key; Android's unsigned maintenance `assembleRelease` build may
leave them blank under its documented CI contract.

Any future Android provider release additionally requires `pintpath://auth-callback` in the Supabase redirect allow list and valid provider-console configuration. Google may be configured for that future release; Apple remains deferred until authorization-token revocation is implemented and tested. Both native password-recovery requests return through the exact HTTPS web callback so it can verify the recovery session before opening password-update mode. The first-release iOS app uses no custom URL scheme; after email confirmation or recovery completes on the web, the user returns to the app and signs in.

iOS local configuration uses `apps/ios/Config.xcconfig`; Android uses `apps/android/local.properties`. Both local files are ignored.

## Known release boundaries

- Android intentionally uses an external maps handoff; iOS has an in-app MapKit map.
- One photo-library image is supported per submission; direct camera capture, multi-image/PDF input, and offline upload queues are not.
- Checkout, plan changes, billing recovery, counter/admin operations, and moderation are web-only for the first iOS release.
- Store signing, provider console verification, real-device QA, accessibility QA, screenshots, reviewer accounts, legal metadata, and final privacy/data-safety declarations require release-owner accounts and devices.

## Verification

```bash
swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')
plutil -lint apps/ios/BeerMap/Info.plist apps/ios/BeerMap/PrivacyInfo.xcprivacy
(cd apps/android && ./gradlew --no-daemon lintDebug lintRelease testDebugUnitTest assembleDebug assembleRelease)
```

Full iOS builds require Xcode; Android builds require JDK 17 and the Android SDK. `.github/workflows/native-apps.yml` runs both platform gates. See `MOBILE_APP_STORE_CHECKLIST.md` for external release work.
