# Pint Path production follow-ups

Last reconciled: 11 August 2026

Scope: full public web launch plus the first Australian iOS release. Pricing,
paid enrolment, venue Pro, report delivery, rewards, counter/POS tools, public
happy-hour discovery, and Android distribution are outside this release.

The repository work is substantially hardened, but the requested full-scale
launch remains no-go until every P0 item below is proved against one frozen
candidate SHA. A checklist entry is not evidence; store the private evidence
reference and verifier in `docs/release-evidence.json`.

Every Railway create, pin, variable, route, deploy, scale, or destroy action in
this ledger remains blocked behind the tracked `readiness:railway:mutation-boundary`
executor. The standalone receipt is read-only; dashboard **Deploy**, Git
autodeploy, ordinary redeploy, and ad-hoc CLI/API writes are not substitutes.

## P0 — implement and prove the selected production data architecture

- **Repository state:** Canonical production now opens only the reviewed
  `DATABASE_URL`, verifies the imported private Postgres schema before serving,
  uses the restricted runtime role and bounded pool, and makes the legacy
  SQLite repository fail closed. All mandatory Free-launch persistence paths,
  deletion-notice outbox, webhook authority, and job leases have async Postgres
  owners with restricted PostgreSQL 17 contract tests.
- **Deployment state:** The live Railway production environment remains on the
  older authoritative SQLite deployment. A dedicated production PostgreSQL 17
  service is provisioned and pinned, but it is empty, detached from the Beer
  service, has not received the reviewed import, and serves no traffic. The
  production import, reconciliation, two-replica proof, and controlled cutover
  therefore remain open.
- **Decision for this release:** The requested launch is full-scale, so the
  controlled single-region SQLite alternative is closed. Execute and prove the
  reviewed snapshot/import/reconciliation/cutover against shared Postgres, run
  at least two application replicas, and show transaction, idempotency, pool,
  restart, deploy, and job-lease correctness under concurrency.
- **Cutover rule:** After cutover, SQLite may remain only as a checksummed,
  read-only migration source. It must not be authoritative or receive production
  writes, and the rollback build must continue using Postgres.
- **Blocks requested launch:** Yes.

## P0 — complete permanent staging and separate destructive restore staging

- **Current state:** Permanent integrated staging now exists with pinned,
  separate Railway Postgres and Redis resources plus Supabase/Auth/private
  Storage identities. Its synthetic import, restricted runtime proof, direct
  logical backup, and isolated operational-copy retrieval are verified. The
  reviewed Beer build is not deployed there, three provider
  credential/configuration gates remain open, and no live write rehearsal may
  use production as a substitute.
- **Permanent integrated staging:** Keep the recorded identities and one-replica
  budgeted topology. Only after the document-wide Railway mutation stop is
  closed, complete provider configuration one exact variable at a time through
  a separately activated and reviewed provider-variable executor. Deploy the
  exact reviewed build only through its separately reviewed one-operation
  deployment executor. Then use the same system for two-replica concurrency,
  Auth, deletion, data repair, DAST, load, smoke, and rollback-build proof before
  returning to one replica.
- **Ephemeral destructive restore staging:** A separate Railway Postgres/Redis
  restore project exists and its database restore plus one-tombstone replay are
  verified. It still needs isolated Supabase/Storage, PITR/WORM retrieval, full
  application recovery, signed RPO/RTO, and exact safe teardown. Never restore
  production data over production or permanent staging; destroy only the
  recorded restore resources after evidence is signed.
- **Required proof:** Both identity sets remain mechanically checked; the exact
  staging build returns `200` from `/health`, `/startup`, and `/ready`; the full
  destructive recovery drill passes; and the recorded disposable resources are
  removed without affecting production or permanent staging.
- **Blocks requested launch:** Yes.

## P0 — repair and re-prove production data readiness

- **Current observation (8 August):** 612 venues, 611 marketed venues, 112
  suburbs, and 288 current price rows. All 62 rows still labelled trusted were
  older than the 30-day maximum, so zero venues had three qualifying prices;
  no suburb passed its 70% threshold; no qualifying core verification was under
  the 48-hour maximum; three structured addresses were malformed; and the old
  public schema exposed no business-status proof.
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
- **Required:** Apply all migrations in permanent integrated staging, run Supabase reset,
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
  encryption keyring, and signed webhook in permanent integrated staging. Run a sacrificial
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
  a candidate Postgres-schema restore plus private Storage restoration,
  evidence reconciliation, RPO/RTO, teardown safety, and two-person
  verification. The same-region Supabase copy remains only an operational
  restore copy.
- **Blocks requested launch:** Yes.

## P0 — capacity, monitoring, security, and incident operations

- **Required capacity evidence:** 2x expected peak, soak, write contention,
  Postgres connection-pool saturation/recovery, Redis shared limiting and outage
  recovery, restart and deploy recovery, job overlap, and rollback on at least
  two application replicas.
- **Required monitoring:** External `/health` and `/ready` uptime, 5xx/latency,
  Redis, database/volume, backup age, deletion queue, moderation queue, provider
  failures, and iOS crash alerts with named primary/backup responders.
- **Required security operations:** DAST only against staging, live header/cache
  verification, secret/provider restriction review, dependency/CodeQL gates,
  session revocation on two devices, and a passed breach tabletop using
  `docs/data-breach-response-runbook.md`.
- **Blocks requested launch:** Yes.

