# Pint Path Provider Configuration Runbook

Use this before a Railway production or staging deployment for the full-scale Free web-and-iOS release. The local app can run with placeholder values, but `NODE_ENV=production` now fails fast if critical provider config is missing.

> **Full-scale launch blocker:** the checked-in Free-live application now uses
> the shared transactional PostgreSQL contract and permanent staging has a
> verified import/runtime/logical backup. The reviewed build is not deployed in
> staging, however, and production remains attached to SQLite while its
> provisioned PostgreSQL service is empty and detached. Provider configuration
> cannot substitute for the remaining provider credentials,
> two-replica/load/restart, PITR/WORM/full-restore, promotion, and
> cutover evidence. Every SQLite command below is retained only for one-time
> source capture, reconciliation, and legacy restore evidence during cutover.

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

The provider check never prints secret values. `readiness:launch` is stricter:
run it inside the deployed service and require
`readinessProfile=production_free_launch`; any remaining warning blocks broad
public launch. It also fails any commercial/trial/reward/report/POS flag or
credential drift. A GitHub job with injected safe literals is not proof of the
actual Railway environment. A green local result does **not** close the live
provider, staging-app, scale, recovery, or cutover blockers above.

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

Target Railway profile after the Postgres adapter and migration tooling are
implemented and proved in permanent staging. Do not paste this into the current
SQLite runtime merely to satisfy a presence check:

Treat Railway configuration and remote-shell output as credential-bearing.
`railway environment config --json` returns resolved secret values, and a
Railway SSH session or nested login shell can expose the full remote/session
environment. Never run either command in a captured terminal, CI log, support
transcript, or release-evidence workflow. For inspection, use name-only or
`decryptVariables:false` provider metadata and perform comparisons entirely in
process without printing values. Write one secret at a time with
`railway variable set NAME --stdin --skip-deploys`; use `railway connect --ssh`
only to launch the intended local database client, with output explicitly
allowlisted and no nested shell. Any accidental resolved-environment output is
a credential incident: stop unrelated work, rotate the exposed staging-only
authorities with overlap, prove the old credentials fail, and preserve a
secret-free incident receipt before continuing.

