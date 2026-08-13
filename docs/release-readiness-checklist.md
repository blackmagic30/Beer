# Pint Path Release-Readiness Test Checklist

This checklist adapts the external Pint Path test-pack assumptions to this repository. Synthetic automated tests may use the isolated SQLite fixture adapter, but SQLite is not an approved full-scale runtime. Production and permanent integrated staging require the reviewed shared Postgres adapter and must never receive synthetic reset/seed data.

## Railway mutation boundary (document-wide stop)

The repository now has protected, one-operation workflows for application
source upload, reviewed runtime/provider variables, the permanent-staging
Supabase cutover and Postgres build canary, bounded staging/production scale,
Postgres HA/PITR enable-and-verify, exact disposable-restore teardown, and the
one canonical production `pintpath.au` close/open state machine.
Each is executable only after its own protected approval, exact current-`main`
authority, and immediate `readiness:railway:mutation-boundary` preflight; its
tracked executor owns one exact write and unconditional postflight. The
standalone boundary and sealed-variable checks remain read-only evidence, not
mutation authority. Any other route/domain mutation, arbitrary service/resource/volume
changes, Railway-native restart/redeploy/rollback, and every unlisted mutation
remain non-executable. If the matching executor or any required authority is
unavailable, leave Railway unchanged; never substitute dashboard **Deploy**,
Git autodeploy, `railway run`, or an ad-hoc CLI/API command.

## Automated Local Gates

Run before any release candidate:

```bash
npm run check
npm run readiness:providers
npm run release:evidence
npm run security:audit
git diff --check
```

These pre-candidate commands run the build/test/security/deployment checks,
production-provider validation, non-strict evidence report, and dependency
audit. Pending live/provider/App Review items must remain visibly pending.
Reserve `npm run test:release:pintpath`, which includes
`release:evidence:strict`, for the final protected evidence gate after the exact
deployment and every required provider and human sign-off exist.

After each protected provider environment is configured, run this inside its
deployed service or a Railway one-shot deployment:

```bash
npm run readiness:launch
```

Require `readinessProfile=permanent_staging_complete` in permanent staging and
`readinessProfile=production_free_launch` in production. The strict gate also
requires platform project, environment, service, deployment, and replica
identity, so `railway run`, a local injected environment, or GitHub-hosted
duplicate application secrets are not evidence. It proves the actual service
configuration and treats provider warnings as blockers. See
`docs/launch-9-readiness-gates.md` for the manual evidence pack that local tests
cannot prove.

After the separate permanent-staging seal ceremony, run the metadata-only
external gate with its narrowly scoped project token loaded as
`PINTPATH_RAILWAY_METADATA_TOKEN`:

```bash
npm run --silent readiness:railway:sealed
```

Require its one receipt to report `policy=permanent-staging-post-rotation`,
`mode=post-seal`, `outcome=passed`, and
`checks.forbiddenVariablesAbsent=true`. The complete inventory must have no
`OFFSITE_BACKUP_SUPABASE_URL`, `OFFSITE_BACKUP_SERVICE_ROLE_KEY`, or
`OFFSITE_BACKUP_BUCKET` row, even if a row is blank or sealed. Then repeat the
strict deployed `readiness:launch` gate from a fresh post-seal deployment
created only by the reviewed executor. Never use
`railway run`, export resolved variables, or unseal a row for readiness.

Separately, before any Railway release or recovery mutation, load two distinct
environment-scoped project tokens as
`PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN` and
`PINTPATH_RAILWAY_STAGING_METADATA_TOKEN`, then run:

```bash
npm run --silent readiness:railway:mutation-boundary
```

Require `mode=read-only-boundary`, `outcome=passed`, and every check `true`.
The command proves both project tokens identify the expected single
environment, both undecrypted staged patches are empty, and the reviewed
production Postgres deployment, snapshot, source, and resolved image digest
remain bound. It does not execute or authorize a mutation. Railway Git autodeploy,
dashboard **Deploy**, and ordinary CLI redeploy remain disabled; a tracked
executor must repeat the boundary before and after its one closed operation.
The checked-in incident baseline is intentionally non-passing until the
production recovery and immutable-source reauthorization are separately
reviewed.

GitHub keeps these two signals deliberately separate:

- **Pint Path Automated Readiness** runs on pushes and pull requests. It proves the build, local release suite, security scan, dependency audit, and reports external evidence without claiming that evidence is complete.
- **Pint Path Release Gate** is a manual production-environment workflow. It runs the external permanent-staging sealed-variable metadata gate, strict authenticated production smoke checks, and `release:evidence:strict`. The separate sanitized deployed/one-shot provider-readiness receipts remain required external evidence; the workflow does not duplicate application secrets onto its GitHub runner.

