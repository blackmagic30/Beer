# Main Website QA Bug-Hunt Report

Date: 2026-06-30

Scope: main Pint Path/BeerMap website, Express routes, public/static viewer pages, account/auth entry points, venue portal logged-out state, pricing, submit, missions, feedback, 404, responsive layout, validation, console output, and existing automated tests.

Mobile app folders were not edited during this pass.

## Bugs Found

1. The map page still had recently-viewed venue storage, rendering, removal, and clear-button logic, but the matching `recentlyViewedPanel`, `recentlyViewedList`, and `clearRecentlyViewed` markup was missing. The code was guarded so it did not crash, but the feature could never appear.
2. The Google Maps advanced marker click handler produced browser console warnings on the landing/map page: advanced markers now expect the `gmp-click` event instead of the old normal click listener path.

## Bugs Fixed

1. Restored the missing recently-viewed panel markup in `viewer/index.html` using the existing `mapPersonalPanel` pattern.
2. Updated the map marker event wiring to use `marker.addEventListener("gmp-click", handleMarkerClick)` when available, with the older Maps listener retained only as a fallback.
3. Updated `test/viewer-map-logic.test.ts` so the missing recently-viewed panel and marker event regression are covered.

## QA Checks Performed

- Static local link crawl across 20 HTML files and 405 references: no missing static targets found.
- Static element-reference scan: only intentionally optional guarded submit-page status/draft elements remain absent.
- Static form scan: no form buttons missing `type`; no real duplicate static IDs found.
- HTTP route smoke crawl:
  - `/`, `/account.html`, `/pricing.html`, `/venue-portal`, `/venue-portal.html`, `/submit.html`, `/missions.html`, `/feedback.html`, `/privacy.html`, `/terms.html`, `/trust.html`, `/security.html`, `/status.html`, `/community.html`, `/stats.html`, `/google-map.html`, `/robots.txt`, `/sitemap.xml` returned expected 200 responses.
  - `/for-bars` and `/for-bars.html` redirect to `/venue-portal`.
  - Unknown page returns the custom 404 page.
- API validation/protected-route smoke checks:
  - Empty signup returns 400 validation.
  - Invalid login returns 401 with a clear message.
  - Account and venue portal API routes require login.
  - Venue manager write route requires login.
  - Venue lookup endpoint returns successfully.
- Browser desktop checks:
  - Core pages loaded without horizontal overflow.
  - Account invalid-login form showed `Invalid email or password.` in the live UI.
  - Logged-out venue portal showed the intended login-required alert and bar support links.
  - Clean console sweep after fixes showed no warnings/errors on checked pages.
- Browser mobile viewport checks at 390 x 844:
  - Core pages had no document-level horizontal overflow.
  - Map, pricing, account, venue portal, missions, feedback, and 404 pages retained expected titles/headings.

## Commands Run

- `node` static link/element/form QA scripts.
- Local dev server: `HOST=127.0.0.1 PORT=3000 PUBLIC_BASE_URL=http://127.0.0.1:3000 NODE_ENV=development npm run dev`
- HTTP smoke checks against `http://127.0.0.1:3000`.
- Browser checks with desktop and 390 x 844 mobile viewport.
- `npx vitest run test/viewer-map-logic.test.ts`
- `npm run build`
- `npm test`
- `npm run security:scan`
- `npm run security:audit`

## Test Results

- Focused map test: passed, 1 file / 27 tests.
- Build: passed.
- Full test suite: passed, 27 files / 266 tests.
- Secret scan: passed, 260 tracked/untracked/explicit local config files checked.
- Dependency audit: passed, 0 high-severity vulnerabilities.
- No lint script is defined in `package.json`.

## Release Blockers

No new release blockers were found in this pass.

## Remaining Manual Tests

- Real signup with a disposable email, including confirmation/resend/recovery flows.
- Real Supabase OAuth login for each enabled provider.
- Authenticated contributor flow: submit data, logout, login, view dashboard/submissions.
- Authenticated venue-manager flow: assigned venue dashboard, edit profile, beer/stock, happy hours, Pro specials, tier checkout/demo mode, and monthly report export.
- Admin-only flows: assign venue manager, review pending changes, source ingestion review, monthly report generation.
- Stripe checkout/webhook flow in Stripe test mode.
- Real Google Maps browser key/domain restrictions in production.
- Real device/browser pass on iOS Safari and Android Chrome.

## Non-Blocking Polish Ideas

- Account QR-code image elements are intentionally empty until a reward/pass is generated; keeping them hidden until populated would avoid false-positive broken-image tooling.
- The submit page intentionally keeps optional status/draft elements absent while preserving guarded code paths; consider removing the stale optional references if those UI pills are not coming back.
- Add a small automated route-smoke test for public static pages so broken links/routes are caught before manual QA.
- Add a lightweight browser-console smoke test in CI for the map page if a test browser is available.

## Files Changed

- `viewer/index.html`
- `test/viewer-map-logic.test.ts`
- `MAIN_WEBSITE_QA_REPORT.md`

## Mobile Folder Confirmation

No mobile app folders were touched by this QA pass. The working tree already contained pre-existing mobile app changes before this task; they were left untouched.