```dotenv
NODE_ENV=production
FIELD_TEST_MODE=false
HOST=0.0.0.0
PORT=8080
PUBLIC_BASE_URL=https://pintpath.au
PINTPATH_IDENTITY_REGISTRY_PHASE=complete
PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID=replace_with_reviewed_staging_project_id
PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID=replace_with_reviewed_staging_environment_id
PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID=replace_with_reviewed_staging_app_service_id
# Do not set DATABASE_PATH in the deployed service. Keep any sealed SQLite
# migration source outside the runtime environment after reconciliation.
DATABASE_URL=postgresql://app_user:replace_me@direct-or-session-host:5432/pintpath?uselibpqcompat=true&sslmode=require
# The checked-in runtime also adds libpq compatibility to its private Pool URL,
# so the flag above is explicit but not required for correct sslmode=require
# behavior. Identity pins always hash the exact configured DATABASE_URL bytes;
# adding, removing, or reordering a query parameter requires new reviewed pins.
# Plain sslmode=require encrypts without certificate authentication; supplying
# sslrootcert promotes it to CA verification as in libpq. Use verify-full where
# the provider supports hostname verification, or verify-ca with one explicit
# readable sslrootcert when only CA verification is possible.
# Keep at one on Railway for forwarded scheme/host handling. Client security
# identity uses Railway's platform-provided X-Real-IP, not proxy hop count.
TRUST_PROXY_HOPS=1
GOOGLE_MAPS_API_KEY=restricted_browser_key
GOOGLE_MAPS_MAP_ID=javascript_vector_map_id
GOOGLE_PLACES_API_KEY=restricted_server_places_key
OPENAI_API_KEY=your_server_openai_key_for_menu_ocr
OPENAI_MENU_OCR_MODEL=gpt-5.6-sol
OPENAI_MENU_OCR_FALLBACK_MODEL=gpt-4.1
OPENAI_MENU_OCR_REVIEW_PASS=true
SUPABASE_URL=https://your-production-project.supabase.co
SUPABASE_ANON_KEY=your_browser_safe_publishable_or_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_server_only_service_role_key
SUPABASE_OAUTH_PROVIDERS=google
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
ACCOUNT_DELETION_NOTICE_MODE=resend
RESEND_TRANSACTIONAL_API_KEY=replace_with_sending_only_key
ACCOUNT_DELETION_NOTICE_FROM="Pint Path <account@pintpath.au>"
ACCOUNT_DELETION_NOTICE_REPLY_TO=admin@pintpath.au
RESEND_WEBHOOK_SIGNING_SECRET=whsec_replace_in_secret_manager
ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID=2026-08
ACCOUNT_DELETION_NOTICE_KEYRING_JSON='{"2026-08":"replace_with_base64_32_byte_key"}'
ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES=5
ACCOUNT_DELETION_REHEARSAL_ENABLED=false
REDIS_URL=redis://default:replace_me@host:6379
PINTPATH_DATABASE_RESOURCE_ID=replace_with_live_environment_database_provider_resource_id
PINTPATH_EXPECTED_DATABASE_RESOURCE_ID=replace_with_registered_environment_database_provider_resource_id
PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS=replace_with_other_two_environment_database_resource_ids
PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID=railway:replace_with_staging_environment_id:replace_with_staging_database_service_id
PINTPATH_REDIS_RESOURCE_ID=replace_with_live_environment_redis_provider_resource_id
PINTPATH_EXPECTED_REDIS_RESOURCE_ID=replace_with_registered_environment_redis_provider_resource_id
PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS=replace_with_other_two_environment_redis_resource_ids
PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID=railway:replace_with_staging_environment_id:replace_with_staging_redis_service_id
PINTPATH_EXPECTED_DATABASE_URL_SHA256=replace_with_exact_environment_database_url_digest
PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S=replace_with_other_registered_environment_database_url_digests
PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256=replace_with_exact_staging_database_url_digest
PINTPATH_EXPECTED_REDIS_URL_SHA256=replace_with_exact_environment_redis_url_digest
PINTPATH_FORBIDDEN_REDIS_URL_SHA256S=replace_with_other_registered_environment_redis_url_digests
PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256=replace_with_exact_staging_redis_url_digest
REQUIRE_REDIS_RATE_LIMITING=true
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
SOURCE_EVIDENCE_SIGNING_SECRET=replace_with_32_plus_random_characters
SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300
POS_WEBHOOK_SIGNING_SECRET=
ADMIN_EMAILS=owner@example.com
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
COMMERCIAL_LAUNCH_ENABLED=false
CONSUMER_PAID_ENROLLMENT_ENABLED=false
PINT_POINTS_REWARDS_ENABLED=false
ALCOHOL_GAMIFICATION_ENABLED=false
VENUE_PRO_TRIAL_DAYS=0
VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=
STRIPE_PRICE_YEARLY=
STRIPE_PRO_PRICE_ID=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
OFFSITE_BACKUP_SUPABASE_URL=https://your-operational-restore-copy-project.supabase.co
OFFSITE_BACKUP_SERVICE_ROLE_KEY=your_operational_restore_copy_service_role_key
OFFSITE_BACKUP_BUCKET=pintpath-backups
OFFSITE_BACKUP_INTERVAL_HOURS=24
OFFSITE_BACKUP_RETENTION_DAYS=30
```

Replace all applicable placeholders with real environment-specific values. `SOURCE_EVIDENCE_SIGNING_SECRET` is always required. Leave `POS_WEBHOOK_SIGNING_SECRET` absent: counter, reward, redemption, and POS modes are outside this release and must remain disabled. `OFFSITE_BACKUP_SUPABASE_URL` must have a different origin from `SUPABASE_URL`, but that separation alone does not make it independent or immutable. Keep field-test mode, both paid flags, rewards, and alcohol gamification `false`; keep `VENUE_PRO_TRIAL_DAYS=0`, report delivery disabled, and all Stripe values absent for this Free-only release.

