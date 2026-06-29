# BeerMap Native Mobile Apps

This branch adds native iOS and Android app projects for the existing BeerMap/Pint Path backend without changing the website.

## What Was Added

- `apps/ios`: SwiftUI iPhone app with an Xcode project.
- `apps/android`: Kotlin + Jetpack Compose Android app with a Gradle project.
- `MOBILE_APP_IMPLEMENTATION_PLAN.md`: implementation plan written before app code.
- `MOBILE_APP_STORE_CHECKLIST.md`: App Store and Play Store readiness checklist.

## Source Of Truth

The website and Express API remain the source of truth. Both native apps call the existing `/api/business/*` endpoints:

- Config: `/api/business/config`
- Auth: `/api/business/auth/signup`, `/api/business/auth/login`, `/api/business/auth/logout`
- Account: `/api/business/account`, privacy settings, deletion request, saved items
- Public discovery: `/api/business/venues`, `/api/business/price-records`, `/api/business/missions`
- Venue management: `/api/business/venue-portal`, profile, beers, happy hours, specials
- Analytics and support: `/api/business/events`, `/api/business/feedback`

The apps do not read/write private Supabase tables directly and do not include service-role keys.

## Folder Structure

```text
apps/
  ios/
    BeerMap.xcodeproj
    BeerMap/
      App/
      Features/
      Components/
      Services/
      Models/
      Theme/
      Assets.xcassets/
    Config.example.xcconfig
  android/
    settings.gradle.kts
    build.gradle.kts
    app/
      build.gradle.kts
      src/main/java/au/pintpath/beermap/
      src/main/res/
    local.properties.example
```

## iOS Run Instructions

1. Open `apps/ios/BeerMap.xcodeproj` in Xcode.
2. Select the `BeerMap` scheme.
3. Choose an iPhone simulator.
4. Run.

The app defaults to `https://pintpath.au`. For local development, copy `apps/ios/Config.example.xcconfig` to `Config.xcconfig`, set `PINT_PATH_API_BASE_URL`, and attach it to the target in Xcode build settings.

## Android Run Instructions

1. Install Android Studio.
2. Open the `apps/android` folder.
3. Let Android Studio install/select the Android SDK and JDK.
4. Copy `apps/android/local.properties.example` to `local.properties` only for local overrides.
5. Run on an emulator or Android phone.

For a backend running on your Mac at port 3000, set:

```properties
PINT_PATH_API_BASE_URL=http://10.0.2.2:3000
```

## Testing Main Flows

1. Start the existing backend with its normal environment.
2. Open the native app.
3. Confirm public venue discovery loads.
4. Sign up or log in with the existing account flow.
5. Confirm account dashboard/privacy controls load.
6. Use an assigned venue-manager account to open the bar dashboard.
7. Save a profile, beer row, happy hour, or Pro special and verify the existing website still shows the expected backend state.

## Release Builds

iOS:

- Configure signing team and bundle ID.
- Archive from Xcode.
- Upload through Xcode Organizer or Transporter.

Android:

- Configure signing in Android Studio.
- Build an Android App Bundle with `./gradlew bundleRelease`.
- Upload the `.aab` to Play Console.

## Intentionally Not Touched

The mobile work intentionally does not modify:

- `viewer/`
- `src/`
- `supabase/`
- existing website routes/styles
- database schema/migrations
- existing tests

