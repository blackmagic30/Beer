# Pint Path Deployment Checklist

> This older beta checklist is retained for historical detail. For the current
> full web plus iOS launch, follow
> [`docs/production-launch-runbook.md`](docs/production-launch-runbook.md) in
> order. The production launch runbook is controlling where the two differ.

## Railway mutation boundary (document-wide stop)

Every Railway create, configuration, variable, deploy, redeploy, rollback,
route, backup, or teardown instruction in this checklist is non-executable
unless a tracked one-operation executor owns the immediate
`readiness:railway:mutation-boundary` preflight, the one exact reviewed write,
and an unconditional postflight. The standalone boundary command is read-only,
and the checked-in incident baseline intentionally fails. Do not use dashboard
**Deploy**, Git autodeploy, an ad-hoc CLI/API command, or commit/discard an
unrelated staged patch to bypass this stop.

Use this before merging a beta/hardening branch into `main` or deploying a Railway production beta.

Provider-specific setup lives in [docs/provider-configuration-runbook.md](/Users/zac/Desktop/Beer/docs/provider-configuration-runbook.md).

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
- Run `npm run readiness:providers`.
- Run `npm run check`.
- Run `npm run test:release:pintpath`.
- Run `npm run security:scan`.
- Run `npm run security:audit`.
- Confirm no `.env` file, API keys, Stripe secrets, Supabase service-role keys, OpenAI keys, private Google Places keys, or source-evidence secrets are committed.
- Confirm public map source does not contain legacy admin/debug UI strings.
- Confirm Google Maps browser keys are HTTP-referrer restricted to localhost and the live beta domain.
- Confirm a JavaScript/vector Google Maps Map ID exists in Google Maps Platform and is set as `GOOGLE_MAPS_MAP_ID`.
- Confirm the server Google Places/geocoding key is not exposed in `/config.js` and has Places API plus Geocoding API enabled for venue imports and mission area lookup.
- Confirm Supabase Auth Site URL is `https://pintpath.au`; allow exact web callbacks `http://localhost:3000/auth/callback` and `https://pintpath.au/auth/callback`. Allow `pintpath://auth-callback` only for an Android release that enables native OAuth. The first-release iOS archive must have no custom URL scheme and uses the HTTPS callback for email confirmation/password recovery.
- Confirm Supabase Auth leaked-password protection is enabled before public signup.
- Confirm Supabase Row Level Security policies from `supabase/migrations/20260512000000_auth_profiles_activity.sql` are reviewed before any direct browser writes are enabled.

