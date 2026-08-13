# Postgres migration execution status

Last updated: 12 August 2026

Overall state: **NO-GO — the Free-live PostgreSQL application implementation,
permanent-staging database import/runtime proof, logical backup, and isolated
operational-copy retrieval, Postgres restore, and substantive synthetic
deletion replay are complete, but provider, application-deploy, scale, full
recovery, promotion, and cutover evidence gates remain open.**

This is the secret-free execution ledger for
`docs/full-scale-postgres-migration-runbook.md`. It records what has actually
been proved. It is not a substitute for the private release register, provider
resource pins, operator approvals, or two-person evidence.

## Completed locally

- Installed PostgreSQL 17 client, logical backup, restore, and server tooling.
- Implemented the AWS S3 Object Lock WORM attestor, exact Put-only writer and
  read-only verifier policy contracts, bounded independent byte/retention
  verification, immutable receipt, offline tests, operator command, and
  triple-gated real-AWS integration test. This is implementation evidence only;
  no AWS recovery account, bucket, role, credential, or object was provisioned.
- Installed and authenticated Railway CLI, linked locally to the existing
  staging service, and confirmed that no credentials were written to Git.
- Inventoried the authoritative SQLite schema: 56 tables, 717 columns, 76
  foreign keys, 185 explicit indexes, 74 automatic key/unique indexes, and 9
  runtime triggers. Added the one missing foreign-key access index on
  `venue_requests.source_submission_id`.
- Added a bounded asynchronous SQL boundary and a TLS-only `pg` connection
  pool with transactions, nested savepoints, timeouts, safe pool metrics, and
  SQLite placeholder compatibility for the completed Free-live repository
  cutover and retained development/test adapters.
- Generated a private Postgres application schema and a separate inaccessible
  migration-ledger schema. All 717 source columns use their reviewed native
  Postgres types. The generated migration creates separate non-login,
  non-superuser, no-RLS-bypass runtime and migrator roles, forces RLS on all
  59 application/operations relations, grants no API role access, and keeps
  the migrator INSERT/DELETE-disabled outside its exact import policies.
- Applied the generated DDL to a disposable local PostgreSQL 17 database and
  verified 57 application relations (56 authoritative plus metadata), two
  operations-ledger tables, all 76 foreign keys, all 14 source checks, valid
  indexes, forced RLS, and least-privilege role boundaries.
- Added CI database lint coverage for `pintpath_app` and `pintpath_ops`, plus a
  pgTAP contract proving `anon`, `authenticated`, and `service_role` cannot
  resolve or use either private schema.
- Added fail-closed runtime catalog checks for the runtime role, exact search
  path, schema version, completed import state, table count, operations
  isolation, API-role isolation, and sanitized pool metrics.
- Added a secret-free runtime verifier that uses a one-connection pool and
  exits nonzero unless every Postgres startup/readiness contract passes.
- Canonical production and permanent-staging startup now select the shared
  PostgreSQL authority without a credential or SQLite fallback. A missing
  `DATABASE_URL`, failed PostgreSQL contract check, or attempted legacy
  `BusinessRepository` access fails closed. Writable SQLite runtime loading is
  restricted to development/test tooling; the production restore-rehearsal
  path is explicitly read-only. The legacy SQLite database remains a sealed
  migration source, not a permitted candidate runtime.
- Added an unsanitized, maintenance-gated SQLite migration snapshot command.
  It preserves encrypted account-deletion recipient records, checks SQLite
  integrity and foreign keys, rejects source/evidence/ledger changes during
  capture, uses private file modes, and emits a secret-free signed manifest.
- Added a read-only independent deletion-ledger export that verifies the
  immutable objects, current aggregate, genesis, and checkpoint as one
  authority. The sealed migration snapshot now carries all four private
  authority files and the planner/importer revalidate them before, during, and
  after the import. A live production read on 8 August 2026 verified zero
  current tombstones/immutable entries; its temporary credential and export
  files were securely removed. This read is not the later cutover authority.
- Added a deterministic full-table migration planner bound to an explicit
  56-table/717-column conversion contract. It validates booleans, JSON root
  types and duplicate keys, UTC instants, local times, binary data, finite
  numbers, primary-key order, and per-table/per-chunk hashes without exporting
  row values into evidence.
- Corrected the legacy monthly-report CAS model before migration: schema 16 now
  stores a canonical `system_state.updated_at` instant separately from an
  opaque `revision`. The upgrade strictly accepts only the reviewed historical
  instant-plus-v4-UUID form, rebuilds the table transactionally into the exact
  fresh-schema fingerprint, and rejects unknown suffixes atomically. A
  read-only production scan found 11 state rows and exactly one such legacy CAS
  value; all other state timestamps were canonical. The same scan validated
  12,090 non-null values across every timestamp-classified SQLite column and
  found no other opaque suffix or invalid instant.
- Added isolated Postgres worker primitives using atomic claims, fencing
  tokens, conditional updates, and `FOR UPDATE SKIP LOCKED` for deletion
  notifications, Stripe webhook idempotency, admin ingestion review work, and
  system leases. Provider calls remain outside claim transactions.
- Added a restartable native-type importer with per-chunk target checkpoints,
  source/plan/DDL/candidate/environment/approval/operator/verifier bindings,
  exact target identity hashes, deterministic table/key/state commitments,
  foreign-key/orphan reconciliation, and hash-only apply/verify receipts.
  A real PostgreSQL 17 rehearsal imported and independently reverified all 56
  tables, 717 columns, and 76 foreign keys through a least-privilege migrator
  login; the disposable database and login were removed afterward. A gated
  real-Postgres CI job now repeats that proof.
- Added a canonical PostgreSQL physical-database identity shared with logical
  backup/recovery evidence and upgraded the reviewed-price no-write plan to
  version 2. The plan now requires the receipt-bound historical migrator
  identity, live restricted planner identity, and operator-pinned expected
  identity to agree on system identifier, database OID/name, and PostgreSQL
  server version. Planner-login authority remains a separate digest. This
  closed only the role-neutral target-identity blocker in that plan version;
  it did not authorize a write.
