# Mobile Status Report

Date: 2026-07-13
Branch inspected: `main`
Baseline note: before this report was written, `git status --short --branch` showed a clean branch tracking `origin/codex/mobile-apps-ios-android`.

## Executive Summary

Mobile app work already exists. Do not create another mobile app.

The repository contains two native mobile projects:

- `apps/ios`: a SwiftUI iPhone app named `BeerMap`.
- `apps/android`: a Kotlin Jetpack Compose Android app named `BeerMap`.

These are not React Native, Expo, Capacitor, or WebView wrappers. They are first-pass native apps that call the existing Pint Path/BeerMap Express API and preserve the current website as the source of truth.

The mobile apps are substantial but not release-complete. They implement native discovery, account auth, account/privacy controls, support feedback, saved venues, price reveal calls, reviewed contribution entry points, photo/source uploads through the system picker, happy-hour submissions, rotating member/reward code generation, and venue-manager portal editing with the newer daily specials planner data. Missing work includes the real map experience, native Google/Apple OAuth, camera capture, multi-image/PDF upload, one-time location proof, billing portals, admin tools, mobile POS redemption workflows, native build verification on a fully provisioned machine, mobile CI, final signing, screenshots, and final store metadata.

## July 2026 App-Store Continuation Update

After the web app received significant updates, the existing native apps were continued in place and reshaped around the updated source-of-truth backend.

Completed in this pass:

- Reworked native navigation to task-first tabs: Find, Add, Bars, Account, Help.
- Added iOS photo/source upload using `PhotosPicker`, resized/compressed JPEG evidence, and `photo_upload` submissions.
- Added Android photo/source upload using the system photo picker, JPEG compression where possible, and `photo_upload` submissions.
- Added native happy-hour contribution forms on iOS and Android using the existing `happy_hour_update` submission type.
- Added account-level rotating Pint Path special code generation through `POST /api/business/account/discount-pass`.
- Added account-level Free Pint Reward code generation through `POST /api/business/account/free-pint-reward-code`.
- Added iOS and Android account cards for estimated savings, Pint Points, active code display, reward states, and safety copy.
- Added iOS and Android parsing/rendering for venue `dailySpecialsPlanner`, venue redemption summary, and venue Pint Points threshold data.
- Kept changes isolated to existing native app folders and mobile documentation.

Still intentionally unfinished after this pass:

- Native Google/Apple OAuth.
- Native map with pins/clustering/nearby behavior.
- Native camera capture, multi-image upload, PDF source upload, and offline upload queue.
- Native one-time location proof for contribution points.
- Billing/customer portal and checkout handling.
- Venue POS redemption actions beyond displaying user codes and venue metrics.
- Monthly report CSV/JSON download/share handling.
- Admin review and beer catalog tools.
- Android encrypted token storage upgrade.
- Native CI, full Xcode build, Android Gradle build, simulator/emulator QA, and UI tests.

## Continuation Update

This report has been updated after continuing the existing mobile app work in place. No duplicate mobile app was created.

Completed in this continuation:

- Added a native iOS Add/Contribute tab through `apps/ios/BeerMap/Features/ContributeView.swift`.
- Added a native Android Add/Contribute tab inside the existing Compose app.
- Wired both platforms to existing backend contribution endpoints:
  - `POST /api/business/submissions`
  - `POST /api/business/wrong-price-reports`
  - `POST /api/business/requests`
- Kept submissions attached to the existing bearer-session account flow.
- Added missing venue/beer request UI and mission browsing to mobile.
- Kept photo evidence and upload-location proof clearly stubbed/documented as website-only in this pass.
- Changed signup consent controls so 18+, Terms, and Privacy start unchecked on both platforms.
- Added Instagram URL editing to Android venue profiles to match iOS/contact-info parity.
- Added default iOS API build settings and safer Android BuildConfig string escaping.
- Updated mobile-local ignore rules for local config, build output, user data, and signing artifacts.
- Updated mobile setup docs and added `QA_REPORT.md`.

