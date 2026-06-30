# Performance Report

## Performance Problems Found

- The landing/map page loaded the Google marker-cluster library as a blocking `<script>` in the document head.
- The landing/map page loaded `business.js` synchronously even though most other website pages already defer it.
- Landing startup work was mostly serial: access state, saved venue state, Google Maps loading, venue rows, and price records waited on each other more than necessary.
- `loadBusinessVenueRows()` fetched venues before starting the price-record request, even though the two API calls are independent.
- The venue portal made a `/api/business/venue-portal` request even when the browser had no local auth or Supabase session hint, which could only return a login-required state.
- Supabase Auth CDN scripts on account/auth utility pages blocked parsing.
- Static website assets were served without route-specific cache intent. HTML/config needed to stay fresh, but JS/CSS/images/crawl files could safely use cache-friendly headers.
- The shared CSS and large inline landing/portal scripts remain heavy, but splitting them would be a larger architecture/bundling change.

## Changes Made

- Added landing-page `preconnect` hints for Google Maps, Google static assets, and jsDelivr.
- Removed the blocking marker-cluster script from the landing-page head and added `loadMarkerClustererScript()` so clustering loads after Google Maps startup, in parallel with venue data.
- Deferred `business.js` on the landing page and started the map initializer on `DOMContentLoaded`, preserving the existing config/map-logic ordering that the inline map script needs.
- Parallelized landing startup work:
  - business access state
  - saved venue/account state
  - Google Maps script loading
  - marker-cluster loading
  - venue rows and price-record fetches
- Added a signed-out fast path on the venue portal so browsers without auth/session hints show the existing login-required state without making an avoidable portal API call.
- Deferred Supabase Auth CDN scripts on account/auth utility pages while preserving script order before `business.js`.
- Added production static cache headers in `src/app.ts`:
  - HTML and `/config.js`: `no-store`
  - JS/CSS/robots/sitemap/manifest: short cache with stale revalidation
  - image/favicon assets: longer cache with stale revalidation
- Added `test/performance-loading.test.ts` to guard the loading and cache-header patterns.

## Build Output Before / After

The project does not currently produce a frontend bundle analyzer report. I captured the TypeScript build result and representative static file sizes before and after.

Before:

```text
npm run build: passed
viewer/business.js: 22,208 bytes
viewer/business.css: 178,488 bytes
viewer/index.html: 294,168 bytes
viewer/venue-portal.html: 185,675 bytes
viewer/pricing.html: 12,361 bytes
selected total: 692,900 bytes
```

After:

```text
npm run build: passed
viewer/business.js: 22,208 bytes
viewer/business.css: 178,488 bytes
viewer/index.html: 296,184 bytes
viewer/venue-portal.html: 185,913 bytes
viewer/pricing.html: 12,361 bytes
selected total: 695,154 bytes
```

The raw HTML grew by about 2.2 KB because of the lazy loader, startup coordination, and auth fast path. The payoff is less blocking work on first paint and fewer serial network waits; shared JS/CSS sizes did not increase.

## Remaining Opportunities

- Split the large shared `business.css` into route-focused CSS once a build pipeline or bundling step is introduced.
- Move the large inline landing/map script into a versioned external file so it can be cached independently from HTML.
- Consider a small route-level loader for venue portal/account/submit pages so each page loads only the helpers it needs.
- Add a compressed, production-ready social preview image instead of relying on the current large logo asset for previews.
- Add HTTP compression and CDN cache validation checks to deployment QA if the host does not already enforce them.
- Consider a backend read endpoint that returns map venue rows and approved price records together. That could reduce client requests, but it would change API shape and was intentionally left for a separate backend-safe pass.

## Risky Optimizations Intentionally Avoided

- No database, schema, auth, or Supabase behavior changes.
- No removal of existing map, dashboard, account, or submission features.
- No rewrite to a bundler or new frontend architecture.
- No aggressive long-lived caching for HTML or `/config.js`.
- No changes to API response shapes or server-side data loading.
- No image recompression or replacement that could accidentally alter branding/social previews.

## Commands Run

- `npm run build`: passed before changes.
- `git diff --check -- src/app.ts viewer test PERFORMANCE_REPORT.md`: passed.
- `npx vitest run test/performance-loading.test.ts test/viewer-map-logic.test.ts test/account-page.test.ts test/seo-metadata.test.ts`: passed, 4 files and 59 tests.
- `npm run build`: passed after changes.
- `npm test`: passed, 25 files and 260 tests.
- Production-mode smoke with local placeholder env values:
  - `/`: `Cache-Control: no-store`
  - `/venue-portal`: `Cache-Control: no-store`
  - `/auth/callback`: `Cache-Control: no-store`
  - `/config.js`: `Cache-Control: no-store`
  - `/business.js`: `Cache-Control: public, max-age=300, stale-while-revalidate=3600`
  - `/assets/pint-path-icon-192.png`: `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`
  - `/sitemap.xml`: `Cache-Control: public, max-age=300, stale-while-revalidate=3600`
- No lint script is defined in `package.json`, so there was no separate lint command to run.

## Mobile Folder Confirmation

- This performance pass did not modify files under `apps/android` or `apps/ios`.
- The worktree already had unrelated mobile-folder changes before this pass; those were left untouched.