- Added the read-only permanent-staging application-deployment attestation
  foundation. Runtime readiness responses expose only domain-separated hashes
  of Railway project, environment, service, deployment, and replica identity.
  The attestor pins the exact staging Beer target, rejects nonempty staged
  patches, joins the sole active successful provider deployment and image to
  `/health`, `/startup`, and `/ready`, fences the provider snapshot before and
  after, and writes a short-lived canonical receipt without raw provider
  metadata. Reviewed-price plan version 3 derived its five deployment hashes
  only from that receipt, retains the exact receipt-file and policy hashes, and
  rejects the former free-form hash flags. This is
  offline implementation evidence only: the Beer service remains undeployed in
  permanent staging, no authentic receipt exists, no Railway write is
  authorized, and the provider-observed deployment blocker remains open.
- Upgraded the reviewed-price no-write plan to version 4. It now consumes a
  canonical, at-most-24-hour `offline-plan-bindings-only` authority bundle that
  is required to declare provider authority, cryptographic approval, and
  mutation authority false. It also emits a separate mode-0600 private review
  packet containing the exact proposed rows and private evidence references,
  with self-hash, candidate, target, recovery, evidence, operator, and reviewer
  bindings. The wrong-price policy conservatively blocks every known reason in
  `open` or `in_progress` state without inventing a severity. This closes no
  live authority: seven blockers remain for the dedicated planner boundary,
  provider-observed deployment, signed approval trust root, immutable/WORM
  evidence, apply/quarantine authorities, durable ledger/crash-safe receipts,
  and atomic apply or receipt-authorized quarantine. The CLI has no apply or
  quarantine command and keeps `mutationAuthorized`/`mutationEnabled` false.
- Added the canonical
  [permanent-staging application source-upload scaffold](permanent-staging-app-deployment.md).
  It pins the target, source/config hashes, one-replica postflight contract,
  adjacent-mutation prohibitions, and staging spend ceiling, but is intentionally
  `HARD_DISABLED_REVIEW_REQUIRED`. Its zero-argument runner emits only one fixed
  blocked receipt and has no credential, provider, network, child-process, or
  mutation transport. This does not deploy the Beer service, authorize spend,
  or close any live launch gate.
- Ported the administrative ingestion queue, its HTTP/operator call sites, and
  claim/finalization flow to the shared asynchronous SQL boundary. Its related
  Free-live price, inventory, review, and publication writes now use the same
  Postgres-ready repository family and transaction authorities.
- Ported beer-catalog reads and moderation writes to an asynchronous,
  Postgres-native repository and moved the public venue-directory read path to
  a separate bounded asynchronous repository. Both have passed disposable
  PostgreSQL 17 contract tests. Community submission now owns catalogue and
  related business publication inside one reviewed asynchronous transaction.
- Added an isolated asynchronous venue-identity/location-cache repository with
  deterministic canonical roots, cycle rejection, bounded identity groups,
  OCC/idempotent alias and cache writes, and native coordinate/timestamp
  validation. Alias insert/re-home acquires the same sorted
  `billing-checkout:subject:venue:<id>` transaction locks required by billing,
  closing the repository-side half of the canonical-subject race. SQLite and
  restricted PostgreSQL 17 race/rollback tests pass. It is now mandatory in
  the application, scripts, and test harnesses, and normal identity/location
  reads plus provider-after-cache OCC writes use it over the shared async
  database. Provider lookup stays before cache persistence. Checkout/Stripe
  canonical reads, intro-trial identity state, and pending-venue publication
  cache mutation use their complete asynchronous transaction owners; the
  orphaned legacy alias writer has been removed.
- Added an isolated asynchronous venue-access repository for claim requests,
  manager assignments, revocation, and counter-staff invitation lifecycle.
  It uses deterministic keyset pages, sorted resource/account locks, deletion
  rechecks, exact claim-review plus manager-assignment transactions, token-
  fenced invitation responses, and strict native JSON/boolean/timestamp
  decoding. SQLite and restricted PostgreSQL 17 contention/rollback tests pass
  with exact disposable cleanup. It is now mandatory in the application,
  report/seed scripts, and all test harnesses from the exact shared asynchronous
  database. Authentication/session projections, assignment checks, claims,
  portal/roster, report recipients, bounded report-assignment pages, counter-
  staff invitation lifecycle, atomic claim review/manager assignment, and admin
  assignment/revocation all use it. The twelve legacy claim/assignment methods,
  row mappers, and exported types have been removed after a zero-caller audit.
  Account-deletion transitions share its account lock. Remaining direct reads
  of access tables are intentionally owned by leaderboard aggregation, partner
  aggregate context, or the account-privacy transaction; there is no remaining
  legacy runtime writer. Counter-staff and other commercial surfaces remain
  disabled for the Free launch regardless of this persistence cutover.
