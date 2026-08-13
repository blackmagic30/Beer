# Full-scale Postgres migration runbook

Last audited: 10 August 2026

Status: **NO-GO — Free-live PostgreSQL application implementation plus the
permanent-staging import/runtime/logical-backup and disposable database-restore
receipt are complete; provider, app-deploy, scale, full recovery, promotion,
and cutover evidence is not complete**.

The completed staging evidence now also includes historical operator-host
byte-for-byte retrieval of its frozen logical set and a staging database-bound
probe that ran under the prior checked-in/live contract coupling permanent
staging to the production operational-copy URL, key, and bucket, plus
substantive, idempotent replay of one authentic synthetic deletion tombstone.
That historical coupling is not current readiness evidence. The candidate now
forbids all three destination variables, but no provider query in this
remediation proves deletion; a fresh complete Railway inventory must prove all
three names deleted before staging can pass. No new staging off-site transport
is authorized. Those narrower proofs do not change the no-go status or close
any full-recovery gate.

Current secret-free execution evidence and the ordered remaining work are
tracked in [postgres-migration-execution-status.md](postgres-migration-execution-status.md).

The frozen candidate selects PostgreSQL for canonical production and permanent
staging and fails closed if its URL, runtime contract, or import state is not
ready; it cannot fall back to `BetterSQLite3`. Writable SQLite is limited to
development/test tooling, while production restore rehearsal opens it read-
only. This closes the Free-live application implementation gate only. The
checked provider boxes below additionally record the isolated staging import/
runtime, logical backup/retrieval, exact database-restore receipt, and nonzero
synthetic deletion replay. They do not close any unchecked provider-credential,
application-smoke, two-replica, load, soak, private Storage, PITR, WORM,
complete restore, RPO/RTO, promotion, or production-cutover evidence box.

Permanent staging is capped at 0.1 vCPU/0.5 GB for Beer and Postgres and
0.1 vCPU/0.25 GB for Redis. Keep one Beer replica permanently; use a second
only during a bounded evidence window and return to one afterward. Including
one permanent-staging Supabase Micro project, the separately operated
canonical-production operational-copy Supabase Micro project, and the
conservative locked-baseline plus daily Postgres-volume snapshot allowance, the
reviewed combined recurring envelope is approximately US$46.80/month. This is
not a staging-only cost or authority boundary.

This runbook is the controlling data-architecture contract for the full public
web and Australian iOS launch. Pint Path must not freeze a release candidate,
promote reviewed data, or announce the combined launch until every exit
criterion below has passed in permanent integrated staging and the resulting
implementation is part of the frozen commit.

Railway writes below use only the exact protected workflows documented in
`protected-provider-mutation-operations.md`; live IDs, credentials, approvals,
and provider receipts remain open gates. The standalone mutation-boundary
receipt is read-only, and no dashboard, Git-autodeploy, or ad-hoc CLI/API action
may bridge a failed preflight.

## Non-negotiable outcome

Before candidate freeze, migrate every authoritative application record from
the current Railway-volume SQLite database to one shared transactional
Postgres database. This includes account-deletion requests and outbox records,
recipient secrets, Resend webhook correlation, idempotency keys, job leases,
venue and price data, moderation state, contribution/evidence references, and
all other active or retained tables.

Production then runs at least two application replicas against Postgres and
proves transaction, idempotency, concurrency, restart, deploy, and rollback
correctness. The old SQLite file may be retained only as a checksummed,
read-only migration source. It must never receive production writes after
cutover. A one-replica SQLite launch is not an alternative for this release.

## Environment separation

- **Permanent integrated staging** is the stable Railway staging service with
  pinned Postgres, Supabase/Auth/private Storage, and Redis resources. Its core
  identities, synthetic import, runtime proof, and logical backup are complete;
  three Google/OpenAI provider categories remain open for protected live
  execution, comprising four exact Railway variables: Google Maps client configuration
  (`GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_MAP_ID`), Google Places server access
  (`GOOGLE_PLACES_API_KEY`), and OpenAI menu OCR (`OPENAI_API_KEY`). Separately,
  the two permanent-staging Supabase replacement-key variables use the
  protected atomic replacement workflow and the later protected
  canary/legacy-disable/old-key-denial ceremony. The old hard-disabled fixtures
  are superseded and non-authoritative. Production operational-copy
  URL, key, and bucket variables are prohibited in permanent staging. The app
  deploy and live evidence also remain open.
- **Ephemeral destructive restore staging** currently has an isolated Railway
  project, Postgres database, and Redis resource, and its logical database
  receipt, one-tombstone replay, idempotent second replay, semantic projection,
  and post-replay runtime readiness match staging. A complete rehearsal must
  additionally use isolated Supabase/private Storage, credentials, domain, and
  callbacks before application/PITR/WORM/RPO/RTO proof. Two-person sign-off is
  necessary but not sufficient for teardown: first complete resource/evidence
  reconciliation and obtain specific authorization naming the exact resource
  IDs; then only the exact reviewed teardown executor may delete or destroy
  them through its immediate mutation-boundary preflight, one exact operation,
  and unconditional postflight.
- Neither environment may share production credentials, database paths,
  service-role keys, Redis namespaces, or callbacks. Restored production data
  must never be loaded into permanent integrated staging.

Record all three resource sets in the private release register. Do not put
project refs, connection strings, database passwords, service keys, or restored
customer data in Git or public evidence.

## 1. Implement the Postgres persistence layer

- [x] Inventory every SQLite table, index, constraint, trigger, migration,
  writer, reader, background worker, and administrative script. Classify every
  row set as migrate, deliberately transform, or delete under an approved data
  contract; no table may be silently omitted.
- [x] Replace mandatory Free-live synchronous SQLite-specific persistence with
  an asynchronous
  Postgres repository/transaction boundary. HTTP handlers, workers, CLI tools,
  tests, backup code, and readiness checks use the same contract. Deferred
  commercial/reward/POS/report features are gated before database access and
  the canonical runtime's legacy repository proxy fails closed.
- [x] Create a non-exposed server-only application schema outside the Supabase
  Data API. Use a dedicated least-privilege runtime role. Do not grant
  `anon` or `authenticated` direct table, sequence, function, or helper access;
  retain row-level security as defence in depth wherever an exposed schema is
  unavoidable.
- [x] Encode primary keys, foreign keys, uniqueness, non-null requirements,
  state checks, timestamp rules, and the measured Free-live query/worker
  indexes in Postgres.
- [ ] Verify every staged candidate query plan under representative permanent-
  staging volume, including the documented follow-up index candidates.
- [x] Implement SSL-required pooled connections with bounded timeouts, a direct
  migration/logical-backup path, and safe persistent-session semantics.
- [ ] Approve and prove the explicit connection budget for at least two
  replicas, overlapping workers, migrations, monitoring, and operator access
  against the pinned provider/pooler topology; prove driver and prepared-
  statement compatibility before any transaction-pooler use.
- [x] Expose safe readiness metrics for pool saturation, checkout latency,
  transaction failures, deadlocks, lock waits, and database availability. Do
  not expose connection strings or customer data.

## 2. Make workers and retries replica-safe

- [x] Claim Free-live queued work in short transactions using row locks and
  `FOR UPDATE SKIP LOCKED`, with a lease/attempt/next-attempt model that can be
  recovered after a process dies.
