# Pint Path Release-Readiness Test Checklist

This checklist adapts the external Pint Path test-pack assumptions to this repository. Synthetic automated tests may use the isolated SQLite fixture adapter, but SQLite is not an approved full-scale runtime. Production and permanent integrated staging require the reviewed shared Postgres adapter and must never receive synthetic reset/seed data.

## Railway mutation boundary (document-wide stop)

The repository now has protected, one-operation workflows for application
source upload, reviewed runtime/provider variables, the permanent-staging
Supabase cutover and Postgres build canary, bounded staging/production scale,
Postgres HA/PITR enable-and-verify, exact disposable-restore teardown, the
four-job post-promotion recovery activation, and the one canonical production
`pintpath.au` close/open state machine.
Each is executable only after its own protected approval, exact current-`main`
authority, and immediate `readiness:railway:mutation-boundary` preflight; its
tracked executor owns one exact write and unconditional postflight. The
standalone boundary and sealed-variable checks remain read-only evidence, not
mutation authority. Any other route/domain mutation, arbitrary service/resource/volume
changes, Railway-native restart/redeploy/rollback, and every unlisted mutation
remain non-executable. If the matching executor or any required authority is
unavailable, leave Railway unchanged; never substitute dashboard **Deploy**,
Git autodeploy, `railway run`, or an ad-hoc CLI/API command.

Permanent-staging provider mutation, application deployment, legacy-key
cutover, and general permanent-staging runtime-variable writes share one
`pintpath-permanent-staging-key-rollout` group with `queue: max` and
`cancel-in-progress: false`, retaining and fully serializing every queued run.
Provider mutation is history-guarded by exact candidate+operation and cutover by
exact candidate through `github:reviewed-candidate-authority:verify`. Complete
authenticated history must span the associated PR's `merged_at` through the
authenticated current `run_started_at`, not its `created_at`, because retained
queued runs can start out of creation order. That `run_started_at` must be no
more than 168 hours after `merged_at`. Beyond seven days or with incomplete
history, create a newly reviewed and merged candidate. After matching prior
runs, a fresh dispatch requires every exact write step to be authenticated with
conclusion `skipped`; this is the only `skipped-before-write` retry case. General
runtime-variable writes use the same
authority keyed by candidate+target+variable and allow no prior matching run,
including one skipped before write.

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
Commit #51 refreshed the checked-in baseline with the exact production
Postgres deployment, snapshot, immutable source, and resolved digest. It is
pass-capable only while live provider state matches those pins; any later drift
requires separate review and exact reauthorization rather than a permissive
policy edit.

GitHub keeps these two signals deliberately separate:

- **Pint Path Automated Readiness** runs on pushes and pull requests. It proves the build, local release suite, security scan, dependency audit, and reports external evidence without claiming that evidence is complete.
- **Pint Path Release Gate** is a manual production-environment workflow. It runs the external permanent-staging sealed-variable metadata gate, strict authenticated production smoke checks, and `release:evidence:strict`. The separate sanitized deployed/one-shot provider-readiness receipts remain required external evidence; the workflow does not duplicate application secrets onto its GitHub runner.

The informational evidence command exits successfully when the evidence file is structurally valid, but its JSON keeps `launchReady: false` until every required sign-off passes. Its `incomplete` array names the accountable owner and exact next action for every open gate. Only the strict command is a launch gate.

Permanent-staging rollout requires exactly two successful workflow-dispatch
deployments of the same current protected-main candidate: the fenced
zero-replica upload and the active one-replica closeout. Both complete before the scale run starts;
the verifier selects the second deployment and rejects any other count or
ambiguous completion order.

Production rollout evidence is ordered rather than a set of same-SHA names.
The verifier binds exact successful attempt-one workflow runs,
start/completion timestamps, artifact IDs, immutable GitHub SHA-256 digests,
sizes, producer checks, and canonical receipts for deploy→two-replica
convergence→route close→protected recovery activation→promotion/recovery
attestation→route open. Each predecessor must complete before its consumer
starts; all six rollout
stages share `pintpath-production-rollout` with `cancel-in-progress: false`. A later
close/open pair cannot repair an earlier out-of-order or one-replica release.

The activation contract is policy v2 SHA-256
`57f66c1c9dde912586ec510e37c28cc3dfea2c098e67c78edbea189c7dcc9988`.
It runs `production-capture` on the JIT `pintpath-production-backup` label,
`disposable-recover` on the separate JIT `pintpath-disposable-recovery` label,
an independent `if: always()` cleanup job, then `finalize`. PITR is observed in
capture. Logical and private recovery-bundle WORM objects are read separately
on the disposable network. The exact compiled candidate runs as a local child
there against disposable Postgres, Redis, Supabase Auth, and private Storage.
No raw recovery byte crosses a GitHub artifact. Require exactly 18 evidence
leaves and exactly 20 final activation files.