- Added an isolated asynchronous mission-lifecycle repository for mission
  creation/read/list/count, one-winner acceptance, owner replay, token-fenced
  release, bounded expired-progress claims, activation OCC, and guarded unused
  deletion. PostgreSQL mutations take sorted mission/account advisory locks,
  lock the relevant rows, recheck account deletion state, and keep progress
  expiry batches bounded with `FOR UPDATE SKIP LOCKED`. SQLite and restricted
  PostgreSQL 17 contention/rollback/RLS/native-type tests pass with exact
  disposable cleanup, and the real-Postgres CI job runs the contract. It is
  now a mandatory dependency from the exact shared asynchronous database in
  the application, scripts, and all service harnesses. Dashboard progress,
  submission preflight, manual mission creation, acceptance, token-fenced
  release, bounded expiry, activation OCC, guarded deletion, and count paths
  use it. Mission-linked Community Submission transactions share its sorted
  mission/account locks and retain atomic accepted/submitted/review/approval
  transitions. Dead synchronous lifecycle methods and progress mappers have
  been removed. A separate mandatory Mission Discovery Automation repository
  now owns the public feed/scoring query, deterministic bounded venue-candidate
  scan, one-writer auto-mission replacement, bounded inactive pruning, and
  bounded demo deactivation. It shares Mission Lifecycle mission locks,
  preserves every progress/submission/request-linked row, keeps provider and
  canonicalisation work outside database transactions, and is covered by
  SQLite plus restricted PostgreSQL 17 contention/RLS/native-type tests. The
  replaced five synchronous methods and their feed/candidate types are gone.
  A production-scale gate is now wired fail-closed into the required PostgreSQL
  17 integration job and passes locally. It applies the canonical schema under
  a restricted runtime login with forced RLS, loads 10,000 venues, 100,000
  prices, 20,000 requests, and 15,000 missions, and captures the actual
  repository SQL for seven default-planner
  `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)` paths. Its bounded,
  hash-bound evidence proves deterministic deep pagination, one application
  round trip, exact runtime membership, zero temporary blocks, and measured
  ceilings: 1 second for feed/search/radius, 2 seconds for candidates, 250 ms
  for prune/demo, and 100 ms for owner discovery. A successful CI run retains
  the exact JSON receipt for 14 days as the
  `pintpath-mission-discovery-scale-evidence` artifact on its candidate-SHA
  workflow run; CI uses PostgreSQL 17.6. The local PostgreSQL 17.10 warm-cache
  run measured approximately 135 ms feed, 35 ms search, 72 ms radius, 378 ms
  candidates, and 2 ms maintenance/owner paths. No candidate index is accepted
  from this synthetic result alone; permanent-staging warm/cold evidence and
  two-replica load/soak remain open.
  The weighted admin list and private manager-only happy-hour intake now use
  their dedicated asynchronous authorities. The unconditional account-
  dashboard current-month contribution total uses the asynchronous Community
  Submission ledger read.
  Added the production-schema mission and progress cursor/expiry indexes used
  by its bounded keyset and worker queries; the integration fixture no longer
  carries access paths absent from the generated production schema.
- Added an isolated asynchronous venue-request repository for idempotent
  request creation, anonymous-to-account ownership promotion, deterministic
  keyset list/count, deletion-fenced admin workflow OCC, and atomic request-to-
  mission creation. It shares the Mission Lifecycle mission lock and keeps the
  request CAS plus mission insert in one transaction. Google-verified venue
  resolution deliberately remains in Community Submission because that
  transaction also cancels mission progress, detaches competing submissions,
  and deactivates linked missions. SQLite and restricted PostgreSQL 17
  contention/rollback/RLS/native-type tests pass with exact disposable cleanup.
  The production schema now includes its created-at/id keyset index. It is now
  a mandatory dependency from the same shared asynchronous database. Request
  intake, lookup, bounded keyset list/count, admin OCC workflow, and atomic
  request-to-mission creation use it, and their replaced synchronous methods
  have been removed. Google-verified resolution remains intentionally owned by
  the complete Community Submission transaction described above.
- Added an isolated asynchronous venue-partner repository for interest intake,
  account/deletion fencing, deterministic keyset list/count, admin workflow
  OCC, and exact-replay/OCC outreach upserts. It deliberately does not own
  venue assignments, pending changes, broad lead analytics, providers, or
  audit delivery. SQLite and restricted PostgreSQL 17 contention/rollback/RLS/
  native-type tests pass with exact disposable cleanup. Its versioned account
  lock is already included in deletion/privacy transactions, and the generated
  production schema now contains the status-filtered and unfiltered interest/
  outreach keyset indexes. It is now mandatory in the application, scripts,
  and all service harnesses from the exact shared asynchronous database.
  Interest intake, deterministic bounded admin pagination, counts, deletion-
  fenced workflow OCC, and outreach exact replay/OCC use it; audit and event
  delivery remain after commit. Existing admin offset pages are implemented by
  guarded 100-row keyset traversal with a 5,000-row hard cap. The web client
  carries the expected revision for interest and outreach writes. Dead
  synchronous interest/outreach methods and mappers were removed. Claim,
  assignment, pending-change aggregate context, potential-lead scoring, and
  combined assignment/outreach relationship context now compose the bounded
  asynchronous Venue Access, Venue Pending Change, Venue Partner, and Admin
  Analytics read authorities.
- Added a read-only asynchronous admin-analytics repository for known-venue
  counts, KPI summaries, retention cohorts, coverage, and potential partner
  leads. It requires one explicit canonical observation time for age metrics,
  preserves the reviewed privacy thresholds and metric definitions, and has
  matching SQLite/restricted PostgreSQL 17 fixture results. It is mandatory in
  all eight application/script/test compositions from the shared database;
  service and HTTP callers await it. The small aggregate analytics preview has
  also moved to this read-only authority with portable JSON extraction,
  deterministic ties, and fail-closed native counts; its synchronous method is
  removed. Relationship context retains its existing complete owner. Five dead
  synchronous dashboard methods and their sole lead helper were removed. Three measured
  full-scale indexes for active mission scoring, venue mission fallback, and
  contribution ranges were added to the canonical schema and generated native
  artifacts. The later Privacy Retention access paths bring the authoritative
  contract to 183 explicit indexes.
  Two lower-priority event analytics index candidates remain documented in
  `PROD_FOLLOWUPS.md` for observed-load review.
- Added a read-only asynchronous venue-data repository for duplicate venue
  detection, latest venue-data freshness, and venue-scoped published-beer
  existence checks. Submission intake, Google venue lookup, and contribution
  scoring now await it from the same shared database in all eight service
  compositions; the three duplicate synchronous reads and their obsolete type
  are removed. SQLite and restricted PostgreSQL 17 native/RLS/concurrency
  tests pass. Five measured duplicate-name and published-beer indexes are in
  the canonical schema and generated PostgreSQL/Supabase artifacts, bringing
  the reviewed contract to 183 explicit indexes.
- Added a read-only asynchronous venue-manager insights authority with bounded
  raw detail lists, deterministic aggregate ties, strict native decoding, and
  portable JSON/case-folding SQL. It is mandatory in all eight application,
  script, and test compositions from the same asynchronous database. The
  service awaits it only after the existing public-price fetch and continues
  to apply the existing capability, privacy-threshold, free-text redaction,
  and private-evidence sanitisation gates before returning any result. The
  synchronous aggregate, row types, and mappers were removed after a zero-
  caller audit, and the parity test now uses a complete explicit result oracle.
  Two full-scale detail-query indexes measured on PostgreSQL 17 were added with
  exact binary/C tie-break ordering, bringing the reviewed contract and native
  and Supabase artifacts to 185 explicit indexes.