- [x] Commit the claim before any external provider call. Perform network I/O
  outside the transaction, then record the provider result idempotently in a
  new short transaction.
- [x] Give every externally visible mutation enabled for the Free launch a
  stable idempotency or correlation key. Duplicate requests, duplicate
  webhooks, reordered webhooks, overlapping workers, retries, and deploy
  interruption must not create duplicate notices, prices, contributions,
  subscriptions, or deletion effects. Deferred commercial mutation gates run
  before database access and remain disabled.
- [ ] Prove account deletion, deletion notices, moderation, status refresh,
  evidence capture, backup ledger/tombstones, and every scheduled job continue
  correctly when two replicas and overlapping workers run together.

## 3. Build a deterministic SQLite-to-Postgres importer

- [x] Quiesce a copied SQLite source, run integrity and foreign-key checks, and
  create a SHA-256 manifest of the database plus private evidence directory.
- [x] Export in a stable order with explicit type, null, boolean, JSON, binary,
  timezone, and timestamp conversions. Preserve stable IDs and provider
  correlation identifiers unless a signed transform map says otherwise.
- [x] Import into an empty candidate schema in one controlled operation or a
  restartable sequence with an explicit checkpoint ledger. Re-running the same
  import must be idempotent.
- [x] Reconcile per-table counts, key ranges, foreign keys, unique constraints,
  deterministic hashes, orphan checks, state totals, and application-level
  invariants. Independently sample sensitive and high-value paths without
  copying personal data into evidence.
- [x] Produce a machine-readable, secret-free migration receipt containing the
  source hash, schema version, counts/hashes, start/end times, candidate commit,
  operator, verifier, and result.
- [x] Make the app refuse startup if an unsupported schema, partial import, or
  SQLite production-write configuration is detected.

The deterministic importer and fail-closed startup contract are implemented.
The first five boxes are closed by the isolated permanent-staging synthetic
import and independent apply/verify receipts across 56 tables, 717 columns, 76
foreign keys, and 13,121 rows. Those receipts do not contain production data
and cannot be reused as the later maintenance-window production authority. The
reviewed commands exist behind `npm run db:postgres:migration --`.

### Exact importer command sequence

Use a new mode-700 evidence directory whose physical absolute path is recorded
with `pwd -P`. Every input/output path below must be that canonical physical
path; `/tmp` on macOS is a symlink and is intentionally rejected. Keep the
off-site service-role key and the direct migrator connection URL in separate,
current-user-owned mode-600 files. Never pass either secret on the command
line, print it, or put it in Git.

1. Verify generated DDL and the source conversion contract:

   ```sh
   npm run db:postgres:schema:check
   npm run db:postgres:migration:contract:check
   ```

   The generated role bootstrap is safe on both standalone PostgreSQL and
   managed Supabase PostgreSQL. It creates `pintpath_runtime` and
   `pintpath_migrator`. A true cluster superuser also creates the database-
   scoped read-only group named exactly
   `pintpath_logical_backup_d<current-database-oid>`; a non-superuser leaves
   that group absent and installs only the exact inert portable policies. The
   OID is the canonical positive decimal OID of `current_database()`, with no
   leading zero. PostgreSQL 17 automatically gives a non-superuser
   `CREATEROLE` principal an `ADMIN TRUE`, `INHERIT FALSE`, `SET FALSE` child
   edge on every role it creates, and that creator cannot revoke the bootstrap-
   superuser grant. The bootstrap therefore never creates the scoped group in
   that context and never accepts the automatic administrator child. The
   runtime and migrator bootstrap validates those roles on replay and continues
   only while they remain `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`,
   `NOCREATEROLE`, `INHERIT`, `NOREPLICATION`, and `NOBYPASSRLS`. The fresh
   scoped-role boundary accepts only an absent role or a pre-existing inert
   `NOLOGIN`/`NOINHERIT` role with all dangerous attributes false and no
   parents, children, settings, ACLs, ownership, or shared dependencies. Do not
   replay the fresh bootstrap after its grants and policies exist; the additive
   forward migration is the idempotent exact-state path.

   Only the scoped group receives direct non-grantable `USAGE` on the two
   private schemas and direct non-grantable `SELECT` on the exact 59 reviewed
   application/control tables. Its cross-catalog `pg_shdepend` allowlist is
   exactly those 61 current-database ACL dependencies. The current inventory
   has zero sequences and grants no private-function execution. Every reviewed
   table instead has a portable, permissive, SELECT-only policy targeted to
   `PUBLIC` whose predicate admits only `current_user =
   'pintpath_logical_backup_d' || <live-current-database-oid>`. The policy
   carries no object grant, names no role, and produces no role dependency; a
   source-database scoped role therefore cannot read a sibling or restored
   target even if someone grants it target table `SELECT` by mistake. The
   complete policy allowlist is exact: 177 existing runtime/migrator policies
   in the pre-upgrade state and 236 after adding the 59 backup policies. Name,
   permissiveness, command, role OID array, `USING`, and `WITH CHECK` must all
   match; any arbitrary named-role policy is a hard failure.

   The later additive migration
   `20260812235959_add_privacy_maintenance_role.sql` creates the separate
   `pintpath_maintenance` NOLOGIN/NOINHERIT group after those exact backup and
   inert-kernel guards have passed. It extends the application-table RLS
   allowlist, grants only the erasure/retention table operations used by the
   two privacy repositories, and removes runtime UPDATE/DELETE from the audit
   and two points ledgers. Do not edit the generated base DDL to introduce this
   role earlier; migration order is part of the reviewed privilege contract.

   Existing databases created by the earlier bootstrap must receive the
   additive transaction in
   `20260810003612_add_pintpath_logical_backup_role.sql` before a backup login
   is provisioned. The migration accepts only a wholly absent pre-upgrade
   state, an exact 59-policy-only state restored from `--no-acl`, or a fully
   exact zero-child state. It rejects every partial/mixed state, unexpected
   private-schema `PUBLIC` policy, extra reserved backup-policy name, current-
   OID versioned login, or unsafe catalog dependency before writing. It takes
   the fixed transaction advisory lock `-1516610544307388182` before its first
   catalog classification, and a fully exact state performs verification only,
   with no repeated grants or policy writes. When either accepted no-role
   pre-state (wholly absent or restored policy-only) is processed by a
   non-superuser, it creates or retains the exact 236-policy inventory while
   the scoped group and all 61 backup ACL dependencies remain absent. That
   `policy-only/inert` state is not backup-ready. A fully exact group and
   61-dependency state remains verification-only even for a non-superuser. A
   merely pre-created inert group remains an unaccepted mixed state. Before
   versioned-login provisioning, either run the reviewed forward SQL as a true
   cluster superuser or use a separately reviewed helper that atomically
   provisions and verifies the complete target-OID group and exact
   61-dependency ACL contract. Apply it through the separately reviewed
   migration-administrator path; do not rerun it while a versioned backup login
   is attached. The bootstrap and migration deliberately avoid broad
   `ALTER ROLE` repair. Any unsafe pre-existing state aborts with SQLSTATE
   `42501` and requires independent remediation.

   The independently protected verifier trust anchor is deliberately outside
   that 59-table archive. `pintpath_ops.migration_verifier_authority` is a
   singleton control row, not application data: logical backup and restore must
   never transplant it. After a clean restore or before each candidate import,
   dispatch `.github/workflows/provision-postgres-migration-verifier-authority.yml`
   from exact current `main`. Its target-specific protected environment holds
   the short-lived authority login, operator/verifier identities, Ed25519 public
   key, Railway private URL, and stock root CA; Git contains no private key.
   The workflow uses one compare-and-swap database write with no retry and
   emits canonical intent, terminal, and receipt evidence. The additive
   `20260813165508_add_postgres_migration_verifier_authority.sql` installs the
   same role/table/RLS/ACL boundary on databases that already applied the base
   migration. The importer role can only `SELECT` the row; only the isolated
   provisioner role can `SELECT`, `INSERT`, or `UPDATE` it, and neither role can
   delete it.

   Configure both protected environments—
   `permanent-staging-postgres-migration-verifier-authority` and
   `production-postgres-migration-verifier-authority`—as `main`-only, with a
   required independent reviewer, self-review disabled, and administrator
   bypass disabled. Each environment must define these target-specific
   secrets: `PINTPATH_POSTGRES_MIGRATION_VERIFIER_TARGET_URL` (the exact URL
   containing a distinct short-lived LOGIN credential whose sole membership is
   `pintpath_migration_verifier_authority`),
   `PINTPATH_POSTGRES_MIGRATION_VERIFIER_ROOT_CA_PEM`,
   `PINTPATH_POSTGRES_MIGRATION_OPERATOR_ID`,
   `PINTPATH_POSTGRES_MIGRATION_VERIFIER_ID`, and
   `PINTPATH_POSTGRES_MIGRATION_VERIFIER_PUBLIC_KEY_PEM`. Define the protected
   variables `PINTPATH_POSTGRES_MIGRATION_VERIFIER_TARGET_URL_SHA256`,
   `PINTPATH_POSTGRES_MIGRATION_VERIFIER_ROOT_CA_DER_SHA256`, and
   `PINTPATH_POSTGRES_MIGRATION_VERIFIER_TARGET_IDENTITY_SHA256`. The
   provisioner LOGIN is separate from both the importer and verifier signing
   principals, must be short-lived, and must be disabled, disconnected, and
   have its membership revoked (or be dropped) after the receipt is retained.
   Import apply/verify rejects any remaining child or parent membership on the
   authority group, so a provisioner session cannot race an import.

   Every connection-URL or service-key file used by this runbook is an
   exact-byte input: one value with no leading/trailing whitespace, CR/LF, or
   NUL. With shell tracing disabled, transfer a protected value using a
   no-line-ending writer equivalent to `printf '%s' "$VALUE" > "$FILE"`;
   never use `echo` or print the value during verification.

