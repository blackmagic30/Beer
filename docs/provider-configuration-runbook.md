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
# Keep at one on Railway for forwarded scheme/host handling. Client security
# identity uses Railway's platform-provided X-Real-IP, not proxy hop count.
TRUST_PROXY_HOPS=1
GOOGLE_MAPS_API_KEY=restricted_browser_key
GOOGLE_MAPS_MAP_ID=javascript_vector_map_id
GOOGLE_PLACES_API_KEY=restricted_server_places_key
OPENAI_API_KEY=your_server_openai_key_for_menu_ocr
OPENAI_MENU_OCR_MODEL=gpt-5.5
OPENAI_MENU_OCR_FALLBACK_MODEL=gpt-4.1
OPENAI_MENU_OCR_REVIEW_PASS=true
SUPABASE_URL=https://your-production-project.supabase.co
SUPABASE_ANON_KEY=your_browser_safe_publishable_or_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_server_only_service_role_key
SUPABASE_OAUTH_PROVIDERS=google,apple
REPORT_TIMEZONE=Australia/Melbourne
REPORT_EMAIL_MODE=disabled
RESEND_API_KEY=
REPORT_EMAIL_FROM="Pint Path <reports@pintpath.au>"
REPORT_EMAIL_REPLY_TO=admin@pintpath.au
REPORT_DELIVERY_SCHEDULE_ENABLED=false
REPORT_DELIVERY_DAY=2
REPORT_DELIVERY_HOUR=9
REPORT_DELIVERY_CHECK_INTERVAL_MINUTES=60
REDIS_URL=redis://default:replace_me@host:6379
REQUIRE_REDIS_RATE_LIMITING=false
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300
POS_WEBHOOK_SIGNING_SECRET=replace_with_a_different_32_plus_random_characters
ADMIN_EMAILS=owner@example.com
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
STRIPE_SECRET_KEY=sk_test_or_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_MONTHLY=price_monthly_499_aud
STRIPE_PRICE_YEARLY=price_yearly_50_aud
STRIPE_PRO_PRICE_ID=price_venue_pro_aud
OFFSITE_BACKUP_SUPABASE_URL=https://your-independent-backup-project.supabase.co
OFFSITE_BACKUP_SERVICE_ROLE_KEY=your_independent_project_service_role_key
OFFSITE_BACKUP_BUCKET=pintpath-backups
OFFSITE_BACKUP_INTERVAL_HOURS=24
OFFSITE_BACKUP_RETENTION_DAYS=30
```

Replace all placeholders with real environment-specific values. The source-evidence and POS secrets must be different high-entropy values. `OFFSITE_BACKUP_SUPABASE_URL` must have a different origin from `SUPABASE_URL`. With `DEMO_BILLING_MODE=false`, all five Stripe values are startup requirements rather than optional checkout-only settings.

Use a persistent Railway volume mounted at `/app/data`. Back it up before each schema-affecting deploy.

`railway.toml` runs `npm run predeploy:production` after the image is built and before Railway starts a candidate deployment. The command imports the same compiled environment validator used by the server, so missing or invalid production configuration stops that candidate before application startup. This guard validates configuration and runtime invariants only; it does not prove provider connectivity. Keep `npm run readiness:launch` and the real-provider checks in the release gate for external verification.

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
- The `beermap-source-evidence` Storage bucket is private, has no direct `anon`/`authenticated` object policies, and is accessed only through the authorized server API/admin signed-URL path.
- Supabase MFA is enabled for admin accounts before public launch.

## Stripe

Keep `DEMO_BILLING_MODE=false` for real launch. Use Stripe test mode first:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_YEARLY`
- `STRIPE_PRO_PRICE_ID`

The browser does not initialise Stripe.js or need a publishable key. Authenticated checkout requests are created server-side and return a Stripe-hosted Checkout URL.

Before live payments:

1. Run Stripe CLI webhook forwarding to `/api/business/billing/webhook`.
2. Confirm missing/invalid signatures are rejected.
3. Confirm duplicate webhook events do not double-process.
4. Confirm Pro venue subscriptions downgrade when cancelled or unpaid.
5. Confirm the pricing page matches the configured Stripe price IDs.
6. Confirm production uses a live-mode `sk_live_` secret. Test-mode `sk_test_` secrets and test price IDs are staging-only.
7. Complete the smallest-value controlled live checkout, signed webhook, billing portal, cancellation, immediate refund, and entitlement/receipt reconciliation in `external-launch-signoffs.md` before opening public paid entry points.

## Monthly Reports

Monthly reports are generated from privacy-thresholded aggregate events and reporting-period venue redemption totals. They do not include user or account IDs, names, emails, raw coordinates, individual clickstreams, recent redemption rows, or source evidence.

Local/staging commands:

```bash
npm run reports:generate -- --month=2026-05 --dry-run
npm run reports:deliver:mock -- --month=2026-05 --dry-run
REPORT_EMAIL_MODE=mock npm run reports:deliver:mock -- --month=2026-05
npm run reports:deliver -- --month=2026-05 --dry-run
```

Real delivery is implemented through the Resend HTTPS API but remains opt-in. Before enabling it:

1. Add and verify a Pint Path sending domain or dedicated sending subdomain in Resend. Configure SPF and DKIM, and add DMARC before public rollout.
2. Create a sending-only API key and store it in Railway as `RESEND_API_KEY`.
3. Set `REPORT_EMAIL_FROM` to an address on that verified domain. Set the required `REPORT_EMAIL_REPLY_TO` to the monitored `admin@pintpath.au` inbox.
4. Keep `REPORT_EMAIL_MODE=disabled` and `REPORT_DELIVERY_SCHEDULE_ENABLED=false` while running `npm run reports:deliver -- --month=YYYY-MM --dry-run` against staging.
5. Set `REPORT_EMAIL_MODE=resend`, leave the automatic schedule off, and run one targeted staging delivery with `--venue-id=...`.
6. Confirm the expected verified manager received one email and attachment, then set `REPORT_DELIVERY_SCHEDULE_ENABLED=true` in production.

Production schedule:

- `REPORT_TIMEZONE=Australia/Melbourne`
- `REPORT_DELIVERY_DAY=2`
- `REPORT_DELIVERY_HOUR=9`
- `REPORT_DELIVERY_CHECK_INTERVAL_MINUTES=60`

The web service checks asynchronously after 09:00 Melbourne time on day 2 and delivers the previous completed month. A missed window within that calendar month is caught up later. If an older month remains incomplete after the calendar rolls over, deliver it explicitly with `npm run reports:deliver -- --month=YYYY-MM`. Successful months are recorded in persistent `system_state` and short-circuited before regeneration on later checks. Each provider request also has a venue/month/recipient idempotency key. `sending` or uncertain outcomes are not automatically retried; inspect the operational state before an explicit `--retry-rejected` run.

Prefer a maintenance window for manual backfills so their status is easy to audit. The delivery ledger uses atomic SQLite recipient claims, and Resend requests use stable idempotency keys, so overlapping scheduler workers cannot intentionally claim the same venue/month/recipient send. The provider also spaces requests to stay below the normal API rate. A provider `429` is recorded as rejected and must be retried explicitly after the reported limit clears with `--retry-rejected`. The command exits non-zero when no reports were generated, a report has no eligible verified manager, another worker still holds an active send lease, or any delivery is rejected or uncertain; treat those outcomes as an incomplete run rather than a successful no-op.

Only active, email-verified assignments with `accessLevel=manager` are eligible. Counter staff are excluded. Delivery state stores a recipient hash rather than an email address. `REPORT_EMAIL_MODE=mock` uses a separate state namespace and cannot mark a Resend delivery complete.