- Replaced operational `system_state`, compare-and-set report state, and fenced
  scheduler leases with a single asynchronous authority. Lease acquisition and
  release are token-fenced and atomic on both databases, report providers run
  outside transactions, and overlapping recipient delivery uses per-recipient
  claims plus a bounded summary merge. The application and schedulers are wired
  to this repository, with direct state SQL retained intentionally inside the
  asynchronous account privacy/anonymisation authority's complete atomic
  transaction.
- Ported account, identity, age-verification, authentication-session, password-
  reset containment, and deletion-lock persistence to a mandatory asynchronous
  repository and wired the application, HTTP middleware, reporting scripts,
  and test harnesses. SQLite and restricted PostgreSQL 17 race tests pass. The
  Stripe event account lookups moved with their complete transaction. Bounded
  admin account search and the status/session-containment mutation now use the
  dedicated asynchronous Admin Account authority described below.
- Added an asynchronous Stripe event/subscription transaction that atomically
  fences webhook ownership, deletion locks, shared Billing Checkout subjects,
  canonical venue identity, event ordering, subscription/access mutation,
  analytics/audit, and token-fenced event finalisation. It is now mandatory in
  the application, scripts, and all service harnesses from the exact shared
  asynchronous database. Signature and Free/commercial gates run before any
  claim; provider authority is resolved outside database transactions; account
  and venue targets are revalidated under one sorted lock union before writes.
  Legacy webhook/customer/profile lookups, the synchronous audit bridge, and
  the duplicate Postgres-worker Stripe implementation were removed after a
  zero-caller audit. Valid provider event time, confirmed equal-time authority,
  bounded retries, and fresh processing tokens remain mandatory. Commercial-
  only checkout-return, completed venue-trial, and demo reconciliation still
  use legacy account/profile subscription writers and must move onto the same
  lock contract before commercial activation. No launch flag was enabled.
- Added an isolated asynchronous billing-checkout repository for consumer and
  venue reservation claims, exact idempotent finalisation, expiry/reclaim,
  canonical venue identity, deletion-lock checks, and one-time trial history.
  Provider calls and all commercial feature gates remain outside its short
  transactions. SQLite and restricted PostgreSQL 17 contention/rollback tests
  pass. The application, scripts, and test harnesses now inject it from the
  exact shared asynchronous database, and consumer/venue reservation plus
  introductory-trial callers use it. Five legacy checkout/trial methods and
  their dead mapping types, together with duplicate legacy venue-identity
  helpers, have been removed. Every account-deletion request creation/state
  transition and final privacy-completion transaction now takes the sorted
  cross-repository account-lock union for Billing Checkout, Venue Access,
  Mission Lifecycle, Venue Request, and Venue Partner before locking the
  account and deletion rows. Venue-identity re-homing already shares the
  Billing subject locks.
  Stripe subscription mutation remains a separate
  complete-transaction residual; no commercial feature gate was enabled.
- Added isolated asynchronous repository contracts for public price reads,
  venue inventory/profile management, and the account-deletion request,
  notification, secret, webhook, checkpoint, and tombstone queues. Their
  SQLite and restricted PostgreSQL 17 tests cover optimistic concurrency,
  worker contention, retry fencing, native types, and bounded secret purging.
  The public-price read path is now a mandatory application dependency and all
  five synchronous fallbacks have been removed without splitting a write
  transaction. Safe venue-inventory reads and standalone manager CRUD now use
  the mandatory async repository as well, and five orphaned synchronous read
  methods were removed. After the pending-change cutover, all nine dead legacy
  beer/happy-hour/special CRUD methods and their row mappers were removed too.
  Legacy profile/subscription calls remain only behind commercial checkout or
  subscription gates that run before database access; they are unavailable in
  the canonical Free PostgreSQL runtime.
- Added the asynchronous replacement for the first venue residual: pending-
  change creation, listing, approval/rejection, and the associated profile/
  beer/happy-hour/special mutation now share one database transaction with the
  inventory repository. Row locks, pending and target OCC revisions, and
  concurrent-review tests prove one winner and full stale-version rollback.
  The application, routes, scripts, and test harnesses now use this repository
  over the shared asynchronous database. Role/tier/commercial checks and
  provider beer normalization stay outside the transaction. All five legacy
  pending-change methods, mapper, and synchronous apply path have been removed.
- Added a separate account-privacy repository that exports a repeatable-read,
  secret-closed account data set and performs anonymisation, deletion-request
  completion, notification activation/suppression, and retained audit/evidence
  updates as one attempt-fenced transaction. Tests explicitly exclude full
  authentication hashes, capability URLs, encrypted recipient material,
  provider payloads, processing tokens, and operational errors. Its SQLite and
  restricted PostgreSQL 17 contention/rollback tests pass. The account-
  deletion coordinator, notification worker, application, operator scripts,
  and test harnesses now use the queue and privacy repositories over the same
  asynchronous SQL authority. The old synchronous request/outbox/export/
  anonymisation methods have been removed. Provider, email, filesystem,
  Supabase Auth, and WORM-ledger work remains outside database transactions.
- Added an isolated account profile/preferences/privacy/saved-items repository
  with optimistic-concurrency revisions, strict native JSON/boolean/timestamp
  decoding, idempotent saved-item uniqueness, deterministic ordering, and an
  atomic privacy-settings plus analytics-event purge. Restricted PostgreSQL 17
  contention and rollback tests pass. The application, HTTP routes, web/iOS
  clients, scripts, and test harnesses now use it over the shared asynchronous
  database. Existing-row writes require canonical `expectedUpdatedAt`, stale
  writes return 409, and same-millisecond writes advance the revision. Privacy
  opt-out and prohibited-event deletion now commit or roll back together. Ten
  replaced methods plus the now-dead standalone privacy-scope deletion helper
  have been removed from the synchronous repository.