Generate each connection digest from the exact credentialed URL only inside the
protected environment; never print or duplicate the URL. The expected digest
must match that environment, while each forbidden digest list contains both of
the other current production/permanent-staging/restore identities. Also bind
the live non-secret database and Redis provider resource IDs through provider
service references, match the protected expected IDs, and forbid both other
environment resource IDs. Startup and provider readiness require both the URL
configuration and provider-resource checks; they emit no connection URL or
digest. Supabase project pinning and the
fixed private `beermap-source-evidence` bucket provide the corresponding
Storage identity check.

### First permanent-staging identity bootstrap

The first staging database cannot truthfully name production and restore
database identities before those service instances exist. Do not invent
placeholder hashes or IDs. For this one operator-only step, set
`PINTPATH_IDENTITY_REGISTRY_PHASE=staging-bootstrap`, load the exact protected
Railway project/environment/app-service tuple, and bind both staging Postgres
and Redis with matching URL hashes and environment-specific identities in the
form `railway:<environment-id>:<service-id>`. Leave all four forbidden sibling
lists absent.

Bootstrap is deliberately non-launchable: `src/server.ts` refuses to import the
application, routes, or workers; provider readiness skips Storage mutations and
returns a distinct incomplete profile; production, restore, and deletion
rehearsal reject the phase. The executable Postgres verifier validates this
full environment contract before opening its one-connection pool. Once the real
production and restore service instances exist, atomically register their two
identities, set `PINTPATH_IDENTITY_REGISTRY_PHASE=complete`, and rerun the full
deploy and provider gates. Complete production/restore configurations must also
include the named permanent-staging hashes and service-instance IDs in their
forbidden lists.

Ordinary Railway staging in complete mode selects
`readinessProfile=permanent_staging_complete`, not the canonical-production
profile. Its live/expected/named database and Redis pins must all identify
permanent staging. Each forbidden list must contain the two distinct production
and restore siblings; the staging self digest/resource must never be placed in
its own forbidden list. The gate completes every local identity and
configuration check before constructing a Supabase client. Only a green strict
preflight may run the bounded source-evidence and isolated operational-copy
list/upload/download/remove canaries. A preflight failure performs no Storage
operation and the app must remain undeployed.

These values now select the implemented server-only `DATABASE_URL` path. The
checked-in runtime and pinned permanent-staging proof:

- require TLS and use a bounded connection pool sized within the provider connection budget;
- use a dedicated least-privilege application login, never `postgres`, `service_role`, `anon`, or `authenticated`;
- keep Pint Path application tables in a non-exposed schema with no Data API grants to `anon` or `authenticated`;
- use a separate direct/admin connection for migrations and logical backups, rather than giving migration ownership to the runtime role;
- migrate and checksum all current SQLite state. The synthetic permanent-
  staging import is verified; two-replica concurrency, idempotency, restart,
  deploy, rollback, and queue/outbox behaviour remain launch gates; and
- leave the sealed SQLite file read-only as migration evidence only. All production writes and rollback targets remain Postgres after cutover.

Keep a persistent Railway volume mounted at `/app/data` during the transition for the sealed SQLite source and legacy private evidence. Back it up before each schema-affecting cutover step. It must not remain the authoritative database after the Postgres cutover.

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

Use Supabase for OAuth, private evidence storage, and the target managed Postgres service, while Pint Path app authorization remains enforced by the Express API.

Required checks:

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set for browser OAuth.
- `SUPABASE_SERVICE_ROLE_KEY` is only server-side.
- Google OAuth is configured with minimal email/profile scopes for the web app. Apple OAuth remains disabled until authorization-token revocation is implemented and tested. The first-release iOS app is email/password only.
- Leaked password protection is enabled in Supabase Auth.
- The hosted database is not on deprecated Postgres 14.
- Supabase Auth redirect URLs include the web callback pages:
  - `http://localhost:3000/auth/callback`
  - `https://pintpath.au/auth/callback`
- If Android social OAuth is released, its native callback is also allowlisted:
  - `pintpath://auth-callback`