2. While production is still serving normally, prove that the independent
   deletion authority is readable and export its mutually consistent current,
   genesis, checkpoint, and immutable-set bindings into a new private
   directory:

   ```sh
   SUPABASE_URL=https://auth.pintpath.au \
   OFFSITE_BACKUP_SUPABASE_URL=https://hfbmhdxrwtihukmixxta.supabase.co \
   OFFSITE_BACKUP_BUCKET=pintpath-backups \
   npm run db:postgres:migration -- ledger-export \
     --service-role-key-file /absolute/private/offsite-service-role.key \
     --output-dir /absolute/private/release-id/deletion-ledger-authority
   ```

   The ledger export accepts only those exact, unnormalized origin bytes. It
   validates the private key file as an exact server credential (a new secret
   key or a structurally valid legacy `service_role` JWT) before starting the
   remote export, and its validation failures never print the configured URL
   or key value.

3. Only inside the approved write-maintenance window, stop every SQLite writer
   and worker, confirm the active WAL has been checkpointed through the SQLite
   online-backup API, and create the unsanitized source snapshot. Do not use
   `data:backup`, because that privacy backup intentionally removes recipient
   ciphertext and changes outbox state.

   ```sh
   PINTPATH_SQLITE_WRITE_MAINTENANCE=confirmed \
   npm run db:postgres:migration -- snapshot \
     --source-sqlite /absolute/private/live.sqlite \
     --source-evidence /absolute/private/source-evidence \
     --deletion-ledger-authority /absolute/private/release-id/deletion-ledger-authority/authority-manifest.json \
     --output-dir /absolute/private/release-id/source-snapshot \
     --candidate-sha <frozen-40-or-64-hex-sha> \
     --operator-id <private-operator-reference> \
     --maintenance-reference <signed-change-reference>
   ```

4. Create the deterministic plan from the exact manifest hash printed by step
   3. The output must not already exist.

   ```sh
   npm run db:postgres:migration -- plan \
     --snapshot-manifest /absolute/private/release-id/source-snapshot/snapshot-manifest.json \
     --snapshot-manifest-sha256 <trusted-64-hex-manifest-sha256> \
     --output-plan /absolute/private/release-id/import-plan.json \
     --chunk-rows 1000
   ```

5. Apply the reviewed generated DDL to the empty target with the owner/migrator
   principal, provision a separate login that can `SET ROLE pintpath_migrator`,
   and record the generated DDL SHA-256. The runtime login is separate and must
   be `LOGIN NOINHERIT NOREPLICATION CONNECTION LIMIT 8`, have only direct
   membership in `pintpath_runtime` with `ADMIN FALSE`, `INHERIT FALSE`, and
   `SET TRUE`, and receive only non-grantable `CONNECT` on the target database.
   Revoke database `CREATE` and `TEMP` from `PUBLIC`; the runtime login must
   have neither, no role/database setting, no extra direct ACL or ownership,
   and no other direct or transitive membership. The application supplies the
   fixed PostgreSQL startup option `role=pintpath_runtime` before a pooled
   backend is exposed. It must not receive migrator or operations-schema
   privileges. Provision a third
   login whose only membership is `pintpath_maintenance`; it must be `LOGIN
   NOINHERIT NOREPLICATION CONNECTION LIMIT 2`, with PG17 membership options
   `ADMIN FALSE`, `INHERIT FALSE`, and `SET TRUE`. It must target the same
   database as the runtime login, receive only direct `CONNECT` on that
   database, have no effective database `CREATE` or `TEMP` privilege (including
   from `PUBLIC`), and receive no other direct ACL, ownership, role setting,
   default privilege, or membership. Keep its TLS URL separately as
   `DATABASE_MAINTENANCE_URL`. Put the direct,
   TLS-required, non-pooler migrator URL in a mode-600 file, then inspect the
   target before approval:

   The deployed web, privacy-maintenance, and operator-only migrator URLs must
   all use the same exact lower-case Railway private
   `*.railway.internal:5432` authority shape with only
   `sslmode=verify-full`. Configure the exact sealed root CA PEM and its
   independently reviewed DER SHA-256 as
   `PINTPATH_POSTGRES_ROOT_CA_PEM` and
   `PINTPATH_POSTGRES_ROOT_CA_DER_SHA256`. Runtime startup materializes owned
   temporary custody, pins one `fd12::/16` address, and authenticates the stock
   leaf as `localhost` for both role-bound pools.

   The migrator URL must be the exact lowercase Railway private
   `*.railway.internal:5432` authority with the sole query
   `sslmode=verify-full`. Keep the independently reviewed self-signed Railway
   root certificate in a separate current-user-owned mode-600 file and retain
   its DER SHA-256 out of band. The importer opens the same
   `railway-stock-localhost-ca-v1` transport as the production application: it
   resolves exactly one `fd12::/16` address, dials only that address, verifies
   the stock leaf as `localhost` against only the held root, and rechecks the
   URL/DNS/file authority before and after every query. `sslmode=require`,
   `verify-ca`, public/proxy endpoints, poolers, extra URL query keys, ambient
   roots, and alternate-address fallback are rejected. Inspection returns a
   transport-authority hash binding the fixed profile, exact URL authority,
   and reviewed root DER pin; approve that hash alongside the URL, target, and
   DDL hashes. Do not edit either private file after approval.

   ```sh
   npm run db:postgres:migration -- inspect-target \
     --output-target-identity /absolute/private/release-id/target-identity.json \
     --target-url-file /absolute/private/target-migrator-url.key \
     --root-ca-file /absolute/private/railway-postgres-root-ca.pem \
     --root-ca-der-sha256 <reviewed-64-hex-root-ca-der-sha256> \
     --target-ddl /absolute/repository/src/db/postgres-schema.sql \
     --target-ddl-sha256 <trusted-64-hex-ddl-sha256>
   ```

   Register the returned target-identity file hash, identity hash, URL,
   transport-authority, live-schema, and DDL hashes privately. The command
   writes the canonical six-field target identity as a new mode-600 file; use
   that exact file and hash for reviewed-price planning rather than recreating
   it with an ad-hoc catalog query. A changed URL, CA pin, transport authority,
   database/cluster identity, DDL, candidate, plan, approval, operator,
   verifier authority, or environment is a hard stop. Before step 6, retain the
   protected provisioning receipt and confirm its authority row is bound to the
   exact candidate, environment, operator, verifier public-key hash, and pinned
   repository policy. `apply` and `verify-target` independently load and
   reassert that row while holding the migration advisory lock; there is no
   caller-supplied verifier identity or verifier-key hash.

