# Website Protection Report

Date: 2026-06-30
Current branch: `codex/mobile-apps-ios-android`
Base branch used for comparison: `origin/main`
Merge base: `10da5155a7401f0ee617e68b94c62b356b763ddf`

## Summary

The current mobile continuation is isolated from the tracked website/backend files.

After inspection, I found tracked uncommitted website/test drift that was unrelated to mobile work. I restored those files to the current branch HEAD:

- `viewer/business.css`
- `viewer/business.js`
- `viewer/index.html`
- `viewer/pricing.html`
- `viewer/trust.html`
- `viewer/venue-portal.html`
- `test/account-page.test.ts`
- `test/pricing-entitlements.test.ts`
- `test/viewer-map-logic.test.ts`

After that cleanup, this command returned no tracked website/backend/test diffs:

```bash
git diff --name-only HEAD -- viewer src scripts test supabase package.json package-lock.json railway.toml README.md docs .github
```

Important distinction: this branch already contains older committed website/backend work relative to `origin/main`. Those committed changes were not created by the mobile UI polish pass and were not reverted here because they are existing branch history. The current uncommitted mobile work no longer touches tracked website, backend, database, or test files.

## Files Changed

### Current Uncommitted Worktree After Cleanup

Mobile app files:

- `apps/android/app/build.gradle.kts`
- `apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/ui/components/Components.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/ui/features/BeerMapApp.kt`
- `apps/android/local.properties.example`
- `apps/ios/BeerMap.xcodeproj/project.pbxproj`
- `apps/ios/BeerMap/App/BeerMapApp.swift`
- `apps/ios/BeerMap/Components/ReusableViews.swift`
- `apps/ios/BeerMap/Features/AccountView.swift`
- `apps/ios/BeerMap/Features/AuthView.swift`
- `apps/ios/BeerMap/Features/ContributeView.swift`
- `apps/ios/BeerMap/Features/DiscoverView.swift`
- `apps/ios/BeerMap/Features/RootView.swift`
- `apps/ios/BeerMap/Features/SettingsView.swift`
- `apps/ios/BeerMap/Features/VenuePortalView.swift`
- `apps/ios/BeerMap/Models/BeerMapModels.swift`
- `apps/ios/BeerMap/Services/BeerMapAPI.swift`
- `apps/ios/BeerMap/Theme/AppTheme.swift`
- `apps/ios/Config.example.xcconfig`

Mobile docs:

- `MOBILE_APP_README.md`
- `MOBILE_STATUS_REPORT.md`
- `QA_REPORT.md`
- `apps/android/README.md`
- `apps/ios/README.md`
- `WEBSITE_PROTECTION_REPORT.md`

Shared config:

- `.gitignore`

Website files:

- `MAIN_WEBSITE_AUDIT.md` (untracked report file, non-runtime)
- `MAIN_WEBSITE_POLISH_REPORT.md` (untracked report file, non-runtime)

Backend/database files:

- None in the current uncommitted worktree after cleanup.

### Branch Changes Relative To `origin/main`

Mobile app files:

- `apps/android/app/build.gradle.kts`
- `apps/android/app/src/main/AndroidManifest.xml`
- `apps/android/app/src/main/java/au/pintpath/beermap/MainActivity.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/data/Models.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/data/SessionStore.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/ui/components/Components.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/ui/features/BeerMapApp.kt`
- `apps/android/app/src/main/java/au/pintpath/beermap/ui/theme/Theme.kt`
- `apps/android/app/src/main/res/drawable/ic_launcher_background.xml`
- `apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml`
- `apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
- `apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml`
- `apps/android/app/src/main/res/values/colors.xml`
- `apps/android/app/src/main/res/values/strings.xml`
- `apps/android/app/src/main/res/values/themes.xml`
- `apps/android/app/src/main/res/xml/backup_rules.xml`
- `apps/android/app/src/main/res/xml/data_extraction_rules.xml`
- `apps/android/build.gradle.kts`
- `apps/android/gradle/wrapper/gradle-wrapper.jar`
- `apps/android/gradle/wrapper/gradle-wrapper.properties`
- `apps/android/gradlew`
- `apps/android/gradlew.bat`
- `apps/android/local.properties.example`
- `apps/android/settings.gradle.kts`
- `apps/ios/BeerMap.xcodeproj/project.pbxproj`
- `apps/ios/BeerMap/App/BeerMapApp.swift`
- `apps/ios/BeerMap/Assets.xcassets/AccentColor.colorset/Contents.json`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-20@2x.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-20@3x.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-29@2x.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-29@3x.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-40@2x.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-40@3x.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-60@2x.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/AppIcon-60@3x.png`
- `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/Contents.json`
- `apps/ios/BeerMap/Assets.xcassets/Contents.json`
- `apps/ios/BeerMap/Assets.xcassets/LaunchBackground.colorset/Contents.json`
- `apps/ios/BeerMap/Components/ReusableViews.swift`
- `apps/ios/BeerMap/Features/AccountView.swift`
- `apps/ios/BeerMap/Features/AuthView.swift`
- `apps/ios/BeerMap/Features/DiscoverView.swift`
- `apps/ios/BeerMap/Features/RootView.swift`
- `apps/ios/BeerMap/Features/SettingsView.swift`
- `apps/ios/BeerMap/Features/VenuePortalView.swift`
- `apps/ios/BeerMap/Info.plist`
- `apps/ios/BeerMap/Models/BeerMapModels.swift`
- `apps/ios/BeerMap/Services/BeerMapAPI.swift`
- `apps/ios/BeerMap/Services/KeychainSessionStore.swift`
- `apps/ios/BeerMap/Theme/AppTheme.swift`
- `apps/ios/Config.example.xcconfig`

