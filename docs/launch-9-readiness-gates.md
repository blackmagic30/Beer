# Pint Path Full-Scale Launch Readiness Gates

This is the evidence pack for the first full-scale public web and iOS release. The release is Free-only: pricing, paid enrolment, trials, Pro features, rewards, counter/redemption/POS flows, public happy-hour discovery, monthly-report delivery, and Android are deferred. There is no beta exception or owner acceptance path around a failed gate.

## Current hard blockers

The Free-live PostgreSQL implementation is complete. Permanent staging now has
pinned Postgres, Supabase/Auth/private Storage, and Redis resources; its
synthetic import, restricted runtime proof, direct logical backup, and the
matching disposable-database restore receipt are verified. A dedicated
production Postgres service is provisioned but is empty, detached from the live
Beer service, and not serving traffic. Production therefore remains on SQLite
until the controlled cutover.

Pint Path remains no-go. Before candidate freeze, finish and review every
implementation and exact execution plan below. After the protected merge,
execute the live provider and permanent-staging gates against the exact current
protected-`main` merge SHA, recorded as `candidateSha`, before production
deployment. Separately fetch the associated `reviewedPrHeadSha`, require exact
tree equality without ancestry, and authenticate the unique merged, non-draft,
same-repository PR plus its exact protected-`main` merge commit and linear
history. Human PR approval is not required by the solo-owner branch policy:

Every Railway create, configuration, variable, scale, deploy, rollback, PITR,
route, delete, destroy, or teardown operation in these gates requires a tracked
one-operation executor that owns the
immediate `readiness:railway:mutation-boundary` preflight, one exact reviewed
operation, and unconditional postflight.
Its standalone receipt is read-only; commit #51 made the immutable baseline
pass-capable only while every live provider observation matches its exact
pins. A passing receipt does not authorize a mutation. Restore-staging teardown
additionally requires complete
resource/evidence reconciliation, specific authorization naming the exact
resource IDs, and the exact reviewed teardown executor. Signed evidence or
two-person sign-off alone is not mutation authority.

Provider mutation, application deployment, Supabase legacy cutover, and general
permanent-staging runtime-variable writes share
`pintpath-permanent-staging-key-rollout` with `queue: max` and
`cancel-in-progress: false`, retaining every queued run for full serialization.
The provider-mutation run guard is keyed by exact candidate+operation and the
cutover guard by exact candidate through
`github:reviewed-candidate-authority:verify`. Require complete authenticated
history from the associated PR's `merged_at` through the authenticated current
`run_started_at`, not its `created_at`, because retained queued runs can start
out of creation order. That `run_started_at` must be no more than 168 hours after
`merged_at`. Beyond seven days or with incomplete history, create a newly
reviewed and merged candidate. A later fresh dispatch is eligible only when each
prior matching run's exact write step is authenticated with conclusion
`skipped`; this is the only
`skipped-before-write` retry case. General runtime-variable writes use the same
reviewed authority keyed by candidate+target+variable and reject every matching
prior run, including one skipped before write.

1. First deploy the exact candidate to permanent staging and retain its initial
   successful artifact. Then execute and retain evidence from the protected
   workflows for the three
   Google/OpenAI provider categories, comprising four exact
   Railway variable operations: Google Maps client configuration
   (`GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_MAP_ID`), Google Places server access
   (`GOOGLE_PLACES_API_KEY`), and OpenAI menu OCR (`OPENAI_API_KEY`). Separately,
   the two permanent-staging Supabase replacement-key variables
   (`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`) use one protected
   atomic Railway upsert. After every planned provider/runtime operation,
   deploy the exact same current-`main` build once more and retain this second,
   closeout artifact;
   prove all server, browser, mobile, CI, scheduled, webhook, backup, and
   archived consumers plus Auth, admin, role, private Storage, provider, and
   Free-scope behavior. Only then run the protected replacement-canary/
   legacy-disable/old-key-denial workflow with the exact replacement and later
   deployment run IDs. The old
   fixed-blocked CLIs and fixture policies are superseded and are not operator
   paths. Historical operational-copy
   attestation and a staging database-bound probe ran under the prior coupled
   contract; they are not current staging readiness. The production-copy URL,
   key, and bucket variables are prohibited in permanent staging by the current
   candidate, and a fresh complete Railway inventory must independently prove
   all three names deleted before remediation passes. No new staging off-site
   transport is authorized.
