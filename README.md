# pint-path

`pint-path` is a production-minded Node.js + TypeScript app for Melbourne beer-price and happy-hour discovery. The active product is the public map, contributor account flow, venue portal, admin review workflow, aggregate venue analytics, and server-gated price/submission APIs.

## Current Capabilities

- Public Melbourne beer-price and happy-hour map.
- Server-side price gating, free preview access, premium access, and contributor unlocks.
- Contributor account dashboard with private evidence handling and submission history.
- Venue portal for venue-managed beers, prices, happy hours, deals, and pending approval flows.
- Admin review, KPI, coverage, retention, partner-lead, and venue-manager workflows.
- Privacy-safe aggregate analytics and source-evidence protections.
- Admin menu/photo capture and crowdsourced submissions feed normalized venue price records after review.
- The public viewer reads approved venue/price data through server-gated business APIs.
- Stores structured per-beer availability fields for map use:
  - `availability_status`
  - `available_on_tap`
  - `available_package_only`
  - `unavailable_reason`
- Syncs `cleaned.beers`, `cleaned.menu_items`, and `cleaned.menu_capture` into Supabase so the map and future crowdsourced menu tooling can build on the same shape.
- Parses happy hour fields:
  - `happy_hour`
  - `happy_hour_days`
  - `happy_hour_start`
  - `happy_hour_end`
  - `happy_hour_price`
- Stores parse confidence plus parse status:
  - `parsed`
  - `partial`
  - `needs_review`
  - `failed`
- Adds a Melbourne-only business-model demo with free preview access, paid premium access, contributor unlocks, public submissions, missions, admin review, and aggregate analytics.

## Main Routes

- `GET /health`
- `GET /ready`
- `GET /api/business/config`
- `POST /api/business/auth/signup`
- `POST /api/business/auth/login`
- `POST /api/business/auth/supabase-session`
- `POST /api/business/auth/logout`
- `POST /api/business/auth/logout-all`
- `GET /api/business/account`
- `GET /api/business/access`
- `GET /api/business/missions`
- `POST /api/business/submissions`
- `POST /api/business/submissions/:id/verifications`
- `POST /api/business/submissions/:id/review`
- `POST /api/business/account/preferences`
- `POST /api/business/account/saved-items`
- `DELETE /api/business/account/saved-items`
- `POST /api/business/feedback`
- `POST /api/business/wrong-price-reports`
- `POST /api/business/requests`
- `POST /api/business/venue-interest`
- `GET /api/business/venue-portal`
- `POST /api/business/venue-portal/:venueId/submissions`
- `POST /api/business/venue-portal/:venueId/discount-redemptions`
- `GET /api/business/venue-portal/:venueId/pos-integration`
- `POST /api/business/pos/discount-redemptions`
- `GET /api/business/venue-portal/:venueId/reports/:month/export`
- `GET /api/business/admin/kpis`
- `GET /api/business/admin/retention`
- `GET /api/business/admin/coverage`
- `GET /api/business/admin/partner-leads`
- `GET /api/business/admin/queues`
- `GET /api/business/admin/venue-partners`
- `POST /api/business/admin/venue-managers`
- `POST /api/business/admin/venue-managers/revoke`
- `POST /api/business/admin/reports/monthly/generate`
- `POST /api/business/admin/reports/monthly/deliver`
- `POST /api/business/admin/venue-interest/:id/status`
- `POST /api/business/admin/venue-outreach`
- `POST /api/business/billing/checkout`
- `POST /api/business/billing/webhook`
- `GET /api/business/analytics/preview`

Field-test note: `/api/admin/*` and `/api/business/admin/*` are admin-only. The old call-control, call-result, and call-webhook endpoints (`/api/calls/*`, `/api/results`, `/webhooks/*`) have been retired and now return not-found responses.

For the intended beta role boundaries, private-data rules, and approval gates, see [`ROLE_PERMISSION_MATRIX.md`](./ROLE_PERMISSION_MATRIX.md).

## Business Model Demo

The hosted viewer now includes a focused Melbourne/Victoria MVP business layer:

- Free users can view the map, venue pins, suburbs, data freshness, missions, happy hours, and pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.
- Premium users can unlock full map utility, every verified beer price, value rings, premium filters, saved night shortcuts, discount-pass access, savings tracking, and venue special-discount details at A$4.99/month or A$50/year.
- Contributors can earn temporary premium access for the rest of the current month after 15 approved monthly contribution points.
- Discount redemptions are explicit only: a paid/contributor user generates a rotating code, venue staff redeem it manually, or Pro venues can wire a POS webhook with a per-venue HMAC token. The app records the discounted item, quantity, savings and server redemption time for user savings history and aggregate venue proof-of-value.
- Public submissions are queued as `pending` and do not become trusted map data until reviewed.
- Approved submissions publish `venue_price_records`, which the map merges into existing venue data for existing venues.
- Mission points are weighted by usefulness, not by number of bars visited: venues updated in the last 24 hours are worth 0.1 points, week-old data is worth 0.5 points, stale data is worth 1 point, and venues with no trusted data are worth 5 points. Repeated same-venue submissions in the same month are capped.
- Admin review lives at `/admin.html` and is protected by account role checks via `ADMIN_EMAILS`.
- Retired call/result APIs are no longer mounted in the active app.
- The public map no longer exposes legacy admin controls or direct browser reads of exact price records.
- Exact price records are redacted by default unless they are part of the free preview: happy hours plus pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.
- Analytics are captured as aggregate events only. Search, filter, happy-hour interest, map pin clicks, venue opens, beer-list views, and price reveal events feed admin and paid venue-tier reports without exporting individual clickstreams.
- The admin KPI dashboard tracks early validation metrics, retention cohorts, data coverage, and potential partner leads from aggregated demand.
- Users can save venues, beers, and suburbs, submit feedback, report wrong prices, and request missing venues or beers.
- The public map includes retention filter chips, active happy-hour previews, recently verified price previews, and wrong-price reporting.
- The public map supports optional one-time browser location for “near me” sorting, approximate venue distances, and active happy hours nearby. Location is first requested after the user taps “Use my location”; if permission is granted, Pint Path remembers that on-device preference and can request one-time location again on future map visits. Users can tap “Location on” to turn the remembered preference off. Browsing coordinates are kept in browser state and analytics store only coarse context such as approximate suburb, selected radius, distance bucket, and coverage status.
- Contributor uploads can optionally save an intentional one-time upload-location proof with the private submission record. The browser keeps the proof locally for up to 12 hours or until the submission succeeds, so a contributor can capture location at the venue and submit after signal returns. Approved submissions only earn points when that saved upload location is within 200m of the selected venue.

Business demo pages:

- `/pricing.html`: venue pricing for Free, Plus A$149, and Pro A$299 bar plans.
- `/account.html`: signup/login, 18+ confirmation, access status, points, saved items, privacy preferences, requests, session controls, and submission status.
- `/missions.html`: Needs Data mission board with sorting, quick-win guidance, and points.
- `/submit.html`: venue data submission with manual rows and photo/source queue.
- `/trust.html`: public trust centre explaining verification, private evidence, aggregate venue insights, and support paths.
- `/community.html`: contributor community standards, moderation rules, anti-abuse expectations, and appeal paths.
- `/security.html`: security/privacy support page for account controls, data requests, abuse reports, and responsible disclosure.
- `/venue-portal`: invite-only, admin-assigned venue dashboard for profile details, beer stock/on-tap rows, prices, happy hours, tier-gated specials, listing quality, tier-gated analytics, generated monthly reports, exports, and pending review updates. `/for-bars` redirects here so public users do not see venue-owner operating details.
- `/admin.html`: admin-only submission review, KPI dashboard, cohorts, coverage, partner leads, and review queues.

Supabase auth/account foundation:

- The beta keeps the existing Pint Path bearer-session system for app API access, but can exchange a Supabase Auth OAuth session for a local Pint Path session through `POST /api/business/auth/supabase-session`.
- `/account.html` shows Google and Apple quick-login buttons when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are configured. Email/password signup/login still works through the existing Pint Path account flow.
- Supabase OAuth providers must be configured in the Supabase dashboard. Use only minimal scopes: email/profile for Google and name/email for Apple.
- In Supabase Auth URL configuration, allow the app callback pages: `http://localhost:3000/auth/callback` and `https://pintpath.au/auth/callback`.
- In the Google and Apple provider consoles, allow the Supabase provider callback URL derived from `SUPABASE_URL`. For production with `SUPABASE_URL=https://auth.pintpath.au`, the exact provider callback is `https://auth.pintpath.au/auth/v1/callback`.
- New or linked users get an app-facing profile row in the local `profiles` table; private provider/auth data should stay in Supabase Auth, not public app tables.
- Supabase `user_metadata` is not trusted for age confirmation, legal acceptance, roles, venue access, or paid entitlements. Pint Path records those states through its own server-side account/legal/admin/Stripe flows.
- Production admin access should use Supabase Auth MFA/Auth Assurance Level 2 (`aal2`) for normal operation. During owner-led field testing, `REQUIRE_ADMIN_MFA_IN_PRODUCTION=false` can temporarily skip MFA while still requiring the admin email allowlist and verified email.
- Public browsing stays anonymous. Uploads and verification actions require a logged-in account, and submissions always use the authenticated session user rather than a client-provided user id.
- Users cannot verify their own uploads. Verifications are recorded in `verifications`, and intentional product actions are recorded in `user_activity_events`.
- Supabase/Postgres RLS-ready tables and policies live in `supabase/migrations/20260512000000_auth_profiles_activity.sql` for `public.profiles`, `beermap_uploads`, `beermap_verifications`, `user_activity_events`, `age_verifications`, and the private `beermap-source-evidence` Storage bucket. `supabase/migrations/20260516000000_user_price_submissions.sql` added an early direct-Supabase contributor scaffold, but the canonical production contribution path is now the Express `POST /api/business/submissions` flow so uploads consistently attach the authenticated user, private evidence, location eligibility, review workflow, and points ledger. `supabase/migrations/20260530000000_deprecate_direct_supabase_contributor_tables.sql` keeps those older direct tables for history while revoking browser writes. `supabase/migrations/20260523000000_submission_location_points.sql` adds private upload-location proof fields and point-award tracking for contributor submissions. `supabase/migrations/20260524010000_account_privacy_settings.sql` adds per-user optional analytics, venue-insight inclusion, product-research, and email-update preferences with owner-only RLS. `supabase/migrations/20260603000000_harden_private_helper_functions.sql` locks down private security-definer helpers with public execute revokes and narrow search paths.
- `/account.html` now has two states: logged-out users see polished Supabase Google/Apple/email sign-in/create-account forms, while authenticated users see a contributor dashboard with stats, recent submissions, private-evidence copy, and quick beer-price upload entry points. Supabase OAuth and password-reset redirects land on `/auth/callback`, exchange the session, and then return to the account page or requested upload page.
- Age-gated reward readiness is only a foundation: `age_verifications` stores status, `18+` threshold, provider name/reference, expiry, and booleans. Pint Path must not store raw ID documents, ID images, licence/passport/Medicare numbers, or raw proof-of-ID data.
- Future rewards should use `canAccessAgeGatedRewards(...)`, which requires verified 18+ status, a latest verified age-check record, and a non-expired verification.