6. Apply only after the independent verifier has approved every hash. This is
   both operator-guarded and separately confirmation-gated; the receipt path
   must be new.

   ```sh
   PINTPATH_POSTGRES_MIGRATION_APPLY=confirmed \
   npm run db:postgres:migration -- apply \
     --snapshot-manifest /absolute/private/release-id/source-snapshot/snapshot-manifest.json \
     --snapshot-manifest-sha256 <trusted-64-hex-manifest-sha256> \
     --plan /absolute/private/release-id/import-plan.json \
     --plan-sha256 <trusted-64-hex-plan-sha256> \
     --target-ddl /absolute/repository/src/db/postgres-schema.sql \
     --target-ddl-sha256 <trusted-64-hex-ddl-sha256> \
     --target-url-file /absolute/private/target-migrator-url.key \
     --target-url-sha256 <approved-64-hex-url-sha256> \
     --root-ca-file /absolute/private/railway-postgres-root-ca.pem \
     --root-ca-der-sha256 <reviewed-64-hex-root-ca-der-sha256> \
     --transport-authority-sha256 <approved-64-hex-transport-authority-sha256> \
     --target-identity-sha256 <approved-64-hex-target-identity-sha256> \
     --expected-environment permanent-staging \
     --candidate-sha <frozen-40-or-64-hex-sha> \
     --approval-reference <signed-change-reference> \
     --operator-id <private-operator-reference-matching-the-installed-authority> \
     --output-receipt /absolute/private/release-id/apply-receipt.json
   ```

   Apply stops in `awaiting-verification`; it does not set `import_state=ready`.
   Give the canonical apply receipt to the independent verifier, who signs the
   exact approval payload with the separately reviewed Ed25519 key.

7. Run the independently signed verifier with the same exact inputs and a
   second new receipt path. It rechecks the sealed SQLite/evidence/deletion authority,
   every chunk/table hash, row count, state total, key range, foreign key,
   orphan check, metadata binding, target identity, and stored ready receipt.

   ```sh
   npm run db:postgres:migration -- verify-target \
     --snapshot-manifest /absolute/private/release-id/source-snapshot/snapshot-manifest.json \
     --snapshot-manifest-sha256 <trusted-64-hex-manifest-sha256> \
     --plan /absolute/private/release-id/import-plan.json \
     --plan-sha256 <trusted-64-hex-plan-sha256> \
     --target-ddl /absolute/repository/src/db/postgres-schema.sql \
     --target-ddl-sha256 <trusted-64-hex-ddl-sha256> \
     --target-url-file /absolute/private/target-migrator-url.key \
     --target-url-sha256 <approved-64-hex-url-sha256> \
     --root-ca-file /absolute/private/railway-postgres-root-ca.pem \
     --root-ca-der-sha256 <reviewed-64-hex-root-ca-der-sha256> \
     --transport-authority-sha256 <approved-64-hex-transport-authority-sha256> \
     --target-identity-sha256 <approved-64-hex-target-identity-sha256> \
     --expected-environment permanent-staging \
     --candidate-sha <frozen-40-or-64-hex-sha> \
     --approval-reference <signed-change-reference> \
     --operator-id <private-operator-reference-matching-the-installed-authority> \
     --apply-receipt /absolute/private/release-id/apply-receipt.json \
     --apply-receipt-sha256 <approved-apply-receipt-file-sha256> \
     --verification-approval /absolute/private/release-id/verification-approval.json \
     --verification-approval-sha256 <approved-verification-file-sha256> \
     --verifier-public-key /absolute/private/release-id/verifier-ed25519-public.pem \
     --output-receipt /absolute/private/release-id/verify-receipt.json
   ```

Run steps 5-7 first against isolated permanent staging. For production, change
only the privately registered target identities and use
`--expected-environment production`; never reuse a staging receipt or target
URL file.

## 4. Prove permanent integrated staging

- [x] Create and pin the permanent-staging Railway app service, Postgres,
  Supabase/Auth/private Storage, and Redis core identities; prove they differ
  from production and the disposable restore resources.
- [ ] Complete the three Google/OpenAI categories/four exact Railway variable
  operations only through their protected authority. Run the separate atomic
  Supabase replacement and protected canary-B/legacy-disable/old-key-denial
  ceremony under its own approval. Then deploy the reviewed app and verify
  provider/domain/callback bindings.
- [ ] Complete the incident-driven staging Postgres runtime/admin and Redis
  credential rotations with the isolated-client acceptance/rejection contract
  in
  [permanent-staging-private-auth-rotation.md](permanent-staging-private-auth-rotation.md),
  then refresh the exact URL pins and recovery evidence.
- [x] Import the approved checksummed synthetic SQLite source with the reviewed
  tool and independently verify its complete receipt. No live production
  credential or unredacted production data was used.
- [ ] Run at least two application replicas and overlapping worker instances.
- [ ] Pass public, member, contributor, assigned venue-Free manager, and MFA
  admin smoke tests; role isolation, revoked-session, deletion, moderation,
  retained internal happy-hour collection, and public happy-hour absence tests;
  and provider failure/recovery tests.
