# Pint Path production follow-ups

Last reconciled: 3 August 2026

Scope: full public web launch plus the first Australian iOS release. Pricing,
paid enrolment, venue Pro, report delivery, rewards, counter/POS tools, public
happy-hour discovery, and Android distribution are outside this release.

The repository work is substantially hardened, but the requested full-scale
launch remains no-go until every P0 item below is proved against one frozen
candidate SHA. A checklist entry is not evidence; store the private evidence
reference and verifier in `docs/release-evidence.json`.

## P0 — choose and prove the production data architecture

- **Current state:** The authoritative database, deletion-notice outbox,
  webhook correlation, and job leases use SQLite on a Railway volume. Railway
  volume deployments are single-region, cannot use replicas, and briefly stop
  the attached service during deployment.
- **Required for the requested full-scale launch:** Move the authoritative
  SQLite state and transactional workers to shared Postgres, prove the migration
  and rollback, run at least two application replicas, and show transaction,
  idempotency, and job-lease correctness under concurrency.
- **Alternative only if scope is reduced:** Record a controlled single-region
  launch decision, accepted deployment downtime, measured 2x peak headroom,
  write-contention/disk-full/restart/deploy recovery, and the objective trigger
  for the Postgres migration. Do not describe that alternative as highly
  available or full-scale.
- **Blocks requested launch:** Yes.

## P0 — restore a real isolated staging environment

- **Current state:** The documented `beer-staging.up.railway.app` health URL
  returned HTTP 404 on 3 August. No live write rehearsal should use production
  as a substitute.
- **Required:** Reconcile the exact Railway staging project, environment,
  service, volume, Redis reference, Supabase project, TLS hostname, callbacks,
  and deployed SHA. Prove `/health`, `/startup`, and `/ready`, then keep every
  staging credential and data set isolated from production.
- **Blocks requested launch:** Yes.

## P0 — repair and re-prove production data readiness

- **Current observation:** 612 venues, 611 marketed venues, 112 suburbs, and
  288 current price rows. Only 5 marketed venues had at least three qualifying
  prices (0.82%); no suburb passed its 70% threshold; the newest qualifying
  price was about 685 hours old against a 48-hour maximum; three structured
  addresses were malformed.
- **Required:** Fix the addresses, prove business/open status and source-evidence
  linkage on the candidate schema, reverify stale records, and either fill every
  marketed suburb to the signed threshold or narrow marketing to an exact list
  of independently passing suburbs. Rerun the strict gate after staging and
  immediately before go/no-go.
- **Blocks requested launch:** Yes.

## P0 — apply and audit the final Supabase/Auth contract

- **Current repo state:** `20260803000000_revoke_direct_browser_data_api.sql`
  revokes all `anon`/`authenticated` table, sequence, RPC, and helper privileges.
  Canonical app data access is Express/service-role only; RLS remains defense in
  depth. Web OAuth is Google-only. The first iOS build is email/password only.
- **Required:** Apply all migrations in isolated staging, run Supabase reset,
  lint, advisors, and pgTAP, then prove the public Data API/RPC/Storage denial
  matrix with anonymous, normal authenticated, and a JWT captured before
  deletion. Enable leaked-password protection, verify Google callbacks and
  custom SMTP, prove admin AAL2, and confirm the live project is on a supported
  Postgres version.
- **Account bridge:** Prove an existing Google-only web user can establish the
  iOS email/password credential for the same email and resolves to the same
  Supabase user and Pint Path account—never a duplicate.
- **Blocks requested launch:** Yes.

## P0 — complete the account-deletion provider rehearsal

- **Current repo state:** Schema 15 provides an encrypted AES-256-GCM completion
  notice outbox, Resend idempotency/webhooks/retries/retention, audited terminal
  resolution, restore suppression, and transaction-first local evidence
  scrubbing. Completed deletion removes submissions, item/free text,
  contribution rows, evidence links, and submission-derived public price rows.
- **Required:** Configure a sending-only Resend key, verified sender/reply-to,
  encryption keyring, and signed webhook in isolated staging. Run a sacrificial
  deletion and prove provider deletion, captured-old-JWT denial, local and
  Supabase evidence removal, public-derived-row removal, completion delivery,
  restart/overlap behavior, retention purge, and failure recovery. Keep
  `ACCOUNT_DELETION_REHEARSAL_ENABLED=false` in production.
