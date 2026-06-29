# BeerMap Mobile Store Checklist

## App Identity

- App display name: `BeerMap`
- iOS bundle ID placeholder: `au.pintpath.beermap`
- Android package placeholder: `au.pintpath.beermap`
- Website/backend brand copy: keep Pint Path wording where current product copy uses it.

## iOS App Store

- Configure Apple Developer Team in Xcode.
- Confirm final bundle ID and provisioning profiles.
- Replace placeholder icon/launch assets if final branding changes.
- Prepare screenshots:
  - iPhone 6.7-inch
  - iPhone 6.5-inch if required
  - iPhone 5.5-inch if required by current App Store Connect rules
- Add app subtitle, description, keywords, support URL, marketing URL, and privacy policy URL.
- Confirm Sign in with Apple requirements if native Apple OAuth is enabled.
- Add account deletion path notes. Current app creates a deletion review request through the backend.
- Confirm 18+ age/responsible-alcohol copy in metadata and review notes.
- Provide a reviewer test account with venue-manager access if venue dashboard review is needed.
- Verify camera/photo/location permission strings:
  - Camera/photo: optional private source evidence for venue updates.
  - Location: one-time nearby sorting and intentional venue submission support.
- Archive in Xcode and upload to App Store Connect.
- Run final TestFlight smoke test before release.

## Android Play Store

- Confirm package name and app signing setup.
- Replace placeholder adaptive icon if final branding changes.
- Build a release Android App Bundle (`.aab`).
- Prepare screenshots:
  - Phone screenshots
  - Feature graphic
  - App icon
- Fill Data safety form using current behavior:
  - Account info for signup/login.
  - User-generated venue/submission/support content.
  - Optional approximate/location use only after user action.
  - Analytics is optional and privacy-scoped.
  - No raw government ID document collection in the app.
- Confirm Play policy treatment for alcohol-related content and 18+ framing.
- Provide a reviewer test account and venue-manager account if requested.
- Confirm account deletion request path is documented in Play Console.
- Verify permissions:
  - Internet for API calls.
  - Camera/photo for optional source evidence.
  - Location for opt-in nearby sorting/submission support.
- Upload to internal testing first, then closed/open testing, then production.

## Privacy And Data Notes

- Native apps use the existing Express API and existing database.
- Native apps do not embed Supabase service-role keys.
- Supabase OAuth public config is optional; email/password works through the existing backend.
- Exact price access remains server-gated.
- Venue manager access remains invite-only and server-enforced.
- Venue analytics remain aggregate and privacy-safe.
- Optional analytics should respect the account privacy setting.
- Location should be one-time/foreground only, not continuous background tracking.
- Private source evidence should remain private and reviewed through backend authorization.

## Manual Tasks Before Public Release

- Final signing certificates/profiles.
- Final app icons and store screenshots.
- Native Google/Apple OAuth redirect/provider setup if enabled.
- Deep links/universal links if the apps should open `/venues/:id`, `/account`, or `/venue-portal`.
- Final privacy policy review.
- Production smoke test against `https://pintpath.au`.
- Reviewer test accounts.
- Accessibility pass with Dynamic Type/font scaling, TalkBack, and VoiceOver.
- Physical-device check on at least one iPhone and one Android phone.