- Added an isolated asynchronous activity/audit repository for user activity,
  general events, security audit logs, and venue-manager delete-rate counts.
  It uses bounded deterministic keyset pagination, exact-ID idempotency,
  secret-redacted bounded JSON metadata, native JSONB/timestamptz decoding, and
  stable conflicts. SQLite and restricted PostgreSQL 17 concurrency/rollback
  tests pass. The application, routes, scripts, admin cursor client, account
  overview, and bounded complete export now use this repository. Standalone
  legacy activity/event/audit methods and mappers have been removed. Audit rows
  already atomic with community/deletion/Stripe stay in those repositories.
  Composite index tie-breakers are a later performance migration; query
  correctness is already deterministic.
- Added an isolated asynchronous support/feedback repository for feedback and
  wrong-price trust-queue records. It validates and decodes stored records
  fail closed, preserves optimistic workflow revisions, serializes duplicate
  reporter/price pairs, and atomically marks a price disputed only after two
  distinct signed-in reporters while preserving venue-confirmed authority.
  SQLite and restricted PostgreSQL 17 contention/rollback tests pass. The
  application, HTTP routes, report/seed scripts, admin queue, and test harnesses
  now use it over the shared asynchronous database. Six legacy feedback/wrong-
  price CRUD methods and the obsolete feedback mapper/types were removed;
  venue-request workflow updates and manager-insight aggregation now use their
  dedicated asynchronous authorities.
- Added an isolated community-submission repository for atomic idempotent
  submission creation, private evidence linkage, active/pending catalogue
  decisions, mission reservation transition, community verification, all
  non-approval moderation outcomes, and approval/publication. The approval
  transaction locks and validates the submission, catalogue version, venue,
  price, inventory, mission, evidence, contributor, and audit state before
  finalising the submission. It rejects happy-hour/special publication and
  proves one-winner concurrency on SQLite and restricted PostgreSQL 17. The
  application, HTTP routes, scripts, dashboard/export paging, verification,
  review, and approval/publication paths now use this repository over the same
  asynchronous database authority. Google/Storage/OCR/catalogue provider work
  remains outside its transactions, and new venues/prices stay private until
  atomic admin approval. Private manager-only happy-hour intake now uses the
  asynchronous Venue Manager Internal Submission authority from the same
  database. It preserves its private moderation/evidence boundary, remains
  excluded from community verification/publication, and creates no public
  price, reward, or contribution effect.
- Added an isolated source-evidence retention repository with bounded keyset
  scans, owner isolation, open-review holds, hard-cap expiry, and snapshot-
  fenced tombstone finalisation. External filesystem or Supabase Storage
  deletion remains outside the transaction; a competing worker cannot
  acknowledge a stale or already-finalised database candidate. SQLite and
  restricted PostgreSQL 17 concurrency tests pass. The application, deletion
  coordinator, retention scheduler, scripts, and test harnesses now use this
  repository. Account-deletion enumeration is paged, compensation uses the
  Community repository's owner-scoped safe tombstone, and all eight obsolete
  synchronous retention/link/delete methods have been removed. Registration
  and single-record delivery now use the separate Source Evidence Object
  authority below. The
  schema still permits duplicate idempotent provider-delete calls because it
  has no durable evidence-deletion claim token, although only one fenced
  database finaliser can succeed.
- Added a single asynchronous source-evidence object authority for strict,
  exact-idempotent metadata registration and delivery lookup across inline
  development, private filesystem, and private Supabase Storage providers.
  All eight application/script/test compositions use it from the shared
  database. Provider upload/download/delete and filesystem work remain outside
  database transactions with explicit compensation. Registration shares a
  versioned account lock with every deletion transition and final privacy
  anonymisation, which is covered by a real PostgreSQL blocking race. The old
  BusinessRepository object writer/reader and Community's test-only duplicate
  registration API were removed after a zero-caller audit. Restricted
  PostgreSQL 17 RLS/native-type tests and the sequential CI contract are green.
- Added a bounded asynchronous privacy-retention authority for session,
  provider-session, Stripe payload, security fingerprint, reviewed-location,
  migration-quarantine, and deletion-notification retention. One explicit
  observation time drives all nine cutoffs; each short transaction mutates at
  most 500 rows and the hourly service drains at most 20 guarded batches. Two-
  worker PostgreSQL tests prove `SKIP LOCKED` progress without double counting.
  Six measured retention indexes were added with exact binary/C collation and
  generated into the native and Supabase artifacts. Applied Stripe envelope
  rows remain the webhook idempotency authority, so their payload/error can be
  redacted but the envelope cannot be deleted until a reviewed durable
  tombstone exists; the result reports that deferred backlog instead of
  spinning. The synchronous privacy-retention transaction is removed.