Mobile docs:

- `MOBILE_APP_IMPLEMENTATION_PLAN.md`
- `MOBILE_APP_README.md`
- `MOBILE_APP_STORE_CHECKLIST.md`
- `apps/android/README.md`
- `apps/ios/README.md`

Shared config/tooling:

- `package.json`
- `package-lock.json`
- `scripts/security-scan.mjs`

Website files and website tests:

- `test/account-page.test.ts`
- `test/admin-ingestion-queue.test.ts`
- `test/admin-places.test.ts`
- `test/beer-catalog.test.ts`
- `test/business-demo.test.ts`
- `test/business-routes-hardening.test.ts`
- `test/error-handler.test.ts`
- `test/manual-capture.test.ts`
- `test/submit-page.test.ts`
- `test/viewer-map-logic.test.ts`
- `viewer/account.html`
- `viewer/admin.html`
- `viewer/business.css`
- `viewer/business.js`
- `viewer/index.html`
- `viewer/submit.html`
- `viewer/venue-portal.html`

Backend/database files:

- `scripts/queue-menu-crawler-results.ts`
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

Backend/database files not changed:

- No `supabase/` files are changed relative to `origin/main`.

## Website Files Touched

Current uncommitted tracked website files touched by the mobile continuation:

- None after cleanup.

Website files changed in committed branch history relative to `origin/main`:

- `viewer/account.html`
  - Touched by `9f02344 Polish role dashboards and map fallback`.
  - Why: committed branch work for role dashboard/dashboard-link polish and map fallback behavior.
- `viewer/admin.html`
  - Touched by `c1bfa8c Add mobile apps and venue intelligence tools`, `9f02344 Polish role dashboards and map fallback`, `a5ff972 Harden role dashboard UX gaps`, and `bf81140 Fix approved venue publishing and beer catalog review`.
  - Why: committed admin/source-review, role-dashboard, approved venue publishing, and beer catalog review work.
- `viewer/business.css`
  - Touched by `c1bfa8c`, `9f02344`, `a5ff972`, and `bf81140`.
  - Why: committed styling for venue intelligence, dashboards, admin review, source review, and beer catalog review surfaces.
- `viewer/business.js`
  - Touched by `c1bfa8c Add mobile apps and venue intelligence tools`.
  - Why: committed venue intelligence/browser behavior work from the earlier branch scope.
- `viewer/index.html`
  - Touched by `9f02344 Polish role dashboards and map fallback`, `a5ff972 Harden role dashboard UX gaps`, and `3668357 Standardize beer catalogue naming`.
  - Why: committed map/dashboard fallback polish and beer catalogue naming standardization.
- `viewer/submit.html`
  - Touched by `bf81140 Fix approved venue publishing and beer catalog review`.
  - Why: committed approved venue publishing and beer catalog review flow fixes.
- `viewer/venue-portal.html`
  - Touched by `c1bfa8c`, `9f02344`, `a5ff972`, and `bf81140`.
  - Why: committed venue portal, venue intelligence, role dashboard, approved publishing, and beer catalog review work.

These branch-level website changes are not required by the current uncommitted mobile polish work. They remain because they are already committed branch history. If a pure mobile-only branch is required, the clean path is to create a fresh branch from `origin/main` and cherry-pick/apply only the mobile app commits/files.

## Whether Website Behavior Changed

From the current uncommitted mobile work:

- No tracked website UI, route, style, copy, backend, database, or test files remain changed.
- Website behavior is unchanged by the current mobile continuation after the cleanup.

Relative to `origin/main`:

- Yes, this branch contains older committed website/backend behavior changes.
- Those changes are branch history and not new mobile-polish drift.
- The current website build and full test suite pass on this branch after cleanup.

## Build/Test Commands Run

Website commands:

```bash
npm run build
npm test
npm run security:scan
npm run security:audit
```

Website lint:

- No `lint` script exists in `package.json`.

Website isolation commands:

```bash
git diff --name-only HEAD -- viewer src scripts test supabase package.json package-lock.json railway.toml README.md docs .github
git diff --check
```

Mobile commands:

```bash
swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')
plutil -lint apps/ios/BeerMap.xcodeproj/project.pbxproj apps/ios/BeerMap/Info.plist
node -e 'const fs=require("fs"); for (const f of process.argv.slice(1)) { JSON.parse(fs.readFileSync(f,"utf8")); console.log(`${f}: OK`); }' apps/ios/BeerMap/Assets.xcassets/Contents.json apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/Contents.json apps/ios/BeerMap/Assets.xcassets/AccentColor.colorset/Contents.json apps/ios/BeerMap/Assets.xcassets/LaunchBackground.colorset/Contents.json
xcodebuild -list -project apps/ios/BeerMap.xcodeproj
cd apps/android && ./gradlew assembleDebug
```

Secrets/config checks:

```bash
npm run security:scan
npm run security:audit
rg -n --hidden -g '!node_modules/**' -g '!dist/**' -g '!apps/android/gradle/wrapper/gradle-wrapper.jar' -g '!apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/*.png' -e 'service[_-]?role|SUPABASE_SERVICE_ROLE|sk-[A-Za-z0-9]|OPENAI_API_KEY\s*=\s*[^\s#]+|STRIPE_SECRET|PRIVATE_KEY|BEGIN RSA|BEGIN PRIVATE|password\s*=\s*[^\s#]+' .
```

Mobile ignore coverage:

```bash
git check-ignore -v apps/android/local.properties apps/android/app/release.keystore apps/android/app/debug.jks apps/android/app/build/generated/file apps/ios/Config.xcconfig apps/ios/BeerMap.xcodeproj/xcuserdata/zac.xcuserdatad/UserInterfaceState.xcuserstate apps/ios/DerivedData/foo
git ls-files apps/android/local.properties apps/ios/Config.xcconfig 'apps/android/**/*.jks' 'apps/android/**/*.keystore' 'apps/ios/**/*.xcuserdata'
```

## Results

Passed:

- `npm run build`
  - TypeScript build completed successfully.
- `npm test`
  - 23 test files passed.
  - 254 tests passed.
- `npm run security:scan`
  - Passed.
  - 246 tracked/untracked files checked.
- `npm run security:audit`
  - Passed.
  - 0 high-severity vulnerabilities found.
- `git diff --check`
  - Passed with no whitespace errors.
- `git diff --name-only HEAD -- viewer src scripts test supabase package.json package-lock.json railway.toml README.md docs .github`
  - Returned no files after cleanup.
- `swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')`
  - Passed.
- `plutil -lint apps/ios/BeerMap.xcodeproj/project.pbxproj apps/ios/BeerMap/Info.plist`
  - Passed.
- iOS asset catalog JSON parsing
  - Passed.
- Mobile ignored-file coverage
  - Android `local.properties`, Android build output, Android signing files, iOS `Config.xcconfig`, iOS `xcuserdata`, and iOS `DerivedData` are ignored.
  - No local mobile config/signing files are tracked.

Blocked by local environment:

- `xcodebuild -list -project apps/ios/BeerMap.xcodeproj`
  - Blocked because active developer tools are Command Line Tools, not full Xcode.
- `cd apps/android && ./gradlew assembleDebug`
  - Blocked because no Java Runtime is installed.

Secrets:

- Security scan passed.
- `npm audit` passed.
- Raw pattern search found env var names, documented placeholders, test fake keys such as `sk_test_xxx`, and code references to server-side secret variables.
- No real committed mobile secret or service-role key was found.

## Fixes Made

- Restored accidental tracked website/test drift to branch HEAD:
  - `viewer/business.css`
  - `viewer/business.js`
  - `viewer/index.html`
  - `viewer/pricing.html`
  - `viewer/trust.html`
  - `viewer/venue-portal.html`
  - `test/account-page.test.ts`
  - `test/pricing-entitlements.test.ts`
  - `test/viewer-map-logic.test.ts`
- Fixed `.gitignore` mobile coverage:
  - Added `apps/ios/**/xcuserdata/`
  - Added `apps/ios/**/*.xcuserdatad/`
  - Added `apps/ios/**/*.xcuserstate`
- Created this report.

## Remaining Risks

- This branch is not pure-mobile relative to `origin/main`; it already contains committed website/backend work.
- Full iOS build still needs full Xcode selected.
- Full Android build still needs a Java Runtime and Android toolchain.
- Untracked non-runtime website report files remain:
  - `MAIN_WEBSITE_AUDIT.md`
  - `MAIN_WEBSITE_POLISH_REPORT.md`
- Store release QA still requires simulator/device testing, native screenshots, signing, and runtime network smoke tests.

## Confirmation That Mobile Work Is Isolated

Confirmed for the current uncommitted continuation:

- No tracked website runtime files remain changed.
- No tracked backend/database files remain changed.
- No tracked website tests remain changed.
- Mobile app work is isolated to `apps/ios`, `apps/android`, mobile docs, and `.gitignore`.
- The website build and full test suite pass after restoring accidental website/test drift.
