# Main Website Launch Readiness Audit

Audit date: 2026-06-30

Scope: main Pint Path / BeerMap website in `viewer/`, `src/`, `supabase/`, `scripts/`, and website-focused tests. I did not inspect or modify mobile app folders. No code fixes were implemented.

## Verification Performed

- Confirmed existing localhost server on port `3000`.
- `GET /health`: `200`, `status: ok`.
- `GET /ready`: `200`, `status: ready`.
- Browser-checked the map, pricing, bar pricing, account, venue portal, submit, and stats pages at desktop and mobile widths.
- Crawled static internal links from `viewer/*.html`; no broken linked static routes found. `/for-bars` and `/for-bars.html` redirect to `/venue-portal`.
- `npx tsc --noEmit --project tsconfig.json`: passed.
- `npm run security:scan`: passed, including ignored `viewer/config.js`.
- `npm run security:audit`: passed, `0` high-severity vulnerabilities.
- `npx vitest run test/pricing-entitlements.test.ts test/account-page.test.ts test/mobile-layout.test.ts test/supabase-rls-migrations.test.ts`: passed, `43` tests.
- I did not run `npm run build` because the package script deletes/recreates `dist`, which would violate the read-only/code-free audit constraint.
- I did not run the full test suite because several integration tests intentionally create or mutate test databases/artifacts; run the full suite before release.

## What Is Already Good

- The site is substantially more than a placeholder. The public map loads locally, shows venues, filters, beer chips, location controls, visible venue rail, map legend, detail overlays, save/share/night-plan actions, and free-vs-paid access copy.
- Bar-owner backend coverage is strong. Routes exist for venue portal load, profile edits, beer/stock rows, happy hours, specials, redemptions, monthly report export, billing checkout, pending review, and admin review.
- Server-side validation is broad. Auth, submissions, bar profile, beer rows, happy hours, specials, venue interest, billing, reports, feedback, and analytics events are validated with Zod schemas.
- The venue portal has the right functional building blocks: managed venue selector, overview, redemption, profile, beers/stock, price refresh, happy hours, specials planner, pending reviews, monthly reports, and support.
- Venue-manager writes are gated and review-first. Profile, beer, happy-hour, and special changes go through manager authorization and pending review instead of directly changing public map data.
- Basic/Pro entitlement logic is deliberate. The schema normalizes old `plus` values to `pro`; current presentation is Free/Pro, with Free blocking analytics/reports/specials and Pro enabling reports, specials, visibility, and growth tooling.
- Analytics and monthly reports have privacy protections. Tests cover aggregate thresholds, low-count suppression, owner scoping, and exports restricted to assigned Pro venue managers/admins.
- Security posture is comparatively mature for launch: Helmet headers, CORS/origin checks for writes, rate limits, secret redaction, path-only error logging, source evidence signed URLs, private evidence storage patterns, and a repo secret scanner.
- Supabase direct-browser write paths are intentionally deprecated or hardened. Migrations enable RLS, revoke old direct contributor writes, lock down helper functions, and keep source evidence storage private.
- Legal/trust pages exist: Privacy, Terms, Security, Status, Community Standards, FAQ, resend confirmation, reset password, account privacy controls, and support/contact.
- Mobile layout is generally responsive. Tested pages did not create horizontal page overflow at `390px` width.
- Existing release documentation is useful: `DEPLOYMENT_CHECKLIST.md` and `docs/release-readiness-checklist.md` already list provider, backup, smoke, security, and rollback checks.

## Highest-Impact Fixes

1. Fix public venue SEO/profile pages for non-UUID local/profile venue IDs.
   - Live issue: `/api/business/venues?limit=3` returns `half-moon-brighton`, but `/venues/half-moon-brighton` returns `502` because Supabase rejects the slug as invalid UUID before local fallback runs.
   - Impact: share links and SEO venue pages can break for promoted/local profile venues that are visible in the map/list API.
   - Likely fix: in `getPublicVenueById`, check local profile/cache first for non-UUID IDs or avoid calling Supabase with invalid UUID-shaped IDs.

2. Add a real bar-owner acquisition path.
   - Current bar portal is invite-only and says access is assigned by admin. Pricing CTAs send owners to `/venue-portal.html`, where signed-out/unassigned owners hit a dead end except “Go to account” and support links.
   - This is fine for private beta, but a launch aimed at bars needs a clear “claim/request demo/join waitlist” form and follow-up state.

3. Improve landing-page clarity.
   - The map is functional, but the first page title/H1 is just “Pint Path” and the public value proposition is mostly implied by controls.
   - Add a concise first-viewport explanation for users and a discoverable “For bars” entry without replacing the map as the main experience.

4. Add SEO metadata to static pages.
   - Every static `viewer/*.html` page has a title, but none has a meta description, canonical URL, page-specific `og:title`, or `og:description`.
   - `/robots.txt` and `/sitemap.xml` return `404`.
   - Dynamic `/venues/:venueId` pages are better and include description/canonical/OG/JSON-LD for valid IDs.