The informational evidence command exits successfully when the evidence file is structurally valid, but its JSON keeps `launchReady: false` until every required sign-off passes. Its `incomplete` array names the accountable owner and exact next action for every open gate. Only the strict command is a launch gate.

Production rollout evidence is ordered rather than a set of same-SHA names.
The verifier binds exact successful attempt-one workflow runs,
start/completion timestamps, artifact IDs, immutable GitHub SHA-256 digests,
sizes, producer checks, and canonical receipts for deploy→two-replica
convergence→route close→protected promotion/recovery attestation→route open.
Each predecessor must complete before its consumer starts; all five rollout
stages share `pintpath-production-rollout` with `cancel-in-progress: false`. A later
close/open pair cannot repair an earlier out-of-order or one-replica release.

Release-evidence schema v3 binds every completed gate to one immutable production release ID and frozen 40-character candidate SHA and requires the SHA-256 of a gate-specific private manifest. The informational command reports stale live proof and code/worktree drift with `evidenceCurrent: false`; the strict gate refuses it. Future timestamps and structurally unsupported proof are invalid in both modes. This does not make human evidence automatic; it prevents a note, old timestamp, or unrelated commit from being mistaken for durable launch proof.

The thirteenth item, `permanent_staging_cost`, additionally requires the active
v2 binder's fresh combined receipt for the same frozen candidate. It binds
separate pre/post read-only provider exports; covers complete Railway, staging
Supabase, and staging external-provider inventories/caps; uses ceiling-rounded
integer USD cents; fails for any unknown, unpriced, shared, or unbounded
resource; and limits each phase to `4700` cents with `300` cents explicit
headroom below the `5000`-cent ceiling. Production operational-copy and
disposable-restore spend remain under distinct hashed authorities. The binder
does not collect provider state or authorize deployment; follow
`permanent-staging-cost-evidence.md` and keep this external gate pending until
authentic observations and independent approval exist.

Use the [external launch evidence checklist](external-launch-signoffs.md) for the ordered owner, command, pass/fail, stop-condition, and evidence checklist for all 13 required IDs.

Create a canonical, protected GitHub environment named `production`, then configure these environment secrets for both hourly user/venue monitoring and the manual gate:

```text
PINTPATH_SMOKE_USER_EMAIL
PINTPATH_SMOKE_USER_PASSWORD
PINTPATH_SMOKE_VENUE_EMAIL
PINTPATH_SMOKE_VENUE_PASSWORD
```

For the manual release gate only, also configure
`PINTPATH_RAILWAY_METADATA_TOKEN` as a Railway project token scoped to the exact
permanent-staging environment. It is used only for the fixed metadata query and
must not be an account/workspace token or an application variable.

Also configure the manual gate's two mutation-boundary secrets with separate
tokens scoped to their exact environments:

```text
PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN
PINTPATH_RAILWAY_STAGING_METADATA_TOKEN
```

Do not reuse one project-wide or account token for both. The boundary gate
rejects identical token material before making a request.

The scheduled workflow signs those dedicated verified accounts in through the public Supabase password flow, exchanges each provider session for a Pint Path session, checks the scoped endpoint, then revokes both the disposable Pint Path session and its current Supabase refresh session. Missing credentials are reported as a monitoring-configuration warning in a separate hourly job; they do not turn a passing public-health job into a false outage alert.

The authenticated job also receives protected `SUPABASE_URL` (exactly
`https://auth.pintpath.au`) and
`SUPABASE_ANON_KEY` environment values. The key must be the exact reviewed
`sb_publishable_...` value; legacy JWTs, `sb_secret_...` values, malformed
keys, and whitespace are rejected. Before sending a password, the job requires
the live public config to match that pinned provider origin and publishable key;
a mismatch fails closed without making a credential request. The release
workflow first runs `npm run supabase:keys:consumer-compatibility:check` without
secrets so a consumer or SDK drift cannot reach the authenticated steps.

Immediately before manually dispatching **Pint Path Release Gate**, also set this `production` environment secret:

```text
PINTPATH_SMOKE_ADMIN_TOKEN
```

The admin token must be a fresh Pint Path session created from a currently MFA-verified Supabase AAL2 admin session. Do not store an admin password or TOTP seed in Actions. The release gate revokes this one-use admin session after the check. Never commit credentials or print them in logs/evidence notes.

