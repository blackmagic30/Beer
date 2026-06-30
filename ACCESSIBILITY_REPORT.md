# Accessibility Report

## Issues Found

- The shared website chrome did not provide a skip link for keyboard users.
- Active navigation links were visually marked, but not exposed with `aria-current`.
- Status and error notices were not consistently marked as live regions before updates.
- Account sign-in/create-account tabs had partial tab semantics, but inactive auth panels were only visually hidden.
- Local account validation errors were shown as text, but the affected fields were not marked with `aria-invalid` or associated with the error message.
- Password visibility toggles used repeated `Show`/`Hide` text without `aria-pressed`, `aria-controls`, or a clearer accessible label.
- Account settings and venue dashboard section switchers looked like tabs, but their selected tab and tabpanel relationships were incomplete.
- The signed-out venue portal loading/error notice was not a live region.
- The map page had strong visual UI, but the main map region and venue detail overlay needed stronger semantic labeling.
- Touch targets were mostly close to accessible sizing, but the shared primary button target could be safer at 44px.

## Fixes Made

- Added a shared `Skip to main content` link through `viewer/business.js` and styled it in `viewer/business.css`.
- Added matching skip-link styling to the standalone map page stylesheet in `viewer/index.html`.
- Added `aria-current="page"` to active shared navigation links.
- Updated `MelbBeerBusiness.setStatus()` so success/loading notices use `role="status"` / `aria-live="polite"` and errors use `role="alert"` / `aria-live="assertive"`.
- Added static live-region attributes to account, password reset, resend-confirmation, and venue-portal status areas.
- Improved account auth tabs:
  - `aria-selected` on tab buttons.
  - `role="tabpanel"` on auth forms.
  - `hidden` on the inactive signup form.
  - JS now keeps selected/hidden state in sync.
- Added account form validation polish:
  - Password mismatch, missing consent, and display-name validation mark the relevant fields with `aria-invalid`.
  - Affected fields are associated with `authStatus` through `aria-describedby`.
  - Focus moves to the field that needs correction.
- Improved password visibility toggles on account and reset pages with `aria-label`, `aria-pressed`, and `aria-controls`.
- Improved reset/resend local validation by marking and focusing invalid fields.
- Added account settings tab semantics with tab IDs, `role="tablist"`, `role="tab"`, labeled `tabpanel`s, and selected-state updates.
- Added venue dashboard tab semantics in JS, including `role="tab"`, `aria-controls`, `aria-selected`, `role="tabpanel"`, `aria-labelledby`, and true `hidden` state.
- Labeled the interactive map region and gave the venue detail overlay a dialog role and labeled title.
- Preserved focus return when closing the venue detail overlay.
- Increased shared button/nav touch target minimum height to 44px and small buttons to 40px.
- Added `test/accessibility-polish.test.ts` to protect the new accessibility behavior.

## Remaining Accessibility Tasks

- Run a manual keyboard pass across the full map workflow, especially Google Maps embedded controls, marker selection, overlay panels, and mobile overlay tabs.
- Run a screen reader smoke test with VoiceOver or NVDA on Account, Venue Portal, Submit Data, Pricing, and the map detail overlay.
- Consider adding a real browser-based accessibility audit with axe once a browser test harness is available.
- Review dense admin/source-review tables for advanced table semantics in a separate admin-focused pass.
- Consider route-specific CSS splitting later so large-text/mobile audits are easier to isolate per page.

## Manual Testing Recommended

- Keyboard-only:
  - Load `/`, press Tab from the top, confirm the skip link appears and moves focus to main content.
  - Open a venue detail panel from the map/list, press Escape or Close, and confirm focus returns to the originating control.
  - Tab through `/account.html` sign-in, create-account, password toggles, OAuth buttons, and account settings tabs.
  - Tab through `/venue-portal.html` dashboard tabs and forms while signed in as a venue manager.
- Screen reader:
  - Confirm account form errors announce and identify the field that needs correction.
  - Confirm venue dashboard tab names and selected state are announced.
  - Confirm map detail overlay announces as selected venue details.
- Small screen / larger text:
  - Check account auth forms, pricing cards, and venue dashboard forms at 200% zoom.

## Commands Run

- `git diff --check -- viewer/business.js viewer/business.css viewer/index.html viewer/account.html viewer/reset-password.html viewer/resend-confirmation.html viewer/venue-portal.html test ACCESSIBILITY_REPORT.md`: passed.
- `npx vitest run test/account-page.test.ts test/viewer-map-logic.test.ts test/performance-loading.test.ts test/seo-metadata.test.ts`: passed, 4 files and 59 tests.
- `npx vitest run test/accessibility-polish.test.ts test/account-page.test.ts test/viewer-map-logic.test.ts test/performance-loading.test.ts test/seo-metadata.test.ts`: passed, 5 files and 62 tests.
- `npm run build`: passed.
- `npm test`: passed, 26 files and 263 tests.
- No lint script is defined in `package.json`, so there was no separate lint command to run.

## Mobile Folder Confirmation

- This accessibility pass did not modify files under `apps/android` or `apps/ios`.
- The worktree already had unrelated mobile-folder changes before this pass; those were left untouched.