Venue partner demo layer:

- Public self-claiming is disabled during beta. Admin assigns verified venue managers from `/admin.html`; `/for-bars` redirects to the invite-only `/venue-portal` access screen.
- Admin can assign or revoke venue managers from `/admin.html`.
- Venue managers can only access assigned venues on `/venue-portal`.
- Free/Basic venue accounts can add beer data and happy-hour data only; Pint Path specials, venue analytics, and monthly reports stay locked.
- Plus A$149 unlocks normal reviewed Pint Path specials, privacy-safe suburb-level analytics, Plus demand snapshots with beer/style opportunities, a staff/customer venue update link for QR prompts, and protected monthly report generation/export in CSV or JSON. Venue-tier checkout reuses the existing Stripe/demo billing flow when `STRIPE_PLUS_PRICE_ID` is configured with a Stripe `price_...` ID.
- Pro A$299 adds visible premium placement: gold/violet map and listing treatment, featured Pint Path exclusive specials after review, priority admin review ordering for venue updates, a Pro growth studio with premium-placement readiness and weekend playbooks, Pro-only monthly growth recommendations, and a transparent Best Match discovery boost that does not fake popularity or override cheapest/nearest sorting. Configure `STRIPE_PRO_PRICE_ID` with the Pro Stripe `price_...` ID.
- Venue manager data updates are scoped to assigned venues. Verified public price publishing still goes through the existing review/approval flow.
- Venue insights are aggregate-only and do not expose user names, individual clickstream, exact user location, private source evidence, or another venue’s private data.
- The portal includes a listing quality score, wrong-price reports, user requests, current verified records, and a copyable update link for QR/signage use.

Venue owner TODOs before paid partner rollout:

- Add a full Stripe Customer Portal/manage-billing flow for venue tiers if paid venue subscriptions move beyond Checkout.
- Add an admin approval interface for authenticated `venue_claim_requests`; claims are stored for manual review today.
- Add stronger claim verification such as business email, phone, or document checks.
- Integrate a real report email provider after staging verifies recipient scoping; current report delivery is disabled/mock-only.
- Expand generated monthly reports from the aggregate `events` pipeline as production search/click volume grows.
- Decide whether trusted venue-manager updates can publish as `venue_confirmed` automatically, or should remain admin-reviewed.
- Replace suburb-based analytics with custom Pint Path areas such as Melbourne CBD, Fitzroy, Richmond, or Chapel Street once those boundaries are defined.

Responsible-alcohol guardrails:

- 18+ confirmation plus Terms and Privacy Policy acceptance are required for account signup and full price/submission flows.
- The demo does not collect government ID documents.
- Copy is intentionally neutral: verified prices, data accuracy, and responsible use.
- Partner venue credit/rewards are marked as coming soon and are disabled.

Location/privacy guardrails:

- Location is opt-in only and uses one-time `getCurrentPosition`; the app does not use continuous tracking.
- Distances are approximate straight-line distances, not walking or driving routes.
- Analytics events for near-me actions store coarse context such as radius and status only, not exact latitude/longitude.
- If location permission is denied or unavailable, users can still search by venue, suburb, or beer.

## Small Public Beta Hardening

For the Melbourne beta, exact prices must flow through the Express API, not direct browser database reads.

