# BeerMap Native Mobile Apps

This repository already contains native mobile apps for the existing BeerMap/Pint Path backend. Continue these projects; do not create duplicate mobile app folders.

## Projects

- iOS: `apps/ios`
  - Swift + SwiftUI
  - Xcode project: `apps/ios/BeerMap.xcodeproj`
  - Session token stored in Keychain
- Android: `apps/android`
  - Kotlin + Jetpack Compose + Material 3
  - Gradle project: `apps/android/settings.gradle.kts`
  - Session token stored in app-private preferences

The mobile apps are not React Native, Expo, Capacitor, Cordova, or WebView wrappers.

## Source Of Truth

The website and Express API remain the source of truth. Native apps call the existing `/api/business/*` endpoints and do not read or write private Supabase tables directly.

Current native API coverage includes:

- Config: `GET /api/business/config`
- Auth: `POST /api/business/auth/signup`, `POST /api/business/auth/login`, `POST /api/business/auth/logout`
- Account: `GET /api/business/account`, privacy settings, deletion request, saved items
- Rewards: rotating Pint Path special codes and Free Pint Reward codes
- Public discovery: `GET /api/business/venues`, `GET /api/business/price-records`, `GET /api/business/missions`
- Contributions: `POST /api/business/submissions`, photo/source uploads, happy-hour updates, wrong-price reports, venue/beer requests
- Venue management: `GET /api/business/venue-portal`, daily specials planner, redemption/Pint Points summaries, profile, beers/stock, happy hours, Pro specials/deals
- Analytics and support: `POST /api/business/events`, `POST /api/business/feedback`

Supabase Auth is still a backend/web OAuth bridge. Native Google/Apple OAuth is intentionally documented as future setup work because it needs final bundle IDs, redirect/deep-link URLs, and provider console configuration. Email/password auth works through the existing Express API.

## Current Native Screens

- Find: venue search/list, detail price reveal, save venue.
- Add: reviewed price submissions, photo/source uploads, happy-hour updates, wrong-price reports, missing venue/beer requests, mission list.
- Bars: invite-only venue dashboard, daily specials planner, redemption/Pint Points summary, profile/contact info, beer stock, happy hours, specials/deals, reports/analytics summary.
- Account: login, signup, account stats, rotating Pint Path special codes, Free Pint Reward codes, privacy controls, deletion request, logout.
- Help: backend config visibility, support message, responsible-use notes.

## UI System

The current native apps use a small shared component layer on each platform for app-store-ready polish:

- iOS: `apps/ios/BeerMap/Theme/AppTheme.swift` and `apps/ios/BeerMap/Components/ReusableViews.swift`
- Android: `apps/android/app/src/main/java/au/pintpath/beermap/ui/theme/Theme.kt` and `apps/android/app/src/main/java/au/pintpath/beermap/ui/components/Components.kt`

Continue polishing through those components first so buttons, cards, form fields, empty states, banners, loading states, and owner workflow sections stay consistent across screens.

## Configuration

No service-role keys or private provider secrets belong in mobile config.

Required for normal hosted testing:

- `PINT_PATH_API_BASE_URL=https://pintpath.au`

Optional public OAuth placeholders for future native OAuth:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

iOS local override:

1. Copy `apps/ios/Config.example.xcconfig` to `apps/ios/Config.xcconfig`.
2. Set `PINT_PATH_API_BASE_URL`.
3. Attach it to the BeerMap target if you need local overrides.

iOS examples:

```xcconfig
PINT_PATH_API_BASE_URL = https:/$()/pintpath.au
PINT_PATH_API_BASE_URL = http:/$()/127.0.0.1:3000
```

Android local override:

1. Copy `apps/android/local.properties.example` to `apps/android/local.properties`.
2. Set `PINT_PATH_API_BASE_URL`.

Android examples:

```properties
PINT_PATH_API_BASE_URL=https://pintpath.au
PINT_PATH_API_BASE_URL=http://10.0.2.2:3000
```

`10.0.2.2` is the Android emulator route to the Mac host.

## Run iOS

1. Install full Xcode, not only Command Line Tools.
2. Open `apps/ios/BeerMap.xcodeproj`.
3. Select the `BeerMap` scheme.
4. Choose an iPhone simulator.
5. Run.

Command-line build, once Xcode is selected:

```bash
xcodebuild -project apps/ios/BeerMap.xcodeproj -scheme BeerMap -destination 'platform=iOS Simulator,name=iPhone 15' build
```

## Run Android

1. Install Android Studio with a JDK and Android SDK.
2. Open `apps/android`.
3. Let Android Studio sync Gradle.
4. Run on an emulator or Android phone.

Command-line build:

```bash
cd apps/android
./gradlew assembleDebug
```

## Known Unfinished Items

- Native Google/Apple OAuth.
- Native map with pins/clustering/nearby behavior.
- Native camera capture, multi-image/PDF source upload, and offline upload queue.
- Native one-time location proof for contribution points.
- Billing/customer portal.
- Venue POS/redemption operations beyond mobile display of user reward/special codes and venue redemption metrics.
- Monthly report CSV/JSON download/share handling.
- Admin review/beer catalog/admin dashboards.
- Mobile CI and native UI tests.
- Android encrypted token storage upgrade before public release.

## Store Prep

See `MOBILE_APP_STORE_CHECKLIST.md`.

Before public release, complete signing, final bundle/package IDs, screenshots, app links/deep links, privacy/data-safety disclosures, reviewer accounts, responsible-alcohol review notes, and native OAuth provider setup if OAuth is enabled.