## Synthetic Data

Use only clearly marked synthetic data:

```bash
npm run test:seed:pintpath
npm run test:reset:pintpath
```

Both scripts refuse to run when `NODE_ENV=production` or when `PUBLIC_BASE_URL` points at `https://pintpath.au`.

## Covered By The Release Suite

- Anonymous users cannot upload beer-price data.
- Authenticated uploads are attached to the server-side authenticated user, not a client-supplied user id.
- Users cannot verify their own uploads.
- Users cannot list another user’s private submissions.
- Admin and analytics preview routes reject anonymous and normal users.
- Source evidence stays behind private references and signed URLs.
- Obvious localhost/private/metadata source-photo URLs are rejected before storage.
- The authenticated owner portal route path covers the current Free launch paths: login, assigned venue access, profile, beer/stock, support, cross-owner blocking, and pending-review state.
- Happy-hour collection and Pro-special branches remain covered as dormant/future regression paths. That coverage is not evidence that either feature is public in this release.
- Assigned venue managers publish profile and beer edits directly for their venue. Retained venue-side happy-hour collection follows the same internal workflow but remains absent from public web and iOS surfaces. Tier, code acceptance, and listing activation remain admin-controlled.
- A venue-wide fourth beer deletion within an hour is held for admin approval, even when multiple managers perform the earlier deletes.
- Pending venue changes are visible to the owning venue manager and admins, but not another venue manager.
- Rejected venue-manager changes do not publish.
- Basic venue tier remains analytics-locked after approved public data changes.
- Admin analytics buckets below `ANALYTICS_MIN_BUCKET_SIZE` are suppressed.
- Venue analytics hide suburb trends until the privacy floor is met.
- Analytics metadata redacts email, tokens, and precise location keys.
- Dormant/future monthly-report generation uses aggregate events and the Melbourne reporting timezone.
- Dormant/future report exports remain restricted to verified assigned Pro venue managers or admins.
- Report-delivery mocks test the future adapter without sending real email. They do not make reports part of the current launch.
- Supabase migrations keep source-evidence storage private and do not introduce `public.bars`.
- Public HTML smoke checks cover key pages and retired Twilio/ElevenLabs leakage.

## Release Blockers Not Fully Automated Locally

These are launch-critical but require provider/staging verification:

- **Railway sealed-variable closure:** Complete private-auth rotation first,
  capture a passing deployed permanent-staging strict-readiness receipt, seal
  only the 16 populated policy rows, capture the passing external metadata
  receipt, then capture a fresh deployed post-seal strict-readiness receipt.
  Missing/extra/shared-shadow rows, reference drift, an unsealed row, or use of
  `railway run` keeps this blocker open.
- **Railway mutation boundary:** Keep production and staging staged patches
  empty, disable Git autodeploy, replace mutable production database image
  authority with an independently approved immutable source, then use only the
  exact protected workflow implemented for the requested operation. The
  standalone read-only receipt cannot close this blocker or authorize an
  unlisted mutation by itself.
- **Permanent-staging cost ceiling:** Authorized finance/infra operators capture
  complete canonical pre/post read-only provider observations out of band, and a
  second verifier binds their exact hashes in the private manifest. Run the
  active credential-free binder to create the single combined version-2 receipt
  for the frozen candidate. It must prove at most `4700` integer USD cents
  observed across both phases and at least `300` cents headroom below the
  `5000`-cent ceiling. Any missing Railway/Supabase/external-provider row or
  unknown, unpriced, shared, or unbounded resource keeps launch blocked. The
  receipt is a post-deployment release gate and cannot authorize deployment.
- **Supabase OAuth:** Google provider credentials, web redirect URLs, the provider callback, and email-confirmation behavior must be verified. Supabase should allow `https://pintpath.au/auth/callback`; the Google console should allow the callback derived from `SUPABASE_URL`, for example `https://auth.pintpath.au/auth/v1/callback`. Set `SUPABASE_OAUTH_PROVIDERS=google` and prove Apple is disabled. The first-release iOS app is email/password only, declares no custom URL scheme, and uses the HTTPS callback for email confirmation/password recovery.
- **Supabase Auth security:** Enable leaked-password protection before public launch.
- **Supabase live access audit:** Apply the final Data API retirement migration, then prove live that `anon` and `authenticated` have zero privileges on public tables, sequences, RPCs, and private helpers. RLS remains defence in depth; only the Express service, using its server-only service role, may access application data. Local SQL parsing is not a substitute for live privilege and denial proof.
- **Supabase database version:** Confirm the live project is not on deprecated Postgres 14 before launch.
- **Supabase Data API retirement:** Prove direct PostgREST/Data API reads, writes, RPCs, and storage-object access are denied to ordinary clients while the documented Express API paths still work. Future migrations must not add public grants unless a separately reviewed access contract explicitly reintroduces them.
- **Storage bucket live audit:** Verify `beermap-source-evidence` is private, has the intended file-size/MIME limits, and has no direct `anon` or `authenticated` object policies. Prove ordinary clients are denied and only the server-authorized API/admin signed-URL paths work.
- **Shared application Postgres:** Implement and exercise the reviewed
  Postgres persistence adapter before candidate freeze. Permanent staging and
  production must use a least-privilege pooled TLS `DATABASE_URL`, at least two
  application replicas, shared Redis, migration/reconciliation proof, and a
  Postgres-compatible rollback build. A mounted SQLite file is migration input
  only and fails this gate.
