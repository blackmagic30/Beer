# Melbourne Beer Map Deployment Checklist

Use this before merging a beta/hardening branch into `main` or deploying a Railway production beta.

## 1. Confirm The Target

- Production branch: `main`.
- Current beta/hardening branch: confirm with `git branch --show-current`.
- Hosting: Railway, using `railway.toml`.
- Build command: `npm run build`.
- Start command: `node dist/src/server.js`.
- Health check: `/health`.
- Database: SQLite at `DATABASE_PATH`, with additive schema creation from `src/db/schema.sql`.

## 2. Pre-Deploy Checks

- Run `git status --short --branch` and confirm only intended release files are changed.
- Run `git diff --check`.
- Run `npm run build`.
- Run `npm test`.
- Run `npm run check`.
- Run `npm run security:scan`.
- Confirm no `.env` file, API keys, Stripe secrets, Supabase service-role keys, Twilio auth tokens, OpenAI keys, or ElevenLabs keys are committed.
- Confirm public map source does not contain legacy admin/debug UI strings.
- Confirm Google Maps browser keys are HTTP-referrer restricted to localhost and the live beta domain.
- Confirm Supabase Row Level Security policies are reviewed if any direct browser Supabase access is enabled for future work.

## 3. Required Production Beta Env

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PUBLIC_BASE_URL=https://beer.splitseconds.app
DATABASE_PATH=/app/data/melb-beer-bot.sqlite
TRUST_PROXY=true
FIELD_TEST_MODE=true
FREE_PRICE_REVEALS_PER_DAY=3
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
ADMIN_EMAILS=your-admin-email@example.com
SESSION_TTL_DAYS=60
ADMIN_SESSION_TTL_DAYS=7
ANALYTICS_MIN_BUCKET_SIZE=5
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
TWILIO_VALIDATE_SIGNATURES=true
ALLOW_UNSIGNED_TWILIO_WEBHOOKS_IN_PRODUCTION=false
ELEVENLABS_WEBHOOK_SECRET=replace_with_elevenlabs_shared_secret
ALLOW_UNSIGNED_ELEVENLABS_WEBHOOKS_IN_PRODUCTION=false
OUTBOUND_CALLS_ENABLED=false
```

If you intentionally use simulated checkout for the private field test, set both:

```dotenv
DEMO_BILLING_MODE=true
ALLOW_DEMO_BILLING_IN_PRODUCTION=true
```

In that mode, the pricing UI must be treated as beta/demo billing, not real payment collection.

## 4. Stripe Modes

- Demo billing: works without Stripe keys, but production blocks it unless `ALLOW_DEMO_BILLING_IN_PRODUCTION=true`.
- Stripe test mode: set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, `STRIPE_PLUS_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
- No billing: keep `DEMO_BILLING_MODE=false` and leave Stripe keys empty; free limits, admin overrides, and contributor unlocks still work.
- Do not process live payments until Stripe Checkout and webhook forwarding have been tested with Stripe CLI.
- Stripe webhooks must reject missing/invalid signatures when `DEMO_BILLING_MODE=false`; smoke-test this before enabling paid checkout.

## 5. Database Backup And Migration

- Before deploy, back up the production SQLite file or Railway volume.
- The schema is additive with `CREATE TABLE IF NOT EXISTS` and indexes; do not run destructive `DROP` or `DELETE` commands for this beta.
- Deploy will initialize missing tables from `src/db/schema.sql` through the app database setup.
- New hardening tables/columns are additive: `security_audit_log`, session revocation/last-used fields, and supporting indexes.
- Verify `/health` after deploy, then confirm account signup and map load.
- If migration fails, stop the deployment, restore the DB backup, and redeploy the previous production commit.

## 6. Admin Account

- Set `ADMIN_EMAILS` to the owner/admin email before first admin signup.
- Sign up with that exact email.
- Open `/admin.html`.
- Confirm unauthenticated requests are blocked and the admin dashboard loads only for the admin account.

## 7. Live Smoke Test