## 3. Required Production Beta Env

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PUBLIC_BASE_URL=https://pintpath.au
DATABASE_PATH=/app/data/pint-path.sqlite
TRUST_PROXY_HOPS=1
FIELD_TEST_MODE=true
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
# Optional until the official owner/admin email is approved.
# Leave blank to keep admin routes disabled while public browsing stays online.
ADMIN_EMAILS=
GOOGLE_MAPS_API_KEY=browser_key_restricted_to_live_domain
GOOGLE_MAPS_MAP_ID=javascript_vector_map_id
GOOGLE_PLACES_API_KEY=server_key_restricted_to_places_and_geocoding
OPENAI_API_KEY=your_openai_api_key
REPORT_TIMEZONE=Australia/Melbourne
REPORT_EMAIL_MODE=disabled
RESEND_API_KEY=
REPORT_EMAIL_FROM="Pint Path <reports@pintpath.au>"
REPORT_EMAIL_REPLY_TO=
REPORT_DELIVERY_SCHEDULE_ENABLED=false
REPORT_DELIVERY_DAY=2
REPORT_DELIVERY_HOUR=9
REPORT_DELIVERY_CHECK_INTERVAL_MINUTES=60
ACCOUNT_DELETION_NOTICE_MODE=resend
RESEND_TRANSACTIONAL_API_KEY=your-dedicated-sending-only-key
ACCOUNT_DELETION_NOTICE_FROM="Pint Path <account@pintpath.au>"
ACCOUNT_DELETION_NOTICE_REPLY_TO=admin@pintpath.au
RESEND_WEBHOOK_SIGNING_SECRET=whsec_replace_in_secret_manager
ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID=2026-08
ACCOUNT_DELETION_NOTICE_KEYRING_JSON='{"2026-08":"replace_with_base64_32_byte_key"}'
ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES=5
ACCOUNT_DELETION_REHEARSAL_ENABLED=false
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
COMMERCIAL_LAUNCH_ENABLED=false
CONSUMER_PAID_ENROLLMENT_ENABLED=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
SOURCE_EVIDENCE_STORAGE_DIR=/app/data/source-evidence
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300
POS_WEBHOOK_SIGNING_SECRET=
SUPABASE_URL=https://auth.pintpath.au
SUPABASE_ANON_KEY=REDACTED_USE_PROJECT_SB_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=REDACTED_USE_PROJECT_SB_SECRET_KEY
SUPABASE_OAUTH_PROVIDERS=google
OFFSITE_BACKUP_SUPABASE_URL=https://hfbmhdxrwtihukmixxta.supabase.co
OFFSITE_BACKUP_SERVICE_ROLE_KEY=REDACTED_USE_DISTINCT_RESTORE_SB_SECRET_KEY
OFFSITE_BACKUP_BUCKET=pintpath-backups
OFFSITE_BACKUP_INTERVAL_HOURS=24
OFFSITE_BACKUP_RETENTION_DAYS=30
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=
STRIPE_PRICE_YEARLY=
STRIPE_PRO_PRICE_ID=
```

Replace every applicable placeholder with a real environment-specific value. Production startup requires the Google Places, OpenAI, Supabase, independent-backup, source-evidence, and account-deletion-notification values shown above. The two Supabase URLs must identify different projects/providers. Leave POS signing absent for manual counter entry and Stripe absent while both paid-enrolment flags remain `false`. Keep Apple OAuth disabled until Apple authorization-token revocation is implemented and tested.

The deletion-notice Resend key must be dedicated and sending-only. Its signed webhook must subscribe to `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`. Purge recipient ciphertext on verified delivery, an audited terminal resolution, or no later than 30 days after deletion completion; ciphertext prepared while deletion is still incomplete has a 60-day maximum. Set `ACCOUNT_DELETION_REHEARSAL_ENABLED=true` only for the isolated Railway staging drill and leave it `false` or absent in production.

Keep the production Beer service at exactly one replica in one Railway region while the authoritative SQLite database and deletion outbox live on its attached volume. Redis does not make that state multi-replica safe.

If you intentionally use simulated checkout for the private field test, set both:

```dotenv
DEMO_BILLING_MODE=true
ALLOW_DEMO_BILLING_IN_PRODUCTION=true
```

In that mode, the pricing UI must be treated as beta/demo billing, not real payment collection.

For the current production deploy, keep `COMMERCIAL_LAUNCH_ENABLED=false` and `CONSUMER_PAID_ENROLLMENT_ENABLED=false`; displayed future pricing does not open paid enrolment.

## 4. Stripe Modes

- Demo billing: works without Stripe keys, but production blocks it unless `ALLOW_DEMO_BILLING_IN_PRODUCTION=true`.
- Stripe test mode: set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, and `STRIPE_PRO_PRICE_ID`; the server creates Stripe-hosted Checkout URLs, so no browser publishable key is required.
- With both paid-enrolment flags `false`, production billing is intentionally deferred and all five Stripe values may remain absent. Enabling either flag requires the complete Stripe configuration. A private simulated environment must instead set both demo flags above and clearly label billing as simulated.
- Do not process live payments until Stripe Checkout and webhook forwarding have been tested with Stripe CLI.
- Stripe webhooks must reject missing/invalid signatures when `DEMO_BILLING_MODE=false`; smoke-test this before enabling paid checkout.

## 5. Database Backup And Migration

- Before deploy, back up the production SQLite file or Railway volume.
- The schema is additive with `CREATE TABLE IF NOT EXISTS` and indexes; do not run destructive `DROP` or `DELETE` commands for this beta.
- Deploy will initialize missing tables from `src/db/schema.sql` through the app database setup.
- New hardening/auth tables/columns are additive: `profiles`, `verifications`, `user_activity_events`, `age_verifications`, `security_audit_log`, session revocation/last-used fields, and supporting indexes.
- If using Supabase Auth/OAuth writes directly, apply and review `supabase/migrations/20260512000000_auth_profiles_activity.sql` in Supabase before field testing uploads/verifications through Supabase-backed clients.
- Verify the Supabase private Storage bucket `beermap-source-evidence` exists, is not public, and has owner-only object policies before accepting source evidence at scale.
- Run `ops/supabase/independent-backup-project-storage.sql` only against the separate backup project. Never include that destination DDL in a production-project `supabase db push`.
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
- Open several venues and confirm anonymous users always receive the same fixed free preview while non-preview prices stay redacted.
- Directly request `/api/business/price-records` logged out and confirm only happy hours and the named preview-beer pint prices are exact.
- Run `POST /api/business/auth/logout` and confirm the same bearer token can no longer access `/api/business/account`.
- Run a sensitive admin action and confirm a row appears in `security_audit_log`.
- Confirm production inline `sourcePhotoDataUrl` submissions are rejected unless `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=true` is intentionally set.
- Confirm source evidence signed URLs are available only to the uploader/admin and expire after `SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS`.
- Create or log in as a test user and confirm 18+.
- Confirm repeated venue opens never widen the fixed preview or expose the full catalogue.
- Submit venue data and confirm it appears as pending in account.
- Log in as admin and approve the submission.
- Confirm points are awarded only after approval.
- Confirm contributor unlock works after the configured threshold.
- Confirm approved price records appear on the map with confidence and last verified date.
- Confirm `/api/calls`, `/api/results`, and `/webhooks/*` return not-found responses because call automation is retired.
- Submit a wrong-price report and feedback.
- Confirm KPI/field-test dashboard records activity.
- Open `/for-bars` and confirm it redirects to `/venue-portal` without exposing a public claim form.
- Assign a venue manager in admin, log in as that user, and confirm `/venue-portal` only shows the assigned venue.
- Confirm the venue portal can save profile details and beer/on-tap/price rows for the assigned venue only; public happy-hour, special, Pro, report, reward, and counter/POS surfaces must remain unavailable.
- Confirm `/config.js` exposes both paid-enrolment flags as `false`, `pricing: null`, venue trial days `0`, and no current checkout, trial, upgrade, amount, or paid-placement claim.
- Confirm `REPORT_EMAIL_MODE=disabled` and `REPORT_DELIVERY_SCHEDULE_ENABLED=false`; do not run a real monthly-report delivery or present report email as part of this release.
- Confirm dormant report, special, billing, and counter/POS endpoints remain authorization- and feature-gated even though they are not current launch journeys.
- Confirm authenticated non-admin users cannot submit public claim requests and only see the invite-only venue portal message.
- Submit an ordinary assigned-venue profile/beer update and confirm it publishes in scope; trigger a documented guarded/destructive change separately and confirm only that change remains pending review.
- Check the main pages on a phone-width screen.

## 8. Security Preflight

- Run `npm run security:scan` after final env/docs edits.
- Run `npm run security:audit` and confirm there are no high-severity advisories before release.
- Rotate any provider key that was ever committed, shared in chat/screenshots, or exposed through public config.
- Confirm `/config.js` only exposes browser-safe fields such as Google Maps browser key, map ID, field-test flag, and non-secret public settings.
- Confirm `viewer/config.js` is ignored and not committed.
- Confirm retired call automation endpoints stay unavailable and no phone-call provider secrets are configured in Railway.
- Confirm Stripe CLI delivered a signed test webhook to `/api/business/billing/webhook`.
- Confirm audit logs redact email, phone, token, secret, raw payload, source image data, and precise coordinates.
- Confirm analytics buckets below `ANALYTICS_MIN_BUCKET_SIZE` are suppressed in admin and venue-owner outputs.
- Confirm Redis-backed rate limiting is active through `REDIS_URL` before full-scale launch. Controlled beta may use `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true`, but set it to `false` once Redis is configured and tested.
- Confirm Supabase MFA is enabled and admin routes require an AAL2 session in production.
- Confirm Supabase Confirm Email/custom SMTP is configured before allowing self-serve venue-manager onboarding.

## 9. Rollback Plan

- Identify the previous production commit with `git log --oneline main`.
- Confirm Railway Git autodeploy is disabled before merging or pushing a release
  candidate. A `main` push must not itself create a production deployment.
- Run `npm run --silent readiness:railway:mutation-boundary` with distinct
  production and staging environment-scoped metadata tokens. Both staged
  patches must be `{}`, and the production deployment/snapshot/source/digest
  must match the reviewed policy. A failure stops rollback and release work; it
  is not permission to discard or commit a patch.
- If the bad deploy came from a merge commit, revert it with `git revert -m 1 <merge_commit_sha>`.
- If it was a fast-forward push, create a revert commit for the problematic range.
- Push the rollback commit to `main` only after it is reviewed. Deploy only
  through the tracked Railway executor that repeats the mutation-boundary check
  before and after one exact deployment. Ordinary `railway redeploy`, a
  dashboard **Deploy**, and autodeploy are not rollback authorities.
- If data migration caused issues, stop the app, restore the pre-deploy database backup, then use the guarded executor to deploy the previous immutable image.
- Fast feature-disable env switches:
  - `FIELD_TEST_MODE=false`
  - `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false`
  - `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false`
- Keep both paid-enrolment flags `false` to hold checkout closed without Stripe. If either flag is enabled, do not remove any Stripe value until the flag is disabled or the previous known-good release is restored.

## 10. Merge Commands

Use these only after all checks pass:

```bash
git switch main
git pull origin main
git merge --ff-only core-business-demo
npm run check
git push origin main
```

If `--ff-only` fails, stop and inspect the merge before continuing. This push
must not autodeploy; the separately reviewed deployment phase owns the exact
image and provider mutation.