- The first-release iOS archive has no custom URL scheme. Its email-confirmation and password-recovery links use the exact HTTPS web callback, after which the user returns to the app and signs in.
- The Google provider console includes the Supabase provider callback URL derived from `SUPABASE_URL`:
  - `https://auth.pintpath.au/auth/v1/callback` when `SUPABASE_URL=https://auth.pintpath.au`
- RLS policies from `supabase/migrations/` are applied and tested in staging.
- New public-schema tables have intentional Data API exposure/grants plus RLS; do not assume new tables are automatically exposed.
- The `beermap-source-evidence` Storage bucket is private, has no direct `anon`/`authenticated` object policies, and is accessed only through the authorized server API/admin signed-URL path.
- Supabase MFA is enabled for admin accounts before public launch.
- Authoritative app tables live in a non-exposed schema and are reached only by the server's least-privilege database role. Do not grant `anon` or `authenticated` access; RLS remains defense in depth rather than the primary server boundary.
- The application uses a TLS connection pool with a documented maximum. Migrations, schema ownership, `pg_dump`, PITR administration, and restore work use a separately held direct/admin connection.
- Permanent integrated staging has its own Supabase project/database, Auth users, Storage bucket, Redis, Resend configuration, Railway environment/service, domain, and callbacks. It stays available for migrations, two-replica concurrency, auth, deletion, data repair, smoke, load, deploy, and rollback proof.
- Disposable restore-staging has a different Railway environment/service, database, Supabase project/Auth/Storage, Redis, secrets, domain, and callbacks from permanent staging, production, and the operational restore copy. It exists only for destructive RPO/RTO proof and is destroyed after signed evidence.
- Before each destructive drill, copy the disposable restore environment identities from the private release register into the protected `RESTORE_REHEARSAL_EXPECTED_*` variables and verify the runtime identities match. Never repurpose permanent staging. Changing these protected pins for a new disposable restore environment does not require a candidate code change.

## Future Stripe configuration — not a current launch gate

