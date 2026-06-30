# Mobile QA Report

Date: 2026-06-30
Branch: `codex/mobile-apps-ios-android`

## Scope

Continued the existing native mobile apps in:

- `apps/ios`
- `apps/android`

No duplicate mobile app was created. No `viewer/`, `src/`, `scripts/`, `test/`, or Supabase files were modified during this continuation.

This report was also updated after a premium UI/UX polish pass on the existing native mobile apps. That pass focused on app-like hierarchy, reusable UI components, owner workflow polish, loading/empty/error states, destructive-action confirmations, accessibility labels/content descriptions, and light/dark compatible styling without changing backend behavior.

## What Was Checked

Repository state:

```bash
git status --short --branch
```

Initial result:

```text
## codex/mobile-apps-ios-android...origin/codex/mobile-apps-ios-android
?? MOBILE_STATUS_REPORT.md
```

Mobile build checks attempted:

```bash
xcodebuild -list -project apps/ios/BeerMap.xcodeproj
xcrun simctl list devices available
cd apps/android && ./gradlew assembleDebug
```

Static checks run after edits:

```bash
git diff --check
plutil -lint apps/ios/BeerMap.xcodeproj/project.pbxproj apps/ios/BeerMap/Info.plist
node -e 'const fs=require("fs"); for (const f of process.argv.slice(1)) { JSON.parse(fs.readFileSync(f,"utf8")); console.log(`${f}: OK`); }' apps/ios/BeerMap/Assets.xcassets/Contents.json apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset/Contents.json apps/ios/BeerMap/Assets.xcassets/AccentColor.colorset/Contents.json apps/ios/BeerMap/Assets.xcassets/LaunchBackground.colorset/Contents.json
rg -n "ContributeView|PINT_PATH_API_BASE_URL|SUPABASE_URL|SUPABASE_ANON_KEY" apps/ios/BeerMap.xcodeproj/project.pbxproj apps/ios/BeerMap/Features/RootView.swift apps/ios/BeerMap/Features/ContributeView.swift
rg -n "Contribute|submitPriceUpdate|reportWrongPrice|requestMissing|missing_venue|missing_beer|toBuildConfigString" apps/android/app/src/main/java/au/pintpath/beermap apps/android/app/build.gradle.kts
git diff --name-only -- viewer src scripts test supabase package.json package-lock.json railway.toml README.md docs .github
```

Additional polish-pass checks:

```bash
rg -n "confirmationDialog|showLogoutConfirmation|EmptyStateView|FeatureCard|FormField|LoadingView|AlertDialog" apps/ios apps/android
git diff --name-only -- apps/ios apps/android MOBILE_STATUS_REPORT.md QA_REPORT.md MOBILE_APP_README.md
```

## Results

Passed:

- `git diff --check` completed with no whitespace errors.
- `plutil` validated the iOS Xcode project file and `Info.plist`.
- Node JSON parsing validated the iOS asset catalog `Contents.json` files.
- iOS project file references for `ContributeView.swift` are present in the file reference, group, and source build phase.
- iOS API config defaults are present in the Xcode project.
- Android contributor calls and Add tab wiring are present by static search.
- Changed file list is limited to mobile folders, mobile docs, `MOBILE_STATUS_REPORT.md`, `QA_REPORT.md`, `MOBILE_APP_README.md`, and `.gitignore`.
- Swift syntax parsing completed successfully for the iOS Swift files with `swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')`.
- Polish-pass component/static searches confirmed the new iOS confirmation, loading, empty-state, and form wrappers plus Android `AlertDialog`, `FeatureCard`, `FormField`, and `LoadingView` usage.
- A final isolation check found unrelated website/test diffs in the worktree. Those diffs were not part of the mobile changes made in this continuation and were left untouched:
  - `test/account-page.test.ts`
  - `test/pricing-entitlements.test.ts`
  - `test/viewer-map-logic.test.ts`
  - `viewer/business.css`
  - `viewer/business.js`
  - `viewer/index.html`
  - `viewer/pricing.html`
  - `viewer/trust.html`
  - `viewer/venue-portal.html`

Blocked by local environment:

- `xcodebuild -list -project apps/ios/BeerMap.xcodeproj` failed because active developer tools are Command Line Tools, not full Xcode.
- `xcrun simctl list devices available` failed because `simctl` is unavailable with the current developer tools selection.
- `./gradlew assembleDebug` failed because no Java Runtime is installed.

Representative failure text:

```text
xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance
```

```text
xcrun: error: unable to find utility "simctl", not a developer tool or in PATH
```

```text
The operation could not be completed. Unable to locate a Java Runtime.
```

## Manual QA Checklist For A Provisioned Machine

iOS:

```bash
xcode-select -p
xcodebuild -project apps/ios/BeerMap.xcodeproj -scheme BeerMap -destination 'platform=iOS Simulator,name=iPhone 15' build
```

Android:

```bash
java -version
cd apps/android
./gradlew assembleDebug
```

Runtime smoke test:

1. Launch the app against `https://pintpath.au` or a local backend.
2. Confirm Discover loads venues and missions.
3. Sign up with explicit 18+, Terms, and Privacy selections.
4. Log out and log back in.
5. Open Add and submit a beer-price update with a signed-in account.
6. Send a wrong-price report.
7. Send a missing venue or missing beer request.
8. Open Account and verify stats/privacy/logout states.
9. Open Bars with a venue-manager account and save profile/contact info, beer stock, happy hour, and Pro special where permitted.
10. Open Settings and send a support note.

## Not Verified Here

- Native iOS compile.
- Native Android compile.
- Simulator/emulator runtime behavior.
- Network smoke tests against production or localhost.
- Native OAuth.
- Camera/photo evidence flow.
- Location proof flow.
- Store signing/archive/bundle release.
- Accessibility pass.

## Website Isolation

No main website files were intentionally changed for the mobile work:

- No `src/` files changed.
- No `scripts/` files changed.
- No `test/` files were edited for the mobile implementation or polish pass.
- No `supabase/` files changed.

Final worktree note:

- The following website/test files currently have unrelated worktree diffs. They were not edited as part of this mobile continuation or polish pass and should be reviewed separately before staging:
  - `test/account-page.test.ts`
  - `test/pricing-entitlements.test.ts`
  - `test/viewer-map-logic.test.ts`
  - `viewer/business.css`
  - `viewer/business.js`
  - `viewer/index.html`
  - `viewer/pricing.html`
  - `viewer/trust.html`
  - `viewer/venue-portal.html`
- The only root config change made for this mobile work outside mobile docs was `.gitignore`, updated to ignore mobile local config, build output, user data, and signing artifacts.