Premium UI/UX polish pass completed afterward:

- Improved shared iOS SwiftUI and Android Compose component systems for cards, section headers, buttons, banners, loading, form fields, feature rows, metric cards, and empty states.
- Refined Discover/Home hierarchy so the native apps feel warmer and more app-like while preserving BeerMap/Pint Path copy and flows.
- Improved login/signup presentation, explicit consent context, and email/password form grouping without changing backend auth behavior.
- Added logout confirmation on iOS and Android, while preserving the existing account-deletion review confirmation path.
- Improved bar owner navigation with scrollable section chips and clearer venue dashboard/editor states.
- Added clearer empty states for beer stock, happy hours, specials, missions, submissions, and price rows.
- Improved settings/support/safety presentation and touch-target consistency.
- Kept the pass isolated to native mobile app files and mobile reporting docs.

## 1. Whether An iOS App Already Exists

Yes.

The iOS app lives at:

- `apps/ios/BeerMap.xcodeproj`
- `apps/ios/BeerMap/`

Key iOS files inspected:

- `apps/ios/BeerMap/App/BeerMapApp.swift`
- `apps/ios/BeerMap/Features/RootView.swift`
- `apps/ios/BeerMap/Features/DiscoverView.swift`
- `apps/ios/BeerMap/Features/AuthView.swift`
- `apps/ios/BeerMap/Features/AccountView.swift`
- `apps/ios/BeerMap/Features/VenuePortalView.swift`
- `apps/ios/BeerMap/Features/SettingsView.swift`
- `apps/ios/BeerMap/Services/BeerMapAPI.swift`
- `apps/ios/BeerMap/Services/KeychainSessionStore.swift`
- `apps/ios/BeerMap/Models/BeerMapModels.swift`
- `apps/ios/BeerMap/Info.plist`

The Xcode project references the Swift source files in its source build phase.

## 2. Whether An Android App Already Exists

Yes.

The Android app lives at:

- `apps/android/settings.gradle.kts`
- `apps/android/build.gradle.kts`
- `apps/android/app/`

Key Android files inspected:

- `apps/android/app/src/main/java/au/pintpath/beermap/MainActivity.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/ui/features/BeerMapApp.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/data/Models.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/data/SessionStore.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/ui/components/Components.kt`
- `apps/android/app/src/main/AndroidManifest.xml`
- `apps/android/app/build.gradle.kts`

## 3. Mobile Framework / Technology Used

iOS:

- Native Swift
- SwiftUI
- Xcode project
- `URLSession` API client
- Keychain-backed bearer token storage

Android:

- Native Kotlin
- Jetpack Compose
- Material 3
- Gradle Android application project
- `HttpURLConnection` API client with coroutines
- Private app `SharedPreferences` for bearer token storage

Website/source-of-truth stack:

- Node.js 22+
- TypeScript
- Express 5
- Zod
- SQLite/local repository classes
- Static HTML/CSS/JS viewer pages under `viewer/`
- Supabase Auth as an optional OAuth bridge
- Supabase migrations/storage policies for account/contribution foundations

## 4. Native, React Native, Expo, Capacitor, WebView, Or Something Else

The existing mobile work is native.

- iOS is native SwiftUI.
- Android is native Kotlin/Compose.
- No React Native, Expo, Capacitor, Cordova, or WebView mobile app folders were found.
- No duplicate root-level `ios`, `android`, `mobile`, or `app` mobile project exists. The only detected mobile app directories are `apps/ios` and `apps/android`.

## 5. Main Screens / Features Already Implemented

iOS implemented screens and flows:

- Five-tab native navigation:
  - Find
  - Add
  - Bars
  - Account
  - Help
- Public app startup load:
  - `GET /api/business/config`
  - `GET /api/business/venues`
  - `GET /api/business/missions`