- [ ] Run expected peak, 2x-peak headroom, sustained-write, connection-pool,
  deadlock/lock-wait, restart, rolling-deploy, and at least 60-minute soak tests.
  Require zero duplicate or lost work, zero cross-role/venue leakage, less than
  1% 5xx, public API p95 below two seconds, and admin p95 below three seconds.
  Follow
  [permanent-staging-load-soak-runbook.md](permanent-staging-load-soak-runbook.md).
- [ ] Deploy the recorded rollback build against the new Postgres schema and
  prove health, reads, authentication, writes allowed by the Free scope, and
  worker correctness. The rollback build must never resume SQLite writes.

## 5. Prove backup and restore before cutover

- [x] Create and lock a permanent-staging Postgres volume baseline and enable
  its six-day daily snapshot schedule. Treat this only as a same-provider
  rollback layer; it is neither PITR nor WORM.
- [ ] Enable managed Postgres PITR and monitor recovery-point age.
  The current Railway PITR contract requires the major `postgres-ssl:17`
  image label. A staging-only label trial migrated the volume toward the wrong
  region and was reverted with data, backups, import, and runtime checks intact;
  require a provider-safe Singapore placement proof before retrying.
  Dispatch the protected PITR workflow with only `permanent-staging` or
  `production`; never supply a root UUID as operator input. Each target has a
  separate protected GitHub environment containing its reviewed target label
  and expected HA-root UUID. The executor maps the label to the checked-in
  canonical environment, enumerates every live service, independently discovers
  exactly one HA root, and fails before writing unless it equals that protected
  authority. Preserve the intent/terminal receipts that bind the resulting
  target-authority SHA-256.
- [x] Create an independently verified logical PostgreSQL export from permanent
  staging with its archive, version-2 manifest, and complete state receipt.
  This describes immutable historical evidence. Version 2 remains readable for
  retrieval/restore but cannot authorize a new capture or close the current
  pinned-transport gate; new backups must be schema version 3.
- [x] Historical operator-host evidence uploaded that frozen
  permanent-staging logical set to a second Supabase project and verified the
  complete remote object set. The associated staging database-bound readiness
  probe ran under the prior checked-in/live contract that coupled staging to the
  production operational-copy URL, key, and bucket. The current candidate makes
  the CLI canonical-production-only and forbids all three variables in staging;
  a fresh complete Railway inventory must still prove their deletion. This
  historical set cannot authorize a new staging upload or probe.
- [x] Retrieve the complete pre-deletion logical set from that isolated private
  bucket through the exact success-state, runtime-identity, destination-pin,
  pointer/attestation, Storage-generation, streamed-size, and SHA-256 contract.
  The resulting mode-700 directory contains exactly the three mode-600 restore
  artifacts and matched the remote authorities byte-for-byte. Follow section 4
  of
  [postgres-logical-offsite-attestation.md](postgres-logical-offsite-attestation.md).
- [ ] Create and verify the corresponding private application Storage snapshot.
  The canonical PostgreSQL-native capture/restore-set foundation, restricted
  PG17 integration test, and operator CLIs are implemented, but no live bucket
  was read or copied as implementation evidence. Permanent-staging Phase 5 is
  runnable against only the exact permanent-staging project-ref origin and its
  server key; the exact production project-ref origin is the only other capture
  source accepted. The command requires an explicit source-environment label
  that maps to exactly one of those origins, an independently reviewed frozen
  candidate SHA, and a matching ready database migration-run binding on both
  repeatable-read inspections before and after the bucket copy. The recovery
  manifest and domain-separated set binding are version 2 for this authority
  contract. Keep every production operational-copy variable absent from staging.
  Execute and independently verify the substantive capture described in
  [postgres-private-storage-recovery.md](postgres-private-storage-recovery.md).
- [x] Create and seal one authentic wholly synthetic deletion-tombstone ledger
  authority tied to the pre-deletion backup; replay it once with
  `newlyApplied=1` and again with `alreadyApplied=1`, require the same semantic
  projection on both passes, and keep restricted runtime readiness green.
- [ ] Write a copy to provider-enforced object-lock/WORM storage in a separate
  failure domain. The application writer must be unable to delete, overwrite,
  or shorten retention. A second Supabase project controlled by a service-role
  key is only a private operational restore copy, not immutable DR proof. The
  pinned AWS S3 Object Lock attestor, Put-only/read-only role policies, offline
  tests, and triple-gated live integration are implemented; the separately
  administered recovery account, bucket, roles, live write, later retrieval,
  and restore evidence remain open. Follow
  [postgres-logical-worm-attestation.md](postgres-logical-worm-attestation.md).
- [x] Restore the retrieved logical Postgres set into the independently pinned
  disposable PG17 database and verify exact source/target receipt equality.
  Follow
  [postgres-logical-restore-rehearsal.md](postgres-logical-restore-rehearsal.md).
- [ ] Restore private Storage, exercise the complete application, test
  PITR/WORM retrieval, measure and approve RPO/RTO, and prove the combined
  recovered system contains no prohibited tombstoned data. The implemented
  restore command requires an empty policy-matching bucket on a distinct
  disposable origin, exact logical-state/reference equality, immutable uploads,
  full re-download verification, and sealed deletion-authority binding; the
  live restore/application/RPO/RTO evidence remains open. The restore command
  is intentionally blocked before credential reads until a real disposable
  Supabase origin is registered in independently reviewed candidate-bound
  authority; invocation-supplied URL hashes are not sufficient.
- [ ] Remove public access, revoke temporary credentials, delete only the
  recorded disposable resources, and independently verify production and
  permanent staging were unchanged.

The logical-export, operational-copy upload/verify/attestation, database-aware
`/ready` probe, read-only retriever, disposable restore, and tombstone-replay
commands are implemented. The attestor binds the archive, manifest, state
receipt, destination pins, and live source database identity into hash-only
state; `/ready` consumes the complete state and freshly computed live identity
rather than a legacy SQLite timestamp. The retriever requires the exact
canonical success-state hash, rechecks pointer/attestation/object generations,
streams every byte, and fences the pointer and state again after local durable
write. See
[postgres-logical-offsite-attestation.md](postgres-logical-offsite-attestation.md).
The verified operational retrieval, disposable database receipt, and authentic
synthetic deletion replay close only their exact checked boxes above. The
operational copy remains mutable same-provider evidence; it does not prove
private Storage recovery, a full application boot, PITR, provider-enforced
WORM, approved RPO/RTO objectives, production recovery, or disposal.
The private-Storage recovery-set implementation is local foundation evidence
only and does not change that conclusion.
Use a dedicated versioned login named exactly
`pintpath_logical_backup_d<current-database-oid>_v<positive-version>`. Both
decimal components are canonical, the database OID must equal the live OID of
`current_database()`, and the version is 1–20 digits with no leading zero. It
must be `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`,
`NOREPLICATION`, `NOBYPASSRLS`, and `CONNECTION LIMIT 2`, with no children or
role settings, `rolvaliduntil` must be catalog `NULL` exactly, and it has
exactly one membership: direct membership in the matching
`pintpath_logical_backup_d<current-database-oid>` group with `ADMIN FALSE`,
`INHERIT FALSE`, and `SET TRUE`. It must be unable to `SET ROLE
pintpath_migrator`, `pintpath_runtime`, or any sibling database-scoped backup
group.

