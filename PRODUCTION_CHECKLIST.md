# Pint Path Production Checklist

> For the current full web plus iOS launch, follow
> [`docs/production-launch-runbook.md`](docs/production-launch-runbook.md) in
> order. The launch runbook is controlling where this older checklist differs.

Use this for a full production release. For smaller private beta releases, also use `FIELD_TEST_CHECKLIST.md` and `DEPLOYMENT_CHECKLIST.md`.

Provider-specific setup lives in [docs/provider-configuration-runbook.md](/Users/zac/Desktop/Beer/docs/provider-configuration-runbook.md).

## Pre-Deploy Checklist

- Confirm branch and release scope with `git status --short --branch`.
- Confirm no production data is used in local tests.
- Confirm no `.env`, `viewer/config.js`, SQLite DB files, exports, uploads, evidence files, or reports are staged.
- Run:
  - `npm ci`
  - `npm run build`
  - `npm test`
  - `npm run check`
  - `npm run readiness:providers`
  - `npm run readiness:launch` once production env is configured
  - `npm run security:scan`
  - `npm run security:audit`
  - `git diff --check`
- Confirm `npm audit --audit-level=high` reports zero high-severity vulnerabilities.
- Confirm `/config.js` exposes only browser-safe values.
- Confirm public map exact-price reads go through Express `/api/business/*`, not direct unrestricted browser Supabase reads.
- Confirm assigned managers publish ordinary profile and beer/price edits directly. Retained venue-side happy-hour collection must create no public discovery, mission, contribution, SEO, or iOS surface. Restricted fields and safeguard-triggered changes create pending review records and do not publish until approved.
- Confirm `ROLE_PERMISSION_MATRIX.md` matches intended product behavior.
- Confirm `SECURITY.md`, `PROD_READINESS_REPORT.md`, and `PROD_FOLLOWUPS.md` are current.
- Confirm `docs/launch-9-readiness-gates.md` has current provider, owner-journey, monitoring, performance, accessibility, and legal evidence.
- Complete every step in the [external launch evidence checklist](docs/external-launch-signoffs.md); its 12 IDs map one-for-one to `docs/release-evidence.json`.
- Confirm cookie/analytics consent banner appears in a fresh browser and optional analytics remain off until the user chooses or saves signed-in privacy settings.

## Required Production Environment

- `NODE_ENV=production`
- `PUBLIC_BASE_URL=https://pintpath.au`. The current production validator intentionally rejects preview domains and alternate canonical hosts.
- Supabase Auth Site URL is `https://pintpath.au`; allow exact web callbacks `http://localhost:3000/auth/callback` and `https://pintpath.au/auth/callback`. Allow `pintpath://auth-callback` only if Android native OAuth is released. The first-release iOS archive declares no custom URL scheme and uses the HTTPS callback for email confirmation/password recovery.
- `SUPABASE_OAUTH_PROVIDERS=google`; launch web OAuth is Google-only. Keep Apple disabled until authorization-token revocation is implemented and tested.
- `COMMERCIAL_LAUNCH_ENABLED=false` and `CONSUMER_PAID_ENROLLMENT_ENABLED=false`; new paid enrolment remains deferred until the controlling launch runbook's independent approval.
- `DATABASE_PATH` points to a persistent Railway volume path.
- Keep `TRUST_PROXY_HOPS=1` on Railway for forwarded scheme/host handling; security identity uses Railway's platform-provided `X-Real-IP`, not a variable-length proxy hop count. Do not use the obsolete `TRUST_PROXY` variable.
- `ADMIN_EMAILS` is set to the exact admin owner email list before enabling admin access. If the official ABN/admin email is pending, leave it blank and confirm admin routes return `403`.
- `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true`.
- `ADMIN_MFA_MAX_AGE_MINUTES=720` or a stricter value.
- `REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true`.
- `GOOGLE_MAPS_API_KEY` is set and HTTP-referrer restricted to the live domain.
- `GOOGLE_MAPS_MAP_ID` is set to a JavaScript/vector Map ID from Google Maps Platform.
- `GOOGLE_PLACES_API_KEY` is set as a server-only key restricted to Places/Geocoding APIs.
- `OPENAI_API_KEY` is set as the server-only menu-evidence extraction key.
- `REPORT_TIMEZONE=Australia/Melbourne`.
- Keep `REPORT_EMAIL_MODE=disabled` and `REPORT_DELIVERY_SCHEDULE_ENABLED=false` throughout this venue-Free release. Monthly-report delivery belongs to a later Pro/commercial candidate and must not be advertised or enabled here.
- Set `ACCOUNT_DELETION_NOTICE_MODE=resend` with a dedicated sending-only `RESEND_TRANSACTIONAL_API_KEY`, verified sender/reply-to, recipient-encryption keyring, and signed webhook subscribed to `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`.
- Set `ACCOUNT_DELETION_REHEARSAL_ENABLED=true` only for the sacrificial drill in the isolated Railway `staging` environment. Leave it `false` or absent in production.
- `REDIS_URL` is set to Railway Redis/Upstash/managed Redis. Do not use `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true` except for a time-boxed emergency beta.
- `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false` for normal production. If it is ever set to `true`, record the incident reason, owner, expiry time, and rollback plan.
- `SOURCE_EVIDENCE_SIGNING_SECRET` is a unique 32+ character random secret.
- `SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS=300` or shorter for production.
- `POS_WEBHOOK_SIGNING_SECRET` is absent; counter/POS is outside this release and its webhook fails closed. Require a different unique 32+ byte secret only in a later approved POS candidate.
- `DEMO_BILLING_MODE=false` unless a private beta intentionally enables demo billing with `ALLOW_DEMO_BILLING_IN_PRODUCTION=true`.
- `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false`.
- Keep `COMMERCIAL_LAUNCH_ENABLED=false` and `CONSUMER_PAID_ENROLLMENT_ENABLED=false` for this deferred-pricing launch; Stripe values may remain absent. Enabling either paid flag makes all five Stripe values mandatory at startup.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are all required in production for provider-backed authentication and private evidence storage. The service-role key stays server-side and is never exposed in public config.
- `OFFSITE_BACKUP_SUPABASE_URL` and `OFFSITE_BACKUP_SERVICE_ROLE_KEY` point to a separate operational-copy project, not the production Supabase origin. This is not the required immutable disaster-recovery proof; also provide a separate-provider/region WORM/object-lock copy whose application writer cannot overwrite, delete, or shorten retention.
- `OFFSITE_BACKUP_BUCKET=pintpath-backups`, with the configured interval and retention reviewed against the release RPO.
- Supabase Auth leaked-password protection is enabled.
- Supabase live project is not on deprecated Postgres 14.
- `ANALYTICS_MIN_BUCKET_SIZE` is at least `5`; use a higher value for paid venue analytics if needed.