- Venue discovery list and search.
- Venue detail view.
- Server-gated price reveal via `GET /api/business/price-records`.
- Save venue via `POST /api/business/account/saved-items`.
- Email/password login.
- Email/password signup.
- Bearer token persistence in Keychain.
- Account dashboard.
- Rotating Pint Path special code display.
- Free Pint Reward code display.
- Privacy settings update.
- Account deletion review request.
- Reviewed single beer-price submission.
- Reviewed photo/source upload submission.
- Reviewed happy-hour update submission.
- Wrong-price report.
- Missing venue/beer request.
- Mission browsing.
- Support feedback form.
- Venue-manager dashboard.
- Assigned-venue picker.
- Venue profile editor.
- Beer row editor.
- Happy-hour editor.
- Pro special editor when allowed by tier.
- Basic analytics/report cards for venue managers.
- Daily specials planner cards for venue managers when returned by the backend.
- Venue redemption and Pint Points summary cards.
- Optional analytics event tracking through `/api/business/events`.

Android implemented screens and flows:

- Five-tab native navigation:
  - Find
  - Add
  - Bars
  - Account
  - Help
- Public app startup load:
  - `GET /api/business/config`
  - `GET /api/business/venues`
  - `GET /api/business/missions`
- Venue discovery list and search.
- Venue detail card with price rows.
- Server-gated price reveal via `GET /api/business/price-records`.
- Save venue via `POST /api/business/account/saved-items`.
- Email/password login.
- Email/password signup.
- Bearer token persistence.
- Account dashboard.
- Rotating Pint Path special code display.
- Free Pint Reward code display.
- Privacy settings update.
- Account deletion review request.
- Reviewed single beer-price submission.
- Reviewed photo/source upload submission.
- Reviewed happy-hour update submission.
- Wrong-price report.
- Missing venue/beer request.
- Mission browsing.
- Support feedback form.
- Venue-manager dashboard.
- Basic assigned-venue switching.
- Venue profile editor.
- Beer row editor.
- Happy-hour editor.
- Pro special editor when allowed by tier.
- Basic analytics/report cards for venue managers.
- Daily specials planner cards for venue managers when returned by the backend.
- Venue redemption and Pint Points summary cards.
- Optional analytics event tracking through `/api/business/events`.

## 6. Main Screens / Features Missing Compared With The Website

Missing or only partially represented compared with the current website:

- Real map UI with pins, clustering, overlays, filters, user radius, and Google Maps behavior from `viewer/index.html`.
- Full venue/detail experience from the website, including all sorting/filtering and map rail behavior.
- Full contributor submission flow from `viewer/submit.html`; native now covers single beer-price, photo/source image upload, and happy-hour update submissions, but not full multi-row venue updates, PDFs, drafts, offline queueing, or new-venue Google lookup.
- Camera capture, multi-photo/PDF source evidence upload, and saved source-upload queue.
- Intentional upload-location proof flow.
- Full missions board behavior beyond native mission browsing.
- Native Google/Apple OAuth.
- Supabase password reset, resend confirmation, and OAuth callback handling.
- Billing checkout and subscription management.
- Venue-side discount redemption, Pint Points recording, and POS flows.
- POS integration screens.
- Venue QR/update-link tooling beyond displaying basic portal information.
- Monthly report export/download handling.
- Deeper venue intelligence screens beyond the mobile daily specials planner summary.
- Admin dashboard/review queues.
- Beer catalog review/admin flows.
- Account export flow.
- Delete saved item flows.
- Saved beers/suburbs/night plans.
- Native camera capture and PDF picker integration.
- Native location permission/use flow.
- Deep links/universal links/app links.
- App store release metadata and screenshots.
- Native mobile tests or CI.

## 7. Backend / Auth / Supabase Integration Status

Current website/backend source of truth:

- The canonical API is the Express `/api/business/*` router.
- The website stores a Pint Path bearer session token in browser local storage and sends `Authorization: Bearer <token>`.
- Supabase Auth is optional for OAuth/email flows on the website.
- Supabase OAuth sessions can be exchanged for a local Pint Path session via `POST /api/business/auth/supabase-session`.
- Direct browser/mobile writes to private Supabase tables are not the production contribution path. The canonical contribution/review path is Express API first.
- Supabase service-role keys remain server-side only.

Mobile integration:

- Both native apps call the existing Express API rather than direct Supabase tables.
- Both apps use the same bearer-token model as the website after email/password login/signup.
- iOS stores the bearer token in Keychain.
- Android stores the bearer token in app-private `SharedPreferences`; this is functional but should be upgraded to encrypted storage before release.
- Reviewed mobile contribution calls now use the Express API, not direct Supabase writes.
- iOS has a `syncSupabase(accessToken:)` API method, but no native OAuth UI is wired to call it.
- Android has Supabase public config fields but no native Supabase OAuth/session-exchange flow implemented.
- No service-role key was found embedded in the mobile projects.

Backend route compatibility checked:

- `/api/business/config` exists.
- `/api/business/auth/signup` exists.
- `/api/business/auth/login` exists.
- `/api/business/auth/supabase-session` exists.
- `/api/business/auth/logout` exists.
- `/api/business/account` exists.
- `/api/business/account/privacy-settings` exists.
- `/api/business/account/delete-request` exists.
- `/api/business/account/saved-items` exists.
- `/api/business/venues` exists.
- `/api/business/price-records` exists.
- `/api/business/missions` exists.
- `/api/business/feedback` exists.
- `/api/business/events` exists.
- `/api/business/venue-portal` exists.
- `/api/business/venue-portal/:venueId/profile` exists.
- `/api/business/venue-portal/:venueId/beers` exists.
- `/api/business/venue-portal/:venueId/happy-hours` exists.
- `/api/business/venue-portal/:venueId/specials` exists.
- `/api/business/submissions` exists.
- `/api/business/wrong-price-reports` exists.
- `/api/business/requests` exists.

## 8. UI Polish Status

Status: improved app-store candidate, still needs device QA and native build confirmation.

What is good:

- Both apps use native UI rather than a thin web wrapper.
- The screens are coherent and aligned with Pint Path/BeerMap concepts.
- The apps use a consistent color system.
- The navigation model is simple and understandable.
- Venue-manager tools are present instead of only consumer browsing.

What needs polish:

- No native map visualization yet.
- No final screenshot/accessibility pass.
- No confirmed VoiceOver/TalkBack pass.
- No final responsive/device QA.
- App icon/launch assets appear present but are still treated as placeholders in docs.
- Signup requires explicit 18+/Terms/Privacy toggles on both platforms.
- Native system photo-picker source upload is wired on both platforms.
- Camera capture, PDF upload, and one-time location proof are not wired yet.
- Settings screens describe location behavior that is not yet wired into native location-proof workflows.

## 9. Build Status

Build files exist.

iOS build setup:

- Xcode project exists at `apps/ios/BeerMap.xcodeproj`.
- Bundle ID placeholder/current value: `au.pintpath.beermap`.
- iOS deployment target: 17.0.
- Swift version in project settings: 6.0.
- App display name: `BeerMap`.
- Signing team is blank.
- `Config.example.xcconfig` exists, and local `Config.xcconfig` is intentionally ignored.
- Default API base URL falls back to `https://pintpath.au` if config is not attached.

Android build setup:

- Gradle wrapper exists under `apps/android`.
- Android Gradle plugin: 8.7.3.
- Kotlin plugin: 2.0.21.
- Compile SDK: 35.
- Min SDK: 26.
- Target SDK: 35.
- Application ID: `au.pintpath.beermap`.
- Version: `0.1.0` / `versionCode 1`.
- Default API base URL: `https://pintpath.au`.

Build verification:

- `xcodebuild -list -project apps/ios/BeerMap.xcodeproj` was attempted, but the active developer directory is Command Line Tools rather than full Xcode.
- `xcrun simctl list devices available` was attempted, but `simctl` is unavailable with the current developer tools selection.
- `./gradlew assembleDebug` was attempted from `apps/android`, but no Java Runtime is installed.
- Because the local machine lacks full Xcode/simulator tooling and a JDK, native compiler success is not confirmed in this audit.
- There is no GitHub Actions workflow for native iOS or Android builds. Existing CI only covers the Node/TypeScript website/backend.

## 10. Known Errors / Issues

Confirmed by inspection:

- Native Google/Apple OAuth is not implemented.
- Android token storage is app-private `SharedPreferences`, not encrypted storage.
- Native contribution flow is partial: single beer-price submissions, photo/source image upload, happy-hour update submissions, wrong-price reports, missing venue/beer requests, and missions exist; full venue updates, PDF/multi-image upload, camera capture, offline queueing, and saved upload-location proof are still missing.
- Native billing, venue-side POS/redemption, admin, and report export flows are missing.
- Native account rewards are partial: rotating Pint Path special codes and Free Pint Reward code display are wired, but QR rendering, app deep links, and venue staff redemption workflows still need device testing and product decisions.
- No native mobile tests were found.
- No native CI workflow was found.
- Native builds were attempted but blocked by missing full Xcode/simulator tooling and missing Java Runtime.
- Store signing/provisioning is not configured.
- Native OAuth redirect/deep link setup is not complete.
- Local mobile config/build/signing files are now explicitly ignored:
  - `apps/android/local.properties`
  - `apps/android/**/build/`
  - `apps/android/**/*.jks`
  - `apps/android/**/*.keystore`
  - `apps/ios/Config.xcconfig`
  - Xcode `xcuserdata`
  - Android `.gradle`

Potential risk, not confirmed as a failure:

- The branch contains broad website/backend changes after `main`, so mobile app readiness should not be judged separately from the current branch's website/backend state.
- The native models only cover a subset of backend response data. That is acceptable for a first pass, but richer website parity will require expanding models and screens.

## 11. Duplicate Or Messy Files / Folders

No duplicate mobile app project was found.

Found mobile folders:

- `apps/ios`
- `apps/android`

Not found:

- root `ios`
- root `android`
- root `mobile`
- root `app` as a mobile project
- Expo project
- React Native project
- Capacitor project
- Cordova project

Messy/risky areas:

- Root-level mobile docs exist alongside platform-specific READMEs:
  - `MOBILE_APP_IMPLEMENTATION_PLAN.md`
  - `MOBILE_APP_README.md`
  - `MOBILE_APP_STORE_CHECKLIST.md`
  - `apps/ios/README.md`
  - `apps/android/README.md`
  This is not a duplicate app, but future updates should keep these docs synchronized.
- `.gitignore` does not explicitly cover several mobile-local and signing-related files.
- Ignored `viewer/config.js` exists locally with placeholder values. It is not tracked, and no real key was observed in it.

## 12. Whether The Main Website Was Modified

Yes, relative to `main`, this branch contains website/backend changes.

Important distinction:

- This continuation did not intentionally modify `viewer/`, `src/`, `scripts/`, `test/`, or Supabase files.
- The only non-mobile-code/non-mobile-doc root file touched in this continuation is `.gitignore`, to ignore mobile local config/build/signing files.
- Final worktree status currently shows unrelated website diffs in `viewer/business.css`, `viewer/index.html`, `viewer/pricing.html`, `viewer/trust.html`, and `viewer/venue-portal.html`. They were not made as part of the mobile work and should be reviewed separately before staging.
- The branch itself already contains changes to website, backend, scripts, tests, and docs compared with `main`.

Changed website-facing files relative to `main` include:

- `viewer/account.html`
- `viewer/admin.html`
- `viewer/business.css`
- `viewer/business.js`
- `viewer/index.html`
- `viewer/submit.html`
- `viewer/venue-portal.html`