For this launch, keep `DEMO_BILLING_MODE=false` and both paid-enrolment flags `false`; Stripe is deferred and the following values remain absent. Before enabling either paid flag, configure all five and use Stripe test mode first:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_YEARLY`
- `STRIPE_PRO_PRICE_ID`

The browser does not initialise Stripe.js or need a publishable key. Authenticated checkout requests are created server-side and return a Stripe-hosted Checkout URL.

Before any later live-payments release:

1. Run Stripe CLI webhook forwarding to `/api/business/billing/webhook`.
2. Confirm missing/invalid signatures are rejected.
3. Confirm duplicate webhook events do not double-process.
4. Confirm Pro venue subscriptions downgrade when cancelled or unpaid.
5. Confirm the pricing page matches the configured Stripe price IDs.
6. Confirm production uses a live-mode `sk_live_` secret. Test-mode `sk_test_` secrets and test price IDs are staging-only.
7. Complete the smallest-value controlled live checkout, signed webhook, billing portal, cancellation, immediate refund, and entitlement/receipt reconciliation in `external-launch-signoffs.md` before opening public paid entry points.

## Future monthly reports — not part of the current launch

Keep `REPORT_EMAIL_MODE=disabled` and
`REPORT_DELIVERY_SCHEDULE_ENABLED=false` for the current venue-Free release.
The implementation and rehearsal steps below are retained for a later approved
Pro/commercial candidate; do not enable or use real delivery to satisfy the
current release gate.

Monthly reports are generated from privacy-thresholded aggregate events and reporting-period venue redemption totals. They do not include user or account IDs, names, emails, raw coordinates, individual clickstreams, recent redemption rows, or source evidence.

Local/staging commands:

```bash
npm run reports:generate -- --month=2026-05 --dry-run
npm run reports:deliver:mock -- --month=2026-05 --dry-run
REPORT_EMAIL_MODE=mock npm run reports:deliver:mock -- --month=2026-05
npm run reports:deliver -- --month=2026-05 --dry-run
```

Real delivery is implemented through the Resend HTTPS API but remains opt-in.
Only in that later approved candidate, before enabling it:

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

Prefer a maintenance window for manual backfills so their status is easy to audit. The current dormant implementation uses atomic SQLite recipient claims and stable Resend idempotency keys; migrate that ledger and its lease semantics to Postgres before any future report release. The provider also spaces requests to stay below the normal API rate. A provider `429` is recorded as rejected and must be retried explicitly after the reported limit clears with `--retry-rejected`. The command exits non-zero when no reports were generated, a report has no eligible verified manager, another worker still holds an active send lease, or any delivery is rejected or uncertain; treat those outcomes as an incomplete run rather than a successful no-op.

Only active, email-verified assignments with `accessLevel=manager` are eligible. Counter staff are excluded. Delivery state stores a recipient hash rather than an email address. `REPORT_EMAIL_MODE=mock` uses a separate state namespace and cannot mark a Resend delivery complete.

Keep real delivery disabled until the external Resend account, verified domain, key, sender, and monitored reply path are configured. See the official [send-email API](https://resend.com/docs/api-reference/emails/send-email) and [domain verification](https://resend.com/docs/dashboard/domains/introduction) documentation.

Protected export route:

- `GET /api/business/venue-portal/:venueId/reports/:month/export?format=json`
- `GET /api/business/venue-portal/:venueId/reports/:month/export?format=csv`

Only verified Pro venue managers assigned to that venue, or admins, can export the report.

## Account-deletion completion notices

Canonical production uses `ACCOUNT_DELETION_NOTICE_MODE=resend` with a dedicated sending-only `RESEND_TRANSACTIONAL_API_KEY`; do not reuse the optional monthly-report key. Configure the signed webhook at `/api/business/account-deletion-notifications/resend-webhook` for `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`.

Recipient ciphertext is held for at most 60 days while deletion is incomplete. After deletion completes, purge it on verified delivery, an audited terminal resolution, or no later than 30 days after completion. Retain only the non-identifying delivery and audit metadata allowed by the retention policy.

Set `ACCOUNT_DELETION_REHEARSAL_ENABLED=true` only for the sacrificial proof in
permanent integrated staging; remove it immediately after the proof. Never use
disposable destructive restore staging for this ordinary integration rehearsal.
The staging service must have no production WORM credentials or
`RESTORE_REHEARSAL_*` variables, but it must retain its dedicated `REDIS_URL`,
`REQUIRE_REDIS_RATE_LIMITING=true`, and
`ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false` while at least two replicas
and overlapping workers run. Load the reviewed
`ACCOUNT_DELETION_REHEARSAL_EXPECTED_*` Railway/Supabase pins from the private
release register and set the independently verified replica count to at least
two; the runtime profile fails closed on any mismatch.
`npm run --silent readiness:providers` must select a mutation-free
`account_deletion_rehearsal` profile that skips the production backup Storage
canary without skipping shared Redis. Leave the rehearsal variable `false` or
absent in production.

## Redis

Full-scale production must set `REDIS_URL`, `REQUIRE_REDIS_RATE_LIMITING=true`, and `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false`. An in-memory limiter is not an accepted launch configuration.

Before public launch:

- Confirm protected auth/upload/feedback/checkout endpoints rate limit through Redis.
- In permanent integrated two-replica staging, set `REQUIRE_REDIS_RATE_LIMITING=true` and verify `/ready` reports `rateLimiterRedis.required=true`. Interrupt only staging Redis and prove readiness plus protected traffic fail closed with `503`, then restore the exact staging Redis reference and confirm recovery.
- Confirm production is not using `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true`.

## Backups And Restore Drills

> **Transition tooling, not the final full-scale backup contract:** the checked-in commands in this section back up and restore SQLite. Preserve them for a checksummed cutover source and legacy evidence, but do not pass the production gate with them. The final contract requires managed Postgres PITR, a separately checksummed logical Postgres export, every private Storage object and its metadata, the private operational Supabase restore copy, and a provider-enforced object-locked/WORM copy in a separate failure domain. A destructive RPO/RTO proof must restore that complete set into disposable restore-staging.

The current SQLite transition captures the database, legacy volume-backed evidence, and every object in the private production `beermap-source-evidence` bucket. Supabase database backups do **not** contain Storage objects, so the Storage export is required for a complete transition snapshot.

The `pintpath-backups` destination must be private and in a different Supabase project from production. Treat it only as the **private operational restore copy**: the application-held service-role key can delete and overwrite it, so it is neither independent nor immutable and does not replace WORM.

Run `ops/supabase/independent-backup-project-storage.sql` manually against that operational restore-copy project. The historical filename is preserved because code and tests refer to it. This file deliberately lives outside `supabase/migrations/`, because the normal migration chain targets the production application project and must never create the restore-copy destination there. The previously recorded `20260712010147` production migration remains as an intentional no-op so existing migration histories stay aligned. The bucket has no bucket-level object-size cap: SQLite transition snapshots can grow beyond 100 MiB. Its allowlist includes JSON, SQLite/octet-stream, PDF, and every supported evidence image MIME.

Configure the schedule and retention with:

```dotenv
OFFSITE_BACKUP_SUPABASE_URL=https://operational-restore-copy-project.supabase.co
OFFSITE_BACKUP_SERVICE_ROLE_KEY=replace_with_operational_restore_copy_service_role_key
OFFSITE_BACKUP_BUCKET=pintpath-backups
OFFSITE_BACKUP_INTERVAL_HOURS=24
OFFSITE_BACKUP_RETENTION_DAYS=30
```

Automatic operational restore-copy jobs and account-deletion-ledger writes run only in the
canonical Railway environment named `production` (or an explicitly operated
non-Railway `NODE_ENV=production` runtime). Railway staging/preview environments
must not share the production backup bucket or service key; use an isolated
destination only for a deliberate restore rehearsal. This environment guard
also prevents cloned two-replica staging services from racing the production
ledger or replacing `latest.json`.

Each run uses SQLite's online backup API, captures Storage, then lists Storage again. A changed object set, missing database-referenced object, byte-size mismatch, or MIME mismatch retries the entire snapshot up to three times. The manifest records every SHA-256 checksum and original MIME type, the live database-reference count, reconciliation attempt, and any unreferenced/orphan paths. A snapshot is never published with a missing live evidence object. Every uploaded file is downloaded and checksum-verified; Storage MIME is also verified, including `application/pdf`, before `latest.json` advances.

Deletion suppression is stored outside snapshot prefixes in the operational restore-copy bucket. An application-convention genesis record lives at `_control/account-deletion-ledger-genesis.json`; append-style deletion records live under `_control/account-deletion-ledger/v1/`; the verified aggregate is `_control/account-deletion-tombstones.json`; its genesis/set/count/hash checkpoint is `_control/account-deletion-ledger-checkpoint.json`. A new installation with no completed deletions therefore has a cryptographically bound zero-count genesis/checkpoint state, not a missing ledger. Deletion entries contain only request ID, internal user ID, and completion time. Production account deletion must durably append and verify its tombstone before the local request can become `completed`. Scheduled backups reconcile the ledger again. Because the service-role principal can still remove or replace these objects, only the separately administered WORM replica is immutable authority.

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

For a legacy SQLite transition drill, create a separate temporary secret key in the operational restore-copy project, store it only in a mode-`600` regular non-symlink file, and delete that temporary key after the drill. Never reuse or revoke the long-lived Railway production restore-copy key. Take the exact `backupId` and trusted `manifestSha256` from the protected result and use the repository SDK downloader to copy only that exact prefix into a nonexistent mode-`700` destination:

```bash
: "${BACKUP_ID:?set from the protected production backup result}"
: "${EXPECTED_MANIFEST_SHA256:?set from the result manifestSha256}"
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

