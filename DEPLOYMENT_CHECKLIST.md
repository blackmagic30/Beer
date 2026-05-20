# Pint Path Deployment Checklist

Use this before merging a beta/hardening branch into `main` or deploying a Railway production beta.

## 1. Confirm The Target

- Production branch: `main`.
- Current beta/hardening branch: confirm with `git branch --show-current`.
- Hosting: Railway, using `railway.toml`.
- Build command: `npm run build`.
- Start command: `node dist/src/server.js`.
- Health check: `/health`.
- Readiness check: `/ready` initializes the lazy backend routers/database and should return `status: "ready"` before routing production traffic.
- Database: SQLite at `DATABASE_PATH`, with additive schema creation from `src/db/schema.sql`.

## 2. Pre-Deploy Checks

- Run `git status --short --branch` and confirm only intended release files are changed.
- Run `git diff --check`.
- Run `npm run build`.
- Run `npm test`.
- Run `npm run check`.
- Run `npm run security:scan`.
- Run `npm run security:audit`.
- Confirm no `.env` file, API keys, Stripe secrets, Supabase service-role keys, Twilio auth tokens, OpenAI keys, or ElevenLabs keys are committed.
- Confirm public map source does not contain legacy admin/debug UI strings.
- Confirm Google Maps browser keys are HTTP-referrer restricted to localhost and the live beta domain.
- Confirm Supabase OAuth providers and redirect URLs are configured if quick login is enabled: `https://pintpath.au/auth/callback` and local `http://localhost:3000/auth/callback`.
- Confirm Supabase Row Level Security policies from `supabase/migrations/20260512000000_auth_profiles_activity.sql` are reviewed before any direct browser writes are enabled.

## 3. Required Production Beta Env

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PUBLIC_BASE_URL=https://pintpath.au
DATABASE_PATH=/app/data/pint-path.sqlite
TRUST_PROXY=true
FIELD_TEST_MODE=true
FREE_PRICE_REVEALS_PER_DAY=3
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
# Optional until the official owner/admin email is approved.
# Leave blank to keep admin routes disabled while public browsing stays online.
ADMIN_EMAILS=
GOOGLE_MAPS_API_KEY=browser_key_restricted_to_live_domain
SESSION_TTL_DAYS=60
ADMIN_SESSION_TTL_DAYS=7
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
ADMIN_MFA_MAX_AGE_MINUTES=720
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
ANALYTICS_MIN_BUCKET_SIZE=5
REDIS_URL=redis://default:replace_me@host:6379
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300
ENABLE_LEGACY_CALL_AUTOMATION=false
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-browser-safe-anon-key
SUPABASE_OAUTH_PROVIDERS=google,apple,facebook
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
- New hardening/auth tables/columns are additive: `profiles`, `verifications`, `user_activity_events`, `age_verifications`, `security_audit_log`, session revocation/last-used fields, and supporting indexes.
- If using Supabase Auth/OAuth writes directly, apply and review `supabase/migrations/20260512000000_auth_profiles_activity.sql` in Supabase before field testing uploads/verifications through Supabase-backed clients.
- Verify the Supabase private Storage bucket `beermap-source-evidence` exists, is not public, and has owner-only object policies before accepting source evidence at scale.
- Verify `/health` after deploy, then confirm account signup and map load.
- Verify `/ready` after deploy; if it fails, inspect app logs before allowing user traffic.
- If migration fails, stop the deployment, restore the DB backup, and redeploy the previous production commit.

## 6. Admin Account

- Set `ADMIN_EMAILS` to the approved owner/admin email before first admin signup. If the official ABN/admin email is still pending, leave it blank; public routes can run, but admin routes must remain disabled.
- Sign up with that exact email.
- Open `/admin.html`.
- Confirm unauthenticated requests are blocked and the admin dashboard loads only for the admin account.

## 7. Live Smoke Test

- Open the live site logged out and confirm the map loads.
- Confirm `/health` and `/ready` both return success.
- Confirm no admin/debug UI is visible.
- Open a venue and confirm exact prices are limited/redacted for anonymous users.
- Directly request `/api/business/price-records` logged out and confirm prices are redacted unless a server-counted reveal is used.
- Run `POST /api/business/auth/logout` and confirm the same bearer token can no longer access `/api/business/account`.
- Run a sensitive admin action and confirm a row appears in `security_audit_log`.
- Confirm production inline `sourcePhotoDataUrl` submissions are rejected unless `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=true` is intentionally set.
- Confirm source evidence signed URLs are available only to the uploader/admin and expire after `SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS`.
- Create or log in as a test user and confirm 18+.
- Hit the free reveal limit.
- Submit venue data and confirm it appears as pending in account.
- Log in as admin and approve the submission.
- Confirm points are awarded only after approval.
- Confirm contributor unlock works after the configured threshold.
- Confirm approved price records appear on the map with confidence and last verified date.
- Confirm `/api/calls`, `/api/results`, and `/webhooks/*` return disabled/not-found responses because legacy call automation is off.
- Submit a wrong-price report and feedback.
- Confirm KPI/field-test dashboard records activity.
- Open `/for-bars` and confirm it redirects to `/venue-portal` without exposing a public claim form.
- Assign a venue manager in admin, log in as that user, and confirm `/venue-portal` only shows the assigned venue.
- Confirm the venue portal can save profile details, beer/on-tap rows, happy hours, and deals/specials for the assigned venue only.
- Confirm a Basic bar tier sees analytics/monthly report upgrade prompts, and Plus/Pro tiers can see aggregate-only suburb analytics once the privacy threshold is met.
- Confirm authenticated non-admin users cannot submit bar-claim requests and only see the invite-only venue portal message.
- Submit a venue-manager update and confirm it remains pending review.
- Check the main pages on a phone-width screen.

## 8. Security Preflight

- Run `npm run security:scan` after final env/docs edits.
- Run `npm run security:audit` and confirm there are no high-severity advisories before release.
- Rotate any provider key that was ever committed, shared in chat/screenshots, or exposed through public config.
- Confirm `/config.js` only exposes browser-safe fields such as Google Maps browser key, map ID, field-test flag, and non-secret public settings.
- Confirm `viewer/config.js` is ignored and not committed.
- Confirm `ENABLE_LEGACY_CALL_AUTOMATION=false`. If the archived calling bot is ever re-enabled, add a separate Twilio/ElevenLabs security checklist before deploy.
- Confirm Stripe CLI delivered a signed test webhook to `/api/business/billing/webhook`.
- Confirm audit logs redact email, phone, token, secret, raw payload, source image data, and precise coordinates.
- Confirm analytics buckets below `ANALYTICS_MIN_BUCKET_SIZE` are suppressed in admin and venue-owner outputs.
- Confirm Redis-backed rate limiting is active through `REDIS_URL` before full-scale launch. Controlled beta may use `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true`, but set it to `false` once Redis is configured and tested.
- Confirm Supabase MFA is enabled and admin routes require an AAL2 session in production.
- Confirm Supabase Confirm Email/custom SMTP is configured before allowing self-serve venue-manager onboarding.

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
  - `ENABLE_LEGACY_CALL_AUTOMATION=false`
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
