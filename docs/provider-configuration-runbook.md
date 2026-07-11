# Pint Path Provider Configuration Runbook

Use this before a Railway production or staging deployment. The local app can run with placeholder values, but `NODE_ENV=production` now fails fast if critical provider config is missing.

## Repeatable Checks

Run these locally before deploy:

```bash
npm run readiness:providers
npm run build
npm test
npm run security:scan
npm run security:audit
git diff --check
```

Run the provider check with production semantics before setting Railway live:

```bash
NODE_ENV=production npm run readiness:providers
npm run readiness:launch
```

The provider check only reports whether values are present. It never prints secret values. `readiness:launch` is stricter: any remaining provider warning blocks broad public launch.

## Google Maps

Pint Path uses Google Maps JavaScript API plus `AdvancedMarkerElement`, so production needs both:

- `GOOGLE_MAPS_API_KEY`: browser-safe web map key.
- `GOOGLE_MAPS_MAP_ID`: JavaScript Map ID for vector styling and advanced markers.

Configure in Google Cloud:

1. Open the Google Cloud project used for Pint Path.
2. Enable **Maps JavaScript API**.
3. Open **Google Maps Platform > Map Management**.
4. Create a new Map ID named `Pint Path Production Vector Map`.
5. Choose platform/type **JavaScript** and a vector map style.
6. Copy the generated Map ID into Railway and local `.env` as `GOOGLE_MAPS_MAP_ID`.
7. Restrict the browser API key to HTTP referrers:
   - `https://pintpath.au/*`
   - `http://localhost:3000/*`
   - `http://127.0.0.1:3000/*`
   - Any explicit staging/preview domain you intentionally test.

Keep `GOOGLE_PLACES_API_KEY` server-side for imports/geocoding. Do not expose it through `/config.js`.

## Railway

Required production values:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PUBLIC_BASE_URL=https://pintpath.au
DATABASE_PATH=/app/data/pint-path.sqlite
TRUST_PROXY_HOPS=1
GOOGLE_MAPS_API_KEY=restricted_browser_key
GOOGLE_MAPS_MAP_ID=javascript_vector_map_id
GOOGLE_PLACES_API_KEY=restricted_server_places_key
OPENAI_API_KEY=your_server_openai_key_for_menu_ocr
OPENAI_MENU_OCR_MODEL=gpt-5.5
OPENAI_MENU_OCR_FALLBACK_MODEL=gpt-4.1
OPENAI_MENU_OCR_REVIEW_PASS=true
REPORT_TIMEZONE=Australia/Melbourne
REPORT_EMAIL_MODE=disabled
REDIS_URL=redis://default:replace_me@host:6379
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
ADMIN_EMAILS=owner@example.com
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
```

Use a persistent Railway volume mounted at `/app/data`. Back it up before each schema-affecting deploy.

Generate `SOURCE_EVIDENCE_SIGNING_SECRET` locally and paste it into Railway as a private environment variable:

```bash
openssl rand -base64 32
```

Or, if `openssl` is unavailable:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

This value signs short-lived source-evidence review/download URLs. Keep it server-side only. Rotating it is safe, but any previously generated signed evidence links will stop working and need to be regenerated.

## Supabase

Use Supabase for OAuth and private evidence storage, while Pint Path app authorization remains enforced by the Express API.

Required checks:

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set for browser OAuth.
- `SUPABASE_SERVICE_ROLE_KEY` is only server-side.
- Google/Apple OAuth providers are configured with minimal scopes.
- Leaked password protection is enabled in Supabase Auth.
- The hosted database is not on deprecated Postgres 14.
- Supabase Auth redirect URLs include the app callback pages:
  - `http://localhost:3000/auth/callback`
  - `https://pintpath.au/auth/callback`
- Google and Apple provider consoles include the Supabase provider callback URL derived from `SUPABASE_URL`:
  - `https://auth.pintpath.au/auth/v1/callback` when `SUPABASE_URL=https://auth.pintpath.au`
- RLS policies from `supabase/migrations/` are applied and tested in staging.
- New public-schema tables have intentional Data API exposure/grants plus RLS; do not assume new tables are automatically exposed.
- The `beermap-source-evidence` Storage bucket is private and owner/admin access is verified.
- Supabase MFA is enabled for admin accounts before public launch.

## Stripe

Keep `DEMO_BILLING_MODE=false` for real launch. Use Stripe test mode first:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRO_PRICE_ID`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

Before live payments:

1. Run Stripe CLI webhook forwarding to `/api/business/billing/webhook`.
2. Confirm missing/invalid signatures are rejected.
3. Confirm duplicate webhook events do not double-process.
4. Confirm Pro venue subscriptions downgrade when cancelled or unpaid.
5. Confirm the pricing page matches the configured Stripe price IDs.
6. Confirm production uses live-mode `sk_live_` and `pk_live_` keys. Test-mode `sk_test_`/`pk_test_` keys are staging-only.

## Monthly Reports

Monthly reports are generated from aggregate events only. They do not include user names, emails, raw coordinates, individual clickstreams, or source evidence.

Local/staging commands:

```bash
npm run reports:generate -- --month=2026-05 --dry-run
REPORT_EMAIL_MODE=mock npm run reports:generate -- --month=2026-05 --deliver --dry-run
npm run reports:deliver:mock -- --month=2026-05 --dry-run
```

Production defaults:

- `REPORT_TIMEZONE=Australia/Melbourne`
- `REPORT_EMAIL_MODE=disabled`

`REPORT_EMAIL_MODE=mock` is for staging/tests only. A real email provider is not integrated yet, so do not claim automated report email delivery is live until that provider is implemented and tested.

Protected export route:

- `GET /api/business/venue-portal/:venueId/reports/:month/export?format=json`
- `GET /api/business/venue-portal/:venueId/reports/:month/export?format=csv`

Only verified Pro venue managers assigned to that venue, or admins, can export the report.

## Redis

Full-scale production should set `REDIS_URL`. The in-memory limiter is acceptable only for a short, single-instance private beta with a documented expiry.

Before public launch:

- Confirm protected auth/upload/feedback/checkout endpoints rate limit through Redis.
- Confirm production is not using `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true`.

## Backups And Restore Drills

Back up the SQLite database with its private source-evidence directory as one unit. The backup command uses SQLite's online backup API, copies private evidence, and writes SHA-256 checksums:

```bash
npm run data:backup -- --output=/secure/offsite/pint-path-$(date +%F)
npm run data:backup:verify -- --backup=/secure/offsite/pint-path-$(date +%F)
```

Store the resulting directory outside the Railway volume with encryption and restricted access. Schedule daily backups, retain at least 30 days, and run the verification command after every backup. Once per quarter, restore the verified directory into an isolated staging service, set `DATABASE_PATH` and `SOURCE_EVIDENCE_STORAGE_DIR` to the restored paths, and confirm `/ready`, login, map prices, and review evidence before recording the drill result.

## No-Go Conditions

Do not launch public production if any of these are true:

- `NODE_ENV=production npm run readiness:providers` fails.
- `GOOGLE_MAPS_MAP_ID` is missing.
- Admin access is enabled without MFA/verified admin allowlist.
- Stripe live checkout is enabled before signed webhook tests pass.
- Report email mode is presented as real delivery while still disabled/mock-only.
- Redis is missing for broad public traffic.
- Supabase source-evidence Storage is public or untested.
- There is no recent off-volume backup that passes `data:backup:verify`, or the quarterly restore drill has not been completed.
