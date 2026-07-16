# Pint Path Native QA Report

Status date: 17 July 2026

## Scope

This report covers the native source, manifests, project configuration, mobile/backend request contracts, sensitive-session handling, and locally available build/static gates. It does not substitute for signed real-device or store-review testing.

## Static and contract checks

- Swift source parsing: `swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')`
- Apple plist/privacy manifest: `plutil -lint apps/ios/BeerMap/Info.plist apps/ios/BeerMap/PrivacyInfo.xcprivacy`
- Native remediation assertions: `npx vitest run test/native-mobile-remediation.test.ts`
- Diff hygiene: `git diff --check -- apps/ios apps/android MOBILE_APP_README.md MOBILE_STATUS_REPORT.md MOBILE_APP_STORE_CHECKLIST.md MOBILE_APP_RELEASE_NOTES_DRAFT.md QA_REPORT.md test/native-mobile-remediation.test.ts`

Local result: Swift parsing passed; both Apple files listed above passed `plutil`; all 30 native remediation tests passed; scoped diff hygiene passed. The tests include live-schema contracts, current server-authority navigation, admin-only quick-bar gating, authoritative upload totals beyond the 12-row recent-history window, offset pagination, cursor pagination, production Supabase auth, fixed-preview pricing, PKCE, secure token storage, Android release-signing guardrails, mutation deduplication, and image-orientation handling.

## Full build gates

```bash
xcodebuild -project apps/ios/BeerMap.xcodeproj -scheme BeerMap -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/ios/BeerMap.xcodeproj -scheme BeerMap -configuration Release -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO archive
(cd apps/android && ./gradlew --no-daemon lintDebug lintRelease testDebugUnitTest assembleDebug assembleRelease)
```

The shared CI workflow runs these with full Xcode, JDK 17, and the Android SDK. On this machine, `xcodebuild` stopped because the active developer directory is Command Line Tools rather than full Xcode, and Gradle stopped before configuration because no Java runtime is installed. Those are recorded environment limitations, not passing build evidence and not source-test failures. GitHub Native Apps run `29535119408` passed the unsigned iOS simulator build, unsigned iOS release archive validation, and the Android debug/release lint, test, and assembly gate for commit `d45ab2d`.

## Required manual device matrix

Run on at least one currently supported small and large iPhone and one Android device at minimum SDK/current target SDK:

- Fresh install, upgrade, uninstall/reinstall, sign in/out, token refresh, session revoke.
- Google and Apple success, cancellation, denial, callback replay, interrupted browser return, and unconfigured-provider errors.
- Account creation requiring email verification and password reset browser handoff.
- Location deny/approximate/precise/off/no-fix, then submit with and without proof.
- Valid, oversized, corrupt, HEIC/JPEG/PNG photo selections and picker cancellation.
- Every contribution type, mission reserve/release, duplicate submission prevention, and backend rejection copy.
- Account privacy, export, deletion request/cancel, reward code, invitation accept/decline.
- Confirm the Admin quick-bar tab appears after a verified admin login, never appears for member/venue/counter accounts, disappears on logout or authority loss, and preserves the secure `/admin.html` return path through browser reauthentication.
- All assigned-venue sections, switching venues with unsaved fields, stale-write conflict, report exports, and counter actions.
- VoiceOver/TalkBack, Dynamic Type/font scaling, keyboard navigation, contrast, reduced motion, landscape/foldable layouts.
- Offline, timeout, slow network, background/foreground, process recreation, and concurrent refresh actions.

## Acceptance rule

Do not mark the mobile release ready until CI is green and the manual matrix has named devices, OS versions, tester, date, outcome, and linked evidence. A source parse or emulator build alone is not a store-readiness sign-off.