- Open the live site logged out and confirm the map loads.
- Confirm no admin/debug UI is visible.
- Open a venue and confirm exact prices are limited/redacted for anonymous users.
- Directly request `/api/business/price-records` logged out and confirm prices are redacted unless a server-counted reveal is used.
- Run `POST /api/business/auth/logout` and confirm the same bearer token can no longer access `/api/business/account`.
- Run a sensitive admin action and confirm a row appears in `security_audit_log`.
- Confirm production inline `sourcePhotoDataUrl` submissions are rejected unless `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=true` is intentionally set.
- Create or log in as a test user and confirm 18+.
- Hit the free reveal limit.
- Submit venue data and confirm it appears as pending in account.
- Log in as admin and approve the submission.
- Confirm points are awarded only after approval.
- Confirm contributor unlock works after the configured threshold.
- Confirm approved price records appear on the map with confidence and last verified date.
- Confirm `/api/calls` and `/api/results` return `401` logged out and `403` for non-admin users.
- Submit a wrong-price report and feedback.
- Confirm KPI/field-test dashboard records activity.
- Open `/for-bars`, submit a venue interest request, and confirm it appears in admin.
- Assign a venue manager in admin, log in as that user, and confirm `/venue-portal` only shows the assigned venue.
- Confirm the venue portal can save profile details, beer/on-tap rows, happy hours, and deals/specials for the assigned venue only.
- Confirm a Basic bar tier sees analytics/monthly report upgrade prompts, and Plus/Pro tiers can see aggregate-only suburb analytics once the privacy threshold is met.
- Confirm authenticated bar-claim requests are stored as pending manual reviews before any manager assignment is granted.
- Submit a venue-manager update and confirm it remains pending review.
- Check the main pages on a phone-width screen.

## 8. Security Preflight

- Run `npm run security:scan` after final env/docs edits.
- Rotate any provider key that was ever committed, shared in chat/screenshots, or exposed through public config.
- Confirm `/config.js` only exposes browser-safe fields such as Google Maps browser key, map ID, field-test flag, and non-secret public settings.
- Confirm `viewer/config.js` is ignored and not committed.
- Confirm Twilio signature validation is enabled in production, or document the explicit temporary override and expiry date.
- Confirm ElevenLabs webhook secret is set in production, or document the explicit temporary override and expiry date.
- Confirm Stripe CLI delivered a signed test webhook to `/api/business/billing/webhook`.
- Confirm audit logs redact email, phone, token, secret, raw payload, source image data, and precise coordinates.
- Confirm analytics buckets below `ANALYTICS_MIN_BUCKET_SIZE` are suppressed in admin and venue-owner outputs.
- Confirm in-memory rate limiting is acceptable for the current single Railway instance. For multiple instances, add Redis or edge/WAF limiting before wider release.

## 9. Rollback Plan

- Identify the previous production commit with `git log --oneline main`.
- If the bad deploy came from a merge commit, revert it with `git revert -m 1 <merge_commit_sha>`.
- If it was a fast-forward push, create a revert commit for the problematic range or redeploy the previous SHA from Railway if available.
- Push the rollback commit to `main` and let Railway redeploy.
- If data migration caused issues, stop the app, restore the pre-deploy database backup, then redeploy the previous commit.
- Fast feature-disable env switches:
  - `FIELD_TEST_MODE=false`
  - `DEMO_BILLING_MODE=false`
  - `FREE_PRICE_REVEALS_PER_DAY=0`
  - `OUTBOUND_CALLS_ENABLED=false`
  - `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false`
  - `ALLOW_UNSIGNED_TWILIO_WEBHOOKS_IN_PRODUCTION=false`
  - `ALLOW_UNSIGNED_ELEVENLABS_WEBHOOKS_IN_PRODUCTION=false`
  - Remove Stripe price IDs to disable live checkout safely.

## 10. Merge Commands

Use these only after all checks pass:

```bash
git switch main
git pull origin main
git merge --ff-only core-business-demo
npm run check
git push origin main
```

If `--ff-only` fails, stop and inspect the merge before continuing.
