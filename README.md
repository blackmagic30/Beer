# pint-path

`pint-path` is a production-minded Node.js + TypeScript app for Melbourne beer-price discovery. The current full-scale public launch scope is the Free web experience, contributor account flow, Free venue portal, admin review workflow, server-gated price/submission APIs, and an iOS app. Pricing, paid enrolment, trials, Pro, rewards, counter/redemption/POS, public happy-hour discovery, report delivery, and Android are deferred.

## Production architecture status

The repository is **not ready for the full-scale launch yet**. The checked-in server now has a canonical `DATABASE_URL` runtime: it opens a bounded PostgreSQL pool, verifies the private imported schema before serving, uses a least-privilege runtime role, and makes the legacy SQLite repository unavailable. The deployed production environment has not been migrated and still runs the older SQLite build. Launch remains blocked until the reviewed Postgres target is provisioned, the snapshot is imported and reconciled, the SQLite source is sealed read-only, and permanent staging proves two-replica concurrency, restore, deploy, and Postgres-compatible rollback.

Use two different pre-production systems: permanent integrated staging for routine migrations/auth/provider/two-replica/release proof, and a disposable restore-staging stack with different Railway, Postgres, Supabase/Auth/Storage, Redis, secrets, domain, callbacks, and volumes for destructive RPO/RTO drills. A separate Supabase bucket is only a private operational restore copy; the immutable authority must be provider-enforced object lock/WORM in a separate failure domain.

## Current Capabilities

- Public Melbourne beer-price map; happy-hour discovery is disabled for this release.
- Server-side price gating, fixed Free access, and contributor unlocks; paid entry points remain disabled.
- Contributor account dashboard with private evidence handling and submission history.
- Free venue portal for assigned-venue profile/hours, beers, stock/on-tap state, prices, safeguards, and pending review flows.
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
- Retains dormant business-model code for later evaluation, but the current release exposes no paid, trial, Pro, reward, redemption, counter, POS, public happy-hour, or report-delivery mode.

## Main Routes

- `GET /health`
- `GET /startup`
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
- `POST /api/business/venue-claim-requests`
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
- `POST /api/business/admin/venue-claims/:id/review`
- `POST /api/business/admin/reports/monthly/generate`
- `POST /api/business/admin/reports/monthly/deliver`
- `POST /api/business/admin/venue-interest/:id/status`
- `POST /api/business/admin/venue-outreach`
- `POST /api/business/billing/checkout`
- `POST /api/business/billing/webhook`
- `GET /api/business/analytics/preview`

Field-test note: `/api/admin/*` and `/api/business/admin/*` are admin-only. The old call-control, call-result, and call-webhook endpoints (`/api/calls/*`, `/api/results`, `/webhooks/*`) have been retired and now return not-found responses.

For the intended launch role boundaries, private-data rules, and approval gates, see [`ROLE_PERMISSION_MATRIX.md`](./ROLE_PERMISSION_MATRIX.md).

## Current Launch Business Model

The hosted viewer now includes a focused Melbourne/Victoria MVP business layer:

- Free users can view the map, venue pins, suburbs, data freshness, non-happy-hour missions, and pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.
- New paid consumer and venue enrolment is disabled. Dormant price and trial designs are not approved, advertised as current, or exposed through public configuration; pricing will be decided in a later release.
- Contributors can unlock the full verified catalogue for the rest of the current month after 15 approved monthly contribution points; this is contribution-based Free access, not a paid plan.
- Discount redemption, rewards, and Pro/POS commercial paths are outside this release and remain disabled.
- Public submissions are queued as `pending` and do not become trusted map data until reviewed.
- Approved submissions publish `venue_price_records`, which the map merges into existing venue data for existing venues.
- Mission points are weighted by usefulness, not by number of bars visited: venues updated in the last 24 hours are worth 0.1 points, week-old data is worth 0.5 points, stale data is worth 1 point, and venues with no trusted data are worth 5 points. Repeated same-venue submissions in the same month are capped.
- Admin review lives at `/admin.html` and is protected by account role checks via `ADMIN_EMAILS`.
- Retired call/result APIs are no longer mounted in the active app.
- The public map no longer exposes legacy admin controls or direct browser reads of exact price records.
- Exact price records are redacted by default unless they are part of the fixed pint preview for Guinness, Carlton Draught, and Stone & Wood Pacific Ale. Happy-hour and special-price records are removed from public responses for this release.
- Analytics are captured as aggregate events only. Search, filter, map pin clicks, venue opens, beer-list views, and price-detail views feed admin and future venue-tier reports without exporting individual clickstreams.
- The admin KPI dashboard tracks early validation metrics, retention cohorts, data coverage, and potential partner leads from aggregated demand.
- Users can save venues, beers, and suburbs, contact Pint Path, report wrong prices, and request missing venues or beers.
- The public map includes recently verified price previews and wrong-price reporting; happy-hour filters/cards/badges are disabled.
- The public map supports optional one-time browser location for “near me” sorting and approximate venue distances. Location is first requested after the user taps “Use my location”; if permission is granted, Pint Path remembers that on-device preference and can request one-time location again on future map visits. Users can tap “Location on” to turn the remembered preference off. Browsing coordinates are kept in browser state and analytics store only coarse context such as approximate suburb, selected radius, distance bucket, and coverage status.
- Contributor uploads can optionally save an intentional one-time upload-location proof with the private submission record. The browser keeps the proof locally for up to 12 hours or until the submission succeeds, so a contributor can capture location at the venue and submit after signal returns. Approved submissions only earn points when that saved upload location is within 200m of the selected venue.

Business demo pages:

- `/pricing.html`: future consumer and venue pricing; paid enrolment remains closed while the commercial launch flags are disabled.
- `/account.html`: signup/login, 18+ confirmation, access status, points, saved items, privacy preferences, requests, session controls, and submission status.
- `/missions.html`: Needs Data mission board with sorting, quick-win guidance, and points.
- `/submit.html`: venue data submission with manual rows and photo/source queue.
- `/trust.html`: public trust centre explaining verification, private evidence, aggregate venue insights, and support paths.
- `/community.html`: contributor community standards, moderation rules, anti-abuse expectations, and appeal paths.
- `/security.html`: security/privacy support page for account controls, data requests, abuse reports, and responsible disclosure.
- `/venue-portal`: manually verified Free venue-access workflow for assigned-venue profile/hours, beer stock/on-tap rows, prices, listing quality, safeguards, wrong-price/support handling, and pending review updates. A claim never grants access until independent admin approval. Pro, reports, specials, rewards, counter/POS, and public happy-hour surfaces are disabled. `/for-bars` redirects here so public users do not see venue-owner operating details.
- `/admin.html`: admin-only submission review, KPI dashboard, cohorts, coverage, partner leads, and review queues.

Supabase auth/account foundation:

- App APIs still use scoped Pint Path sessions, issued after a verified Supabase Auth exchange through `POST /api/business/auth/supabase-session`. The browser receives that app session in an HttpOnly cookie; native apps keep it in platform-protected storage.
- Supabase is an Auth provider for browser/native clients, not a direct
  application-data API. The final migration revokes all `anon`/`authenticated`
  public table, sequence, RPC, and private-helper privileges; venue, profile,
  submission, privacy, reward, and Storage access goes through the Express API
  or a server-only service-role path. This also makes a pre-deletion access JWT
  unable to use the Data API while it waits to expire.
- `/account.html` uses Supabase Auth for email/password plus configured Google sign-in. Direct Pint Path password signup/login exists only for localhost/development compatibility and returns `410` in production. Apple stays disabled for this launch.
- Configure Google in the Supabase dashboard with only the minimal email/profile scopes. Do not enable Apple until authorization-token revocation is implemented and tested.
- In Supabase Auth URL configuration, set the Site URL to `https://pintpath.au` and allow the exact web callbacks `http://localhost:3000/auth/callback` and `https://pintpath.au/auth/callback`. Allow `pintpath://auth-callback` only for a future Android release that enables native provider sign-in; current launch OAuth remains Google-only and Apple is deferred. The first-release iOS app is email/password only, declares no custom URL scheme, and uses the HTTPS callback for email confirmation/password recovery.
- In the Google provider console, allow the Supabase provider callback URL derived from `SUPABASE_URL`. For production with `SUPABASE_URL=https://auth.pintpath.au`, the exact provider callback is `https://auth.pintpath.au/auth/v1/callback`.
- In the canonical runtime, new or linked users get an app-facing profile row in the non-exposed Postgres application schema while private provider/auth data stays in Supabase Auth. The currently deployed SQLite production build remains transitional and must be migrated before launch.
- Supabase `user_metadata` is not trusted for age confirmation, legal acceptance, roles, or venue access. Pint Path records those states through server-side account/legal/admin flows.
- Production admin access requires Supabase Auth MFA/Auth Assurance Level 2
  (`aal2`). This full-scale release has no production field-test/beta exception;
  keep `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true` and block admin access until AAL2
  is configured and proved.
- Public browsing stays anonymous. Uploads and verification actions require a logged-in account, and submissions always use the authenticated session user rather than a client-provided user id.
- Users cannot verify their own uploads. Verifications are recorded in `verifications`, and intentional product actions are recorded in `user_activity_events`.
- Supabase/Postgres tables and defense-in-depth RLS policies live in `supabase/migrations/20260512000000_auth_profiles_activity.sql` and later migrations. Earlier migrations included direct-browser owner policies for `public.profiles`, uploads, verification, activity, privacy, and rewards, but the canonical production path is Express-only. `20260803000000_revoke_direct_browser_data_api.sql` removes every remaining `anon`/`authenticated` Data API/RPC/helper privilege without weakening server/service-role access. The full-scale migration must also put authoritative app tables in a non-exposed schema and connect through a dedicated least-privilege database role; the Supabase service-role key is not the Postgres runtime login. The private `beermap-source-evidence` bucket has no browser object policies.
- Local database resets, pgTAP coverage, and the isolated CI database gate are documented in [`docs/supabase-database-testing.md`](docs/supabase-database-testing.md). These checks intentionally cover only repository-owned objects; the production `public.venues` schema remains externally managed and must be reconciled separately rather than invented by local tests.
- `/account.html` now has two states: logged-out production users see Google web sign-in, while authenticated users see a contributor dashboard with stats, recent submissions, private-evidence copy, and quick beer-price upload entry points. Email/password forms remain localhost-only for development; the first iOS release uses Supabase email/password. OAuth, confirmation, and password-recovery redirects land on `/auth/callback`, exchange the session where applicable, and then return to the account page or requested upload page.
- Age-gated reward readiness is only a foundation: `age_verifications` stores status, `18+` threshold, provider name/reference, expiry, and booleans. Pint Path must not store raw ID documents, ID images, licence/passport/Medicare numbers, or raw proof-of-ID data.
- Future rewards should use `canAccessAgeGatedRewards(...)`, which requires verified 18+ status, a latest verified age-check record, and a non-expired verification.

Venue partner demo layer:

- Verified account holders can request access to a known Pint Path venue. Admin independently verifies and approves or rejects the claim; only approval assigns manager access.
- Admin can assign or revoke venue managers from `/admin.html`.
- Venue managers can only access assigned venues on `/venue-portal`.
- Free venue accounts can maintain assigned-venue profile/hours, beer, stock/on-tap, and price data. Happy-hour data may be collected internally for later review but has no public web or iOS surface; specials, venue analytics, rewards, counter/POS, and monthly reports stay disabled.
- A future Pro tier may add reviewed specials, privacy-safe analytics, reports,
  premium display, and growth tools. No price or offer is approved for this
  release; do not configure or advertise a live Pro amount until the future
  commercial contract is reviewed and tested.
- Venue manager data updates are scoped to assigned venues. Verified public price publishing still goes through the existing review/approval flow.
- Venue insights are aggregate-only and do not expose user names, individual clickstream, exact user location, private source evidence, or another venue’s private data.
- The portal includes a listing quality score, wrong-price reports, user requests, current verified records, and a copyable update link for QR/signage use.

Future paid-partner work — not a current launch gate:

- Re-run the implemented Stripe Customer Portal/manage-billing flow against a controlled staging venue subscription and signed webhook sequence.
- Exercise the implemented admin `venue_claim_requests` review interface with one approved and one rejected staging claim.
- Add stronger claim verification such as business email, phone, or document checks.
- Complete the external Resend domain/key setup and one targeted staging delivery before enabling the implemented monthly report scheduler in production; delivery remains opt-in and fail-closed by default.
- Expand generated monthly reports from the aggregate `events` pipeline as production search/click volume grows.
- Reassess whether any happy-hour surface should launch; for the current release it remains internal-only. Assigned profile/beer/price updates still require the documented safeguards, including review of a venue-wide deletion burst.
- Replace suburb-based analytics with custom Pint Path areas such as Melbourne CBD, Fitzroy, Richmond, or Chapel Street once those boundaries are defined.

Responsible-alcohol guardrails:

- 18+ confirmation plus Terms and Privacy Policy acceptance are required for account signup and full price/submission flows.
- The demo does not collect government ID documents.
- Copy is intentionally neutral: verified prices, data accuracy, and responsible use.
- Reward and redemption code paths are dormant and unavailable in this release. Any future alcohol-linked reward requires a separate legal, RSA, abuse, venue, security, and App Review assessment.

Location/privacy guardrails:

- Location is opt-in only and uses one-time `getCurrentPosition`; the app does not use continuous tracking.
- Distances are approximate straight-line distances, not walking or driving routes.
- Analytics events for near-me actions store coarse context such as radius and status only, not exact latitude/longitude.
- If location permission is denied or unavailable, users can still search by venue, suburb, or beer.

## Full-Scale Free Launch Security Contract

For the Melbourne launch, exact prices must flow through the Express API, not direct browser database reads.

- `/api/business/price-records` returns exact records only for admin, existing entitled access, contributor access, or the fixed pint preview for Guinness, Carlton Draught, and Stone & Wood Pacific Ale. Public happy-hour and special-price records are excluded for this release.
- The free preview is fixed rather than quota-based; repeatedly opening venues does not expand it. Premium, contributor, or admin access is required for the full verified price catalogue.
- The map gets venue pins and preview metadata by default, then requests venue detail records when a user opens a venue panel. The server still decides which exact prices are visible.
- Admin tools live on `/admin.html` and `/api/business/admin/*`; public map HTML should not include admin unlock forms or secret-entry UI.
- Photo/source uploads are validated for image MIME type and 6MB max size, then stored behind private source-evidence references. New production uploads are written to the private `beermap-source-evidence` Supabase Storage bucket; existing volume-backed evidence remains readable for compatibility. Review/download access is issued through short-lived signed server URLs after an uploader/admin authorization check.
- `DEMO_BILLING_MODE=true` is an opt-in local-only fixture. The frozen Free launch requires both it and `ALLOW_DEMO_BILLING_IN_PRODUCTION` to be `false`.
- Protected business APIs check trusted origins where applicable and use hashed-key rate limits for auth, submissions, feedback, requests, price access, and dormant billing routes. Full-scale production must set `REDIS_URL`, set `REQUIRE_REDIS_RATE_LIMITING=true`, keep `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false`, and fail closed when Redis is unavailable.
- Security headers are enabled with a Google Maps-compatible CSP, `nosniff`, same-origin frame protection, strict referrer policy, and limited browser permissions.
- Account sessions are hashed at rest, expire by role, can be revoked with logout/logout-all, and store only short SHA-256 request fingerprints rather than raw IP addresses or user agents.
- Sensitive admin, payment, session, and venue-manager actions are written to `security_audit_log` with redacted metadata.
- Aggregate analytics use `ANALYTICS_MIN_BUCKET_SIZE` to suppress low-count buckets before they are returned to dashboards or venue-owner views.
- Retired call automation routes stay unavailable in the active app. Keep any future provider automation in a separate security-reviewed feature branch.
- Production admin routes require the configured admin email allowlist, verified email, and a fresh MFA/AAL2 claim with `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true`.
- Upload and verification actions require a verified account in production when `REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true`.
- Inline demo image evidence is never exposed publicly. Production field uploads use private Supabase Storage plus signed, authorization-checked review links; keep the `beermap-source-evidence` bucket private.
- `FIELD_TEST_MODE=true` is for private staging/field tests only; full-scale production uses `false`.
- Run `npm run security:scan` before deploy to catch common committed secret patterns. If it flags a real key, rotate it immediately and replace it with an env placeholder.
- Run `npm run security:audit` before deploy to catch high-severity dependency advisories.
- Run `npm run test:release:pintpath` before a release candidate. This executes the repo-native Pint Path release-readiness suite against synthetic/local data only, plus secret and dependency checks. See `docs/release-readiness-checklist.md` for provider-only blockers that still need staging/manual verification.
- Before any Railway write, require `npm run --silent readiness:railway:mutation-boundary` and the tracked one-operation executor that repeats the boundary in an unconditional postflight. The standalone receipt is read-only; dashboard Deploy, Git autodeploy, and ordinary redeploy remain prohibited.
- Production startup now requires an HTTPS `PUBLIC_BASE_URL`, `GOOGLE_MAPS_API_KEY`, and `GOOGLE_MAPS_MAP_ID`; admin routes stay locked until `ADMIN_EMAILS` is configured with the approved owner/admin email.
- `/startup` is the production deploy gate: it forces database migration/open, notice-keyring validation, local storage checks, and scheduler startup without depending on fragile external canaries. `/ready` remains the deeper ongoing dependency check after `/health`.
- See `FIELD_TEST_CHECKLIST.md` before showing the app to real users.
- See `DEPLOYMENT_CHECKLIST.md` before merging to `main` or deploying the Railway candidate; it includes backup, migration, security scan, smoke-test, and rollback steps.

Security and rotation notes:

- Browser Google Maps keys are public by design, but should still be restricted to `https://pintpath.au/*`, `http://localhost:3000/*`, and `http://127.0.0.1:3000/*`. If a browser key was ever committed or shared too broadly, rotate it in Google Cloud and update Railway/local configuration only through the guarded executor.
- Supabase service-role keys, Stripe secret keys, Stripe webhook secrets, OpenAI keys, and private Google Places keys must stay server-side only. If any were exposed, rotate them with the provider, update Railway configuration and restart only through the guarded executor, then run `npm run security:scan`.
- Do not use standalone static viewer mode for public launch price data, because it cannot enforce server-side price gating.

