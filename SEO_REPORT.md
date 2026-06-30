# SEO Report

## What SEO Changes Were Made

- Added stronger page titles, meta descriptions, canonical URLs, Open Graph tags, Twitter preview tags, and shared preview images across the main public website pages.
- Added `robots` noindex metadata to private/utility pages that should not appear in search results, including account, admin, stats, reset, resend-confirmation, and auth callback pages.
- Added `viewer/robots.txt` with crawl guidance and a sitemap pointer.
- Added `viewer/sitemap.xml` for the main public website pages.
- Added a branded `viewer/404.html` page with noindex metadata and useful internal links.
- Updated the Express not-found middleware so browser HTML requests receive the branded 404 page while API/non-HTML requests keep the existing JSON error behavior.
- Improved public venue page metadata for `/venues/:venueId` with richer title, description, social preview image tags, and venue schema fields based only on existing venue data.
- Expanded footer/internal links on key conversion pages so crawlers and visitors can move between pricing, venue portal, FAQ, support, privacy, and terms pages.
- Added SEO regression coverage for metadata, crawl files, noindex pages, and HTML/API 404 behavior.

## Structured Data Added

- `viewer/index.html`: `WebApplication` schema for Pint Path as the beer map web app.
- `viewer/pricing.html`: `WebPage` schema for pricing information.
- `viewer/trust.html`: `FAQPage` schema using existing FAQ topics and natural, non-invented copy.
- `src/app.ts`: public venue pages now emit improved `BarOrPub` schema with postal address fields, URL, image, geo coordinates when available, and price range when available.

## Pages Reviewed

- Landing page: `viewer/index.html`
- Pricing: `viewer/pricing.html`
- Venue portal / bar-owner entry: `viewer/venue-portal.html`
- FAQ / trust: `viewer/trust.html`
- Submit data: `viewer/submit.html`
- Contact/support: `viewer/feedback.html`
- Privacy: `viewer/privacy.html`
- Terms: `viewer/terms.html`
- Missions: `viewer/missions.html`
- Security: `viewer/security.html`
- Community: `viewer/community.html`
- Status: `viewer/status.html`
- Account/auth utilities: `viewer/account.html`, `viewer/reset-password.html`, `viewer/resend-confirmation.html`, `viewer/auth/callback.html`
- Admin/stats utilities: `viewer/admin.html`, `viewer/stats.html`
- Map shell: `viewer/google-map.html`
- Branded 404: `viewer/404.html`
- Dynamic public venue pages: `/venues/:venueId` in `src/app.ts`
- Crawl files: `viewer/robots.txt`, `viewer/sitemap.xml`

## Remaining SEO Tasks

- Add dynamic public venue URLs to the sitemap once the production domain and venue crawl policy are final.
- Confirm whether the production canonical domain is permanently `https://pintpath.au`; update canonical, sitemap, robots, and social URLs if the launch domain changes.
- Add real production social preview artwork if a more polished share image is created.
- Consider server-rendered metadata for any future public pages that are currently client-rendered only.
- Review search snippets after deployment in Google Search Console and adjust descriptions if actual snippets are weak.

## Manual Deployment / Domain Tasks

- Ensure `https://pintpath.au/robots.txt` and `https://pintpath.au/sitemap.xml` are served in production after deployment.
- Submit the sitemap in Google Search Console once the domain is verified.
- Confirm the public domain redirects consistently to the canonical host and HTTPS.
- Confirm social previews with platform debuggers after deploy, especially Open Graph image caching.
- If public venue pages are meant to be indexed at launch, generate and submit a sitemap that includes approved venue URLs only.

## Performance Opportunities

- Keep the static crawl files cacheable in production.
- Consider adding image dimensions or optimized preview assets if social/brand images become heavier.
- Review JavaScript bundle weight for public landing/pricing pages if Lighthouse flags render-blocking or main-thread work.
- Add production compression/caching checks to deployment QA if not already covered by infrastructure.

## Accessibility / Discoverability Notes

- Metadata and internal links now make the main public pages easier for crawlers and assistive browsing flows to understand.
- Future image/content work should continue to add descriptive `alt` text where images communicate meaningful product or venue information.
- The branded 404 provides clear next steps instead of a generic JSON/not-found response for browser visitors.

## Build / Test Results

- `git diff --check -- src/app.ts src/middleware/not-found.ts viewer test SEO_REPORT.md`: passed.
- `npx vitest run test/seo-metadata.test.ts test/error-handler.test.ts test/account-page.test.ts`: passed, 3 files and 34 tests.
- `npm run build`: passed.
- `npm test`: passed, 24 files and 257 tests.
- Compiled server smoke: `/health`, `/robots.txt`, `/sitemap.xml`, browser HTML 404, and API JSON 404 all returned expected responses.
- No lint script is currently defined in `package.json`, so there was no separate lint command to run.

## Mobile Folder Confirmation

- This SEO pass did not modify files under `apps/android` or `apps/ios`.
- The worktree already contained unrelated mobile-folder changes before this SEO pass; those were left untouched.
