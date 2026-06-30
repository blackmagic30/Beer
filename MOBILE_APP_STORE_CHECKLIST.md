# BeerMap Mobile App Store Checklist

Date: 2026-06-30
Scope: existing native apps in `apps/ios` and `apps/android`
Do not create duplicate mobile apps. Do not put secrets in mobile config.

## 1. iOS App Store Checklist

- Confirm Apple Developer account, team, certificates, identifiers, and provisioning profiles.
- Confirm final app display name: `BeerMap`.
- Confirm final bundle ID. Current placeholder in the Xcode project: `au.pintpath.beermap`.
- Confirm versioning. Current iOS values: marketing version `0.1.0`, build `1`.
- Confirm app category. Current `Info.plist` category: `public.app-category.food-and-drink`.
- Confirm production API base URL. Current default: `https://pintpath.au`.
- Confirm `apps/ios/Config.xcconfig` is local-only and ignored.
- Confirm no Supabase service-role key, Stripe secret, OpenAI key, or provider secret is embedded.
- Replace or approve the current app icon assets in `apps/ios/BeerMap/Assets.xcassets/AppIcon.appiconset`.
- Confirm splash/launch color in `LaunchBackground.colorset`.
- Add App Store Connect metadata:
  - Subtitle.
  - Promotional text if used.
  - Short and long description.
  - Keywords.
  - Support URL.
  - Marketing URL.
  - Privacy policy URL.
  - Copyright.
  - Review contact details.
- Complete App Privacy details from actual app behavior.
- Add reviewer notes explaining:
  - BeerMap is 18+ framed.
  - Email/password login uses the existing BeerMap/Pint Path backend.
  - Native Google/Apple OAuth is not wired unless final OAuth setup is completed.
  - Venue dashboard requires an assigned venue-manager account.
  - Account deletion is a backend deletion-review request.
- Provide reviewer credentials:
  - Standard user account.
  - Venue-manager account with an assigned venue.
  - Any special test data needed to view price rows, account stats, and venue dashboard.
- Run TestFlight smoke testing on physical devices and at least one current simulator.
- Archive with Xcode and upload to App Store Connect.
- Do not submit until the release blocker checklist below is clear.

## 2. Android Play Store Checklist

