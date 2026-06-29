# BeerMap Native Mobile App Implementation Plan

## Repository Read

- Current product name in the repo is Pint Path, but the requested mobile app name is BeerMap. The mobile projects use `BeerMap` as the app display name while keeping Pint Path copy where the website does.
- Current stack is Node.js 22+, TypeScript, Express 5, Zod, SQLite/local repository classes, static HTML/CSS/JS viewer pages, Supabase Auth as an optional OAuth bridge, and Supabase migrations/storage policies for the account/contribution foundation.
- Current source-of-truth API is the Express `/api/business/*` router. The website stores a bearer session token in local storage and sends `Authorization: Bearer <token>` to account, venue portal, price, submission, billing, and analytics endpoints.
- Supabase is not used by the browser for direct production contribution writes. The canonical production path for auth exchange, submissions, price access, venue management, analytics, and admin/venue reports is the Express API.
- Existing assets live in `viewer/assets/`, including Pint Path icons and logo. Mobile projects should copy or reference these as launch/app icon placeholders without altering the website.
- Existing public routes include the map, account, pricing, missions, submit, venue portal, trust/privacy/security/community pages, admin tools, and venue SEO pages.
- Existing account flows include email/password signup/login, optional Supabase OAuth session exchange, age confirmation, legal acceptance, preferences, privacy settings, export, delete request, saved items, billing, and logout.
- Existing venue-manager flows include invite-only assigned venues, profile editing, beers/stock, happy hours, Pro-only specials, discount redemption, Pint Points, Free Pint Rewards, POS integration, aggregate analytics, monthly reports, pending review updates, support, and tier checkout.

## Implementation Direction

1. Add mobile-only code under `/apps/ios` and `/apps/android`. Do not modify `viewer/`, `src/`, `supabase/`, or existing website styling/routes unless a build-breaking shared config issue is discovered.
2. Use native UI:
   - iOS: Swift + SwiftUI, Xcode project, local `URLSession` API client, Keychain-backed bearer-token storage, native sheets/forms, dark/light theme support.
   - Android: Kotlin + Jetpack Compose + Material 3, Gradle project, `HttpURLConnection`/coroutines API client, encrypted/shared preference session storage, native navigation and forms.
3. Keep backend/data behavior aligned with the website:
   - Use `GET /api/business/config`, `/venues`, `/price-records`, `/access`, `/account`, `/missions`, `/submissions`, `/venue-portal`, `/venue-portal/:venueId/*`, `/billing/*`, `/events`.
   - Keep exact price access server-gated. Mobile UI can ask the backend to reveal prices but must not bypass the API.
   - Keep venue-management rights server-enforced. UI reflects `invite_required`, locked tier capabilities, and API errors.
   - Keep analytics opt-in and coarse. Do not collect precise location in analytics metadata.
4. Add config examples only:
   - iOS `Config.example.xcconfig`
   - Android `local.properties.example`
   - No secrets and no service-role keys in app projects.
5. Provide native first-pass feature parity screens:
   - Welcome/discovery
   - Login/signup
   - Public venue search/list/detail
   - Account dashboard/settings/privacy/logout
   - Contribution/submission entry point
   - Venue-owner dashboard with profile, beers, happy hours, specials, analytics/report/tier sections
   - Store preparation docs/checklists
6. Validate:
   - Run existing website build/tests/security scan if possible.
   - Run iOS build check with `xcodebuild` if Xcode is configured.
   - Run Android Gradle check if a JDK/Gradle or Android Studio environment is available.
   - Document any local environment gaps.

## Non-Goals For This Branch

- No WebView wrapper.
- No separate database.
- No destructive migrations.
- No direct mobile writes to Supabase tables.
- No refactor of the website, existing static pages, backend routes, or schema.
- No production signing credentials, App Store Connect API keys, Play upload keys, or private OAuth client secrets.