Candidate canonical-production values after the reviewed Postgres target has
been created, imported, and pinned. These values describe the checked-in
runtime contract; they do not prove that the currently deployed production
environment has completed the migration.

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PUBLIC_BASE_URL=https://pintpath.au
# DATABASE_PATH must be absent. Keep the sealed SQLite source outside the web
# service environment after cutover.
DATABASE_URL=postgresql://pintpath_runtime:replace_me@direct-or-session-host:5432/pintpath?sslmode=require
# Keep at one on Railway for forwarded scheme/host handling. Client security
# identity uses Railway's platform-provided X-Real-IP, not proxy hop count.
TRUST_PROXY_HOPS=1
SUPABASE_URL=https://your-production-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_publishable_or_legacy_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_server_only_service_role_key
SUPABASE_OAUTH_PROVIDERS=google
OFFSITE_BACKUP_SUPABASE_URL=https://your-operational-backup-project.supabase.co
OFFSITE_BACKUP_SERVICE_ROLE_KEY=your_operational_restore_copy_service_role_key
OFFSITE_BACKUP_BUCKET=pintpath-backups
OFFSITE_BACKUP_INTERVAL_HOURS=24
OFFSITE_BACKUP_RETENTION_DAYS=30
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
COMMERCIAL_LAUNCH_ENABLED=false
CONSUMER_PAID_ENROLLMENT_ENABLED=false
PINT_POINTS_REWARDS_ENABLED=false
ALCOHOL_GAMIFICATION_ENABLED=false
VENUE_PRO_TRIAL_DAYS=0
VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD=false
FIELD_TEST_MODE=false
ADMIN_EMAILS=approved-owner-admin@example.com
SESSION_TTL_DAYS=60
ADMIN_SESSION_TTL_DAYS=7
ANALYTICS_MIN_BUCKET_SIZE=5
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
ADMIN_MFA_MAX_AGE_MINUTES=720
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
GOOGLE_MAPS_API_KEY=your_google_maps_browser_key
GOOGLE_MAPS_MAP_ID=your_google_vector_map_id
GOOGLE_PLACES_API_KEY=your_server_side_google_places_api_key
OPENAI_API_KEY=your_openai_api_key_for_menu_ocr
OPENAI_MENU_OCR_MODEL=gpt-5.6-sol
OPENAI_MENU_OCR_FALLBACK_MODEL=gpt-4.1
OPENAI_MENU_OCR_REVIEW_PASS=true
REPORT_TIMEZONE=Australia/Melbourne
REPORT_EMAIL_MODE=disabled
RESEND_API_KEY=
REPORT_EMAIL_FROM=
REPORT_EMAIL_REPLY_TO=
REPORT_DELIVERY_SCHEDULE_ENABLED=false
REPORT_DELIVERY_DAY=2
REPORT_DELIVERY_HOUR=9
REPORT_DELIVERY_CHECK_INTERVAL_MINUTES=60
PINTPATH_REPORT_DELIVER=false
REDIS_URL=redis://default:replace_me@host:6379
PINTPATH_DATABASE_RESOURCE_ID=replace_with_live_production_database_provider_resource_id
PINTPATH_EXPECTED_DATABASE_RESOURCE_ID=replace_with_registered_production_database_provider_resource_id
PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS=replace_with_permanent_staging_and_restore_database_resource_ids
PINTPATH_REDIS_RESOURCE_ID=replace_with_live_production_redis_provider_resource_id
PINTPATH_EXPECTED_REDIS_RESOURCE_ID=replace_with_registered_production_redis_provider_resource_id
PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS=replace_with_permanent_staging_and_restore_redis_resource_ids
PINTPATH_EXPECTED_DATABASE_URL_SHA256=replace_with_exact_production_database_url_digest
PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S=replace_with_registered_staging_and_restore_database_url_digests
PINTPATH_EXPECTED_REDIS_URL_SHA256=replace_with_exact_production_redis_url_digest
PINTPATH_FORBIDDEN_REDIS_URL_SHA256S=replace_with_registered_staging_and_restore_redis_url_digests
REQUIRE_REDIS_RATE_LIMITING=true
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
SOURCE_EVIDENCE_STORAGE_DIR=/app/data/source-evidence
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300
SOURCE_EVIDENCE_RETENTION_DAYS=90
POS_WEBHOOK_SIGNING_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=
STRIPE_PRICE_YEARLY=
STRIPE_PRO_PRICE_ID=
ACCOUNT_DELETION_NOTICE_MODE=resend
RESEND_TRANSACTIONAL_API_KEY=re_xxx
ACCOUNT_DELETION_NOTICE_FROM="Pint Path <account@pintpath.au>"
ACCOUNT_DELETION_NOTICE_REPLY_TO=admin@pintpath.au
RESEND_WEBHOOK_SIGNING_SECRET=whsec_xxx
ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID=2026-08
ACCOUNT_DELETION_NOTICE_KEYRING_JSON='{"2026-08":"base64_encoded_32_byte_key"}'
ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES=5
ACCOUNT_DELETION_REHEARSAL_ENABLED=false
```

Replace every applicable placeholder with a reviewed environment-specific value. Canonical production requires the Supabase operational restore copy, Google Places, OpenAI, evidence-signing, and account-deletion notification values above; the two Supabase URLs must identify different projects. That second project is not immutable because its service-role key can delete and overwrite. Leave POS signing absent because counter/redemption/POS is disabled. With both paid-enrolment flags `false`, Stripe remains deferred and all five values stay absent.

The full-scale gate remains blocked until this configuration is exercised against the reviewed shared Postgres target with the least-privilege login and separate migrator/backup authority, two safe replicas, managed PITR, an independently attested logical export, complete private Storage capture, and separately administered WORM replication. A configured URL or a green local contract test is not migration evidence.

Run `npm run readiness:providers` after configuring env. It checks required provider values without printing secrets.
Before broad public launch, run `npm run readiness:launch` inside the deployed
production service and require `readinessProfile=production_free_launch`; it
treats provider warnings and any paid/POS/report scope drift as launch-blocking.
The GitHub check's safe literals do not substitute for this Railway-side proof.
Use [`docs/launch-9-readiness-gates.md`](./docs/launch-9-readiness-gates.md) for
the full provider, owner-journey, monitoring, performance, accessibility, and
legal evidence pack.

Future Stripe test-mode webhook check — not part of the current release:

1. In an isolated payment test environment, set `DEMO_BILLING_MODE=false`, enable the paid-enrolment flag under test, and configure all five Stripe test values in `.env`.
2. Run `npm run dev`.
3. In another terminal, run:

```bash
stripe listen --forward-to localhost:3000/api/business/billing/webhook
```

4. Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.
5. Start checkout from `/pricing.html` or `/account.html` and complete it with a Stripe test card.
6. Confirm `/account.html` shows premium access after the webhook is delivered.

Local MVP flow checks:

- Free map: open `http://localhost:3000`, confirm pins appear, no happy-hour surface is visible, and only Guinness/Carlton Draught/Stone & Wood Pacific Ale pint prices are exact.
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
TRUST_PROXY_HOPS=1
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_publishable_or_legacy_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
# Configure Google OAuth in the Supabase dashboard for this launch. Keep Apple
# disabled until authorization-token revocation is implemented and verified.
# Web redirect URLs: http://localhost:3000/auth/callback and
# https://pintpath.au/auth/callback. pintpath://auth-callback is Android-only
# when native OAuth is enabled; the first-release iOS app has no custom scheme.
SUPABASE_OAUTH_PROVIDERS=google
SUPABASE_MENU_CAPTURE_TABLE=venue_menu_captures
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
GOOGLE_MAPS_MAP_ID=your_google_vector_map_id
GOOGLE_PLACES_API_KEY=your_server_side_google_places_api_key
OPENAI_API_KEY=your_openai_api_key_for_menu_ocr
OPENAI_MENU_OCR_MODEL=gpt-5.6-sol
OPENAI_MENU_OCR_FALLBACK_MODEL=gpt-4.1
OPENAI_MENU_OCR_REVIEW_PASS=true
ADMIN_EMAILS=you@example.com
SESSION_TTL_DAYS=60
ADMIN_SESSION_TTL_DAYS=7
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
ADMIN_MFA_MAX_AGE_MINUTES=720
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
ANALYTICS_MIN_BUCKET_SIZE=5
REPORT_TIMEZONE=Australia/Melbourne
REPORT_EMAIL_MODE=disabled
RESEND_API_KEY=
REPORT_EMAIL_FROM=
REPORT_EMAIL_REPLY_TO=
REPORT_DELIVERY_SCHEDULE_ENABLED=false
REPORT_DELIVERY_DAY=2
REPORT_DELIVERY_HOUR=9
REPORT_DELIVERY_CHECK_INTERVAL_MINUTES=60
PINTPATH_REPORT_DELIVER=false
REDIS_URL=
REQUIRE_REDIS_RATE_LIMITING=false
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
SOURCE_EVIDENCE_STORAGE_DIR=./data/source-evidence
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300
SOURCE_EVIDENCE_RETENTION_DAYS=90
OFFSITE_BACKUP_SUPABASE_URL=https://operational-restore-copy-project.supabase.co
OFFSITE_BACKUP_SERVICE_ROLE_KEY=replace_with_operational_restore_copy_service_role_key
OFFSITE_BACKUP_BUCKET=pintpath-backups
OFFSITE_BACKUP_INTERVAL_HOURS=24
OFFSITE_BACKUP_RETENTION_DAYS=30
POS_WEBHOOK_SIGNING_SECRET=
FIELD_TEST_MODE=false
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=
STRIPE_PRICE_YEARLY=
STRIPE_PRO_PRICE_ID=
```

What each one does:

- `PUBLIC_BASE_URL`: your public HTTPS base URL. Use your ngrok URL here.
- `HOST`: interface the Node server should bind to. Use `0.0.0.0` for Railway and other hosted deployments.
- `DATABASE_PATH`: local-development database path and the explicit read-only restore-rehearsal path. Canonical production rejects it; keep the sealed migration source outside the web-service environment.
- `DATABASE_URL`: canonical production Postgres connection consumed by the checked-in server. Startup creates a bounded pool and fails closed unless the dedicated least-privilege runtime role, search path, imported schema metadata, authoritative table count, RLS isolation, and operations-schema denial all pass. Migration and logical-backup tools use separate direct credentials.
- `SUPABASE_URL`: production Supabase project URL used for email/password and OAuth authentication, private evidence storage, venue imports, and reviewed map-sync writes. It is mandatory in production.
- `SUPABASE_ANON_KEY`: browser-safe publishable key, or legacy anon key, used by `/account.html` and native clients for Supabase Auth. It is mandatory in production; never use the service-role key in a public client.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only key required in production for verified auth operations, private evidence storage, venue imports, and reviewed/admin menu-capture sync.
- `SUPABASE_OAUTH_PROVIDERS`: comma-separated provider buttons to show on `/account.html`. Use `google` for the current launch; production rejects `apple` until Apple authorization-token revocation is implemented and tested.
- `ACCOUNT_DELETION_NOTICE_MODE`: `disabled`, test-only `mock`, or production `resend`. Canonical production requires `resend` independently of monthly reports.
- `RESEND_TRANSACTIONAL_API_KEY`: sending-only Resend key dedicated to account-deletion completion notices.
- `ACCOUNT_DELETION_NOTICE_FROM` / `ACCOUNT_DELETION_NOTICE_REPLY_TO`: verified transactional sender and monitored privacy/support inbox.
- `RESEND_WEBHOOK_SIGNING_SECRET`: `whsec_` secret for the signed deletion-notice webhook. Subscribe it to `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`.
- `ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID` / `ACCOUNT_DELETION_NOTICE_KEYRING_JSON`: active ID and bounded JSON keyring of base64-encoded 32-byte recipient-encryption keys. Recipient ciphertext is held for at most 60 days before deletion completes, then purged on verified delivery, an audited terminal resolution, or no later than 30 days after completion. Retain each old key only while a live encrypted recipient references it.
- `ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES`: canonical-production outbox and provider-status reconciliation interval; defaults to five minutes.
- `ACCOUNT_DELETION_REHEARSAL_ENABLED`: set `true` only for the sacrificial end-to-end drill in permanent integrated staging with its exact staging origin/data paths, staging Supabase project, and staging-only Resend webhook. Do not use disposable restore-staging for this ordinary integration proof. Leave it `false` or absent in production.
- Production scaling blocker: the repository-side Postgres cutover is implemented, but the live production dataset and workers have not been imported or reconciled on a reviewed target. Prove the migrated state and all cross-replica transaction, outbox, lease, session, deletion, and webhook races on at least two replicas before launch.
- `SUPABASE_MENU_CAPTURE_TABLE`: server-side reviewed menu/manual capture table. Defaults to `venue_menu_captures`.
- `GOOGLE_MAPS_API_KEY`: browser-safe Google Maps key used by the hosted viewer.
- `GOOGLE_MAPS_MAP_ID`: production-required JavaScript/vector Google Maps Map ID for branded map styling and AdvancedMarkerElement support. Local development can fall back to `DEMO_MAP_ID`.
- `GOOGLE_PLACES_API_KEY`: server-side key used by venue imports and mission area geocoding. Enable Places API and Geocoding API on this key. A development fallback may use `GOOGLE_MAPS_API_KEY`, but production startup requires this dedicated value.
- `OPENAI_API_KEY`: server-only key used to extract structured beer rows from submitted menu photos. Photo evidence is never exposed through browser configuration.
- `OPENAI_MENU_OCR_MODEL`: primary vision model for menu-photo extraction. Defaults to `gpt-5.6-sol`.
- `OPENAI_MENU_OCR_FALLBACK_MODEL`: model used only if the primary OCR request fails. Defaults to `gpt-4.1`.
- `OPENAI_MENU_OCR_REVIEW_PASS`: when `true`, asks the vision model to review its first structured extraction before deterministic beer, food/noise, package-size, and catalogue checks run.
- `ADMIN_EMAILS`: comma-separated emails that become admin accounts on signup. In production this can be left blank while the official ABN/admin email is pending; the public site will still boot, but admin routes will return `403` until the allowlist is configured.
- `SESSION_TTL_DAYS`: normal account app-session lifetime. Defaults to `30`; the production examples intentionally choose `60` within the allowed range.
- `ADMIN_SESSION_TTL_DAYS`: shorter admin app-session lifetime. Defaults to `1`; the production examples intentionally choose the maximum allowed `7`.
- `REQUIRE_ADMIN_MFA_IN_PRODUCTION`: production guard for admin routes. Keep it
  `true` for this full-scale release; `false` is not an accepted production or
  field-test configuration.
- `ADMIN_MFA_MAX_AGE_MINUTES`: maximum age for admin AAL2/step-up claims. Defaults to `720`.
- `REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION`: production guard for uploads, verifications, and venue dashboard access. Keep `true`.
- `CONTRIBUTOR_UNLOCK_POINTS`: approved monthly contribution points required for contributor access.
- `CONTRIBUTOR_UNLOCK_DAYS`: legacy fallback setting. Contributor unlocks now expire at the end of the current month after the monthly point threshold is reached.
- `ANALYTICS_MIN_BUCKET_SIZE`: minimum aggregate bucket count before dashboard analytics reveal a beer, suburb, or venue identity.
- `REPORT_TIMEZONE`: timezone used for generated monthly report boundaries. Keep `Australia/Melbourne` for the current market.
- `RESTORE_REHEARSAL_MODE`: fail-closed mode for inspecting a verified restored copy in **disposable restore-staging**, never permanent integrated staging. After disposable resources are created, protected `RESTORE_REHEARSAL_EXPECTED_*` values from the reviewed private register must exactly match the runtime Railway/Supabase/Redis identities. It disables non-session mutations, automatic maintenance, external write providers, browser Supabase access, and the remote Supabase venue directory. Any restore-shaped paths, namespace, variables, or mounted restore directories left behind while this flag is false also block startup.
- `RESTORE_REHEARSAL_PHASE`: use `bootstrap` only while the empty staging volume is being populated. Bootstrap opens no database and exposes only `/health` and `/ready`. Change to `active` only after the verified restore directory has been atomically moved into place.
- `RESTORE_REHEARSAL_BACKUP_ID`, `RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256`, and `RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256`: fixed identity for the legacy SQLite/evidence restore drill. Separate PostgreSQL logical-backup/restore tooling verifies exact authoritative and control-table state; both that path and managed PITR plus Storage/WORM restoration still require isolated provider rehearsal before launch.
- `RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL` / `RESTORE_REHEARSAL_BACKUP_SUPABASE_URL`: comparison-only canonical URLs required in restore mode. Startup binds the production, private operational restore-copy, and disposable restore-staging projects and proves they are distinct; no credentials accompany the comparison URLs. Each new one-shot environment receives newly reviewed protected expected pins without changing the frozen application code; permanent staging can never substitute.
- `RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID`, `RESTORE_REHEARSAL_REDIS_SERVICE_ID`, `RESTORE_REHEARSAL_REDIS_SENTINEL`, and `REDIS_KEY_NAMESPACE`: bind Redis to the exact pinned restore-staging Redis service, the same disposable Railway restore environment, and the selected backup. `REDIS_URL` must be the authenticated Railway private `redis.railway.internal:6379` origin. Every protected rate-limit write atomically compares the pre-seeded identity sentinel and performs its counter mutation in the same Redis script; a mismatch fails closed.
- `RESTORE_REHEARSAL_ACCESS_USERNAME` / `RESTORE_REHEARSAL_ACCESS_PASSWORD`: application access gate for restored data. Use a unique 32+ byte password stored outside the repository. `/health` and `/ready` remain available to Railway, while all restored pages require the gate.
- `REPORT_EMAIL_MODE`: `disabled` prevents delivery, `mock` is isolated staging/test delivery, and `resend` enables the real HTTPS provider only when its key, sender, and monitored reply mailbox are configured.
- `RESEND_API_KEY`: private sending-only Resend key. Required when `REPORT_EMAIL_MODE=resend`; never expose it in browser config.
- `REPORT_EMAIL_FROM`: future venue-report sender on a verified Resend domain. Leave absent for this Free launch.
- `REPORT_EMAIL_REPLY_TO`: future monitored venue-report mailbox. Leave absent while `REPORT_EMAIL_MODE=disabled`.
- `REPORT_DELIVERY_SCHEDULE_ENABLED`: opt-in production scheduler. It cannot be enabled unless `REPORT_EMAIL_MODE=resend` passes configuration validation.
- `PINTPATH_REPORT_DELIVER`: operator guard for report delivery. Keep `false` for the current Free-only launch.
- `REPORT_DELIVERY_DAY` / `REPORT_DELIVERY_HOUR`: Melbourne-local monthly delivery threshold, defaulting to day 2 at 09:00. The previous completed month is sent once and missed windows catch up later.
- `REPORT_DELIVERY_CHECK_INTERVAL_MINUTES`: due-check interval, default `60`. Completed monthly state short-circuits before report regeneration.
- `REDIS_URL`: Redis connection URL for production/distributed rate limiting. Configure this for Railway/production before exposing auth, uploads, price access, feedback, or checkout publicly.
- `REQUIRE_REDIS_RATE_LIMITING`: hosted-staging fail-closed switch. Set it to `true` for the two-replica Redis outage drill; production already requires Redis whenever the emergency memory override is false.
- `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION`: legacy emergency/private-test override. It is not accepted for the full-scale launch; keep it `false` so protected routes fail closed if Redis is missing or unavailable.
- `DEMO_BILLING_MODE`: opt-in synthetic local-test behavior only. Keep it `false` in permanent staging and production.
- `ALLOW_DEMO_BILLING_IN_PRODUCTION`: legacy compatibility switch. The frozen Free launch provider profile requires it to be explicitly `false`; do not use it to turn production into a demo environment.
- `COMMERCIAL_LAUNCH_ENABLED` / `CONSUMER_PAID_ENROLLMENT_ENABLED`: keep both `false` for the current production deploy so new paid enrolment remains deferred. The controlling launch runbook defines the independent approval required before either scope can change.
- `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION`: legacy emergency override for inline demo image evidence. Leave `false`; production uploads should use private Supabase Storage.
- `SOURCE_EVIDENCE_STORAGE_DIR`: transitional private server-side directory for
  existing volume-backed evidence and local development. The full-scale
  migration must move authoritative private evidence to the reviewed private
  Storage contract; retain the mounted directory only as sealed/reconciled
  cutover evidence.
- `SOURCE_EVIDENCE_SIGNING_SECRET`: private 32+ character server-side secret used to sign short-lived source-evidence review/download URLs. Generate it with `openssl rand -base64 32`; never commit it or expose it through `/config.js`. Production boot now fails fast without it so OCR and source-review evidence links are not silently broken.
- `SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS`: signed evidence URL lifetime. Defaults to `300`.
- `SOURCE_EVIDENCE_RETENTION_DAYS`: retention window for source-evidence cleanup eligibility. Defaults to `90`; completed deletion and legal/security holds still follow the dedicated retention policy.
- `OFFSITE_BACKUP_SUPABASE_URL`: mandatory production destination URL for the separate operational restore-copy project. It must not share the production `SUPABASE_URL` origin. A second Supabase project alone is not immutable/independent disaster recovery.
- `OFFSITE_BACKUP_SERVICE_ROLE_KEY`: server-only service-role key for that operational destination. Because it can read/list/delete/overwrite Storage, it cannot satisfy the full-scale WORM/append-only backup gate.
- `OFFSITE_BACKUP_BUCKET`: private Storage bucket in the operational restore-copy project for verified transition database and source-evidence backups. Defaults to `pintpath-backups`.
- Provision that bucket only in the operational restore-copy project with `ops/supabase/independent-backup-project-storage.sql`; the historical path is intentionally preserved and excluded from `supabase/migrations/`.
- `OFFSITE_BACKUP_INTERVAL_HOURS`: automatic production backup interval. Defaults to `24`.
- `OFFSITE_BACKUP_RETENTION_DAYS`: operational off-volume copy retention. Defaults to `30`. Full-scale launch separately requires provider-enforced object lock/WORM in a different provider or region, an append/create-only application principal, and separately held restore/retention authority.
- `POS_WEBHOOK_SIGNING_SECRET`: future POS secret. Leave it absent for this release; POS, counter, reward, and redemption modes are disabled.
- `FIELD_TEST_MODE`: shows beta contact affordances and an admin field-test
  summary. Use it only in a non-production private test environment. It must be
  `false` for this full-scale production launch.
- `STRIPE_SECRET_KEY`: Stripe test/live secret key for checkout sessions and webhook calls.
- `STRIPE_WEBHOOK_SECRET`: Stripe endpoint secret used to verify subscription webhooks.
- `STRIPE_PRICE_MONTHLY`: future Stripe consumer-monthly price ID; leave unset while pricing is deferred.
- `STRIPE_PRICE_YEARLY`: future Stripe consumer-yearly price ID; leave unset while pricing is deferred.
- `STRIPE_PRO_PRICE_ID`: future Stripe venue-Pro price ID; leave unset while pricing is deferred.
- The Stripe variables and checkout implementation are dormant future-commercial material, not current launch requirements. No browser checkout or payment entry point is authorised in this release.

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
2. Deploy the exact immutable app image through the tracked Railway mutation-boundary executor.
3. Point `pintpath.au` at that host with DNS.
4. Switch `PUBLIC_BASE_URL` to `https://pintpath.au`.
5. Add the domain to your Google Maps browser key referrer rules.