2. Pass real provider/Auth/role/private-Storage/Free-scope smoke and run the
   protected Postgres build-canary workflow. Require exactly the initial and
   closeout successful deployment runs for the same candidate, both completed,
   and select the second; any other count or ambiguous order is a hard stop.
   Only then use the protected scale workflow to move the same build temporarily
   from one to two replicas for concurrency, queue/
   outbox, idempotency, load/soak, restart, rolling-deploy, rollback, and pool-
   headroom proof; return staging to one replica afterward.
3. Run the protected exact-target Railway Postgres-HA PITR enable/verification
   workflow after its provider-safe HA placement preflight. The operator
   selects only production or permanent staging; the corresponding protected
   GitHub environment pins the expected HA root, which must equal the one root
   independently discovered from the complete provider inventory before any
   write. Then test a usable recovery point; have the independent recovery
   administrator provision
   and exercise the implemented AWS S3 Object Lock WORM authority; and extend
   the existing disposable database restore through later WORM retrieval,
   Storage/tombstones, application smoke, deletion replay, signed RPO/RTO, and
   safe teardown through the protected exact-inventory disposable-project
   workflow. Executable repository paths do not replace live provider receipts,
   restore proof, RPO/RTO approval, or external IDs.
4. Complete reviewed-data promotion, production snapshot/import/reconciliation,
   post-import and post-promotion recovery sets, monitored Postgres cutover, and
   the coordinated web/iOS release sequence.

The checked-in permanent-staging target is one Beer replica at 0.1 vCPU/0.25
GB, Postgres at 0.1 vCPU/0.25 GB with a 10 GB maximum volume, and Redis at 0.05
vCPU/0.1 GB. It allocates at most US$20 to the isolated Railway workspace,
US$25 to one isolated Supabase Pro/Micro project, and US$2 across staging
external providers, leaving US$3 explicit headroom below the US$50 ceiling.
Those are repository planning targets, not claims about live provider state.

The active credential-free validator binds authentic pre/post read-only export
observations for the frozen candidate. Each must report zero unknown, unpriced,
shared, or unbounded resources, respect every provider cap, total at most
`4700` integer USD cents, and keep production operational-copy and disposable
restore under separate hashed authorities. One combined v2 receipt is the
post-deployment release gate; it cannot authorize deployment and it does not
replace provider-owner evidence. Follow
`permanent-staging-cost-evidence.md`. The item remains pending until that live
evidence exists.

The exact external-provider source inventory spans
Dynamic Maps, Directions Legacy, Geocoding, Text Search Pro/Enterprise, Nearby
Search Enterprise, and Place Details Enterprise, but Google does not document
a monthly hard quota for every surface and warns that quota and billing meters
can differ. OpenAI OCR now uses no SDK retries, finite `high` image detail, and
an 8,192-output-token cap, and rejects model overrides outside the reviewed
`gpt-5.6-sol`/`gpt-4.1` allowlist; monthly call reservations, bounded PDF/input
tokens, and a documented hard-limit overshoot maximum are still absent in the
live environment. The candidate cost-bound path pins
`gpt-4.1-mini-2025-04-14`, forbids PDFs/discovery OCR, and reserves five cents
per attempt in shared state up to US$1 in every rolling 31-day window, but it still needs the
labelled benchmark, current price/project receipt, and two-replica
restart/denial proof. Provider hard-limit enforcement is not instantaneous.
Resend
Free may be a zero-dollar target only after a dedicated
live team, quota, and add-on inventory is observed. The US$2 external-provider
allowance is not a proved upper bound until those exports pass. No provider move, plan, cap, quota, or credential
mutation is authorized by this planning target.

## Environment identities

- **Permanent integrated staging** is the stable pre-production system. Its core Railway service, Postgres database, Supabase project/Auth/private Storage, and Redis identities are pinned and separate; remaining provider credentials and app/live evidence are still open. Use it for migrations, replicas, auth, deletion, data repair, provider canaries, browser/device smoke, load, deploy, and rollback evidence.
- **Disposable restore-staging** is a different one-shot system. Its separate Railway project, Postgres database, and Redis resource now exist and its logical database receipt matches. It still requires isolated Supabase/Storage, app smoke, PITR/WORM/Storage/tombstone/RPO/RTO proof and safe disposal; do not treat the database-only receipt as a complete recovery drill.
- The disposable restore resources are temporary metered evidence capacity and
  are excluded from the combined recurring envelope above. At their current caps they
  would add approximately US$20.13/month if left running; finish the drill and
  complete resource/evidence reconciliation promptly. Disposal then requires
  specific authorization for the exact recorded project/environment inventory
  hash and the reviewed teardown executor's one delete attempt plus independent
  unconditional absence postflight.