## Database And Migration Checklist

- Back up the production SQLite database or Railway volume before deploy.
- Confirm schema changes are additive and do not drop/delete production data.
- Confirm `src/db/schema.sql` contains any new tables/indexes needed by the release.
- Confirm the app can initialize a fresh local database from `src/db/schema.sql`.
- Apply and review every migration in `supabase/migrations/`; canonical app reads/writes remain Express/service-role only.
- Run `ops/supabase/independent-backup-project-storage.sql` only against the separate backup project; the production migration chain must not create `pintpath-backups`.
- Confirm the final retirement migration leaves `anon` and `authenticated` with zero public table, sequence, RPC, and private-helper privileges. RLS remains defense in depth; do not add a browser Data API grant without a separate reviewed access contract.
- Confirm live denial for anonymous, ordinary authenticated, and a captured pre-deletion JWT across Data API/RPC/Storage while the intended Express paths work.
- Confirm the private Supabase Storage bucket `beermap-source-evidence` exists, is not public, has no direct `anon`/`authenticated` object policies, and is accessed only through the server-authorized evidence API.
- Confirm source evidence review links are generated by the Express API and expire after the configured TTL.
- After deploy, call `/ready` to initialize DB-backed routes before real traffic.

## Deploy Checklist

- Build the exact commit that will be deployed.
- Confirm Railway/start command is `node dist/src/server.js`.
- Confirm startup logs do not print secrets.
- Confirm `/health` returns success.
- Confirm `/ready` returns success.
- Confirm retired call automation endpoints are not mounted and no phone-call provider secrets are configured.
- Confirm demo billing and demo image storage production overrides are false unless intentionally time-boxed.

## Post-Deploy Verification Checklist