5. Make analytics discoverable in the venue dashboard.
   - `venue-portal.html` defines an `analytics` panel, `analyticsGate`, and `analyticsContent`, but the sidebar has no `data-tab="analytics"` button.
   - Owners can see report/overview content, but the explicit analytics section is not reachable through normal tab navigation.

6. Clarify venue pricing/tier naming.
   - The requested Basic/Plus/Pro mental model does not match the current UI exactly. The site now presents Free and Pro; old `plus` is normalized to Pro.
   - Decide whether launch copy should say Basic/Pro, Free/Pro, or Basic/Plus/Pro, then make pricing, dashboard gates, tests, and env docs consistent.
   - Venue Pro is now shown as `A$149/month`; keep launch copy, dashboard gates, tests, and env docs consistent with that monthly plan.

7. Reduce first-load weight and improve cache strategy.
   - `viewer/index.html` is about `292 KB`, `viewer/business.css` about `174 KB`, `viewer/venue-portal.html` about `175 KB`, and `viewer/assets/pint-path-logo.png` about `804 KB`.
   - Static assets currently serve with `Cache-Control: public, max-age=0`.
   - There is no explicit app-level compression dependency/middleware visible.

8. Tighten mobile touch targets.
   - Tested mobile pages avoid horizontal overflow, but top-nav/footer links and several settings buttons render around `32-38px` high, below common `44px` touch-target guidance.

9. Add clean signed-out/account/venue-manager browser smoke paths.
   - The local browser had an authenticated account state, but not a venue-manager assignment. I could verify the invite-only venue gate, not the full manager dashboard end-to-end in the browser.
   - Launch should have a documented staging/demo manager login or seed flow that exercises profile, beers, happy hours, specials, analytics, and reports.

10. Clear Google Maps console warning.
   - Browser console shows: `<gmp-advanced-marker>: Please use addEventListener('gmp-click', ...) instead of addEventListener('click', ...)`.
   - Not a blocker today, but it is a compatibility warning worth cleaning before launch.

## Launch Blockers

- Public venue pages break for at least one API-listed/promoted venue ID: `/venues/half-moon-brighton` returns `502`.
- Bar-owner self-serve launch is not ready if the product expects owners to sign up or claim venues without manual admin assignment.
- Static SEO fundamentals are missing: descriptions, canonicals, social metadata, robots, and sitemap.
- Full release verification is still required because `npm run build`, `npm test`, provider readiness, release suite, and live provider checks were not run in this read-only audit.
- Provider/staging blockers from existing docs remain launch-critical: Supabase OAuth redirects/email confirmation/leaked-password protection, live RLS/storage audit, Google Maps restricted browser key plus Map ID, Stripe checkout/webhook verification, Redis-backed rate limiting, backup/restore drill, and report-email delivery if monthly reports are promised by email.

## Nice-To-Have Polish

- Add a visible “For bars” navigation entry that lands on bar pricing or venue support instead of only redirecting `/for-bars` to the protected portal.
- Make the signed-out venue portal more conversion-oriented: explain expected setup time, what bars get, and how to request access.
- Add empty-state screenshots/copy polish for venue dashboard lists: “No beers yet”, “No happy hours yet”, “No specials yet”, “No pending edits” already exist in code, but they need a live manager smoke pass.
- Profile form fields could use stronger browser semantics: `type="url"` for website/Instagram, `type="tel"` for phone, and clearer per-field helper/error text.
- Keep contact emails as structured data instead of embedding “Reply email:” inside feedback message text.
- Add unsaved-change prompts for larger venue profile/beer/happy-hour/special edits.
- Improve account/dashboard state clarity in a clean browser and after Supabase session expiry.
- Consider making the public venue “Manage this venue” link point to a claim/support flow for unassigned users instead of a protected dashboard.

## SEO Opportunities

- Add unique meta descriptions and canonical URLs to every static page.
- Add page-specific Open Graph and Twitter tags for map, pricing, venue dashboard, submit, FAQ, trust/legal pages, and contact.
- Add `/robots.txt` and `/sitemap.xml`.
- Include public venue detail URLs in the sitemap once the non-UUID venue route bug is fixed.
- Add structured data beyond venue pages where useful: `WebSite`, `Organization`, `FAQPage`, and possibly `BreadcrumbList`.
- Make the homepage title more descriptive, for example “Pint Path | Melbourne beer prices and happy hours”.
- Add canonical production host enforcement to rendered static pages, not only dynamic venue pages.
- Review `PUBLIC_BASE_URL` before production so local/ngrok canonical URLs do not leak into hosted output.

## Performance Opportunities

- Split the very large inline map page into cacheable JS/CSS modules where practical.
- Give static assets hashed filenames or versioned URLs and long-lived cache headers.
- Compress HTML/CSS/JS responses in production.
- Resize/optimize `viewer/assets/pint-path-logo.png` or serve smaller responsive variants.
- Lazy-load below-the-fold venue portal/admin/dashboard code where possible.
- Audit Google Maps load timing and fallback list mode so a Maps provider delay does not stall the first useful map/list interaction.
- Consider a lightweight static shell for pricing/legal/trust pages instead of loading shared business JS where it is not needed.

## Accessibility Opportunities

