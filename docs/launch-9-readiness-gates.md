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

Pint Path remains no-go. Before candidate freeze:

All Railway provider-writing work in these gates is non-executable until the
tracked `readiness:railway:mutation-boundary` executor owns the immediate
preflight, one exact operation, and unconditional postflight. Its standalone
receipt is read-only; the current incident baseline intentionally fails.

1. Complete the three remaining staging provider credential/configuration
   gates and deploy the exact reviewed app build to permanent staging. The
   isolated private offsite operational copy is now attested and live-probed.
2. Pass real provider/Auth/role/private-Storage/Free-scope smoke, then scale the
   same build temporarily from one to two replicas for concurrency, queue/
   outbox, idempotency, load/soak, restart, rolling-deploy, rollback, and pool-
   headroom proof; return staging to one replica afterward.
3. Enable and test PITR; have the independent recovery administrator provision
   and exercise the implemented AWS S3 Object Lock WORM authority; and extend
   the existing disposable database restore through later WORM retrieval,
   Storage/tombstones, application smoke, deletion replay, signed RPO/RTO, and
   safe teardown. The code and offline tests do not close this live gate.
4. Complete reviewed-data promotion, production snapshot/import/reconciliation,
   post-import and post-promotion recovery sets, monitored Postgres cutover, and
   the coordinated web/iOS release sequence.

Permanent staging is capped at 0.1 vCPU/0.5 GB for Beer and Postgres and
0.1 vCPU/0.25 GB for Redis. Keep one Beer replica permanently and use the
second only for a bounded evidence window. With two Supabase Micro projects and
the conservative locked-baseline plus daily Postgres-volume snapshot
allowance, the reviewed recurring envelope is approximately US$46.80/month.

## Environment identities

- **Permanent integrated staging** is the stable pre-production system. Its core Railway service, Postgres database, Supabase project/Auth/private Storage, and Redis identities are pinned and separate; remaining provider credentials and app/live evidence are still open. Use it for migrations, replicas, auth, deletion, data repair, provider canaries, browser/device smoke, load, deploy, and rollback evidence.
- **Disposable restore-staging** is a different one-shot system. Its separate Railway project, Postgres database, and Redis resource now exist and its logical database receipt matches. It still requires isolated Supabase/Storage, app smoke, PITR/WORM/Storage/tombstone/RPO/RTO proof and safe disposal; do not treat the database-only receipt as a complete recovery drill.
- The disposable restore resources are temporary metered evidence capacity and
  are excluded from the recurring staging envelope. At their current caps they
  would add approximately US$20.13/month if left running; finish the drill and
  dispose the exact recorded resources promptly.
- Production, permanent staging, restore-staging, and the private operational restore-copy project must never share credentials or mutable resources. After each disposable restore system is created, load its reviewed `RESTORE_REHEARSAL_EXPECTED_*` values through protected environment configuration and require the runtime identities to match; never hard-code or repurpose permanent staging.

## Automated gates

Run against the frozen release SHA before every candidate:

```bash
npm run check
npm run test:release:pintpath
npm run ocr:benchmark
npm run smoke:production
npm run release:evidence
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
live/App Review items. Run `npm run release:evidence:strict` only after the exact
candidate is live, both production smoke gates are current, the full App Review
approval/manual hold is recorded, and all 12 evidence items are complete.
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
- A dated destructive drill restores PITR/logical Postgres, Storage, and the deletion ledger from the operational and WORM authorities into disposable restore-staging, meets RPO/RTO, proves reconciliation and key journeys, and then destroys the one-shot environment.
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

Go only when every gate above has evidence for the frozen SHA, both permanent staging and disposable restore-staging are correctly separated, the 12-item release evidence pack is complete, App Review is approved, and the release owner is holding the App Store build for the coordinated manual/phased launch.

No-go if any gate is missing, waived, or stale; production still writes authoritative SQLite; two replicas are unsafe; an ordinary user can access admin/other-venue/private evidence data; any deferred commercial or public happy-hour surface is enabled; Redis can fail open; the backup set lacks Postgres/Storage/WORM authority; staging identities overlap; or the signed iOS build is not approved and held for Australia.
