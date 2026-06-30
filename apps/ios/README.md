# BeerMap iOS

Native SwiftUI iPhone app for the existing BeerMap/Pint Path backend. Continue this app in place; do not create a duplicate iOS project.

## Open And Run

1. Open `apps/ios/BeerMap.xcodeproj` in Xcode.
2. Select the `BeerMap` scheme.
3. Pick an iPhone simulator.
4. Press Run.

The app defaults to `https://pintpath.au`. To point at a local backend, copy `Config.example.xcconfig` to `Config.xcconfig`, set `PINT_PATH_API_BASE_URL`, and attach the xcconfig to the BeerMap target build settings in Xcode.

Useful values:

```xcconfig
PINT_PATH_API_BASE_URL = https:/$()/pintpath.au
PINT_PATH_API_BASE_URL = http:/$()/127.0.0.1:3000
```

## Backend Contract

- Public config: `GET /api/business/config`
- Public venues: `GET /api/business/venues`
- Price records: `GET /api/business/price-records`
- Auth: `POST /api/business/auth/signup`, `POST /api/business/auth/login`, `POST /api/business/auth/logout`
- Account dashboard: `GET /api/business/account`
- Venue manager dashboard: `GET /api/business/venue-portal`
- Venue CRUD: `/api/business/venue-portal/:venueId/profile`, `/beers`, `/happy-hours`, `/specials`
- Contributor updates: `POST /api/business/submissions`, `/wrong-price-reports`, `/requests`
- Analytics: `POST /api/business/events`

The native app stores only the Pint Path bearer session token in Keychain. It does not connect directly to private Supabase tables and it never includes service-role keys.

## Native Screens

- Discover
- Account
- Add
- Bars
- Settings

The Add tab covers reviewed beer-price submissions, wrong-price reports, missing venue/beer requests, and mission browsing. Photo evidence, one-time location proof, native OAuth, billing, and reward/POS flows are not wired yet.

## Release Notes

Before App Store submission, replace placeholder signing, review the bundle ID, add final screenshots, confirm OAuth/deep-link settings if native Google/Apple login is enabled, and verify privacy disclosures against the production data flows.