Changed backend/script/test files relative to `main` include:

- `package.json`
- `package-lock.json`
- `scripts/queue-menu-crawler-results.ts`
- `scripts/security-scan.mjs`
- `src/app.ts`
- `src/db/admin-ingestion-queue.repository.ts`
- `src/db/beer-catalog.repository.ts`
- `src/db/business.repository.ts`
- `src/db/database.ts`
- `src/db/models.ts`
- `src/db/schema.sql`
- `src/middleware/error-handler.ts`
- `src/middleware/not-found.ts`
- `src/modules/admin/admin.routes.ts`
- `src/modules/admin/admin.service.ts`
- `src/modules/business/business.routes.ts`
- `src/modules/business/business.schemas.ts`
- `src/modules/business/business.service.ts`
- multiple `test/*.test.ts` files

The initial mobile commit was `c1bfa8c Add mobile apps and venue intelligence tools`, but subsequent commits also changed website/backend behavior.

## 13. Whether Any Website Changes Look Risky

Risk status: medium, because the branch includes broad website/backend changes, not because a specific broken website change was confirmed in this inspection.

What looks intentional:

- The branch history shows mobile apps, venue intelligence, rate-limit hardening, query redaction, dashboard polish, beer catalog normalization, and approved venue publishing fixes.
- Tests were added/updated for several backend and viewer behaviors.

What is risky:

- The diff from `main` is large: thousands of lines across viewer pages, CSS, backend routes/services, schema, scripts, and tests.
- `viewer/business.css`, `viewer/admin.html`, `viewer/index.html`, and `viewer/venue-portal.html` changed heavily.
- Mobile app work was committed alongside venue intelligence and admin/backend work, so it is harder to review mobile in isolation.
- Package lock changes exist.
- No build/test run was performed in this audit, so current website safety is not newly verified by this report.

Recommended handling:

- Preserve the existing mobile apps.
- Do not start another mobile implementation.
- Before any release/merge, run the existing website/backend verification suite and native mobile builds.
- If possible, split future mobile fixes from unrelated website/backend work.

## 14. Recommended Next Steps

1. Preserve `apps/ios` and `apps/android` as the existing mobile apps.
2. Do not create a duplicate app or rewrite from scratch.
3. Run build verification on a machine with full Xcode and a JDK:
   - iOS: `xcodebuild -project apps/ios/BeerMap.xcodeproj -scheme BeerMap -destination 'platform=iOS Simulator,name=iPhone 15' build`
   - Android: from `apps/android`, run `./gradlew assembleDebug`
   - Website/backend: run the repo's normal `npm run check` or release-readiness suite.
4. Fix any compile/runtime errors found by those builds.
5. Upgrade Android token storage to encrypted storage before release.
6. Implement native Google/Apple OAuth only after bundle IDs, redirect URLs, provider console settings, and deep links are finalized.
7. Add the remaining mobile source-of-truth flows in priority order:
   - real map/filter experience
   - camera/PDF/multi-image source evidence flow
   - opt-in location flow
   - billing/subscription flow
   - venue report export/download
   - venue-side rewards/discount/POS flows if mobile release scope needs them
8. Add mobile CI for at least Android debug build and iOS simulator build.
9. Add smoke tests or snapshot/UI tests for critical auth, discovery, contribution, and venue-manager flows.
10. Finish store prep:
   - final app icons
   - screenshots
   - signing/provisioning
   - reviewer accounts
   - privacy/data-safety disclosures
   - alcohol/responsible-use review notes
   - app links/deep links if needed

## Final Determination

The mobile app work already exists and should be preserved. The current state is best described as a native iOS and Android implementation wired to the existing Pint Path/BeerMap backend, with discovery, auth, account, contribution, venue-owner, and settings coverage, but not yet a production-ready store release.

The next work should be build verification on a fully provisioned machine, incremental hardening, missing-flow implementation, and UI/compliance polish inside the existing `apps/ios` and `apps/android` projects.
