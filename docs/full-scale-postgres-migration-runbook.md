# Full-scale Postgres migration runbook

Last audited: 10 August 2026

Status: **NO-GO — Free-live PostgreSQL application implementation plus the
permanent-staging import/runtime/logical-backup and disposable database-restore
receipt are complete; provider, app-deploy, scale, full recovery, promotion,
and cutover evidence is not complete**.

The completed staging evidence now also includes byte-for-byte retrieval from
the isolated operational-copy bucket and substantive, idempotent replay of one
authentic synthetic deletion tombstone. Those narrower proofs do not change
the no-go status or close any full-recovery gate.

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
two Supabase Micro projects and the conservative locked-baseline plus daily
Postgres-volume snapshot allowance, the reviewed recurring envelope is
approximately US$46.80/month.

This runbook is the controlling data-architecture contract for the full public
web and Australian iOS launch. Pint Path must not freeze a release candidate,
promote reviewed data, or announce the combined launch until every exit
criterion below has passed in permanent integrated staging and the resulting
implementation is part of the frozen commit.

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
  three provider credentials, the app deploy, and live evidence remain open.
- **Ephemeral destructive restore staging** currently has an isolated Railway
  project, Postgres database, and Redis resource, and its logical database
  receipt, one-tombstone replay, idempotent second replay, semantic projection,
  and post-replay runtime readiness match staging. A complete rehearsal must
  additionally use isolated Supabase/private Storage, credentials, domain, and
  callbacks before application/PITR/WORM/RPO/RTO proof; destroy it only after
  two-person sign-off.
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
   managed Supabase PostgreSQL. It creates `pintpath_runtime`,
   `pintpath_migrator`, and a database-scoped read-only group named exactly
   `pintpath_logical_backup_d<current-database-oid>`. The OID is the canonical
   positive decimal OID of `current_database()`, with no leading zero. The
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
   with no repeated grants or policy writes. Apply it through the separately
   reviewed migration-administrator path; do not rerun it while a versioned
   backup login is attached. The bootstrap and migration deliberately avoid
   broad `ALTER ROLE` repair. Any unsafe pre-existing state aborts with SQLSTATE
   `42501` and requires independent remediation.

2. While production is still serving normally, prove that the independent
   deletion authority is readable and export its mutually consistent current,
   genesis, checkpoint, and immutable-set bindings into a new private
   directory:

   ```sh
   SUPABASE_URL=<production-origin> \
   OFFSITE_BACKUP_SUPABASE_URL=<independent-operational-copy-origin> \
   OFFSITE_BACKUP_BUCKET=<private-bucket> \
   npm run db:postgres:migration -- ledger-export \
     --service-role-key-file /absolute/private/offsite-service-role.key \
     --output-dir /absolute/private/release-id/deletion-ledger-authority
   ```

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
   not receive migrator or operations-schema privileges. Put the direct,
   TLS-required, non-pooler migrator URL in a mode-600 file, then inspect the
   target before approval:

   The URL must carry exactly one of `sslmode=require`, `sslmode=verify-ca`, or
   `sslmode=verify-full`. The migration client applies standard libpq semantics
   internally; callers do not need to add `uselibpqcompat=true`. Plain
   `require` guarantees encryption but does not authenticate the server
   certificate, so use it only through the separately authenticated, pinned
   provider tunnel. As in libpq, adding `sslrootcert` promotes `require` to
   CA verification.
   `verify-ca` requires one explicit `sslrootcert` and verifies the certificate
   chain without hostname matching. `verify-full` verifies both the certificate
   chain and hostname and is preferred wherever the provider endpoint supports
   it. If `uselibpqcompat=true` is already present it is accepted, while false
   or duplicate compatibility flags fail closed. Inspection and every later
   gate hash the exact original URL bytes—including whether that optional flag
   is present—rather than the normalized private client copy. Do not edit the
   URL file after its hash has been approved.

   ```sh
   npm run db:postgres:migration -- inspect-target \
     --target-url-file /absolute/private/target-migrator-url.key \
     --target-ddl /absolute/repository/src/db/postgres-schema.sql \
     --target-ddl-sha256 <trusted-64-hex-ddl-sha256>
   ```

   Register the returned target identity, URL, and DDL hashes privately. A
   changed URL, database/cluster identity, DDL, candidate, plan, approval,
   operator, verifier, or environment is a hard stop.

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
     --target-identity-sha256 <approved-64-hex-target-identity-sha256> \
     --expected-environment permanent-staging \
     --candidate-sha <frozen-40-or-64-hex-sha> \
     --approval-reference <signed-change-reference> \
     --operator-id <private-operator-reference> \
     --verifier-id <private-independent-verifier-reference> \
     --output-receipt /absolute/private/release-id/apply-receipt.json
   ```

7. Run the read-only verifier with the same exact inputs and a second new
   receipt path. It rechecks the sealed SQLite/evidence/deletion authority,
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
     --target-identity-sha256 <approved-64-hex-target-identity-sha256> \
     --expected-environment permanent-staging \
     --candidate-sha <frozen-40-or-64-hex-sha> \
     --approval-reference <signed-change-reference> \
     --operator-id <private-operator-reference> \
     --verifier-id <private-independent-verifier-reference> \
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
- [ ] Complete the three remaining staging provider credential/configuration
  gates, deploy the reviewed app, and verify provider/domain/callback bindings.
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
- [x] Create an independently verified logical PostgreSQL export from permanent
  staging with its archive, version-2 manifest, and complete state receipt.
- [x] Upload that frozen logical set to the isolated staging-offsite Supabase
  project, verify the complete remote object set, and pass the live
  database-bound readiness probe.
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
  was read or copied as implementation evidence. Execute and independently
  verify the substantive capture described in
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
  live restore/application/RPO/RTO evidence remains open.
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
role settings and exactly one membership: direct membership in the matching
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

Operational provisioning is **STOP** until the reviewed in-process helper can
accept a precomputed SCRAM-SHA-256 verifier, bind it without command-line or SQL
log exposure, validate the resulting catalog contract, and emit only secret-
free evidence. Manual plaintext `CREATE ROLE ... PASSWORD`, `psql` variable
substitution, and hand-built dynamic SQL are forbidden. PostgreSQL 17
membership options must ultimately be explicit rather than relying on defaults.
The following is a structural contract only; it is deliberately non-executable
and is not an authorization to provision or rotate a live credential:

```text
NON-EXECUTABLE ROLE CONTRACT
name: pintpath_logical_backup_d{verified-current-database-oid}_v{positive-version}
attributes: LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
            NOREPLICATION, NOBYPASSRLS, CONNECTION LIMIT 2