- **Google Maps Map ID:** Create a JavaScript/vector Map ID in Google Maps Platform, set `GOOGLE_MAPS_MAP_ID`, and verify AdvancedMarkerElement markers render on staging.
- **Stripe/pricing:** Keep `COMMERCIAL_LAUNCH_ENABLED=false` and
  `CONSUMER_PAID_ENROLLMENT_ENABLED=false` for this release. Stripe values may
  remain absent; prove no current amount, checkout, trial, upgrade, or enrolment
  action is public. Test-mode lifecycle proof and the smallest-value live canary
  belong to a future commercial candidate after pricing is approved; do not
  enable a flag or make a charge for this free launch.
- **Report email:** Keep `REPORT_EMAIL_MODE=disabled` and `REPORT_DELIVERY_SCHEDULE_ENABLED=false` for this Free venue launch, and prove no report is sent or advertised. Provider-delivery proof belongs to a future Pro/commercial release candidate. This does not replace the separate current-launch account-deletion completion-notice evidence below.
- **Account-deletion completion notice:** Configure a dedicated Resend sending-only key, verified sender/reply-to, 32-byte recipient-encryption keyring, and signed webhook for `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`. Set `ACCOUNT_DELETION_REHEARSAL_ENABLED=true` only for the sacrificial proof in permanent integrated Railway staging and prove it is `false` or absent in production. The reviewed expected Railway/Supabase identity pins must match, Postgres and shared staging Redis must be active, and at least two replicas must participate. Verify delivery and audited terminal-resolution purges, the 30-day post-completion limit, the 60-day pre-completion held cap, invalid/replayed and out-of-order events, failure handling, restart/worker overlap, the pre-24-hour uncertain-send cutoff, and restored-tombstone suppression.
- **Redis rate limiting:** Full-scale production and permanent integrated staging must use `REDIS_URL`, a distinct environment namespace, and `REQUIRE_REDIS_RATE_LIMITING=true`; in-memory fallback is preview/local only. Run the two-replica staging outage drill so protected traffic and readiness fail closed when staging Redis is unavailable.
- **DAST/mobile E2E:** Do not run dynamic scanners against production. Run any ZAP/Lighthouse/Playwright mobile pass only against local, preview, or staging.
- **Backups/restore:** Before full-scale launch, capture Postgres PITR plus
  logical, private Storage/evidence, and deletion-tombstone exports into the
  separately administered WORM authority. Retrieve and restore the exact set
  into newly created ephemeral destructive restore staging, prove RPO/RTO and
  application invariants, then destroy every recorded disposable resource.

## Manual Staging Smoke

- Open the public map logged out and confirm no admin/debug/provider legacy content is visible.
- Confirm free users see only the fixed pint previews for Guinness, Carlton
  Draught, and Stone & Wood Pacific Ale; no public happy-hour filter, card,
  badge, promotional claim, submission mode, or special-price detail appears.
- Log in, submit a beer price and source photo, and confirm it is pending.
- Confirm another user cannot see that raw submission/evidence.
- Approve the submission as admin and confirm the normalized price appears on the map.
- Assign a venue manager and confirm ordinary profile and beer edits publish directly for that assigned venue. Exercise the retained venue-side happy-hour collection field, but prove it creates no public happy-hour record, filter, mission, contribution path, SEO claim, or iOS surface. Then trigger a documented safeguard/restricted change, confirm it stays pending, approve it as admin, and confirm only the approved guarded change publishes.
- Prove Pro, report, special, checkout, counter, reward, and POS surfaces are unavailable in the current web and iOS release, and that scheduled report delivery remains disabled.