The downloader uses the lockfile-installed `@supabase/supabase-js`; it needs no runtime `npx`, Supabase CLI, project linking, access token, or experimental command. It accepts the protected key file path, downloads only the exact validated prefix into a private temporary directory, rejects unsafe paths and existing destinations, verifies the manifest, and then publishes the completed output without object-path progress. The manifest plus independent checksum verification is the integrity check for this operational copy, not proof of provider-enforced immutability. The complete safe variable setup, captures, and cleanup steps are in [`external-launch-signoffs.md`](external-launch-signoffs.md#9-backup_restore).

The online rehearsal reads the application-convention append-only genesis and
every deletion object directly, verifies the current aggregate/checkpoint, and
accepts a zero-count ledger only when all authority agrees. This detects normal
drift but is not provider-enforced immutability while Railway holds the Supabase
service-role key. Set `DATABASE_PATH` to the SQLite file that will be created
inside the new rehearsal output, so the operational job state is written only
to that isolated restored copy:

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

The legacy restore fails closed if the operational ledger is absent, malformed, stale, tampered, or an empty aggregate is not bound to the verified genesis/checkpoint. It verifies SQLite, filesystem evidence, Storage evidence, reference-to-object reconciliation, checksums, MIME metadata, and the orphan report before applying all later deletion tombstones. Tombstoned account PII and private evidence are removed from the restored copy before success.

Operational snapshot retention is capped at 30 days, so old snapshots can physically retain pre-deletion bytes for at most 30 days. A completed deletion has zero unprotected restore window: its tombstone must be durable in both the operational copy and the separately administered immutable authority before completion. The scheduled 24-hour run is reconciliation and drift detection, not the primary deletion write. If either append fails, deletion remains failed/retryable and production restore is blocked until the ledger is healthy.

Keep both source and operational destination buckets private. `/ready` requires a
fresh successful operational backup and live destination capability canaries for
list/upload/download/remove across PDF, SQLite/octet-stream, and image objects.
Those delete canaries prove the existing Supabase restore copy and also prove it
is not WORM. Replicate every completed set and deletion ledger to a separately
administered provider/region with object lock and an append/create-only Railway
principal; verify that copy outside `/ready` with a separately held reader.
Once per quarter, restore the latest complete verified Postgres, Storage, ledger,
and WORM set into disposable restore-staging. Do not use permanent integrated
staging and do not accept the SQLite-only procedure below as the final drill.
Rows with `storage_provider='supabase_private'` cannot be tested by pointing
`SOURCE_EVIDENCE_STORAGE_DIR` at the local restored tree. Use `npm run
data:backup:stage-evidence -- --backup="$BACKUP_PATH"
--restore="$REHEARSAL_ROOT"` to upload the restored objects, with manifest MIME
types and original paths, into an empty private `beermap-source-evidence` bucket
in the disposable restore-staging Supabase project. Configure the restore-only
app with the restored database and that project, disable external writes, then confirm
`/ready`, login, map prices, private image/PDF review, the orphan report,
deletion-tombstone counts, and staging restore-job state. Purge the staging
project/object copy after sign-off.

## No-Go Conditions

Do not launch public production if any of these are true:

- `NODE_ENV=production npm run readiness:providers` fails.
- The reviewed PostgreSQL build is not deployed and proved in permanent
  staging, production still opens authoritative state through SQLite, or the
  candidate cannot run two safe replicas and a Postgres-native rollback path.
- `GOOGLE_MAPS_MAP_ID` is missing.
- Admin access is enabled without MFA/verified admin allowlist.
- Any paid, trial, Pro, reward, counter, redemption, POS, public happy-hour, or report-delivery surface is enabled for this Free-only release.
- Redis is missing for broad public traffic.
- Supabase source-evidence Storage is public or untested.
- Permanent integrated staging and disposable restore-staging share any database, Supabase project/Auth/Storage, Redis, secrets, service, volume, domain, or callback identity.
- There is no object-locked/WORM copy in a separate provider or region, Railway
  can delete/overwrite that copy or change its retention, either bucket is
  public, or the WORM-protected deletion ledger is unavailable.
- There is no complete recent Postgres PITR point, checksummed logical export, Storage export, private operational restore copy, and WORM set, or the quarterly ledger-backed restore drill has not passed in disposable restore-staging.
- The frozen release SHA has no signed iOS archive, external TestFlight/Beta Review pass, App Review approval, Australia storefront configuration, or manual-release/phased-release hold controlled by the release owner.
