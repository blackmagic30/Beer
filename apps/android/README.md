# BeerMap Android

Native Android app for the existing BeerMap/Pint Path backend, built with Kotlin, Jetpack Compose, Material 3, and Gradle. Continue this app in place; do not create a duplicate Android project.

## Open In Android Studio

1. Install Android Studio.
2. Open the `apps/android` folder.
3. Let Android Studio install or select the Android SDK.
4. Copy `local.properties.example` to `local.properties` only if you need local overrides.
5. Press Run and choose a phone emulator.

The app defaults to `https://pintpath.au`. For a local backend, set:

```properties
PINT_PATH_API_BASE_URL=http://10.0.2.2:3000
```

`10.0.2.2` is the Android emulator route to your Mac localhost.

## Build

From `apps/android`, run:

```bash
./gradlew assembleDebug
./gradlew bundleRelease
```

## Backend Contract

The app calls the same Express API as the website:

- `GET /api/business/config`
- `POST /api/business/auth/signup`
- `POST /api/business/auth/login`
- `GET /api/business/account`
- `GET /api/business/venues`
- `GET /api/business/price-records`
- `GET /api/business/venue-portal`
- `POST /api/business/venue-portal/:venueId/profile`
- `POST /api/business/venue-portal/:venueId/beers`
- `POST /api/business/venue-portal/:venueId/happy-hours`
- `POST /api/business/venue-portal/:venueId/specials`
- `POST /api/business/submissions`
- `POST /api/business/wrong-price-reports`
- `POST /api/business/requests`
- `POST /api/business/events`

The Android app stores the Pint Path bearer token in private app preferences. It does not read or write private Supabase tables directly.

## Native Screens

- Discover
- Account
- Add
- Bars
- Settings

The Add tab covers reviewed beer-price submissions, wrong-price reports, missing venue/beer requests, and mission browsing. Photo evidence, one-time location proof, native OAuth, billing, and reward/POS flows are not wired yet.