## P0 — complete OCR, Free venue-pilot, and moderation evidence

- **OCR corpus:** Build the approved labelled menu corpus, run the frozen
  extraction/review threshold, and preserve precision/recall, failure, privacy,
  content-rights, and independent-verifier evidence. Synthetic unit tests do
  not replace the labelled-corpus gate.
- **Three Free venue pilots:** At three separately verified assigned venues,
  prove claim/assignment isolation, profile/opening-hours edits, at least three
  beer/stock/price rows, safeguard/admin review, support/wrong-price handling,
  manager revocation, interruption/idempotency, and the independent verifier
  matrix in `docs/venue-pilot-runbook.md`. Happy-hour records may be saved only
  as internal venue-operations data and must remain absent from public web/iOS.
- **Disabled-scope proof:** During every pilot, prove Pro/trial/checkout,
  reports, specials, rewards/redemption, counter staff, POS, and public
  happy-hour routes/UI are absent or denied and their credentials are inert.
- **Moderation operations:** Exercise queue isolation, takedown, appeal,
  audit-history preservation, SLA alert/escalation, and primary-to-backup
  operator handoff without sharing credentials or private evidence.
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
  deletion, reinstall/restore, and reviewer accounts; distribute the same build
  externally and pass Beta App Review; configure symbolicated crash reporting
  and alerts; obtain full App Review approval for that exact build, select the
  Australia storefront and manual/phased release, and hold the approved build
  until the coordinated launch before verifying the live storefront/install.
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

## P0 — correct and verify the legacy apex redirect

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

## P1 — optional admin-analytics event indexes

These two indexes are measured performance follow-ups for low-traffic private
admin analytics. They are not correctness blockers for the current Free launch
and must not be added ad hoc to a live database. Review them in the canonical
migration contract and use a separately rehearsed `CREATE INDEX CONCURRENTLY`
production rollout so normal event writes are not blocked.

1. Beer analytics candidate:

   ```sql
   CREATE INDEX idx_events_type_created_beer_analytics
     ON pintpath_app.events (event_type, created_at DESC, beer_id)
     WHERE beer_id IS NOT NULL AND beer_id <> '';
   ```

   The EXPLAIN audit measured the existing path at about 4.2 ms and the
   candidate at about 0.42 ms; on the 500,000-row fixture it improved about
   4.42 ms to 0.949 ms.

2. Suburb analytics candidate:

   ```sql
   CREATE INDEX idx_events_type_created_suburb_analytics
     ON pintpath_app.events (event_type, created_at DESC, suburb)
     WHERE suburb IS NOT NULL AND suburb <> '';
   ```

   The existing path was already index-only. The EXPLAIN audit measured about
   5.7 ms versus 0.54 ms with the candidate; on the 500,000-row fixture it
   improved about 6.45 ms to 2.09 ms, so this remains optional.

## P0 — complete permanent-staging mission-discovery scale and load proof

The repository and required PostgreSQL 17 CI job now include a production-like
synthetic plan gate. It applies the canonical schema, uses a restricted runtime
login with exact `pintpath_runtime` membership and forced RLS, and loads 10,000
venues, 100,000 prices, 20,000 requests, and 15,000 missions. It captures the
actual repository SQL and retains bounded, hash-bound
`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)` evidence for public
feed/search/radius sorts, venue-candidate discovery, auto-mission owner
discovery, demo deactivation, and inactive-auto pruning. The default planner
must preserve deterministic deep-page results, one application round trip,
zero temporary read/write blocks, and the recorded per-path ceilings.
Those ceilings are 1 second for feed, search, and radius; 2 seconds for venue
candidates; 250 ms for pruning and demo deactivation; and 100 ms for owner
discovery. Each successful CI run retains
`pintpath-mission-discovery-scale-evidence` as a 14-day artifact attached to
the exact workflow run and candidate SHA; the CI baseline is PostgreSQL 17.6.

The local PostgreSQL 17.10 warm-cache proof measured approximately 135 ms for
the public feed, 35 ms for address search, 72 ms for radius sort, 378 ms for
venue candidates, and 2 ms for each maintenance/owner path, with zero temporary
blocks. This closes the local synthetic-plan implementation proof and does not
justify a schema/index change by itself. The fail-closed CI gate must pass at
the exact candidate head. Before the frozen launch candidate, repeat the
evidence on the exact permanent-staging build with representative live
cardinalities and both warm and cold caches. That provider-scale proof, the
two-replica load/soak exercise, and its private evidence references remain open.

Review these index/projection candidates only when supported by those plans:

- `venue_requests (venue_id, created_at DESC, id ASC)` including venue name and
  suburb for deterministic latest-request selection;
- `venue_price_records (venue_id, last_verified_at DESC, id ASC)` including the
  candidate projection and happy-hour flags;
- a partial active, non-auto mission candidate path on
  `(venue_id, updated_at DESC, id ASC)`;
- pattern-operator partial paths for `auto:%` mission IDs and active `demo:%`
  venue IDs; and
- a maintained venue-freshness/search projection if the all-venue price rollup
  or joined address search remains a broad scan. Do not replace these set-based
  reads with application N+1 queries.

Any accepted index must enter the canonical schema and migration contract and
be rehearsed with `CREATE INDEX CONCURRENTLY`; do not add it ad hoc to the live
database. The measured candidates remain follow-ups unless permanent-staging
evidence proves that one is required. The remaining provider-scale plan
evidence is part of the P0 capacity gate.