- `/api/business/price-records` returns exact records only for admin, premium, contributor access, or the free preview scope: happy hours plus pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.
- Free users cannot reveal every price by repeatedly opening venues; premium/contributor/admin access is required for the full price catalogue.
- The map gets venue pins and preview metadata by default, then requests venue detail records when a user opens a venue panel. The server still decides which exact prices are visible.
- Admin tools live on `/admin.html` and `/api/business/admin/*`; public map HTML should not include admin unlock forms or secret-entry UI.
- Photo/source uploads are validated for image MIME type and 6MB max size, then stored behind private source-evidence references. In production, decoded image bytes are written to the private `SOURCE_EVIDENCE_STORAGE_DIR` filesystem/volume path instead of inline SQLite blobs. Review/download access is issued through short-lived signed server URLs after an uploader/admin authorization check.
- `DEMO_BILLING_MODE=true` is for local/demo only. Production blocks demo billing unless `ALLOW_DEMO_BILLING_IN_PRODUCTION=true` is explicitly set.
- State-changing business APIs check trusted origins and use hashed-key rate limits for auth, submissions, feedback, requests, price reveals, and billing routes. Production fails closed when Redis is missing unless `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true` is explicitly set for a short emergency beta window. Full-scale production should set `REDIS_URL` and keep `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false`.
- Security headers are enabled with a Google Maps-compatible CSP, `nosniff`, same-origin frame protection, strict referrer policy, and limited browser permissions.
- Account sessions are hashed at rest, expire by role, can be revoked with logout/logout-all, and store only short SHA-256 request fingerprints rather than raw IP addresses or user agents.
- Sensitive admin, payment, session, and venue-manager actions are written to `security_audit_log` with redacted metadata.
- Aggregate analytics use `ANALYTICS_MIN_BUCKET_SIZE` to suppress low-count buckets before they are returned to dashboards or venue-owner views.
- Retired call automation routes stay unavailable in the active app. Keep any future provider automation in a separate security-reviewed feature branch.
- Production admin routes require the configured admin email allowlist and verified email. They also require a fresh MFA/AAL2 claim when `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true`; this can be temporarily set to `false` for owner-led field testing.
- Upload and verification actions require a verified account in production when `REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true`.
- Inline demo image evidence is never exposed publicly. Production field uploads use private filesystem/volume evidence storage plus signed review links; keep the `beermap-source-evidence` Supabase Storage bucket private if/when evidence storage is migrated there at larger scale.
- `FIELD_TEST_MODE=true` adds an unobtrusive beta label, feedback entry point, and admin field-test summary without exposing debug details to public users.
- Run `npm run security:scan` before deploy to catch common committed secret patterns. If it flags a real key, rotate it immediately and replace it with an env placeholder.
- Run `npm run security:audit` before deploy to catch high-severity dependency advisories.
- Run `npm run test:release:pintpath` before a release candidate. This executes the repo-native Pint Path release-readiness suite against synthetic/local data only, plus secret and dependency checks. See `docs/release-readiness-checklist.md` for provider-only blockers that still need staging/manual verification.
- Production startup now requires an HTTPS `PUBLIC_BASE_URL`, `GOOGLE_MAPS_API_KEY`, and `GOOGLE_MAPS_MAP_ID`; admin routes stay locked until `ADMIN_EMAILS` is configured with the approved owner/admin email.
- `/ready` initializes the database-backed routers and should be used as the deeper readiness check after `/health`.
- See `FIELD_TEST_CHECKLIST.md` before showing the app to real users.
- See `DEPLOYMENT_CHECKLIST.md` before merging to `main` or deploying the Railway beta; it includes backup, migration, security scan, smoke-test, and rollback steps.

Security and rotation notes:

- Browser Google Maps keys are public by design, but should still be restricted to `https://pintpath.au/*`, `http://localhost:3000/*`, and `http://127.0.0.1:3000/*`. If a browser key was ever committed or shared too broadly, rotate it in Google Cloud and update Railway/local env.
- Supabase service-role keys, Stripe secret keys, Stripe webhook secrets, OpenAI keys, and private Google Places keys must stay server-side only. If any were exposed, rotate them with the provider, update Railway env, restart the service, and run `npm run security:scan`.
- Do not use standalone static viewer mode for public beta price data, because it cannot enforce server-side price gating.

Suggested production beta values:

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://pintpath.au
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
FREE_PRICE_REVEALS_PER_DAY=5
FIELD_TEST_MODE=true
# Optional until the official owner/admin email is approved.
# Without this, public traffic can run but admin routes are disabled.
ADMIN_EMAILS=
SESSION_TTL_DAYS=60
ADMIN_SESSION_TTL_DAYS=7
ANALYTICS_MIN_BUCKET_SIZE=5
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
ADMIN_MFA_MAX_AGE_MINUTES=720
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
GOOGLE_MAPS_API_KEY=your_google_maps_browser_key
GOOGLE_MAPS_MAP_ID=your_google_vector_map_id
REPORT_TIMEZONE=Australia/Melbourne
REPORT_EMAIL_MODE=disabled
REDIS_URL=redis://default:replace_me@host:6379
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300
POS_WEBHOOK_SIGNING_SECRET=replace_with_32_plus_random_characters
STRIPE_SECRET_KEY=sk_test_or_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_MONTHLY=price_monthly_499_aud
STRIPE_PRICE_YEARLY=price_yearly_50_aud
STRIPE_PLUS_PRICE_ID=price_venue_plus_aud
STRIPE_PRO_PRICE_ID=price_venue_pro_aud
```

Run `npm run readiness:providers` after configuring env. It checks required provider values without printing secrets.

Stripe test-mode webhook check:

1. Set `DEMO_BILLING_MODE=false` and Stripe test keys in `.env`.
2. Run `npm run dev`.
3. In another terminal, run:

```bash
stripe listen --forward-to localhost:3000/api/business/billing/webhook
```

4. Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.
5. Start checkout from `/pricing.html` or `/account.html` and complete it with a Stripe test card.
6. Confirm `/account.html` shows premium access after the webhook is delivered.

Local MVP flow checks:

- Free map: open `http://localhost:3000`, confirm pins appear, happy hours are visible, and only Guinness/Carlton Draught/Stone & Wood Pacific Ale pint prices are exact.
- Signup/age gate: create an account, confirm 18+, then submit venue data at `/submit.html`.
- Admin approval: sign up with an email in `ADMIN_EMAILS`, open `/admin.html`, approve the pending submission, and confirm points are awarded.
- Contributor unlock: approve enough unique-venue points to reach `CONTRIBUTOR_UNLOCK_POINTS`, then confirm full access and map price visibility.
- KPI tracking: open `/admin.html` and confirm KPI, retention, coverage, partner lead, and queue sections load for admin only.