password input: precomputed SCRAM-SHA-256 verifier, never plaintext
membership: matching pintpath_logical_backup_d{verified-current-database-oid}
            with ADMIN FALSE, INHERIT FALSE, SET TRUE
direct ACLs: non-grantable CONNECT on this database only; non-grantable EXECUTE
             on this database's pg_catalog.pg_control_system() only
```

Never put the password or resulting URL in Git, command arguments, logs, or
evidence. Keep the direct, non-pooler URL with exactly
`sslmode=verify-full` in a current-user-owned mode-600 file. The backup client
forces Node certificate verification and libpq `PGSSLROOTCERT=system`; no
weaker production TLS mode is accepted. Separately obtain the trusted
lowercase SHA-256 of the logical trimmed URL from the reviewed provisioning
authority. Do not derive that pin from the mutable URL file during the backup
ceremony. The exact connection limit of two bounds the
exported-snapshot holder plus the `pg_dump` reader; any other value fails
closed. Inability to read `pg_control_system()` is a hard failure, not a reason
to use a superuser. The
output directory must be a new path inside the mode-700 release evidence
directory:

```sh
npm run db:postgres:backup:logical -- \
  --connection-file /absolute/private/postgres-backup-url.key \
  --expected-source-url-sha256 "$EXPECTED_SOURCE_URL_SHA256" \
  --output /absolute/private/release-id/postgres-logical
```

The command accepts PostgreSQL 17 only. Before tool discovery, connection, or
output creation, it requires the exact trimmed URL to match the supplied source
pin. It binds the login and group OID segment to the live source database OID,
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
The custom archive contains only `pintpath_app` and `pintpath_ops`, has row
security enabled, and has no owner or ACL statements. Its portable policies
name no scoped source role: PostgreSQL may render the default `PUBLIC` target by
omitting the `TO` clause, and restore must still produce `polroles = ARRAY[0]`
with the exact live-database-OID predicate on all 59 tables. The mode-600 private
`state-receipt.json` commits to every column of all 56 authoritative tables,
`schema_metadata`, `migration_runs`, and `migration_chunks` in reviewed primary
key order, with bounded pages, exact native-type canonicalization, counts,
table/data/state/key-range hashes, source/database/snapshot hashes, and the
archive/manifest binding. `manifest.json` schema version 2 binds that receipt.
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
  --target-url-file /absolute/private/disposable-target-url.key \
  --target-identity-sha256 <inspected-64-hex-target-identity-sha256> \
  --receipt /absolute/private/release-id/postgres-logical-restore-receipt.json
```

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
migration-administrator path. It accepts that exact policy-only state and
constructs only the target-OID group and 61 target ACLs; provision a target-OID
versioned login separately afterward. A source-OID role must remain unable to
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
   authorised Postgres workflow. Then capture a new post-promotion PITR,
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