- **Blocks requested launch:** Yes.

## P0 — create genuine immutable disaster-recovery evidence

- **Current state:** The second Supabase project is a useful operational copy,
  but it is not provider-enforced immutable disaster recovery.
- **Required:** Create a separate-provider or separately isolated-region WORM/
  object-lock target. The application credential must be append/create-only and
  unable to overwrite, delete, or shorten retention; read and retention-admin
  authority must be separately controlled. Prove backup age alerts, integrity,
  a schema-15 restore, evidence reconciliation, RPO/RTO, teardown safety, and
  two-person verification.
- **Blocks requested launch:** Yes.

## P0 — capacity, monitoring, security, and incident operations

- **Required capacity evidence:** 2x expected peak, soak, write contention,
  Redis shared limiting and outage recovery, disk-full behavior, restart and
  deploy recovery, job overlap, and rollback on the chosen architecture.
- **Required monitoring:** External `/health` and `/ready` uptime, 5xx/latency,
  Redis, database/volume, backup age, deletion queue, moderation queue, provider
  failures, and iOS crash alerts with named primary/backup responders.
- **Required security operations:** DAST only against staging, live header/cache
  verification, secret/provider restriction review, dependency/CodeQL gates,
  session revocation on two devices, and a passed breach tabletop using
  `docs/data-breach-response-runbook.md`.
- **Blocks requested launch:** Yes.

## P0 — finish signed iOS and App Store release evidence

- **Current repo state:** Release builds fail closed without production public
  Supabase configuration; CI inspects the compiled archive; social login,
  StoreKit, Pro/trial/billing, rewards, counter/admin, and happy-hour surfaces
  are outside the first archive.
- **Required:** Confirm Apple Developer membership, Account Holder/backup App
  Manager, agreements and entity; produce and scan a signed archive/IPA from the
  frozen SHA; validate and upload it; reconcile PrivacyInfo/App Privacy; test
  iOS 17 and current iOS on physical devices through TestFlight; prove auth,
  password recovery, permissions, offline/interruption, accessibility, export,
  deletion, reinstall/restore, and reviewer accounts; configure symbolicated
  crash reporting and alerts; obtain App Review approval and verify storefront
  availability under manual/phased release control.
- **Broad-release threshold:** Zero reproducible critical crashes and at least
  99.5% crash-free sessions over seven days and 500 sessions. Remain controlled
  with a smaller sample.
- **Blocks requested launch:** Yes.

## P0 — legal, accessibility, operating owners, and release evidence

- **Required:** Final Australian legal/privacy/liquor/marketing review; entity,
  ABN/contact, policy and App Store metadata reconciliation; named deletion,
  moderation, release, rollback, evidence, and first-72-hour on-call owners;
  physical-device keyboard/screen-reader/zoom matrix; no critical/high defects;
  and all 12 evidence objects marked `pass` against one frozen SHA.
- **Blocks requested launch:** Yes.

## P1 — correct the legacy apex redirect

- **Current state:** Both Railway ownership TXT records resolve correctly and
  `www.pintpath.com.au` points to Railway. The GoDaddy apex forwarding response
  for `pintpath.com.au` currently points through `http://pintpath.au/`.
- **Required:** Change the GoDaddy forwarding destination to
  `https://pintpath.au/`, preserve query/path behavior if supported, wait for
  propagation, and verify the full redirect/TLS matrix. Do not replace or edit
  the working Railway TXT records.
- **Blocks requested launch:** Yes until the legacy-domain matrix passes.

## Deliberately deferred — pricing and commercial features

- Keep `COMMERCIAL_LAUNCH_ENABLED=false`,
  `CONSUMER_PAID_ENROLLMENT_ENABLED=false`, `VENUE_PRO_TRIAL_DAYS=0`, report
  delivery disabled, and Stripe values absent/inert for this release.
- The public config must expose `pricing: null`; public responses must not
  publish an old amount, upgrade action, trial, special/discount pass, or paid
  placement claim.
- Later, approve pricing, GST, eligibility, exact free-offer duration, expiry,
  fraud/duplicate handling, renewal/cancellation/refund terms, and whether the
  offer is a separately flagged no-billing grant or a Stripe trial. Build and
  prove that as a new candidate with its own legal, provider, test, and evidence
  cycle.
- **Blocks this free launch:** No, provided every disabled-state check passes.