## Exact Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Set these values:

```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
PUBLIC_BASE_URL=https://your-ngrok-subdomain.ngrok-free.app
DATABASE_PATH=./data/pint-path.sqlite
TRUST_PROXY=true
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_publishable_or_legacy_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
# Configure Google/Apple OAuth providers in Supabase dashboard.
# Redirect URLs: http://localhost:3000/auth/callback and https://pintpath.au/auth/callback.
SUPABASE_OAUTH_PROVIDERS=google,apple
SUPABASE_MENU_CAPTURE_TABLE=venue_menu_captures
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
GOOGLE_MAPS_MAP_ID=your_google_vector_map_id
GOOGLE_PLACES_API_KEY=your_server_side_google_places_api_key
ADMIN_EMAILS=you@example.com
SESSION_TTL_DAYS=60
ADMIN_SESSION_TTL_DAYS=7
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
ADMIN_MFA_MAX_AGE_MINUTES=720
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
FREE_PRICE_REVEALS_PER_DAY=5
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
ANALYTICS_MIN_BUCKET_SIZE=5
REPORT_TIMEZONE=Australia/Melbourne
REPORT_EMAIL_MODE=disabled
REDIS_URL=
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
DEMO_BILLING_MODE=true
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300
POS_WEBHOOK_SIGNING_SECRET=replace_with_32_plus_random_characters
FIELD_TEST_MODE=true
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_MONTHLY=price_monthly_499_aud
STRIPE_PRICE_YEARLY=price_yearly_50_aud
STRIPE_PLUS_PRICE_ID=price_venue_plus_aud
STRIPE_PRO_PRICE_ID=price_venue_pro_aud
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
```

What each one does:

- `PUBLIC_BASE_URL`: your public HTTPS base URL. Use your ngrok URL here.
- `HOST`: interface the Node server should bind to. Use `0.0.0.0` for Railway and other hosted deployments.
- `DATABASE_PATH`: SQLite file path.
- `SUPABASE_URL`: Supabase project URL used for venue imports, map-sync result writes, and optional Supabase Auth OAuth login.
- `SUPABASE_ANON_KEY`: browser-safe publishable key, or legacy anon key, used by `/account.html` for Supabase Auth OAuth. Never use the service-role key in browser config.
- `SUPABASE_SERVICE_ROLE_KEY`: required for inserting venues and syncing reviewed/admin menu captures.
- `SUPABASE_OAUTH_PROVIDERS`: comma-separated provider buttons to show on `/account.html`; set this to providers configured in the Supabase dashboard, for example `google,apple`.
- `SUPABASE_MENU_CAPTURE_TABLE`: server-side reviewed menu/manual capture table. Defaults to `venue_menu_captures`.
- `GOOGLE_MAPS_API_KEY`: browser-safe Google Maps key used by the hosted viewer.
- `GOOGLE_MAPS_MAP_ID`: production-required JavaScript/vector Google Maps Map ID for branded map styling and AdvancedMarkerElement support. Local development can fall back to `DEMO_MAP_ID`.
- `GOOGLE_PLACES_API_KEY`: server-side key used by venue imports and mission area geocoding. Enable Places API and Geocoding API on this key. If absent, server lookups fall back to `GOOGLE_MAPS_API_KEY` where possible.
- `ADMIN_EMAILS`: comma-separated emails that become admin accounts on signup. In production this can be left blank while the official ABN/admin email is pending; the public site will still boot, but admin routes will return `403` until the allowlist is configured.
- `SESSION_TTL_DAYS`: normal account bearer-session lifetime. Defaults to `60`.
- `ADMIN_SESSION_TTL_DAYS`: shorter admin bearer-session lifetime. Defaults to `7`.
- `REQUIRE_ADMIN_MFA_IN_PRODUCTION`: production guard for admin routes. Prefer `true` for normal production; set `false` only for short owner-led field testing while keeping `ADMIN_EMAILS` and email verification enforced.
- `ADMIN_MFA_MAX_AGE_MINUTES`: maximum age for admin AAL2/step-up claims. Defaults to `720`.
- `REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION`: production guard for uploads, verifications, and venue dashboard access. Keep `true`.
- `FREE_PRICE_REVEALS_PER_DAY`: configurable daily exact-price previews for free users.
- `CONTRIBUTOR_UNLOCK_POINTS`: approved monthly contribution points required for contributor access.
- `CONTRIBUTOR_UNLOCK_DAYS`: legacy fallback setting. Contributor unlocks now expire at the end of the current month after the monthly point threshold is reached.
- `ANALYTICS_MIN_BUCKET_SIZE`: minimum aggregate bucket count before dashboard analytics reveal a beer, suburb, or venue identity.
- `REPORT_TIMEZONE`: timezone used for generated monthly report boundaries. Keep `Australia/Melbourne` for the current market.
- `REPORT_EMAIL_MODE`: `disabled` prevents any report email payloads; `mock` is for staging/tests only and does not send real email.
- `REDIS_URL`: Redis connection URL for production/distributed rate limiting. Configure this for Railway/production before exposing auth, uploads, price reveals, feedback, or checkout publicly.
- `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION`: emergency fallback for a single-instance controlled beta only. Defaults to `false`; leave it false for full-scale production so protected routes fail closed if Redis is missing or unavailable.
- `DEMO_BILLING_MODE`: when `true`, checkout can simulate a premium subscription without live Stripe. Keep this `false` for production beta.
- `ALLOW_DEMO_BILLING_IN_PRODUCTION`: emergency override that allows demo billing in production. Leave `false` unless you are intentionally running a demo environment.
- `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION`: legacy emergency override for inline demo image evidence. Leave `false`; production uploads should use private filesystem/volume evidence storage.
- `SOURCE_EVIDENCE_STORAGE_DIR`: private server-side directory for source evidence files. On Railway, keep this under the mounted `/app/data` volume, for example `./data/source-evidence`.
- `SOURCE_EVIDENCE_SIGNING_SECRET`: private 32+ character server-side secret used to sign short-lived source-evidence review/download URLs. Generate it with `openssl rand -base64 32`; never commit it or expose it through `/config.js`.
- `SOURCE_EVIDENCE_SIGNING_SECRET`: 32+ character random secret used to sign short-lived source evidence URLs. Public pages can boot without it, but source-evidence review/download links fail closed in production until configured.
- `SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS`: signed evidence URL lifetime. Defaults to `300`.
- `POS_WEBHOOK_SIGNING_SECRET`: private 32+ character server-side secret used to derive per-venue POS webhook tokens for Pro venue discount redemptions. Generate it with `openssl rand -base64 32`; rotate it if a POS token is exposed.
- `FIELD_TEST_MODE`: shows beta feedback affordances and an admin field-test summary. Keep enabled for private field tests; disable for a polished public launch.
- `STRIPE_SECRET_KEY`: Stripe test/live secret key for checkout sessions and webhook calls.
- `STRIPE_WEBHOOK_SECRET`: Stripe endpoint secret used to verify subscription webhooks.
- `STRIPE_PRICE_MONTHLY`: Stripe price ID for the A$4.99/month plan.
- `STRIPE_PRICE_YEARLY`: Stripe price ID for the A$50/year plan.
- `STRIPE_PLUS_PRICE_ID`: Stripe price ID for the paid Plus venue analytics tier.
- `STRIPE_PRO_PRICE_ID`: Stripe price ID for the premium Pro venue tier.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: browser publishable key placeholder for future embedded Stripe UI.

## Exact ngrok Workflow

1. Install dependencies.

```bash
npm install
```

2. Start the app.

```bash
npm run dev
```

3. Start ngrok in another terminal.

```bash
ngrok http 3000
```

4. Copy the HTTPS forwarding URL from ngrok.

Example:

```text
https://abc123.ngrok-free.app
```

5. Put that exact URL into `.env` as `PUBLIC_BASE_URL`.

```dotenv
PUBLIC_BASE_URL=https://abc123.ngrok-free.app
```

6. Restart the app after editing `.env`.

## Pint Path Production Domain

The official production URL is:

Use:

```text
pintpath.au
```

That is the recommended live host for this project. Keep localhost/ngrok for local testing and use `pintpath.au` for production Railway traffic once DNS is fully configured.

When you deploy it, switch:

```dotenv
PUBLIC_BASE_URL=https://pintpath.au
```

Recommended rollout:

1. Keep local development on `localhost` and ngrok.
2. Deploy the app to Railway.
3. Point `pintpath.au` at that host with DNS.
4. Switch `PUBLIC_BASE_URL` to `https://pintpath.au`.
5. Add the domain to your Google Maps browser key referrer rules.

Recommended Google Maps browser key referrers once hosted:

- `https://pintpath.au/*`
- `http://localhost:3000/*`
- `http://127.0.0.1:3000/*`

Recommended Google key split long-term:

- `.env` `GOOGLE_MAPS_API_KEY`: browser Google Maps key for web map rendering
- `.env` `GOOGLE_PLACES_API_KEY`: server-side key for venue import/search and mission area geocoding
- later: dedicated iOS key for the App Store app
- later: dedicated Android key for the Play Store app

Recommended hosted environment values:

```dotenv
PUBLIC_BASE_URL=https://pintpath.au
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
GOOGLE_MAPS_API_KEY=your_google_maps_browser_key
GOOGLE_MAPS_MAP_ID=your_google_vector_map_id
REPORT_TIMEZONE=Australia/Melbourne
REPORT_EMAIL_MODE=disabled
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
```