- Open the public site logged out.
- Confirm map loads and no admin/debug UI is visible.
- Open several venues and confirm anonymous users always receive the fixed free preview while non-preview prices stay redacted.
- Directly request `/api/business/price-records` logged out and confirm happy-hour and special rows are absent, only the named preview-beer pint prices are exact, and every other ordinary price is redacted.
- Sign in to the web with Google as a normal test user; separately test iOS email/password confirmation and recovery against the same Supabase identity.
- Confirm 18+ flow.
- Confirm uploads require login and store the authenticated user, not a client-supplied user id.
- Confirm users cannot verify their own uploads.
- Confirm signed-in Account can download an export that includes retained exact upload-location fields while they still exist, clearly discloses that retention, and excludes raw evidence bytes/URLs, raw tokens, and passwords.
- Confirm signed-in Account page can create an account deletion-review request and that the request appears in the admin support/feedback queue as high priority.
- In isolated staging, prove a completed deletion queues one notice and purges recipient ciphertext on verified delivery or an audited terminal resolution. Prove the 30-day post-completion hard limit, the 60-day pre-completion held cap, and signed-webhook rejection, replay, and event-order handling before launch.
- Confirm repeated venue opens do not widen the fixed free preview or expose the full catalogue.
- Submit venue data and confirm it is pending.
- Log in as admin and approve/reject a submission.
- Confirm points are awarded only after approval.
- Confirm approved data publishes to the map.
- Log in as venue manager and submit ordinary profile/beer edits, exercise the retained internal happy-hour collection field, and trigger one restricted or safeguard-protected change.
- Confirm ordinary assigned-venue edits publish directly, the retained happy-hour data remains non-public, and the restricted/safeguard change stays pending and absent from public map/API until admin approval.
- Confirm another venue manager cannot view or approve that pending guarded change.
- Confirm Free venue managers see no Pro/trial/checkout/report/special/counter surface and `/config.js` exposes `pricing: null`, both paid flags false, and trial days `0`.
- Confirm monthly report delivery is disabled and no report email is advertised or sent. Keep dormant report and Stripe regression coverage local; provider lifecycle proof belongs to a future commercial candidate.
- Confirm `/api/calls`, `/api/results`, and `/webhooks/*` are disabled/not found.
- Confirm source photo inline storage is rejected in production.
- Confirm security audit rows are created for admin review, venue-manager assignment, billing grants, and webhook failures.
- Confirm mobile Safari/Chrome smoke test: map, venue details, submit data, account, venue portal.
- Open `/status.html` and confirm outage/security/privacy reporting copy and provider verification steps are visible.

## Monitoring And Alerting Checklist

- Configure Railway/app uptime monitoring for `/health` and `/ready`.
- Before deployment, record the incident owner and on-call escalation contact in the private operations system; do not commit personal contact details to this repository.
- Target beta RPO: `24 hours` until provider PITR is verified. Target beta RTO: `4 hours` until restore drill is proven.
- Configure automated Railway volume/database backup and alert if the newest backup is older than the agreed RPO.
- Run one staging restore drill before full-scale public launch and record the date/commit/source backup.
- Alert on 5xx rate spikes.
- Stripe/report alerts become required only in a future candidate that enables those features.
- Alert on repeated login failures/rate limits.
- Alert on admin review, venue-manager assignment/revoke, and user status override events if possible.
- Alert on Redis/rate-limiter connection failures; production should fail closed rather than silently bypassing limits.
- Monitor database file/volume size and backup age.
- No phone-call automation provider monitoring is required because that product surface is retired.
- Preserve enough logs for incident response without logging secrets, raw source photos, or exact user locations.

## Rollback Checklist

- Identify previous known-good production commit.
- If the release was a merge commit, use `git revert -m 1 <merge_sha>`.
- If the release was fast-forwarded, revert the problematic commit range or redeploy the previous Railway SHA.
- Disable risky features quickly with env:
  - `DEMO_BILLING_MODE=false`
  - `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false`
  - `FIELD_TEST_MODE=false`
  - `ACCOUNT_DELETION_REHEARSAL_ENABLED=false`
- Keep both paid-enrolment flags `false` during rollback so absent Stripe configuration remains valid and checkout stays closed. If either paid flag is enabled, preserve all five Stripe values or roll back to a release/configuration with paid enrolment disabled.
- If schema/data is impacted, stop the app, restore the pre-deploy DB backup, then redeploy the previous commit.
- After rollback, verify `/health`, `/ready`, map load, account login, admin access, and price gating.

## Go / No-Go Criteria

Go only if:
- All required checks pass.
- No P0 blocker in `PROD_FOLLOWUPS.md` remains unresolved or unaccepted.
- Production secrets are configured provider-side and not committed.
- `NODE_ENV=production npm run readiness:providers` passes before public traffic.
- `npm run readiness:launch` passes with zero failures and zero blocking warnings before broad public traffic.
- Backups and rollback path are verified.
- Supabase/Auth/Storage/Data-API denial tests pass in isolated staging; both paid-enrolment flags remain false and no Stripe lifecycle is required for this free release.

No-go if:
- Any exact-price API leaks unrestricted prices.
- Any normal user can access admin or another venue's private data.
- Restricted or safeguard-triggered venue-manager changes publish without approval.
- Upload evidence is publicly exposed or stored inline in production without an explicit temporary exception.
- Stripe webhooks accept unsigned payloads outside demo mode.
- Admin MFA/compensating control is absent for a public full-scale launch.