Recommended Google Maps browser key referrers once hosted:

- `https://pintpath.au/*`
- `http://localhost:3000/*`
- `http://127.0.0.1:3000/*`

Current map-provider split:

- `.env` `GOOGLE_MAPS_API_KEY`: browser Google Maps key for web map rendering
- `.env` `GOOGLE_PLACES_API_KEY`: server-side key for venue import/search and mission area geocoding
- iOS: native MapKit, with no bundled Google Maps key
- Android: venue list plus an external maps-app/browser handoff, with no bundled map SDK key

Recommended hosted environment values:

Use the candidate-values block only after the migration runbook has created and pinned the target. Do not call the existing SQLite deployment production-ready. Keep both paid-enrolment flags false, `VENUE_PRO_TRIAL_DAYS=0`, demo billing false, report delivery false, POS absent, and Stripe values unset for this Free-only release.

## Railway Deployment

This repo includes [railway.toml](railway.toml) with:

- build command: `npm run build`
- start command: `npm run start`
- default/staging healthcheck path: `/ready`
- production deploy healthcheck path: `/startup`

Recommended Railway service setup:

1. Provision and pin the isolated permanent-staging Postgres target, then apply the generated private schema with the separate migrator authority.
2. Run the implemented server-only `DATABASE_URL` path under the restricted runtime role and preserve separate migration/logical-backup credentials.
3. Import and reconcile all SQLite state, seal the source read-only, and prove Postgres-compatible rollback in permanent staging.
4. Deploy at least two web replicas from the frozen SHA and prove concurrency, idempotency, restart, rolling deploy, Redis failure, and pool headroom.
5. Keep `/app/data` only for sealed migration evidence and legacy private files; do not use it as authoritative database state.
6. Set `PUBLIC_BASE_URL=https://pintpath.au` and add the custom domain.