Before approving capture, dispatch and hold the protected activation, record
its assigned `GITHUB_RUN_ID`, then create, sign, independently verify, and
install the singleton emergency arm plus both exact-run teardown authorities
in the non-interactive cleanup environment, then publish the arm through the
protected manager's dedicated-ref compare-and-swap. An OPEN state mechanically
rejects a second run; same-target linked renewal prevents expiry from stranding
cleanup. Both provider cleanup steps remain independent. Supabase
`cleanupMode=orderly` must bind the exact Storage purge receipt for green;
emergency cleanup never greens the chain. Use standard cancel only, and forbid
force-cancel until independent observations prove Railway and Supabase absent.
The completion/15-minute/manual watchdog retries outside the activation run
while the state is OPEN and cannot green activation. It persists exact delete
acknowledgements across runs but requires a fresh absence proof before
reconciliation. Railway workspace absence without an
exact delete acknowledgement is transfer-ambiguous; keep ARMED and reconcile
provider-global state.
Create the version-2 authority and both distinct approvals only after final
activation. Its `recoveryStartedAt` is immutably copied from the GitHub
activation workflow's `run_started_at`, never a reviewer-selected timestamp.

Release-evidence schema v4 binds every completed gate to one immutable
production release ID, the separately fetched PR-head SHA, and the exact current
protected-main merge candidate SHA. Human pull-request approval is not release
authority for this solo-owner repository. The verifier instead requires one
exact merged, non-draft, same-repository PR, its exact protected-main merge
commit, one-parent linear history, and reviewed-head/candidate Git-tree equality.
The two commits may be non-ancestral after a squash/rebase merge; only the
protected-main candidate anchors the later evidence-only closeout lineage. Each gate also requires the
SHA-256 of its private manifest. The informational command
reports stale live proof and code/worktree drift with `evidenceCurrent: false`;
the strict gate refuses it. Future timestamps and structurally unsupported proof
are invalid in both modes.

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

Despite the compatibility name, this secret must contain the raw value from one exact host-only `pint_path_session` cookie created from a currently MFA-verified Supabase AAL2 admin session. The smoke script sends it only in the `Cookie` header, never as a bearer. Do not store an admin password or TOTP seed in Actions. The release gate revokes this one-use admin session after the check. Never commit credentials or print them in logs/evidence notes.

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
  empty, disable Git autodeploy, preserve the independently approved immutable
  production database image authority, then use only the exact protected
  workflow implemented for the requested operation. The
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
- **Supabase Auth security:** Enable leaked-password protection before public launch. Prove browser access/refresh tokens never enter localStorage, sessionStorage, a fixed SDK BroadcastChannel, logs, or ordinary Pint Path requests. Exercise the server-bound sensitive-action email link for a Google-only account with exact cookie/account/purpose binding, `shouldCreateUser:false`, expiry/replay denial, MFA step-up, and no identity/provider downgrade. Prove production admin access rechecks the authoritative verified-factor list and fails closed after factor removal or provider lookup failure.
- **Supabase live access audit:** Apply the final Data API retirement migration, then prove live that `anon` and `authenticated` have zero privileges on public tables, sequences, RPCs, and private helpers. RLS remains defence in depth; only the Express service, using its server-only service role, may access application data. Local SQL parsing is not a substitute for live privilege and denial proof.
- **Supabase database version:** Confirm the live project is not on deprecated Postgres 14 before launch.
- **Supabase Data API retirement:** Prove direct PostgREST/Data API reads, writes, RPCs, and storage-object access are denied to ordinary clients while the documented Express API paths still work. Future migrations must not add public grants unless a separately reviewed access contract explicitly reintroduces them.
- **Storage bucket live audit:** Verify `beermap-source-evidence` is private, has the intended file-size/MIME limits, and has no direct `anon` or `authenticated` object policies. Prove ordinary clients are denied and only the server-authorized API/admin signed-URL paths work.
- **Shared application Postgres:** Implement and exercise the reviewed
  Postgres persistence adapter before candidate freeze. Permanent staging and
  production must use a least-privilege pooled TLS `DATABASE_URL`, at least two
  application replicas, shared Redis, migration/reconciliation proof, and a
  Postgres-compatible rollback build. Require the strict post-transition pool
  contract: runtime 2/process with LOGIN limit 8, separate maintenance work and
  readiness pools of 1/process each with LOGIN limit 8, four-process rolling
  overlap, 16 application sessions, and
  separately measured provider/reserved/non-app headroom. Require every accepted
  permanent-staging load report to validate the three fixed labeled pool metric
  shapes on each `/ready` sample and in a bounded post-load sweep across every
  exact frozen replica hash under one unchanged deployment identity, with zero
  instantaneous waiters, zero monotonic capacity-wait
  events/high-water/duration, and a retained minimum available-connection count
  per label.
  The candidate may retain the exact 2-or-8 rollout compatibility needed to
  deploy safely while workers are fenced, but the protected transition must
  prove the maintenance LOGIN changed from 2 to 8 before worker activation or
  scale. An incomplete fence→deploy→role→activate→scale chain, or a live limit
  of 2 at scale, fails this gate. A mounted SQLite file is migration input only
  and fails this gate.
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
  logical, private Storage/evidence, and deletion-tombstone exports into their
  separately administered WORM authorities. Retrieve the logical and private
  WORM sets independently into newly created ephemeral destructive restore
  staging, restore them, replay deletion twice, and run the compiled candidate
  locally on the exact disposable private network. Prove RPO from the captured
  recovery point and RTO from immutable GitHub activation `run_started_at` to
  application readiness. Purge restored Storage, require orderly Supabase
  cleanup, and retain independent Railway/Supabase absence terminals before
  finalization. The checked-in path is not live evidence; any missing authentic
  provider receipt remains a launch no-go.

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