- Production, permanent staging, restore-staging, and the private operational restore-copy project must never share credentials or mutable resources. After each disposable restore system is created, load its reviewed `RESTORE_REHEARSAL_EXPECTED_*` values through protected environment configuration and require the runtime identities to match; never hard-code or repurpose permanent staging.

## Automated gates

Run against the frozen release SHA before every candidate:

```bash
npm run check
npm run readiness:providers
npm run release:evidence
npm run security:audit
npm run ocr:benchmark
npm run smoke:production
git diff --check
```

After real provider configuration is installed in permanent staging:

```bash
npm run readiness:launch
npm run smoke:production:auth
npm run release:evidence
```

In permanent staging, `readiness:launch` must report
`readinessProfile=permanent_staging_complete`, zero failures, and zero blocking
warnings. Its Storage canaries run only after the local staging identity/config
preflight passes. The later canonical-production invocation must instead report
`readinessProfile=production_free_launch` with the same zero-failure contract.
The non-strict evidence command validates the schema and lists genuinely pending
live/App Review items. Run `npm run test:release:pintpath` (which includes
`release:evidence:strict`) only after the exact
candidate is live, both production smoke gates are current, the full App Review
approval/manual hold is recorded, and all 13 evidence items are complete.
Record the command, frozen SHA, UTC time, environment identity, sanitized
output, evidence link, reviewer, and result.

## Provider and security proof

- Supabase Auth redirects include `https://pintpath.au/auth/callback` and the local web callback. `pintpath://auth-callback` remains Android-only; the first iOS archive uses email/password and HTTPS confirmation/recovery links.
- The Google provider callback derived from `SUPABASE_URL` is allowlisted, `SUPABASE_OAUTH_PROVIDERS=google`, and Apple OAuth remains disabled until token revocation is implemented and tested.
- Supabase leaked-password protection is enabled; admin MFA/AAL2 is proved with a real staging admin.
- The managed Postgres version is supported. App tables are in a non-exposed schema, the runtime role is least-privileged, and dashboard/RLS checks prove no direct `anon`/`authenticated` app-data access.
- `beermap-source-evidence` is private, has no direct browser object policies, and is reachable only through authorized server APIs and short-lived admin review URLs. Canonical PostgreSQL-bound capture and empty-distinct-destination restore tooling is implemented and locally tested; the substantive live capture, restore, full-application, deletion, and RPO/RTO evidence remains open.
- Google Maps keys are restricted to approved referrers; `GOOGLE_MAPS_MAP_ID` renders advanced markers on permanent staging. Google Places and OpenAI keys remain server-only and absent from `/config.js`.
- `REDIS_URL` is configured, `REQUIRE_REDIS_RATE_LIMITING=true`, and `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false`. A two-replica staging outage test proves protected traffic and readiness fail closed, then recover.
- `COMMERCIAL_LAUNCH_ENABLED=false`, `CONSUMER_PAID_ENROLLMENT_ENABLED=false`, `VENUE_PRO_TRIAL_DAYS=0`, `VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD=false`, `DEMO_BILLING_MODE=false`, `ALLOW_DEMO_BILLING_IN_PRODUCTION=false`, `REPORT_EMAIL_MODE=disabled`, `REPORT_DELIVERY_SCHEDULE_ENABLED=false`, and `PINTPATH_REPORT_DELIVER=false`; `POS_WEBHOOK_SIGNING_SECRET` and all Stripe values are absent. Stripe is not a current launch gate because no payment surface is authorised.
- Resend uses a dedicated sending-only key and verified account-deletion sender. The signed webhook covers accepted/delivered/delayed/bounced/failed/suppressed/complained, replay, out-of-order delivery, timeout, restart, purge, retention, and restore suppression in permanent staging.

## Free venue and contributor journeys

Record real browser/auth/provider evidence in permanent staging:

1. Create and verify a fresh venue-manager account.
2. Submit a claim; prove it grants no access before independent admin verification and approval.
3. Assign one venue and prove the manager cannot read or mutate another venue.
4. Update the assigned venue profile and opening hours.
5. Add and edit at least three beer, stock/on-tap, and price rows; prove safeguard-triggered changes queue for admin review.
6. Submit a separate community contribution with private source evidence; prove the uploader and authorized admin can review it while other users cannot.
7. Exercise wrong-price reporting, support, network interruption, retry/idempotency, session expiry, and manager revocation.
8. Prove happy-hour data, if collected internally, has zero public web or iOS surface.
9. Prove Pro, paid, trial, reward, counter/redemption/POS, special, report, and public happy-hour surfaces stay disabled.