Keep real delivery disabled until the external Resend account, verified domain, key, sender, and monitored reply path are configured. See the official [send-email API](https://resend.com/docs/api-reference/emails/send-email) and [domain verification](https://resend.com/docs/dashboard/domains/introduction) documentation.

Protected export route:

- `GET /api/business/venue-portal/:venueId/reports/:month/export?format=json`
- `GET /api/business/venue-portal/:venueId/reports/:month/export?format=csv`

Only verified Pro venue managers assigned to that venue, or admins, can export the report.

## Redis

Full-scale production should set `REDIS_URL`. The in-memory limiter is acceptable only for a short, single-instance private beta with a documented expiry.

Before public launch:

- Confirm protected auth/upload/feedback/checkout endpoints rate limit through Redis.
- In isolated two-replica staging, set `REQUIRE_REDIS_RATE_LIMITING=true` and verify `/ready` reports `rateLimiterRedis.required=true`. Interrupt only staging Redis and prove readiness plus protected traffic fail closed with `503`, then restore the exact staging Redis reference and confirm recovery.
- Confirm production is not using `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true`.

## Backups And Restore Drills

Production backs up the SQLite database, legacy volume-backed evidence, and every object in the private production `beermap-source-evidence` bucket. Supabase database backups do **not** contain Storage objects, so this Storage export is required for a complete production snapshot.

The `pintpath-backups` destination must be private and in a genuinely independent Supabase project/provider. A bucket in the production project is not disaster isolation and is rejected by startup, provider readiness, and the backup runner.

Run `ops/supabase/independent-backup-project-storage.sql` manually against that independent project. This file deliberately lives outside `supabase/migrations/`, because the normal migration chain targets the production application project and must never create the backup destination there. The previously recorded `20260712010147` production migration remains as an intentional no-op so existing migration histories stay aligned. The backup bucket has no bucket-level object-size cap: SQLite snapshots can grow beyond 100 MiB. Its allowlist includes JSON, SQLite/octet-stream, PDF, and every supported evidence image MIME.

Configure the schedule and retention with:

```dotenv
OFFSITE_BACKUP_SUPABASE_URL=https://independent-backup-project.supabase.co
OFFSITE_BACKUP_SERVICE_ROLE_KEY=replace_with_independent_project_service_role_key
OFFSITE_BACKUP_BUCKET=pintpath-backups
OFFSITE_BACKUP_INTERVAL_HOURS=24
OFFSITE_BACKUP_RETENTION_DAYS=30
```

Automatic off-site backups and account-deletion-ledger writes run only in the
canonical Railway environment named `production` (or an explicitly operated
non-Railway `NODE_ENV=production` runtime). Railway staging/preview environments
must not share the production backup bucket or service key; use an isolated
destination only for a deliberate restore rehearsal. This environment guard
also prevents cloned two-replica staging services from racing the production
ledger or replacing `latest.json`.

Each run uses SQLite's online backup API, captures Storage, then lists Storage again. A changed object set, missing database-referenced object, byte-size mismatch, or MIME mismatch retries the entire snapshot up to three times. The manifest records every SHA-256 checksum and original MIME type, the live database-reference count, reconciliation attempt, and any unreferenced/orphan paths. A snapshot is never published with a missing live evidence object. Every uploaded file is downloaded and checksum-verified; Storage MIME is also verified, including `application/pdf`, before `latest.json` advances.

Deletion suppression is stored outside snapshot prefixes in the independent bucket. An immutable genesis record lives at `_control/account-deletion-ledger-genesis.json`; immutable deletion records live under `_control/account-deletion-ledger/v1/`; the verified aggregate is `_control/account-deletion-tombstones.json`; its genesis/immutable-set/count/hash checkpoint is `_control/account-deletion-ledger-checkpoint.json`. A new installation with no completed deletions therefore has a cryptographically bound zero-count genesis/checkpoint state, not a missing ledger. Deletion entries contain only request ID, internal user ID, and completion time. Production account deletion must durably append and verify its tombstone before the local request can become `completed`. Scheduled backups reconcile the ledger again.

Run an immediate off-volume backup only inside the protected production service/container where `DATABASE_PATH` resolves to the readable live file on the mounted `/app/data` volume. Capture and validate the machine-readable result:

```bash
set -euo pipefail
umask 077
BACKUP_RESULT="$(mktemp)"
trap 'rm -f "$BACKUP_RESULT"' EXIT INT TERM
test -r "${DATABASE_PATH:?}"
case "$(realpath "$DATABASE_PATH")" in /app/data/*) ;; *) exit 1 ;; esac
npm run --silent data:backup:offsite | tee "$BACKUP_RESULT"
jq -e '.ok == true
  and (.backupId | type == "string" and length > 0)
  and (.manifestSha256 | type == "string" and test("^[a-f0-9]{64}$"))' \
  "$BACKUP_RESULT"
```

Capture the sanitized JSON stdout through the protected operator channel if launch evidence is required; the trap deletes its private remote temporary copy. Running this command in a local checkout can silently capture the wrong SQLite file and does not count as production evidence.

For a local or operator-managed backup, use:

```bash
export LOCAL_BACKUP_PATH="${LOCAL_BACKUP_PATH:?set a new private mode-700 destination}"
test ! -e "$LOCAL_BACKUP_PATH"
npm run --silent data:backup -- --output="$LOCAL_BACKUP_PATH"
npm run --silent data:backup:verify -- --backup="$LOCAL_BACKUP_PATH"
```

The local command covers SQLite and legacy filesystem evidence only. It is not a complete production backup when the database contains `supabase_private` evidence references.

For an online drill, create a separate temporary secret key in the independent backup project, store it only in a mode-`600` regular non-symlink file, and delete that temporary key after the drill. Never reuse or revoke the long-lived Railway production backup key. Take the exact `backupId` and trusted `manifestSha256` from the protected production result and use the repository SDK downloader to copy only that immutable prefix into a nonexistent mode-`700` destination:

```bash
: "${BACKUP_ID:?set from the protected production backup result}"
: "${EXPECTED_MANIFEST_SHA256:?set from that result's manifestSha256}"
test ! -e "$BACKUP_PATH"
test -f "${OFFSITE_BACKUP_SECRET_KEY_FILE:?}"
test ! -L "$OFFSITE_BACKUP_SECRET_KEY_FILE"
chmod 600 "$OFFSITE_BACKUP_SECRET_KEY_FILE"

OFFSITE_BACKUP_SUPABASE_URL="${OFFSITE_BACKUP_SUPABASE_URL:?}" \
OFFSITE_BACKUP_BUCKET="${OFFSITE_BACKUP_BUCKET:-pintpath-backups}" \
  npm run --silent data:backup:download-offsite -- \
    --backup-id="$BACKUP_ID" \
    --expected-manifest-sha256="$EXPECTED_MANIFEST_SHA256" \
    --output="$BACKUP_PATH" \
    --service-role-key-file="$OFFSITE_BACKUP_SECRET_KEY_FILE"
npm run --silent data:backup:verify -- --backup="$BACKUP_PATH"
```

The downloader uses the lockfile-installed `@supabase/supabase-js`; it needs no runtime `npx`, Supabase CLI, project linking, access token, or experimental command. It accepts the protected key file path, downloads only the exact validated immutable prefix into a private temporary directory, rejects unsafe paths and existing destinations, verifies the manifest, and then publishes the completed output without object-path progress. The manifest plus the independent verification command remains the integrity authority. Use only a trusted independent project. The complete safe variable setup, captures, and cleanup steps are in [`external-launch-signoffs.md`](external-launch-signoffs.md#8-backup_restore).

The online rehearsal reads the immutable genesis and every deletion object directly, verifies the current aggregate/checkpoint, and accepts a zero-count ledger only when all authority agrees. Set `DATABASE_PATH` to the SQLite file that will be created inside the new rehearsal output, so the operational job state is written only to that isolated restored copy:

```bash
test ! -e "$REHEARSAL_ROOT"
DATABASE_PATH="$REHEARSAL_ROOT/pint-path.sqlite" \
  npm run --silent data:backup:rehearse -- \
    --backup="$BACKUP_PATH" \
    --output="$REHEARSAL_ROOT"
```

Do not use the ledger hash in `latest.json` as restore authority; it is only the backup-time observation and later completed deletions legitimately advance the ledger. If the destination is temporarily offline, an operator may use a separately downloaded non-empty ledger with its trusted out-of-band SHA-256. A zero-count ledger additionally requires the independently downloaded genesis and checkpoint, each with its own trusted out-of-band SHA-256:

```bash
DATABASE_PATH=/secure/restore/rehearsal/pint-path.sqlite \
  npm run --silent data:backup:rehearse -- \
  --backup=/secure/restore/pint-path-SNAPSHOT \
  --tombstones=/secure/restore/account-deletion-tombstones.json \
  --tombstone-sha256=TRUSTED_64_HEX_SHA256 \
  --tombstone-genesis=/secure/restore/account-deletion-ledger-genesis.json \
  --tombstone-genesis-sha256=TRUSTED_GENESIS_64_HEX_SHA256 \
  --tombstone-checkpoint=/secure/restore/account-deletion-ledger-checkpoint.json \
  --tombstone-checkpoint-sha256=TRUSTED_CHECKPOINT_64_HEX_SHA256 \
  --output=/secure/restore/rehearsal
```

Restore fails closed if the independent ledger authority is absent, malformed, stale, tampered, or an empty aggregate is not bound to the verified genesis/checkpoint. It verifies SQLite, filesystem evidence, Storage evidence, reference-to-object reconciliation, checksums, MIME metadata, and the orphan report before applying all later deletion tombstones. Tombstoned account PII and private evidence are removed from the restored copy before success.

Off-site snapshot retention is capped at 30 days, so old snapshots can physically retain pre-deletion bytes for at most 30 days. A completed deletion has zero unprotected restore window: its independent tombstone must be durable before completion. The scheduled 24-hour run is reconciliation and drift detection, not the primary deletion write. If the ledger append fails, deletion remains failed/retryable and production restore is blocked until the ledger is healthy.

Keep both source and destination buckets private. `/ready` requires a fresh successful backup and live destination capability canaries for list/upload/download/remove across PDF, SQLite/octet-stream, and image objects. Once per quarter, restore the latest verified directory into isolated staging. Rows with `storage_provider='supabase_private'` cannot be tested by pointing `SOURCE_EVIDENCE_STORAGE_DIR` at the local restored tree. Use `npm run data:backup:stage-evidence -- --backup="$BACKUP_PATH" --restore="$REHEARSAL_ROOT"` to upload the restored objects, with manifest MIME types and original paths, into an empty private `beermap-source-evidence` bucket in a separate staging Supabase project. Configure the isolated staging app with the restored database and that project, disable external writes, then confirm `/ready`, login, map prices, private image/PDF review, the orphan report, deletion-tombstone counts, and staging restore-job state. Purge the staging project/object copy after sign-off.

## No-Go Conditions

Do not launch public production if any of these are true:

- `NODE_ENV=production npm run readiness:providers` fails.
- `GOOGLE_MAPS_MAP_ID` is missing.
- Admin access is enabled without MFA/verified admin allowlist.
- Stripe live checkout is enabled before test-mode flow coverage and the controlled smallest-value live checkout/webhook/portal/cancel/refund reconciliation pass.
- Automatic report email is presented as live before Resend credentials, verified sender-domain DNS, targeted staging delivery, and scheduler operational state are confirmed.
- Redis is missing for broad public traffic.
- Supabase source-evidence Storage is public or untested.
- The backup destination shares the production project/provider, either bucket is public, or the independent deletion ledger is unavailable.
- There is no complete recent off-site backup (SQLite plus Storage evidence) that passes verification, or the quarterly ledger-backed restore drill has not been completed.