- Confirm Google Play developer account and Play App Signing setup.
- Confirm app display name: `BeerMap`.
- Confirm final package name. Current placeholder/application ID: `au.pintpath.beermap`.
- Confirm versioning. Current Android values: `versionCode = 1`, `versionName = "0.1.0"`.
- Confirm production API base URL. Current default: `https://pintpath.au`.
- Confirm `apps/android/local.properties` is local-only and ignored.
- Confirm no service-role key, signing key, keystore, Stripe secret, OpenAI key, or provider secret is tracked.
- Replace or approve adaptive icon assets:
  - `apps/android/app/src/main/res/drawable/ic_launcher_background.xml`
  - `apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml`
  - `apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
  - `apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml`
- Configure release signing outside git.
- Build and upload an Android App Bundle (`.aab`), not only a debug APK.
- Complete Play Console Data safety form from actual app behavior.
- Complete App access instructions if login is required for review.
- Add reviewer credentials:
  - Standard user account.
  - Venue-manager account with an assigned venue.
  - Notes about any server-gated price reveal behavior.
- Upload to internal testing first, then closed/open testing, then production.
- Do not submit until the release blocker checklist below is clear.

## 3. App Name

- Store display name: `BeerMap`
- Product/backend wording: keep Pint Path wording where the existing website/backend copy uses it.
- Avoid changing legal entity or product ownership wording in metadata without business/legal review.

## 4. Bundle ID Placeholder

- Current iOS bundle ID placeholder: `au.pintpath.beermap`
- Confirm final ID in Apple Developer before archiving.
- Do not change it after store setup unless intentionally creating a new app record.

## 5. Android Package Name Placeholder

- Current Android package/application ID placeholder: `au.pintpath.beermap`
- Confirm final package name before first Play production submission.
- Treat the package name as permanent once published.

## 6. App Category Suggestions

iOS:

- Primary: Food & Drink.
- Secondary consideration: Lifestyle, only if the store positioning moves away from venue/beer discovery.

Android:

- Primary: Food & Drink.
- Secondary consideration: Lifestyle, only if Play Console category options or positioning require it.

Use the category that best matches the submitted product, not a growth tactic.

## 7. Screenshot List Needed

iOS screenshots:

- Discover/Home with venue search and stats.
- Venue detail with server-gated price rows.
- Account login/signup.
- Add/Contribute flow.
- Bar owner dashboard overview.
- Bar profile editing.
- Beer stock/prices editor.
- Happy hours/specials editor.
- Settings/support/safety screen.
- Dark mode equivalents if final QA supports dark mode well.

Android screenshots:

- Discover/Home.
- Venue detail/price reveal.
- Account login/signup.
- Add/Contribute.
- Bar owner dashboard.
- Profile/stock/happy-hour/special editor.
- Settings/support/safety.
- Include phone screenshots in Play Console sizes requested by the console.

Screenshot rules:

- Use real or seeded test data that can be shown publicly.
- Do not show private user emails, private admin data, real secrets, unpublished partner data, or sensitive review queue contents.
- Keep 18+ and responsible-use framing consistent with the website.

## 8. App Icon Checklist

iOS:

- Confirm all AppIcon sizes are present and not placeholder-quality.
- Confirm the 1024px marketing icon has no alpha if App Store Connect rejects transparency.
- Confirm icon looks legible in light and dark home screen contexts.
- Confirm no prohibited alcohol-consumption claim is implied by the icon.

Android:

- Confirm adaptive foreground/background render cleanly.
- Confirm round icon render.
- Confirm launcher preview on light/dark wallpapers.
- Confirm Play Store high-resolution icon is exported separately if required by Play Console.

## 9. Splash Screen Checklist

iOS:

- Current launch uses `UILaunchScreen` with `LaunchBackground`.
- Confirm launch background color matches final brand.
- Add a branded launch image only if the final design requires it and App Store guidelines are respected.

Android:

- Current app uses `Theme.BeerMap`.
- Confirm launch screen/default window background does not flash an off-brand color.
- Add Android 12+ splash screen assets/theme if release QA shows a blank or jarring launch.

## 10. Privacy Policy Reminders

Do not invent privacy claims. The privacy policy and store forms must match production behavior.

Cover these actual app behaviors:

- Account creation and login with email/password through the existing backend.
- Optional display name at signup.
- 18+, Terms, and Privacy confirmations sent during signup.
- Bearer session token storage:
  - iOS: Keychain.
  - Android: app-private SharedPreferences.
- Anonymous session UUID storage:
  - iOS: UserDefaults.
  - Android: app-private SharedPreferences.
- Venue search and price reveal requests to the backend.
- Saved venue actions for signed-in accounts.
- Reviewed contribution submissions.
- Wrong-price reports.
- Missing venue/beer requests.
- Support feedback messages.
- Optional analytics events when allowed by account privacy settings.
- Venue-manager profile, stock, happy-hour, and special/deal edits for assigned venue-manager accounts.
- Server-gated exact-price access.

Also state what is not currently wired natively:

- Native Google/Apple OAuth is not wired unless final OAuth setup is completed.
- Native camera/photo evidence upload is not wired in the current app flow.
- Native upload-location proof is not wired in the current app flow.
- Billing, rewards, POS, and native report exports are not wired in this app version.

## 11. Terms Of Service Reminders

- Link the same Terms used by the website/account flow.
- Confirm Terms cover:
  - 18+ use and responsible alcohol framing.
  - User-submitted venue/price/report content.
  - Venue-manager responsibility for accurate venue/profile/stock/special information.
  - Server review/moderation of submissions.
  - Account suspension or access limits if applicable.
- Do not add new legal promises in app metadata that are not present in the actual Terms.

## 12. Account Deletion Notes

Actual app behavior:

- iOS calls `POST /api/business/account/delete-request`.
- Android calls `POST /api/business/account/delete-request`.
- The UI describes this as a deletion review request, not instant deletion.
- Logout removes the saved session token from the device.

Before submission:

- Confirm the privacy policy and account page explain the deletion review path.
- Confirm store review notes explain any records that may be retained for legal, security, billing, moderation, or abuse-prevention reasons.
- Confirm reviewer can find the deletion request path after login.
- If store policy requires a direct web deletion URL, add the real URL in store console metadata after legal/product confirmation.

## 13. Login/Test Account Notes For Reviewers

Prepare at least two reviewer accounts:

- Standard account:
  - Can sign in.
  - Has account stats/privacy screen.
  - Can save a venue.
  - Can submit a price update/report/request.
- Venue-manager account:
  - Has one assigned venue.
  - Can open Bars dashboard.
  - Can edit profile/contact fields.
  - Can add beer stock.
  - Can add happy hours.
  - Can view Pro-locked or Pro-enabled specials behavior depending on test tier.

Reviewer notes should include:

- API environment used.
- Test account email/password.
- Whether the venue-manager account is Basic/Free, Plus, Pro, or admin.
- Any expected server-gated price behavior.
- Account deletion path.
- Support contact.

Do not put real production admin credentials in store notes.

## 14. Permissions Used And Why

iOS `Info.plist` currently includes:

- Camera: described for attaching venue menus, taps, receipts, or other intentional source evidence.
- Location When In Use: described for one-time nearby sorting and intentional venue submissions.
- Photo Library: described for selected photos as private source evidence.

Android manifest currently includes:

- `android.permission.INTERNET`: required for backend API calls.
- `android.permission.ACCESS_FINE_LOCATION`: intended for opt-in nearby sorting/submission proof.
- `android.permission.CAMERA`: intended for optional source evidence.
- `android.permission.READ_MEDIA_IMAGES`: intended for selected source evidence images.

Release decision required:

- The current native contribution flow sends photo and upload-location fields as `nil`, and the app copy says photo evidence and saved upload-location proof are website-only in this native pass.
- Before submission, either implement and test native camera/photo/location flows, or remove unused native camera/photo/location permissions and update disclosures.
- Keep `INTERNET` on Android.
- Do not request background location.

## 15. Data Collection Notes Based On The App

Data the app may send to the existing backend:

- Email and password for login/signup.
- Optional display name.
- 18+, Terms, and Privacy signup confirmation flags.
- Bearer token in Authorization headers after login.
- Anonymous session UUID for public events, price reveals, reports, and requests.
- Venue search text.
- Venue ID, venue name, suburb, and saved-venue metadata.
- Price reveal request data.
- Beer price submissions: venue, beer name, serving size, observed price, observed timestamp, notes.
- Wrong-price reports: venue, optional beer name, reason, notes.
- Missing venue/beer requests: request type, optional venue/beer/suburb/notes.
- Support feedback message.
- Optional analytics events: map view, venue detail open, signup completed, saved venue, submissions, reports, requests, with app source metadata.
- Venue-manager data: venue profile/contact fields, beer stock rows, happy hours, specials/deals.
- Privacy settings toggles.
- Account deletion review request message.

Data stored locally:

- iOS: bearer token in Keychain, anonymous session UUID in UserDefaults.
- Android: bearer token and anonymous session UUID in app-private SharedPreferences.

Data not collected by this native version unless implemented later:

- Native source photos.
- Native camera captures.
- Native upload-location proof payloads.
- Payment card data.
- Government ID documents.
- Background location.
- Contacts/address book.
- Health data.

Store disclosure reminder:

- Store privacy/data safety forms should be filled by the final production behavior, not by intended future features.

## 16. Supabase/Backend Notes

- Native apps call the existing Express `/api/business/*` API.
- Native apps do not read or write private Supabase tables directly.
- Supabase service-role keys must remain server-side only.
- Optional public Supabase config placeholders exist for future native OAuth:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
- Email/password auth currently works through the existing backend.
- iOS has a `syncSupabase(accessToken:)` API client method, but native OAuth UI is not wired.
- Android exposes public Supabase config through BuildConfig placeholders, but native OAuth UI is not wired.
- Venue-manager access and exact-price access remain server-enforced.
- Do not add service-role, Stripe secret, OpenAI, or provider secrets to iOS `Config.xcconfig`, Android `local.properties`, plist values, Gradle fields, or source code.

## 17. iOS Build/Archive Steps

Prerequisites:

- Full Xcode installed and selected with `xcode-select`.
- Apple Developer team configured.
- Final bundle ID and provisioning profiles ready.
- Production API base URL configured.
- No local secrets in build settings.

Steps:

```bash
cd /Users/zac/Desktop/Beer
plutil -lint apps/ios/BeerMap.xcodeproj/project.pbxproj apps/ios/BeerMap/Info.plist
swiftc -parse $(rg --files apps/ios/BeerMap -g '*.swift')
xcodebuild -project apps/ios/BeerMap.xcodeproj -scheme BeerMap -destination 'platform=iOS Simulator,name=iPhone 15' build
```

Archive:

1. Open `apps/ios/BeerMap.xcodeproj` in Xcode.
2. Select the `BeerMap` scheme.
3. Select `Any iOS Device` or a generic iOS device destination.
4. Product > Archive.
5. Validate archive.
6. Upload to App Store Connect.
7. Test in TestFlight before release submission.

Current local blocker:

- `xcodebuild` cannot run in this environment because active developer tools are Command Line Tools, not full Xcode.

## 18. Android APK/AAB Build Steps

Prerequisites:

- Java Runtime/JDK installed.
- Android SDK installed.
- Release signing configured outside git.
- Production API base URL configured.
- No local secrets in Gradle properties.

Debug check:

```bash
cd /Users/zac/Desktop/Beer/apps/android
./gradlew assembleDebug
```

Release App Bundle:

```bash
cd /Users/zac/Desktop/Beer/apps/android
./gradlew bundleRelease
```

Release APK if needed for testing:

```bash
cd /Users/zac/Desktop/Beer/apps/android
./gradlew assembleRelease
```

Current local blocker:

- Gradle cannot run in this environment because no Java Runtime is installed.

## 19. Release Blocker Checklist

Do not submit until all are resolved:

- Full iOS Xcode build passes.
- Full Android Gradle build passes.
- Physical iPhone smoke test passes.
- Physical Android smoke test passes.
- TestFlight smoke test passes.
- Play internal testing smoke test passes.
- Store icons and screenshots are final.
- Privacy policy URL is final and reachable.
- Terms URL is final and reachable.
- Support URL is final and reachable.
- Marketing URL is final or intentionally omitted where allowed.
- Reviewer standard and venue-manager test accounts are prepared.
- Account deletion path verified.
- Native permissions match actual shipped behavior.
- Decision made on camera/photo/location:
  - either implemented and disclosed,
  - or removed before submission.
- No secrets in repo or mobile bundles.
- Android release signing stored outside git.
- iOS provisioning/signing verified.
- App category and 18+ framing confirmed.
- Data safety/App Privacy answers reviewed against production behavior.
- Accessibility smoke test with VoiceOver and TalkBack.
- Backend production smoke test against `https://pintpath.au`.

## 20. Final Manual Tasks Before Submission

- Verify current App Store Connect and Play Console requirements in the consoles.
- Review all metadata with product/legal owner.
- Confirm final app name and identifiers.
- Capture final screenshots from release builds.
- Confirm app icon/splash assets at production quality.
- Confirm reviewer credentials work.
- Confirm server-gated price reveal behavior works.
- Confirm venue-manager account has assigned venue data.
- Confirm account deletion review request works.
- Confirm logout removes local session.
- Confirm support feedback works.
- Confirm no website or backend changes are required for mobile release.
- Tag release candidate only after native builds and store smoke tests pass.

## Official Store References

- Apple App Privacy details: https://developer.apple.com/app-store/app-privacy-details/
- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Apple App Store Connect build upload help: https://developer.apple.com/help/app-store-connect/manage-builds/upload-a-build/
- Google Play Data safety: https://support.google.com/googleplay/android-developer/answer/10787469
- Google Play app access review instructions: https://support.google.com/googleplay/android-developer/answer/9859455
- Google Play account deletion/data deletion requirements: https://support.google.com/googleplay/android-developer/answer/13327111
- Android signed app bundle/build documentation: https://developer.android.com/studio/publish