## Railway Deployment

This repo includes [railway.toml](/Users/zac/Desktop/Beer/railway.toml) with:

- build command: `npm run build`
- start command: `npm run start`
- healthcheck path: `/health`

Recommended Railway service setup:

1. Deploy one web service from this repo.
2. Attach a persistent volume mounted at `/app/data`.
3. Set `DATABASE_PATH=./data/pint-path.sqlite`.
4. Set `PUBLIC_BASE_URL=https://pintpath.au`.
5. Add the custom domain `pintpath.au`.

Because the app uses SQLite for local sessions, submissions, approvals, venue portal state, and analytics queues, the persistent volume matters.

## Viewer Google Maps Setup

The viewer supports two modes:

1. Hosted through the Express app
   This is the recommended production path on Railway.
2. Standalone static viewer
   This is useful for quick local-only tests with `npx serve viewer`.

When the viewer is hosted through the Express app, the browser config is served automatically from:

- `/config.js`

and uses these safe env vars:

- `GOOGLE_MAPS_API_KEY`
- `GOOGLE_MAPS_MAP_ID`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_OAUTH_PROVIDERS`

The hosted public viewer may receive the Supabase anon key for OAuth login only. It must never receive the Supabase service-role key, and venue/price data still comes through `/api/business/venues` and `/api/business/price-records` so exact-price access can be enforced server-side.

For legacy standalone local use, the viewer can still use:

- `viewer/config.js`

Start from the example:

```bash
cp viewer/config.example.js viewer/config.js
```

Then set:

```js
window.MELB_BEER_BOT_VIEWER_CONFIG = {
  googleMapsApiKey: "your_google_maps_browser_key",
  googleMapsMapId: "your_google_vector_map_id",
  trackedBeers: [],
  business: {
    fieldTestMode: true,
    freePriceRevealsPerDay: 3,
    supabaseUrl: "https://your-project.supabase.co",
    supabaseAnonKey: "your_supabase_anon_browser_key",
    supabaseOauthProviders: ["google", "apple"],
  },
};
```

Notes:

- Do not use standalone static mode for public beta price data, because it cannot enforce server-side price gating.
- `googleMapsApiKey` should be a browser key restricted by HTTP referrers
- `googleMapsMapId` is required for production AdvancedMarkerElement/vector map styling. Local-only tests can fall back to Google's `DEMO_MAP_ID`.
- `supabaseAnonKey` is public and only for Supabase Auth OAuth. Never put a service-role key in `viewer/config.js`.

Create the Google Maps Map ID in Google Cloud before launch:

1. Enable Maps JavaScript API in the Pint Path Google Cloud project.
2. Open Google Maps Platform Map Management.
3. Create a Map ID named `Pint Path Production Vector Map`.
4. Choose JavaScript and vector map styling.
5. Copy the Map ID into Railway/local env as `GOOGLE_MAPS_MAP_ID`.

For local browser testing, allow these referrers on the Google Maps browser key:

- `http://localhost:3000/*`
- `http://127.0.0.1:3000/*`
- `http://localhost:*/*`
- `http://127.0.0.1:*/*`

For hosted staging, also allow:

- `https://pintpath.au/*`

Make sure the same Google Cloud project has:

- `Maps JavaScript API` enabled
- a JavaScript/vector Map ID configured as `GOOGLE_MAPS_MAP_ID`
- `Geocoding API` enabled on the server-side Places/geocoding key if mission street/suburb lookup is used
- billing enabled

Long-term recommended key split:

- browser web viewer: Google Maps browser key via `/config.js` or `viewer/config.js`
- server-side venue import and mission geocoding: `GOOGLE_PLACES_API_KEY`
- iOS app: dedicated iOS Maps key
- Android app: dedicated Android Maps key

That keeps local testing, the web viewer, and the future mobile apps on the same Google Maps platform without sharing one over-broad key.

## Melbourne Venue Import

Import or refresh Melbourne bar and pub venues into Supabase `venues`:

```bash
npm run venues:import -- --dry-run
```

Then run the real import:

```bash
npm run venues:import
```

Notes:

- the importer scans a Melbourne metro grid with Google Places Nearby Search
- it keeps only venues Google classifies as a strict `bar` or `pub`
- it excludes obvious noisy results like airport lounges and sports/golf club false positives
- it updates existing rows by `google_place_id` when available
- it falls back to matching by normalized `name + address`
- it stores `name`, `address`, `suburb`, `state`, `postcode`, `phone`, `website`, `latitude`, and `longitude`
- it continues past single-cell Google API failures instead of killing the whole run

If you want to test on a smaller area first:

```bash
npm run venues:import -- --dry-run --max-cells=5
```

For a targeted Melbourne CBD backfill to catch bars the broad metro grid can miss:

```bash
npm run venues:import:city -- --dry-run
npm run venues:import:city
```

That city backfill:

- runs Google Places Text Search against Melbourne CBD bar/pub queries
- is useful for filling gaps where Nearby Search ranking misses inner-city venues
- still dedupes by `google_place_id` first, then normalized `name + address`