Until steps 1–4 are proved on the frozen candidate and then repeated under the production cutover controls, the repository is a migration candidate, not the full-scale production service.

## iOS release gate

The iOS release must use the frozen compatible SHA and exact version/build. Require a protected native workflow, signed archive, physical-device proof, external TestFlight/Beta App Review, full App Review approval, Australia storefront availability, and a named owner holding manual release with phased release configured. TestFlight alone does not authorize launch.

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

The hosted public viewer may receive the Supabase anon/publishable key for Supabase Auth email/password and OAuth flows. It must never receive the Supabase service-role key, and venue/price data still comes through `/api/business/venues` and `/api/business/price-records` so exact-price access can be enforced server-side.

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
    supabaseUrl: "https://your-project.supabase.co",
    supabaseAnonKey: "your_supabase_anon_browser_key",
    supabaseOauthProviders: ["google"],
  },
};
```

Notes:

- Do not use standalone static mode for public launch price data, because it cannot enforce server-side price gating.
- `googleMapsApiKey` should be a browser key restricted by HTTP referrers
- `googleMapsMapId` is required for production AdvancedMarkerElement/vector map styling. Local-only tests can fall back to Google's `DEMO_MAP_ID`.
- `supabaseAnonKey` is public and only for Supabase Auth email/password and OAuth. Never put a service-role key in `viewer/config.js`.

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

Current map-provider split:

- browser web viewer: Google Maps browser key via `/config.js` or `viewer/config.js`
- server-side venue import and mission geocoding: `GOOGLE_PLACES_API_KEY`
- iOS app: MapKit pins and Apple Maps directions; no Google Maps key
- Android app: external maps-app/browser directions; no bundled map SDK key

Only the web viewer and server-side venue tooling use Google Maps Platform credentials. Native clients intentionally avoid bundling those keys in the current release.

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

`/api/business/price-records` returns redacted records by default, except for the fixed pint preview for Guinness, Carlton Draught, and Stone & Wood Pacific Ale. Public happy-hour/special records are excluded for this release. Opening a venue does not consume or unlock a daily allowance. The server returns the full verified non-happy-hour catalogue only for existing entitled, contributor, or admin access.

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

For a conservative crawler-to-map base pass, use the strict publisher after queueing crawler output:

```bash
npm run menus:discover -- --limit=1000 --concurrency=4
npm run menus:queue-review -- --dry-run
npm run menus:queue-review
npm run menus:publish-map-base -- --dry-run
npm run menus:publish-map-base
```

`menus:publish-map-base` only publishes pending `source_reference` items that look like regular menu/drinks/beer sources, revalidates the source URL by default, keeps numeric on-tap pint rows in a conservative price range, and skips happy-hour/event/special pages, direct raster image assets, non-beer drink products, non-on-tap rows, and ambiguous duplicate prices. Skipped rows stay in the admin queue for manual review.

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
- Confirm Supabase redirect URLs include `https://pintpath.au/auth/callback` and local `http://localhost:3000/auth/callback`. Require `pintpath://auth-callback` only for Android native OAuth; the first-release iOS app has no custom URL scheme.
- Confirm the Google OAuth Authorized redirect URI includes the Supabase provider callback from `SUPABASE_URL`, for example `https://auth.pintpath.au/auth/v1/callback`.
- Confirm Google is enabled in Supabase and its provider console, `SUPABASE_OAUTH_PROVIDERS=google`, and Apple is disabled until authorization-token revocation is implemented and tested.
- Confirm full-scale production has `REDIS_URL`, `REQUIRE_REDIS_RATE_LIMITING=true`, and `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false`.

### Uploads or source evidence fail

- Confirm users are logged in and email-verified where production requires it.
- Confirm `SUPABASE_SERVICE_ROLE_KEY` is available to the server and the private `beermap-source-evidence` bucket exists.
- During migration only, confirm `SOURCE_EVIDENCE_STORAGE_DIR` resolves to the
  sealed/reconciled legacy evidence directory. The full-scale runtime uses the
  reviewed private Storage authority rather than new volume-local evidence.
- Confirm `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false`; production should not store field photos as inline SQLite demo evidence.
- Confirm the Supabase Storage bucket is not public.
- Confirm file size and MIME type fit the bucket policy.
- Confirm `SOURCE_EVIDENCE_SIGNING_SECRET` is set for server-side evidence review links.

### Venue updates do not appear on the map

- Manager and user-submitted changes are pending by default.
- Approve the pending submission or venue-manager change in admin before expecting public map updates.
- Confirm approved rows publish into `venue_price_records`; the public map should not read pending or raw source tables directly.