- Increase mobile nav/footer/settings touch targets to at least `44px`.
- Add visible focus-state review across map controls, cards, custom tabs, and generated venue cards.
- Ensure all icon-only or `×` buttons have accessible labels in generated content; many do, but run an automated accessibility pass to catch generated edge cases.
- Add `aria-selected`/`role="tab"` consistency to venue dashboard tabs if keeping a tabbed mental model.
- Review contrast on muted text over dark panels, especially small helper text.
- Re-check keyboard flow for map controls, venue rail, overlays, modal discount pass, and dashboard tab panels.
- Run Axe/Lighthouse/Playwright accessibility checks against local or staging before public launch.

## Security / Privacy Notes

- Good: `.env`, `viewer/config.js`, and SQLite files are ignored; `security:scan` explicitly checks ignored `viewer/config.js` if present.
- Good: `/config.js` is generated server-side and exposes only browser-safe config classes: Google Maps browser key/map ID, Supabase URL/anon key, OAuth providers, pricing labels, flags, and tracked beers.
- Good: production env validation rejects non-HTTPS/non-`pintpath.au` `PUBLIC_BASE_URL`, requires Google Maps key and Map ID, and blocks demo billing unless explicitly allowed.
- Good: admin routes require admin role, production admin allowlist, verified email, and MFA freshness.
- Good: venue managers are limited to assigned venues, with cross-venue access audited.
- Good: analytics consent gates optional tracking, strips precise coordinate keys, and low-count venue analytics are suppressed.
- Remaining risk: production must use `REDIS_URL` for distributed rate limits; in-memory fallback is only safe for controlled beta.
- Remaining risk: Supabase RLS/storage policies still need live project verification after migrations, because local SQL/test parsing is not a substitute for a live Supabase policy audit.
- Remaining risk: Stripe live payments should stay disabled until signed webhook verification, idempotency, cancellations, and failed invoices are tested.
- Remaining risk: public map and portal use `unsafe-inline` in CSP today, largely because pages contain inline scripts/styles. That is understandable for this architecture but weaker than nonce/hash-based CSP.
- Remaining risk: local `viewer/config.js` contains browser-facing keys and must stay ignored/uncommitted. Rotate any key ever shared outside intended config channels.

## Recommended Implementation Order

1. Fix `/venues/:venueId` for non-UUID/local/promoted venue IDs and add regression coverage.
2. Decide the bar-owner launch model: private invite-only beta vs public owner acquisition. If public, add a claim/request/demo flow before pushing owner traffic.
3. Add static SEO metadata, `/robots.txt`, `/sitemap.xml`, and production canonical URL handling.
4. Restore/expose the venue analytics tab or intentionally merge it into overview/report and remove unreachable markup.
5. Align venue pricing naming and billing period copy across UI, tests, README/env docs, and checkout.
6. Create a staging smoke account set: normal user, admin, Basic venue manager, Pro venue manager.
7. Run full release gates: `npm run build`, `npm test`, `npm run readiness:providers`, `npm run test:release:pintpath`, `npm run check`, `npm run security:scan`, `npm run security:audit`, and `git diff --check`.
8. Optimize static asset size/cache/compression.
9. Run mobile/accessibility browser passes on map, account, submit, pricing, and venue portal.
10. Complete provider launch checks: Supabase Auth/RLS/storage, Google key restrictions/Map ID, Stripe, Redis, backups, and report delivery.

## Files Likely To Need Changes

- `src/modules/business/business.service.ts` - public venue lookup fallback for non-UUID/local IDs; venue portal/dashboard data contracts.
- `src/app.ts` - venue page rendering, static metadata support, sitemap/robots routes, static cache/compression options.
- `viewer/index.html` - landing clarity, map SEO, performance splitting, Google Maps marker warning, public venue links.
- `viewer/pricing.html` - bar pricing naming, billing period copy, owner acquisition CTAs, SEO metadata.
- `viewer/venue-portal.html` - owner gate copy, analytics tab reachability, dashboard smoke fixes, form semantics.
- `viewer/account.html` - signup/login smoke states, checkout resume copy, account session clarity.
- `viewer/feedback.html` - structured venue-owner contact path and support/claim flow.
- `viewer/business.css` - mobile touch targets, dashboard/tab responsive polish, shared metadata/layout polish.
- `viewer/business.js` - shared nav, consent/auth helpers, event tracking polish if SEO/performance split changes.
- `viewer/site.webmanifest` plus new `viewer/robots.txt` and `viewer/sitemap.xml` or server-rendered equivalents.
- `test/business-demo.test.ts` - regression coverage for non-UUID venue pages and bar portal behavior.
- `test/pintpath-release-readiness.test.ts` - end-to-end launch gates for venue pages, manager dashboard, reports, and provider-sensitive paths.
- `test/pricing-entitlements.test.ts`, `test/account-page.test.ts`, `test/mobile-layout.test.ts` - update expected pricing/nav/accessibility behaviors after UI copy changes.
- `DEPLOYMENT_CHECKLIST.md`, `docs/release-readiness-checklist.md`, `.env.example`, `README.md` - keep launch commands, provider setup, pricing/tier naming, and owner onboarding aligned.