- Cut admin account search and status overrides over to one asynchronous
  `AdminAccountRepository` shared by all eight service compositions. Search is
  literal-wildcard safe, deterministically ordered, and capped at 25 rows.
  Status overrides persistently recheck the actor, fence deletion transitions,
  use optimistic account revisions, and commit account/profile state plus
  suspension-time app-session, discount-pass, and provider-session containment
  atomically; production allowlist, MFA, last-admin, and audit policy remains
  outside the database transaction. AsyncSQLite and restricted PostgreSQL 17
  tests cover forced RLS, least privilege, native types, rollback, malformed
  rows, concurrent one-winner decisions, and exact disposable database/role
  cleanup. The PostgreSQL CI job now runs this contract. The optional
  `idx_accounts_admin_search_trgm` performance candidate is deliberately not in
  canonical schema artifacts yet: `pg_trgm` extension approval and a reviewed
  `CREATE INDEX CONCURRENTLY` rollout with representative permanent staging
  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` evidence are prerequisites before
  that production DDL is accepted.
- Expanded the PostgreSQL 17 CI service job to run the account/session,
  account profile/preferences, activity/audit, account-deletion queue,
  account-privacy, privacy-retention, Stripe-subscription, billing-checkout, public-price,
  community-submission, source-evidence object, source-evidence retention,
  venue-inventory, and venue
  pending-change, support/feedback, venue-access, mission-lifecycle,
  mission-discovery-automation,
  venue-request, venue-partner, admin-analytics, venue-manager-insights, and
  admin-account database contracts in
  addition to import reconciliation, public venue-directory, venue-identity,
  and system-state coverage. The
  required `postgres-migration-integration` job now installs exact PostgreSQL
  17.10 `pg_dump` and `pg_restore` clients and runs a real schema-version-3
  logical backup and restore. `pg_dump` connects through a disposable fd12
  `verify-full` endpoint whose fixture CA DER SHA-256 is pinned; `pg_restore`
  restores into a distinct disposable loopback target. The branch-required
  `build-test-scan` job declares `needs: postgres-migration-integration`,
  evaluates with `if: always()`, and rejects every dependency result except
  `success`, so a failed, skipped, or cancelled rehearsal cannot produce a
  passing required check.
- Added a protected PostgreSQL 17 logical-backup/restore foundation for the two
  private schemas. Backup accepts a direct TLS URL only from a mode-600 file,
  rejects privileged or pooled logins, sets the reviewed migrator role, and
  holds one exported `REPEATABLE READ READ ONLY` snapshot across bounded state
  hashing and `pg_dump --snapshot`. Its current schema-version-3 manifest binds
  the exact transport profile and root-CA DER SHA-256 together with the private
  canonical receipt for all rows/columns of the 56 authoritative tables,
  `schema_metadata`, `migration_runs`, and `migration_chunks`, plus native-type,
  metadata, DDL, source identity, snapshot, archive, table/data/state/key-range,
  receipt, and manifest hashes. Restore authenticates all three mode-600
  artifacts before connecting, uses a single-transaction disposable restore,
  reapplies the ACL contract, independently recomputes the same complete
  inventory, and reports promotion reconciliation ready only on exact equality.
  The required isolated CI PG17 test committed a concurrent write between
  hashing and `pg_dump` and proved that both artifacts consistently excluded it;
  it also completed exact restore reconciliation and removed the uniquely named
  databases/logins. This is synthetic/disposable CI implementation evidence,
  not provider, permanent-staging, WORM, PITR, or production evidence.
- Completed the reachable-runtime cutover audit for the mandatory Free launch.
  Its HTTP handlers, repositories, moderation paths, schedulers, queue workers,
  reports required by the Free scope, scripts, readiness checks, and privacy/
  deletion paths use the shared asynchronous database. Remaining legacy
  `BusinessRepository` calls are confined to commercial, reward, POS, or broad
  paid-report features whose gates run before database access. The canonical
  PostgreSQL runtime injects a fail-closed unavailable legacy proxy, so those
  calls cannot silently open or dual-write SQLite.
- Completed the Free-live worker cutovers to bounded claims, leases, fencing
  tokens, optimistic revisions, deterministic keysets, and idempotent
  finalisation. Provider/network work remains outside short transactions.
  SQLite and restricted PostgreSQL 17 contention/rollback suites cover the
  individual authorities; permanent-staging two-replica and soak evidence is
  still an open live gate below.
- Added the operator-run PostgreSQL logical-backup operational-copy attestation.
  It requires independently reviewed destination-origin and bucket hashes,
  binds the archive, manifest, state receipt, source database identity, remote
  object set, immutable attestation, and mutable latest pointer, re-downloads
  and verifies remote evidence, fences concurrent operators, and writes only a
  bounded hash-only `job:postgres_logical_backup_success` record. Canonical
  PostgreSQL `/ready` loads that complete state, recomputes the connected live
  database identity, and performs the fail-closed remote probe using
  `backupCreatedAt`; a migrated SQLite `{ completedAt }` value is invalid.
  Added the paired read-only retriever: it requires the exact canonical success-
  state hash, live runtime identity, destination pins, pointer/attestation
  hashes and Storage generations, then streams all three objects through
  before/after identity fences into one exact restore-compatible private
  directory. Focused tests and a restricted disposable PostgreSQL 17 identity
  query pass. The provider execution recorded below proves one isolated staging
  upload, a database-bound readiness probe under the prior staging/production-
  copy coupling, and full byte-for-byte retrieval. That is historical evidence,
  not current staging readiness. It does not prove PITR, WORM, private Storage
  recovery, or a full application boot.
- Added a fail-closed synthetic nonzero account-deletion recovery harness and a
  separate restored-target tombstone replay authority. They bind the runtime
  database identity, pre-deletion logical-backup receipt, verified ledger
  genesis/current/checkpoint hashes, the exact restore receipt through its
  independently retained successful-publication SHA-256, target identity, secret
  physical checkpoint, and idempotent semantic projection. Restricted local
  PostgreSQL 17 tests pass. The provider execution recorded below completed the
  permanent-staging prepare/pre-deletion backup/deletion sequence and both
  replay passes with one authentic synthetic tombstone; the exact disposable
  replay database and its two temporary logins were removed after independent
  live-row verification.
- Added the environment-independent Supabase replacement-key consumer gate.
  It reproduces and prevents the pinned browser SDK's opaque publishable-key
  bearer duplication and redirect forwarding, pins the canonical production
  Auth origin, keeps public/server key roles separate at hosted startup,
  requires exact publishable keys for new iOS and Android Release artifacts and
  protected strict-auth smoke, and inventories every tracked SDK factory,
  manual `apikey` transport, provider endpoint, browser bundle, and dependency
  pin. The release workflow runs it before protected secrets. This is offline
  compatibility evidence only: no key was read or changed, no provider was
  contacted, and the two permanent-staging replacement operations plus
  legacy-key disablement remain hard-disabled and unauthorized. Production
  operational-copy authority is not part of the staging replacement.

## Completed against pinned provider targets

- Provisioned and pinned permanent integrated staging with isolated Railway
  Postgres 17, Redis, and Supabase project/Auth/private Storage identities.
  Supabase Auth and the private application Storage policy are configured and
  verified; no production credential or mutable resource is shared.
- Applied the reviewed private PostgreSQL schema and imported the approved
  synthetic SQLite migration source through the least-privilege migrator. The
  apply and independent verify receipts agree across all 56 authoritative
  tables, 717 columns, 76 foreign keys, and 13,121 rows. This is staging-only
  synthetic evidence and is not a production-data snapshot or cutover receipt.
- Verified the permanent-staging runtime through the restricted runtime login:
  startup/readiness catalog checks, completed import state, relation inventory,
  private operations-schema denial, RLS/API-role isolation, and pool checks all
  pass without a SQLite fallback.
- Created and verified the direct PostgreSQL logical backup from permanent
  staging. Its archive, version-2 manifest, and complete state receipt are the
  source authority for the disposable logical-restore proof. A protected
  operator-host invocation uploaded that frozen set to a then-isolated second
  Supabase Micro project and private bucket, re-downloaded and verified its
  objects, wrote the version-2 immutable attestation/latest pointer, and recorded
  the full hash-only success state. A staging database-bound probe reported
  `status=ok`, `required=true`, and `liveProbe=true` under the prior checked-in/
  live contract that coupled staging to the production operational-copy URL,
  key, and bucket. That probe is historical and must not remain in force. The
  current candidate makes the operational-copy CLI canonical-production-only,
  prohibits all three destination variables in staging, and limits current
  staging Storage readiness to its own source-evidence bucket. No provider query
  in this remediation proves deletion; a fresh complete Railway inventory must
  prove all three names deleted before staging can pass. Retrieved the staging
  pre-deletion set from that isolated private bucket through the exact pinned
  state/pointer/attestation/Storage-generation contract; the local archive,
  manifest, and state receipt matched their remote authorities byte-for-byte.
  The operational copy is isolated from production but is still mutable same-
  provider storage, not WORM.
  This historical version-2 set remains valid retrieval/restore evidence. It
  cannot authorize a new offsite/WORM/private-Storage capture or satisfy the
  current transport gate; those require a newly captured version-3 manifest
  bound to the reviewed pinned-CA profile.
- Created a locked manual Railway volume baseline for permanent-staging
  Postgres and enabled its six-day daily snapshot schedule. The recorded
  backup references 889 MB; even treating the locked baseline and every
  retained daily snapshot as a full copy defines the conservative snapshot
  allowance used in the combined permanent-staging and separately operated
  production operational-copy envelope of approximately US$46.80/month. That
  amount is not a staging-only cost or authority boundary. The volume baseline
  itself is a same-provider snapshot layer, not PITR, an off-platform copy, or
  WORM.
- Provisioned an isolated disposable Railway restore project with separate
  Postgres 17 and Redis resources. Restored the permanent-staging logical
  backup into its fresh database and independently verified the resulting
  logical receipt, runtime catalog, ACLs, representative application-adapter
  reads, all private foreign keys, and post-restore `ANALYZE`. The measured
  logical-restore proxy was 316.670 seconds and source-to-restore-start lag was
  360.088 seconds. A subsequent drill restored the byte-for-byte retrieved
  pre-deletion staging set to the independently pinned disposable PG17 target,
  replayed one authentic synthetic deletion tombstone with
  `newlyApplied=1`, replayed it again with `alreadyApplied=1`, and obtained the
  same semantic projection on both passes. Restricted runtime readiness stayed
  green after replay. Independent review passed before the exact replay database
  and its two temporary logins were removed with zero residue. The containing
  restore environment remains retained; objectives are not yet approved, and
  this does not claim a full application boot, private
  Storage recovery, PITR, provider-enforced WORM, or approved RPO/RTO. Its
  retained Postgres and Redis caps would add approximately US$20.13/month if
  left running for a full month; that temporary, prorated recovery-drill spend
  is not part of the recurring US$46.80 combined staging-plus-production-copy
  envelope. Complete the open
  proof and dispose the exact recorded resources promptly rather than letting
  the rehearsal become permanent infrastructure.
- Provisioned and pinned a dedicated production PostgreSQL 17 service and
  least-privilege login roles. It is not attached to the production Beer
  service, has not received the production import, and serves no live traffic;
  production remains on its existing SQLite authority.
- Applied permanent-staging Railway resource caps of 0.1 vCPU/0.5 GB to Beer,
  0.1 vCPU/0.5 GB to Postgres, and 0.1 vCPU/0.25 GB to Redis. Keep one Beer
  replica permanently; a second replica is allowed only for a bounded evidence
  window and must be scaled back to one. With one permanent-staging Supabase
  Micro project, the separately operated canonical-production operational-copy
  Supabase Micro project, the full 50 GB staging-Postgres volume allowance, and
  conservative current Redis storage, the combined recurring envelope including
  the conservative volume-snapshot allowance is approximately US$46.80/month.
  This is not a staging-only cost or authority boundary.

## Live execution still required

Every Railway create, configuration, scale, deploy, rollback, PITR, route,
delete, destroy, or teardown item below remains blocked until the tracked
`readiness:railway:mutation-boundary` executor owns its immediate preflight,
one exact operation, and unconditional postflight. The standalone receipt is
read-only and the checked-in incident baseline intentionally fails; do not use
dashboard **Deploy**, Git autodeploy, or an ad-hoc CLI/API write instead.
Restore-staging teardown additionally requires complete resource/evidence
reconciliation, specific authorization naming the exact resource IDs, and the
exact reviewed teardown executor. Signed evidence or two-person sign-off alone
is not mutation authority.

- Complete three Google/OpenAI provider categories comprising four exact
  Railway variable operations: Google Maps client configuration
  (`GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_MAP_ID`), Google Places server access
  (`GOOGLE_PLACES_API_KEY`), and OpenAI menu OCR (`OPENAI_API_KEY`). Separately,
  the two permanent-staging Supabase replacement-key operations
  (`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`) remain
  `HARD_DISABLED_REVIEW_REQUIRED` and unauthorized; production
  operational-copy variables are prohibited in permanent staging.
- Deploy the reviewed application build to permanent staging at one replica and
  pass provider, Auth, role, private Storage, and Free-scope smoke checks.
- Temporarily run the same reviewed build with at least two application
  replicas and overlapping workers through role smoke, concurrency,
  provider-failure,
  expected-peak/2x-peak load, restart, rolling-deploy, rollback-build, and
  minimum 60-minute soak gates, then return permanent staging to one replica.
- Enable and measure PITR; obtain recovery-administrator approval and provision
  the separately controlled AWS account/bucket/roles; run the implemented WORM
  attestor and later independent retrieval; extend disposable recovery to
  private Storage and full application smoke; obtain approved two-person
  RPO/RTO evidence; then reconcile the complete resource/evidence set and seek
  specific authorization for the exact recorded disposable resource IDs. Only
  the reviewed teardown executor may delete them, with its immediate
  mutation-boundary preflight and unconditional postflight. The completed
  database tombstone replay is evidence for the recorded staging set, not a
  substitute for those remaining recovery gates.
- Complete the maintenance-window production snapshot/import/reconciliation,
  post-import and post-promotion recovery sets, two restore proofs, monitored
  cutover, and coordinated web/iOS launch only after every prior gate passes.

## Current provider state and open gates

- Permanent staging now has pinned Postgres, Supabase/Auth/private Storage, and
  Redis resources, a verified import/runtime, a verified direct logical backup,
  and a historical live destination-bound operational-copy attestation. The three
  Google/OpenAI categories/four exact Railway variable operations remain open;
  the separate two permanent-staging Supabase replacement-key operations remain
  hard-disabled and unauthorized; production operational-copy variables are
  prohibited there; and the staging application has not yet been deployed.
- The separate offsite Supabase project, private logical-backup bucket, remote
  re-download verification, historical database-bound readiness probe, and one
  exact full-retrieval drill passed under the prior coupled contract. That probe
  is not current staging readiness and must not remain in force. The candidate
  permits staging to probe only its own source-evidence bucket; a fresh complete
  Railway inventory must still prove all three operational-copy variable names
  deleted. The operational copy cannot satisfy WORM.
- The separately administered AWS WORM foundation is implemented and documented
  in `docs/postgres-logical-worm-attestation.md`. Its account/administrator
  approval, Melbourne bucket, distinct roles, live synthetic and staging
  attestations, later independent retrieval, and restore proof remain open; do
  not count the offline tests or mutable Supabase copy as provider evidence.
- The disposable Railway Postgres/Redis restore project remains retained. Its
  original restore database logical receipt, runtime checks, representative
  adapter reads, foreign keys, and post-restore statistics match. The separate
  replay database proved the substantive one-tombstone replay, idempotent second
  replay, semantic projection, and post-replay readiness, then was removed with
  its two exact temporary logins. Full application boot, private Storage
  recovery, PITR/WORM recovery, approved RPO/RTO objectives, and teardown of the
  remaining recorded provider resources are still open.
- The production Postgres service exists and is pinned, but is empty, detached
  from the live Beer service, and not cut over. Production continues to use the
  Railway SQLite volume.
- One staging Beer replica is the permanent budgeted topology. The second
  replica is temporary evidence capacity only; two-replica participation,
  concurrency, load/soak, restart, rolling-deploy, and rollback proof remain
  open, as do managed PITR and independent provider-enforced WORM.
- Railway PITR is not enabled. Its current contract rejects the pinned
  `postgres-ssl:17.10` minor label, while the first staging-only attempt to use
  the supported `:17` label caused an unexpected Europe volume migration. The
  attempt failed closed and was reverted: PostgreSQL, its active protected
  volume, locked baseline, daily schedule, import, and runtime checks are again
  healthy in Singapore on the original digest. Do not retry the image-label
  change or enable PITR until the provider-safe placement sequence has been
  reviewed and proved without touching production.
- Reviewed-data promotion, production import/reconciliation, post-import and
  post-promotion recovery sets, monitored cutover, and coordinated launch have
  not started.

## Exact remaining sequence

1. Complete the three Google/OpenAI categories/four exact Railway variable
   operations only after their reviewed authority exists. Keep the separate two
   permanent-staging Supabase replacement-key operations hard-disabled and
   unauthorized until their own reviewed provider and Railway authorities
   exist. The candidate requires production operational-copy configuration
   absent there; a fresh complete Railway inventory must independently prove all
   three names deleted. Retain the historical operator-host retrieval evidence,
   but do not keep or repeat the staging offsite probe. Current staging readiness
   probes only its own source-evidence bucket, and no new staging off-site
   transport is authorized.
2. Deploy the exact reviewed application build to permanent staging at one
   replica and complete provider/Auth/role/Storage/Free-scope smoke.
3. Scale the same build temporarily to two replicas; complete overlap,
   duplicate/reordered/retry, load, soak, restart, rolling-deploy, and
   Postgres-compatible rollback proof; then scale back to one.
4. Enable/test PITR; have the independent recovery administrator provision and
   exercise the implemented AWS WORM contract; then extend the existing
   disposable logical restore through WORM retrieval, private Storage and full
   application recovery and sign RPO/RTO. Then complete resource/evidence
   reconciliation and obtain specific authorization for the exact resource IDs
   before the reviewed teardown executor runs its mutation-boundary preflight,
   one exact delete operation, and unconditional postflight. Retain the
   completed operational-copy retrieval and database deletion-replay evidence
   without treating either as WORM or full recovery.
5. Freeze the exact candidate only after every staging and recovery gate passes.
   Then run the maintenance-mode production snapshot, import,
   reconciliation, post-import recovery set, restore proof, deployment,
   reviewed-data promotion, final recovery set, second restore proof, and
   coordinated web/iOS launch sequence in the controlling runbooks.

## Prohibited until the gates pass

- Do not push the new Supabase migration to the linked production project.
- Do not point `DATABASE_URL` at production or permanent staging merely to make
  a readiness check green.
- Do not use the existing sanitized `data:backup` artifact as the migration
  source; it deliberately removes deletion-recipient secrets and changes
  outbox state.
- Do not open public traffic, leave permanent staging at two replicas outside a
  bounded evidence window, freeze the candidate, or reopen the sealed SQLite
  source for writes after cutover.
