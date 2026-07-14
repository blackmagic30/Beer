# Pint Path Native Mobile Implementation Record

Status: **Completed and superseded as an implementation plan on 14 July 2026.** This file records the delivered direction; use `MOBILE_STATUS_REPORT.md`, `MOBILE_APP_README.md`, and the platform READMEs for current operation and release boundaries.

## Delivered architecture

- The existing native projects live in `apps/ios` and `apps/android`; no duplicate app was created.
- Both installed apps are branded **Pint Path**. The Xcode target and Android package/source types retain the internal `BeerMap` name for compatibility.
- iOS is SwiftUI with `URLSession`, Keychain `WhenUnlockedThisDeviceOnly` token storage, MapKit discovery, native forms, and light/dark styling.
- Android is Kotlin/Jetpack Compose with coroutine-backed HTTP calls, Android-Keystore AES-GCM token protection, a venue-list discovery flow, and external maps-app/browser directions.
- Production email/password and Google/Apple sign-in use Supabase Auth. Provider authorization uses PKCE, then `POST /api/business/auth/supabase-session` issues the scoped Pint Path app session.
- The Express `/api/business/*` router remains authoritative for price access, submissions, accounts, venue management, billing, analytics, rewards, and reports. Native clients never read private Supabase tables or carry a service-role key.
- The browser app session now uses an HttpOnly cookie. A local-storage bearer token is read only for one-time legacy migration; it is not the current browser session design.

## Delivered product coverage

1. Public discovery uses the current `/config`, `/venues`, `/price-records`, and `/access` contracts. The server returns either the fixed free preview or entitled full prices.
2. Account flows include signup/login, provider callback, refresh/logout, password recovery, legal acceptance, preferences, sessions, export, deletion, saved items, billing recovery, rewards, and invitations.
3. Contributor flows include reviewed price, selected-photo, and happy-hour submissions, optional one-time location proof, missing venue/beer requests, and mission reserve/release.
4. Assigned venue roles can use profile, stock/beer, happy-hour, eligible special, counter/POS, analytics, planner, report, and billing-recovery surfaces within server-issued authority.
5. Configuration examples are provided through `apps/ios/Config.example.xcconfig` and `apps/android/local.properties.example`; neither app bundles private provider credentials.

## Preserved boundaries

- No WebView wrapper or separate mobile database.
- No direct mobile writes to Supabase tables.
- No service-role keys, signing credentials, App Store Connect keys, Play upload keys, or private OAuth client secrets in the projects.
- Direct camera capture, multiple-image/PDF evidence, offline upload queues, general plan/checkout changes, and native admin moderation remain outside this release.
- iOS uses MapKit; Android intentionally uses an external maps handoff instead of a bundled map SDK/API key.

## Current validation boundary

- `swiftc -parse`, plist/privacy lint, and `test/native-mobile-remediation.test.ts` are the locally available source/contract gates.
- Full Xcode simulator/archive and Android lint/unit/assemble gates run in CI with full Xcode, JDK 17, and the Android SDK.
- Signing, real-device/provider testing, screenshots, reviewer accounts, store metadata, and provider-console approval remain external release-owner gates.