For an inner-ring Melbourne suburb backfill across:

- Fitzroy
- Collingwood
- Richmond
- Carlton
- South Yarra
- St Kilda
- Brunswick
- Prahran
- South Melbourne

run:

```bash
npm run venues:import:inner-ring -- --dry-run
npm run venues:import:inner-ring
```

That inner-ring backfill:

- runs Google Places Text Search suburb-by-suburb for bars and pubs
- is useful for catching major hospitality pockets just outside the CBD
- keeps the suburb list explicit instead of widening the whole metro filter

## Legacy Call Automation Archive

The old outbound phone-call automation has been removed from the repository and is no longer built, tested, mounted, configured, or documented as a supported Pint Path feature.

Do not configure phone-call provider secrets in Railway for the active product. If that idea ever comes back, rebuild it as a separate, security-reviewed feature from git history instead of re-enabling it casually.

## Viewer Data Source

The hosted `viewer/index.html` now reads venue pins and approved price previews through the local Express business API:

- `GET /api/business/venues`
- `GET /api/business/price-records`

`/api/business/price-records` returns redacted records by default, except for the free preview scope: happy hours plus pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale. The viewer requests `reveal=true&venueId=...` only when a user opens a venue detail, and the server decides whether any additional exact prices can be returned.

Reviewed admin/menu captures can sync into Supabase `venue_menu_captures` for internal review history, but the public browser should not read that table directly. Public map data should come from approved `venue_price_records`.

The hosted Express app serves browser config from `/config.js`. For standalone static testing only, you can copy `viewer/config.example.js` to a local ignored `viewer/config.js`; do not commit real browser keys.

For quick local testing with a temporary browser key override, you can also open:

```text
http://localhost:3000/?googleMapsKey=YOUR_BROWSER_KEY
```

The synced `cleaned` payload is now more map-friendly:

- `cleaned.beers.<beer_key>` contains the structured beer outcome for each known beer
- `cleaned.menu_items` exposes the same data as a simple list for future menu aggregation
- `cleaned.menu_capture` records the reviewed source type, such as manual entry, menu photo OCR, or source ingestion
- each beer entry includes explicit availability fields so the viewer can show `On tap`, `Cans only`, `Bottles only`, or `Unavailable` without guessing from free-text notes

That means the end-to-end loop is:

1. import venues into Supabase
2. collect user, venue-manager, or admin source evidence
3. review submissions/OCR/manual captures in the admin queue
4. store reviewed menu captures in `venue_menu_captures` where needed
5. publish trusted rows into `venue_price_records`
6. refresh the hosted viewer and see the server-gated map update

## Future Menu Roadmap

The current menu workflow is intentionally lightweight. The normalized payload leaves a clean runway for future crowdsourcing:

- keep `venue_menu_captures` focused on reviewed internal source captures
- treat `cleaned.menu_items` as the first small slice of venue menu knowledge
- later add crowdsourced venue menu submissions on top, keyed by `venue_id`
- merge crowdsourced menu items with venue-managed/admin-reviewed beer availability rather than replacing it

## Verification

Run the full local check suite:

```bash
npm run check
```

## Troubleshooting

### Map does not load

- Confirm `GOOGLE_MAPS_API_KEY` is set in Railway/local env.
- Confirm `GOOGLE_MAPS_MAP_ID` is set in production; AdvancedMarkerElement requires a map ID.
- Confirm the browser key allows `https://pintpath.au/*`, `http://localhost:3000/*`, and `http://127.0.0.1:3000/*`.
- Open `/config.js` and confirm it only contains browser-safe public settings.
- Confirm `/api/business/venues` returns public venue data.

### Login fails

- Confirm `PUBLIC_BASE_URL=https://pintpath.au` in production.
- Confirm Supabase Auth Site URL is `https://pintpath.au`.
- Confirm Supabase redirect URLs include `https://pintpath.au/auth/callback` and local `http://localhost:3000/auth/callback`.
- Confirm Google OAuth Authorized redirect URIs and Apple Sign in Return URLs include the Supabase provider callback from `SUPABASE_URL`, for example `https://auth.pintpath.au/auth/v1/callback`.
- Confirm the chosen OAuth provider is enabled in Supabase and its provider console.
- Confirm rate limiting is available: set `REDIS_URL` for production or explicitly allow the in-memory fallback for a short controlled beta.

### Uploads or source evidence fail

- Confirm users are logged in and email-verified where production requires it.
- Confirm `SOURCE_EVIDENCE_STORAGE_DIR` resolves to a writable private directory on the Railway volume.
- Confirm `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false`; production should not store field photos as inline SQLite demo evidence.
- If using Supabase Storage later, confirm the private bucket `beermap-source-evidence` exists and is not public.
- Confirm file size and MIME type fit the bucket policy.
- Confirm `SOURCE_EVIDENCE_SIGNING_SECRET` is set for server-side evidence review links.

### Venue updates do not appear on the map

- Manager and user-submitted changes are pending by default.
- Approve the pending submission or venue-manager change in admin before expecting public map updates.
- Confirm approved rows publish into `venue_price_records`; the public map should not read pending or raw source tables directly.