The local suite covers synthetic boundaries; it never replaces this real-provider proof.

## iOS release proof

The native release gate is complete only when all of the following refer to the frozen web/API-compatible SHA and intended version/build:

- protected native workflow passes and produces a signed release archive with the approved bundle ID, team, entitlements, privacy manifest, icons, screenshots, metadata, support/privacy URLs, and production API origin;
- physical-device web/API compatibility, email confirmation/recovery, sign-in/out, account deletion, map, venue details, private contribution upload, network loss, and accessibility smoke pass;
- external TestFlight distribution and Beta App Review pass;
- the same build receives full App Review approval;
- App Store Connect availability includes the Australia storefront; and
- automatic release is off, manual release is held by the named release owner, and phased release is configured before the coordinated web/iOS launch.

TestFlight alone is not approval to launch.

## Monitoring, backup, restore, and rollback

- External uptime checks hit both `/health` and `/ready`; alerts cover 5xx, deploy failure, Postgres availability/pool saturation, Redis failure, authentication/rate-limit spikes, deletion-notice failure, backup age, and WORM replication failure.
- A named incident owner, deputy, escalation path, severity model, RPO, RTO, status-page path, support path, and Postgres-compatible rollback target are recorded.
- Managed Postgres PITR is enabled and tested. A separate checksummed logical Postgres export and complete private Storage inventory are produced on schedule.
- A separate Supabase project may be used as a **private operational restore copy**. Because its service-role principal can list/delete/overwrite, it is not independent or immutable.
- A separately administered provider/region stores the complete database, Storage, manifest, and deletion-ledger set under provider-enforced object lock/WORM. The application writer cannot delete, overwrite, shorten retention, or read with the separately held recovery principal.
- A dated destructive drill restores PITR/logical Postgres, Storage, and the deletion ledger from the operational and WORM authorities into disposable restore-staging, meets RPO/RTO, and proves reconciliation and key journeys. It does not itself authorize destruction; the exact-resource teardown contract above still applies.
- Existing SQLite backup/restore commands are one-time cutover/legacy evidence only and cannot satisfy this gate.

## Performance budget

Run Lighthouse or WebPageTest against permanent staging on mobile and desktop for `/`, `/account.html`, `/submit.html`, and `/venue-portal.html`. Also confirm `/pricing.html` exposes no checkout or approved price.

- Performance: 85+ on public landing/map pages.
- Accessibility: 95+ on public pages and 90+ on authenticated tools.
- SEO: 95+ on public pages.
- No document-level horizontal overflow at 390px, 768px, and desktop widths.
- No blocking console errors on initial page load.
- Load and soak evidence remains inside the documented Postgres, Redis, Railway, Supabase, OpenAI, Google, and Resend budgets with two replicas.

Prefer measured fixes such as deferred non-critical scripts, lazy-loaded map extras, compressed/cacheable static assets, and avoiding unnecessary signed-out work.

## Accessibility and device proof

- Keyboard-only pass: landing/map, account auth, submit, venue portal tabs/forms, modals/dialogs, and account deletion.
- Screen-reader pass: headings, form labels, errors, map alternatives, empty states, and destructive confirmations.
- Real iPhone/iPad Safari plus the signed native iOS build pass at default and large text. Android Chrome remains a web-compatibility check, not an Android app release.
- Primary touch targets are at least 44px where practical; focus remains visible on dark backgrounds.

## Legal and trust proof

- Owner/legal review covers Privacy, Terms, account deletion/export, analytics/cookie consent, App Store privacy disclosures, location, private evidence, user-generated content/moderation, alcohol/responsible-service wording, and support/security reporting.
- Final business identity, owner contact, privacy contact, and monitored support/security details are published.
- Pricing, billing, refund, trial, and Pro terms are explicitly deferred and no dormant amount or offer appears as current.
- Screenshots and case-study/sample copy use synthetic or explicitly approved data.

## Go / no-go

Go only when every gate above has evidence for the frozen SHA, both permanent staging and disposable restore-staging are correctly separated, the 13-item release evidence pack is complete, the fresh permanent-staging-only cost receipt proves the `5000`-cent ceiling, App Review is approved, and the release owner is holding the App Store build for the coordinated manual/phased launch.

No-go if any gate is missing, waived, or stale; production still writes authoritative SQLite; two replicas are unsafe; an ordinary user can access admin/other-venue/private evidence data; any deferred commercial or public happy-hour surface is enabled; Redis can fail open; the backup set lacks Postgres/Storage/WORM authority; staging identities overlap; or the signed iOS build is not approved and held for Australia.
