# Main Website Polish Report

Date: 2026-06-30

## What changed

- Improved the map-first landing hero with a clearer Pint Path value proposition, visible bar-owner CTA, secondary submission CTA, and trust notes for reviewed venue updates, privacy-safe reports, and responsible use.
- Added a public "For bars" entry point in shared website navigation and the map header, routed to the existing `/pricing.html?audience=venues` path.
- Reworked the venue pricing presentation into Basic / Plus / Pro without adding backend billing or database behavior. Plus and Pro interest routes through existing venue support/onboarding paths.
- Added a short "how Pint Path helps bars" flow and trust band to the venue pricing page.
- Improved venue portal signed-out/claim copy so owners know how to request verified access, view plans, or sign in.
- Surfaced the existing venue Analytics panel in the dashboard sidebar.
- Refreshed bar FAQ copy to match the Basic / Plus / Pro story and route bar help to venue support.
- Added launch-facing page descriptions for the landing, pricing, venue dashboard, and FAQ pages.
- Updated website guardrail tests for the new navigation, pricing tiers, FAQ copy, and portal access copy.

## Verification

- `npx vitest run test/pricing-entitlements.test.ts test/account-page.test.ts test/viewer-map-logic.test.ts test/mobile-layout.test.ts` passed: 4 files, 59 tests.
- `npm run build` passed.
- `npm test` passed: 23 files, 254 tests.
- No lint script exists in `package.json`.
- Local server smoke checks passed on the existing `http://localhost:3000` instance:
  - `/health` returned ok.
  - `/` and `/pricing.html?audience=venues` returned 200.
  - Browser checks at 1280px and 390px found no horizontal overflow, visible owner CTAs, three venue tier cards, venue pricing unhidden with `?audience=venues`, and no captured console errors.

## Mobile App Folder Confirmation

This pass did not edit `apps/android`, `apps/ios`, or other mobile app folders. Those folders already had dirty worktree changes before this website polish pass and were left alone.

## Files changed by this pass

- `viewer/index.html`
- `viewer/business.js`
- `viewer/business.css`
- `viewer/pricing.html`
- `viewer/venue-portal.html`
- `viewer/trust.html`
- `test/pricing-entitlements.test.ts`
- `test/account-page.test.ts`
- `test/viewer-map-logic.test.ts`
- `MAIN_WEBSITE_POLISH_REPORT.md`
