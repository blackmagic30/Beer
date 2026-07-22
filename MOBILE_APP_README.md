# Pint Path Native Mobile Apps

This repository contains the existing native Pint Path apps. Do not create duplicate iOS or Android projects.

| Platform | Project | UI | Installed name | Internal identifier |
| --- | --- | --- | --- | --- |
| iOS | `apps/ios/BeerMap.xcodeproj` | SwiftUI | Pint Path | `BeerMap`, `au.pintpath.app` |
| Android | `apps/android` | Jetpack Compose | Pint Path | `BeerMap`, `au.pintpath.beermap` |

These are native apps, not WebView, React Native, Expo, or Capacitor wrappers.

## Architecture and authentication

The Express `/api/business/*` API is the product source of truth. The apps use Supabase Auth REST for email/password and Google/Apple provider authentication, then exchange the Supabase access token for a scoped Pint Path app session at `/api/business/auth/supabase-session`. Provider login uses authorization-code PKCE. Apps do not access private Supabase tables and never contain service-role keys.

Session storage is device-protected:

- iOS: Keychain with `WhenUnlockedThisDeviceOnly`, plus a fresh-install marker so an uninstalled app cannot silently resurrect an old Keychain session.
- Android: AES-GCM encrypted values backed by Android Keystore; session preferences are excluded from backup and device transfer.

## Current feature coverage

- Public: venue discovery, iOS map/Android external directions, fixed free price preview, wrong-price reports, missing-data requests.
- Contributors: reviewed price/photo/happy-hour submissions, one-time optional location proof, mission reserve/release, progress and rewards.
- Accounts: signup/login/OAuth/logout/refresh/recovery, fresh-authenticated session/export/deletion controls, suspended-account billing-only recovery, saved venues, privacy settings, device sessions, account export, deletion status/cancel, staff invitations.
- Venue managers and counter staff: assigned-venue dashboard, profile, stock/beer prices, happy hours, entitled specials, counter/POS and reward checks, privacy-safe analytics/planner, monthly report export.
- Admins: a server-authority-gated quick-bar tab that hands off to the secure web admin workspace and disappears immediately when current admin authority is absent.
- Claims: secure web handoff for evidence upload and admin verification.

The native clients cover normal-user, contributor, counter-staff, and venue-manager workflows. Admin navigation is native and authority-gated; moderation remains a web-admin responsibility.

## Configuration

Only public configuration belongs in native builds:

- `PINT_PATH_API_BASE_URL`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Google/Apple sign-in additionally requires `pintpath://auth-callback` in the Supabase redirect allow list and valid provider-console configuration.

iOS local configuration uses `apps/ios/Config.xcconfig`; Android uses `apps/android/local.properties`. Both local files are ignored.

## Known release boundaries

- Android intentionally uses an external maps handoff; iOS has an in-app MapKit map.
- One photo-library image is supported per submission; direct camera capture, multi-image/PDF input, and offline upload queues are not.
- General checkout/plan changes and admin moderation are web-only; suspended paid users can open the narrowly scoped billing-recovery portal without receiving app access.
- Store signing, provider console verification, real-device QA, accessibility QA, screenshots, reviewer accounts, legal metadata, and final privacy/data-safety declarations require release-owner accounts and devices.

## Verification

```bash
swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')
plutil -lint apps/ios/BeerMap/Info.plist apps/ios/BeerMap/PrivacyInfo.xcprivacy
(cd apps/android && ./gradlew --no-daemon lintDebug lintRelease testDebugUnitTest assembleDebug assembleRelease)
```

Full iOS builds require Xcode; Android builds require JDK 17 and the Android SDK. `.github/workflows/native-apps.yml` runs both platform gates. See `MOBILE_APP_STORE_CHECKLIST.md` for external release work.