The login itself receives exactly one direct, non-grantable database privilege
(`CONNECT` on the source database) and exactly one direct, non-grantable
function privilege (`EXECUTE` on `pg_catalog.pg_control_system()`). Its
`pg_shdepend` allowlist is exactly those two ACL dependencies: the shared
current-database ACL row and the current-database function ACL row. It receives
no private schema/table/column/sequence authority and owns nothing. Do not
substitute a provider monitoring role: extra or transitive memberships fail
closed. The runtime login cannot read `pintpath_ops` and is not an
authoritative backup principal.

The tracked in-process manager is `npm run db:postgres:backup:login`. It derives
a 48-random-byte base64url password and a 4,096-iteration SCRAM-SHA-256 verifier
locally, passes only the verifier as an extended-protocol bind after exact
PostgreSQL logger guards, and emits a fixed secret-free receipt. It never uses
`psql`, a shell credential, `PGPASSWORD`, or a direct `pg_authid` update. It
creates the candidate `NOLOGIN`, verifies its marker/OID, two direct ACLs and
single explicit PostgreSQL 17 membership, and enables `LOGIN` only as the last
transactional write. A fresh SASL/SCRAM connection must then set only the
matching scoped group and read inside a read-only transaction. Manual plaintext
`CREATE ROLE ... PASSWORD`, `psql` variable substitution, and hand-built
dynamic SQL remain forbidden.

Live provisioning is still operationally **STOPPED**. The manager and logical
backup client require the same explicit `railway-stock-localhost-ca-v1`
transport: the stock volume's single root certificate is independently pinned
by its DER SHA-256, the Railway private hostname resolves to one approved
`fd12::/16` address, and TLS authenticates the stock leaf as `localhost` without
rewriting the source URL authority. Repository tests, including the verifier
logger-suppression fixture, are implementation evidence rather than authority
to run the command. Do not execute `arm`, `provision`, or `retire` against
staging until the exact mode-600 root-CA file and DER pin are independently
approved for the intended Postgres service, the live endpoint proof passes,
and the integrated tracked bytes receive independent review.

The following role shape remains the exact live contract:

```text
NON-EXECUTABLE ROLE CONTRACT
name: pintpath_logical_backup_d{verified-current-database-oid}_v{positive-version}
attributes: LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
            NOREPLICATION, NOBYPASSRLS, CONNECTION LIMIT 2
catalog expiry: rolvaliduntil NULL exactly
password input: precomputed SCRAM-SHA-256 verifier, never plaintext
membership: matching pintpath_logical_backup_d{verified-current-database-oid}
            with ADMIN FALSE, INHERIT FALSE, SET TRUE
direct ACLs: non-grantable CONNECT on this database only; non-grantable EXECUTE
             on this database's pg_catalog.pg_control_system() only
```

### Backup LOGIN manager ceremony (live authority still stopped)

The manager takes no credential in an argument or environment variable. The
administrator URL is an absolute, canonical, current-UID-owned mode-600 regular
file with one direct non-pooler URL; its independently reviewed logical URL
SHA-256 is a separate argument. The source database identity SHA-256 and root
certificate DER SHA-256 must come from independently reviewed Railway
endpoint/system evidence. The mode-600 CA file contains exactly that one public
root certificate; never extract, copy, or mount `root.key` or a server private
key. The intended
escrow path must not exist, its canonical parent must be mode 700, and each
receipt path must be absent inside a separate canonical mode-700 evidence
directory. The operation also binds the clean upstream-equal Git HEAD/tree,
exact Node 22 version, UID, permanent-staging environment, operation ID,
approval reference, and canonical positive login version.

Once the live CA, endpoint, database-identity, and reviewed-SHA authority gates
above are closed, derive the mutation arm first with the complete operation
flags. `arm` reads no database URL or secret:

```sh
npm run --silent db:postgres:backup:login -- arm provision \
  --admin-connection-file /absolute/private/postgres-admin-url.key \
  --expected-admin-url-sha256 <reviewed-64-hex-logical-url-sha256> \
  --expected-database-identity-sha256 <reviewed-64-hex-source-identity-sha256> \
  --transport-profile railway-stock-localhost-ca-v1 \
  --root-ca-file /absolute/private/railway-postgres-root-ca.pem \
  --expected-root-ca-der-sha256 <reviewed-64-hex-root-certificate-DER-sha256> \
  --expected-head-sha <reviewed-40-hex-clean-head> \
  --expected-tree-sha <reviewed-40-hex-clean-tree> \
  --expected-uid <canonical-current-uid> \
  --expected-node-version <exact-v22.x.y> \
  --expected-environment permanent-staging \
  --operation-id <approved-nonsecret-operation-id> \
  --approval-reference <approved-nonsecret-reference> \
  --login-version <positive-1-to-20-digit-version> \
  --escrow-directory /absolute/private/new-login-escrow \
  --receipt /absolute/private/release/new-provision-receipt.json
```

The canonical arm output supplies only the name and value for
`PINTPATH_POSTGRES_LOGICAL_BACKUP_LOGIN_MUTATION`. Execution additionally
requires `NODE_ENV=production`,
`PINTPATH_POSTGRES_LOGICAL_BACKUP_LOGIN_ENVIRONMENT=permanent-staging`, and
`PINTPATH_POSTGRES_LOGICAL_BACKUP_LOGIN_OPERATION=provision`, with the same
flags after `provision`. It refuses every standard `PG*` connection variable
and `DATABASE_URL`. Before any role DDL it durably publishes a mode-700 escrow
directory containing only the mode-600 direct URL and canonical provision
intent, then revalidates both inode identities and the administrator file.

Retirement is a separate approved operation using `arm retire` and `retire`.
It requires the exact mode-600 provision receipt plus its independently
retained SHA-256, the same escrow and login version, and a new operation ID,
approval reference, receipt path, mutation arm, and operation environment. It
accepts only the receipt-bound role name, OID and cryptographic marker. It
first commits `NOLOGIN`, `PASSWORD NULL`, and exact membership/ACL revocation;
then terminates sessions by `usesysid`; then requires zero dependencies before
`DROP ROLE`. It never uses `DROP OWNED`, `CASCADE`, wildcard cleanup, credential
re-enablement, or an overlapping rotation. A crash is resumed only with the
same exact protected inputs and durable intent/checkpoint; an unclassified
partial state stops for a separately reviewed recovery ceremony. Preserve the
provision receipt, retirement receipt, escrow intent/checkpoints, and their
external hashes with the backup/retrieval evidence before creating a later
version.

Never put the password or resulting URL in Git, command arguments, logs, or
evidence. Keep the direct, non-pooler Railway private URL with exactly
`sslmode=verify-full` in a current-user-owned mode-600 file. The shared
transport dials one pinned private address while Node verifies the leaf as
`localhost` against only the held CA and libpq uses the same address,
`PGHOST=localhost`, the same exclusive CA copy, and TLS 1.2 or newer. No system
root, `sslmode=require`, `verify-ca`, public proxy, or alternate-address
fallback is accepted. Separately obtain the trusted lowercase SHA-256 of the
logical trimmed URL and the root certificate's DER SHA-256 from the reviewed
provisioning authority. Do not derive either pin from the mutable files during
the backup ceremony. The exact connection limit of two bounds the
exported-snapshot holder plus the `pg_dump` reader; any other value fails
closed. Inability to read `pg_control_system()` is a hard failure, not a reason
to use a superuser. The
output directory must be a new path inside the mode-700 release evidence
directory:

The stock Railway Postgres SSL image cannot use ordinary system-root validation:
its private self-signed root is not in the system trust store and its [server leaf names only
`localhost`](https://github.com/railwayapp-templates/postgres-ssl/blob/35fb8234ad6c88d400c4be1f19d9a11d6c6c3564/init-ssl.sh), not the Railway private
DNS hostname. The named profile handles that exact stock layout by pinning the
root and retaining `localhost` as the certificate identity while separately
pinning the original Railway URL and database identity. Certificate rotation,
DNS drift, fewer than 24 hours of remaining CA validity, or any pin mismatch is
a new STOP requiring re-authorization. Do not weaken either path to
`sslmode=require` implicitly.

```sh
npm run db:postgres:backup:logical -- \
  --connection-file /absolute/private/postgres-backup-url.key \
  --expected-source-url-sha256 "$EXPECTED_SOURCE_URL_SHA256" \
  --transport-profile railway-stock-localhost-ca-v1 \
  --root-ca-file /absolute/private/railway-postgres-root-ca.pem \
  --expected-root-ca-der-sha256 "$EXPECTED_ROOT_CA_DER_SHA256" \
  --pg-dump-file "$PG_DUMP_FILE" \
  --expected-pg-dump-sha256 "$EXPECTED_PG_DUMP_SHA256" \
  --pg-restore-file "$PG_RESTORE_FILE" \
  --expected-pg-restore-sha256 "$EXPECTED_PG_RESTORE_SHA256" \
  --output /absolute/private/release-id/postgres-logical
```

`PG_DUMP_FILE` and `PG_RESTORE_FILE` must be independently reviewed canonical
absolute paths, and both expected hashes must be independently retained
lowercase SHA-256 pins; bare tool names and ambient `PATH` lookup are rejected.
The command accepts PostgreSQL 17 only. Before transport opening, database
connection, or output creation, it sequentially opens, descriptor-hashes, and
version-probes the dump authority and then the list authority. It also requires
the exact trimmed URL to match the supplied source pin. It binds the login and
group OID segment to the live source database OID,
validates both complete authority contracts,
sets the matching database-scoped group, opens one `REPEATABLE READ READ ONLY`
transaction, exports that snapshot, and keeps it open while it hashes state and
while `pg_dump --snapshot --role=<validated-scoped-group>` reads the same view.
It never exports `PGPASSWORD`. For `pg_dump` alone, it creates one exclusive,
fsynced mode-600 pgpass leaf inside a fresh mode-700 directory under the
canonical operating-system temporary root, then validates and removes that
exact inode nonrecursively before inspecting the child result. Tool version
probes and `pg_restore` receive no credential file. Any missing, drifted,
multiply linked, replaced, or unexpectedly populated temporary state fails as
`cleanup_failed`, and an untrusted replacement is left untouched for explicit
incident handling.
The archive pathname is never passed to `pg_dump` or to the validating
`pg_restore --list` process. The canonical parent and new output directory must
both be current-user-owned mode-`700` directories and remain descriptor-guarded
through cleanup. `pg_dump` writes to a parent-owned pipe; the parent alone
copies those bytes into an exclusive held mode-`600` descriptor. After fsync
and an exact inode/hash snapshot, `pg_restore --list` reads from a separately
opened and identity-matched read-only descriptor at offset zero. Both handles
stay open until their respective child has settled, and descriptor plus
pathname snapshots are rechecked before a manifest or receipt can be returned.
This prevents a leaf or ancestor pathname ABA from substituting a different
archive at either child-open boundary. Each tool runs in its own process group;
reaping starts at leader exit, and forced failures destroy the parent pipe
before settling, so ordinary same-group descendants cannot retain archive-write
authority.

Each purpose-bound authority retains its exact reviewed binary descriptor and
revalidates its hash, metadata, canonical pathname, and PostgreSQL-17 evidence
around its permitted operation. The production factories pre-bind the exact
process runner and do not publish a generic runner or test filesystem seam.
That is still not activation authority. Node launches by pathname, leaving a
same-UID execution ABA between preflight and `spawn`; a binary hash does not
bind the dynamic loader or full shared-library dependency tree; the worker must
run in a pristine realm with locked Promise primordials; and the archive needs
an independently retained external digest guard across recovery. The
process-group proof also cannot observe a substituted child that calls
`setsid`. Until an immutable digest-pinned runtime or reviewed descriptor-native
launcher binds all of those surfaces and the exact pre-bound runner, this
review-only implementation must not authorize a live backup or restore
ceremony. An escaped substituted tool could retain its credential environment
or a read-only archive descriptor even though it cannot retain the parent's
writable archive descriptor.
The canonical state receipt and manifest are likewise checked against their
in-memory canonical bytes, retained by validated descriptors, and revalidated
after database and transport cleanup before success is emitted.
When failure is known before descriptor release, every still-held artifact is
zeroized and fsynced. A descriptor-close failure instead reports
`cleanup_failed` and preserves the retained set for incident review. No failure
path recursively removes the output pathname: check-then-recursive-delete would
itself be a rename/swap deletion capability. Do not reuse that mode-`700`
marker or remove it with an ad-hoc launch command; cleanup requires a separately
reviewed exact-target procedure.
The custom archive contains only `pintpath_app` and `pintpath_ops`, has row
security enabled, and has no owner or ACL statements. Its portable policies
name no scoped source role: PostgreSQL may render the default `PUBLIC` target by
omitting the `TO` clause, and restore must still produce `polroles = ARRAY[0]`
with the exact live-database-OID predicate on all 59 tables. The mode-600 private
`state-receipt.json` commits to every column of all 56 authoritative tables,
`schema_metadata`, `migration_runs`, and `migration_chunks` in reviewed primary
key order, with bounded pages, exact native-type canonicalization, counts,
table/data/state/key-range hashes, source/database/snapshot hashes, and the
archive/manifest binding. New `manifest.json` files use schema version 3 and
bind the exact transport profile plus validated root-certificate DER SHA-256 in
a new domain-separated manifest-binding preimage. Historical version-2 sets
remain byte-for-byte readable for retrieval and restore only; they cannot
authorize a new offsite/WORM/private-Storage capture or close current readiness.
Standard output contains only fixed booleans, decimal counts, and SHA-256
values; it contains no URL, login, database name, row value, or local path.

Before any restore mutation, inspect a fresh database carrying the exact
`disposable-rehearsal` marker:

```sh
npm run db:postgres:restore:logical -- inspect-target \
  --target-url-file /absolute/private/disposable-target-url.key
```

After an independent operator verifies the returned identity hash, restore the
untouched three-file backup directory:

```sh
PINTPATH_POSTGRES_LOGICAL_RESTORE=confirmed \
npm run db:postgres:restore:logical -- restore \
  --backup-directory /absolute/private/release-id/postgres-logical \
  --backup-manifest-sha256 <trusted-64-hex-manifest-sha256> \
  --pg-restore-file "$PG_RESTORE_FILE" \
  --expected-pg-restore-sha256 "$EXPECTED_PG_RESTORE_SHA256" \
  --target-url-file /absolute/private/disposable-target-url.key \
  --target-identity-sha256 <inspected-64-hex-target-identity-sha256> \
  --receipt /absolute/private/release-id/postgres-logical-restore-receipt.json
```

The restore-only flags are mandatory; inspect-target intentionally accepts
neither. `PG_RESTORE_FILE` must be an independently reviewed canonical absolute
path with basename `pg_restore`, and its expected hash must be an independently
retained lowercase SHA-256. One purpose-bound authority retains that exact tool
across PostgreSQL-17 version proof, archive listing, target preflight, and the
single restore. The listing and restore use separate held archive descriptors,
while the restore wrapper retains its independent full digest-bound archive
guard. Authority, archive descriptor, advisory lock, and target-connection
closure are authorization gates, not best-effort cleanup; any uncertainty after
mutation requires disposal and prevents a receipt.

These restore and deletion-replay paths remain review-only. Node still launches by pathname and does
not bind the dynamic loader or complete shared-library closure, and a substituted
child can escape process-group observation with `setsid`. More importantly, the
entire restore and replay CLI/workers—not just the tool-authority module—must
start in pristine frozen-intrinsics realms before imports or secret reads. Their
ordinary async carriers include plaintext target URL material, parsed
`PGPASSWORD`, connection capabilities, tombstone identifiers, and query rows;
inherited `then` poisoning can observe them. The current `npm`/`tsx` commands
are not activation launchers. Use neither these implementations nor these example commands for a new
live ceremony until an immutable digest-pinned runtime or reviewed
descriptor-native launcher, complete dependency closure, and whole-worker
then-safety have passed independent review.

The disposable target must also be isolated, with no concurrent credential
holder. Restore checks run before mutation, after `pg_restore`, and after final
target verification; replay checks before mutation and immediately before its
final lock proof and sole-session close. Each `pg_stat_activity` result is only
a point-in-time observation and cannot stop a new client from connecting
afterward. Replay also disables idle retirement and rejects any pool error or
non-empty post-close metrics, but activation must lock its injected database
factory to that reviewed one-session behavior. Receipt bytes are read back
through held descriptors, fsynced with held parent directories, and closed
before their hashes are authorized. A CLI success-output failure leaves the
receipt unauthorized and requires disposal. Portable Node still lacks an
fd-relative exclusive leaf creation
that atomically binds that pathname to the retained parent against a hostile
current-UID namespace toggler, so a protected immutable namespace remains an
activation requirement.

Restore success requires a fresh independently computed receipt to match every
source authoritative and archived-control count/hash exactly. Any mismatch
after `pg_restore` requires disposal of the complete target. Register the
backup, source-state, restore, migration-verification, and PITR hashes together.
Because restore uses `--no-acl`, the source-OID group and its grants are neither
required nor recreated. The exact `PUBLIC` policies do restore and evaluate the
target's live database OID, leaving the database in the intentionally inert
`restored_policy_only` state: 59 exact policies, no target-OID scoped group, and
no target-OID versioned login. Before that restored database can itself become
a backup source, apply
`20260810003612_add_pintpath_logical_backup_role.sql` through the reviewed
migration-administrator path. It accepts that exact policy-only state. A true
cluster superuser constructs only the target-OID group and 61 target ACLs; a
non-superuser preserves the inert policy-only state and must STOP. Provision a
target-OID versioned login separately only after the full target-OID group/ACL
contract is exact. A source-OID role must remain unable to
set the target group or see target rows, even if temporary target `USAGE` and
`SELECT` are deliberately granted during the isolation rehearsal.

The completed operational-copy retrieval, matching database receipt, and
synthetic deletion replay are still not complete recovery authority. The
provider-enforced copy must also be retrieved from the independent failure
domain, private Storage and the full application must be recovered into the
pinned disposable environment, application smoke must pass, and RPO/RTO must
be measured and approved.

## 6. Production cutover

1. Stop candidate-changing work and record the exact frozen candidate,
   rollback build, schema, importer, and private environment identities.
2. Put production into the approved write-maintenance mode. Stop all SQLite
   writers and workers; verify no process can reopen SQLite for writes.
3. Capture a fresh SQLite integrity-checked source snapshot, private evidence
   snapshot, Postgres recovery point, and WORM copy. If the signed freshness
   window expires, restart this step.
4. Import into the empty production Postgres target and run the full
   reconciliation. Any mismatch is a no-go; do not route application traffic.
5. Capture a new post-import Postgres PITR point plus logical export, complete
   private Storage/evidence and tombstone set, and provider-enforced WORM copy.
   Retrieve the WORM set with the separate recovery principal, restore it into
   fresh ephemeral destructive restore staging, rerun deterministic
   reconciliation/deletion replay, and sign RPO/RTO before traffic is routed.
   The pre-import SQLite/Postgres snapshot is not rollback authority for the
   migrated state.
6. Deploy the exact candidate with the Postgres connection and at least two
   replicas. Prove `/startup`, `/ready`, role smoke, Free-scope writes, worker
   overlap, public data gates, and provider readiness while public ingress
   remains in the signed maintenance/closed state.
7. Publish only the exactly reviewed launch data through the candidate's
   authorised Postgres workflow. Produce the no-write plan first, register the
   independent reviewer's signed apply authorization with
   `db:postgres:reviewed-price:authorize-apply`, and execute the exact approved
   operation once with `db:postgres:reviewed-price:apply`. Reconcile an
   uncertain result by operation UUID and receipt rather than retrying. If the
   batch must be withdrawn, register the separately signed, apply-receipt-bound
   quarantine authorization and run `db:postgres:reviewed-price:quarantine`;
   direct SQL and the legacy SQLite mutation path remain forbidden. Then
   capture a new post-promotion PITR,
   logical/Storage/evidence/tombstone WORM set, retrieve it with the independent
   recovery principal, restore it into fresh disposable staging, reconcile it,
   and obtain two-person RPO/RTO sign-off before routing any traffic. The
   earlier pre-import and post-import sets are not the final authority for the
   published launch state.
8. Keep the sealed SQLite source read-only. Monitor error rate, latency, pool
   saturation, locks, queues, provider correlation, and deletion state through
   the signed observation window.
9. If rollback is required, deploy the recorded Postgres-compatible rollback
   build against the same Postgres database. Never roll back by reopening the
   SQLite source for writes.

## Exit criteria

Candidate freeze is allowed only when all of the following are signed by the
operator and an independent verifier:

- every authoritative table and workflow is implemented on Postgres;
- deterministic import and reconciliation pass with no unexplained mismatch;
- permanent staging passes two-replica concurrency, load, restart, deploy, and
  Postgres-compatible rollback proof;
- `anon`/`authenticated` cannot access the private application schema and the
  runtime role has only required privileges;
- PITR, logical/private Storage backup, WORM copy, and disposable restore pass;
- production and permanent staging identities cannot be selected by destructive
  restore tooling;
- runtime configuration cannot make SQLite authoritative or writable; and
- the migration implementation, tests, operations evidence contract, and this
  runbook are included in the candidate commit.

Until every box passes, Pint Path remains **no-go for full-scale production**.
