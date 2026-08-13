# PostgreSQL logical restore rehearsal foundation

Status: the database restore and nonzero deletion-ledger replay have passed
against an independently pinned disposable Railway PostgreSQL 17 target. The
staging pre-deletion logical set was retrieved byte-for-byte from the isolated
Supabase operational-copy bucket before restore. Neither procedure may target
production or a database that may be reused. Independent live-state review
passed before the exact replay database and its two temporary login roles were
removed; the broader restore project remains retained for the still-open full
application/private-Storage recovery gates.

The current pinned-binary restore and tombstone-replay implementations are
review-only and do not authorize a new live ceremony. The historical proof
above predates this wiring.
Activation still requires an immutable digest-pinned executable, dynamic-loader,
and complete shared-library closure (or a reviewed descriptor-native launcher),
plus dedicated restore and replay workers that start with frozen intrinsics in
pristine realms before any import or secret read. The ordinary `npm`/`tsx`
commands below are not those workers.

## What this proves

The restore command authenticates a strict historical version-2 or current
version-3 manifest, private source-state receipt, and archive before opening a
database connection. Version 3 additionally binds the exact backup transport
profile and root-certificate DER SHA-256. It restores both
private schemas in one `pg_restore --single-transaction`, reconstructs the
reviewed ACL model, and verifies:

- the exact disposable database identity selected by the operator;
- 56 authoritative tables, the current reviewed contract column count, and 76 foreign keys;
- the exact `schema_metadata` key set and `import_state=ready` binding;
- FORCE RLS on every private table;
- every column and row of all 56 authoritative tables in migration-contract
  primary-key order using the same exact native-type canonical hashes captured
  from the exported backup snapshot;
- every archived `schema_metadata`, `migration_runs`, and `migration_chunks`
  row and column in primary-key order, including exact timestamps and operation
  evidence rather than count-only checks;
- no private-schema access for PUBLIC or the Supabase API roles;
- reviewed runtime application access with no runtime access to `pintpath_ops`;
- reviewed migrator read/import/reconciliation access; and
- the source database/URL/snapshot, archive, manifest, migration contract,
  schema metadata, DDL, table/data/state/key-range, and archived-control
  bindings; and
- a private canonical restore receipt with
  `promotionReconciliationReady=true` only after exact source/target equality.

The table, column, and foreign-key expectations are read from the generated migration contract. They are not duplicated in the restore implementation.

## Required containment

Create a fresh disposable PostgreSQL database on a non-production cluster. Before using this tool:

1. Provision `pintpath_runtime` and `pintpath_migrator` through the separately reviewed cluster bootstrap. The restore command will not create or alter cluster-global roles. Both roles must be `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`, and `INHERIT`.
2. Set the database-level marker `pintpath.logical_restore_target_class` to the exact value `disposable-rehearsal` with `ALTER DATABASE` from the disposable cluster administrator.
3. Confirm that neither `pintpath_app` nor `pintpath_ops` exists. Empty pre-created schemas are also rejected because the archive owns `CREATE SCHEMA`.
4. Use a direct PostgreSQL endpoint. Poolers, port 6543, URL fragments, URL options, and non-TLS connections are rejected by the production API.
5. Put the complete target URL in a current-user-owned regular mode-0600 file. Do not export it through `DATABASE_URL`, put it on the command line, or store it in a receipt directory.
6. Use the untouched mode-0700 backup directory created by the logical-backup
   command. It must contain exactly `manifest.json`, `state-receipt.json`, and
   `pintpath-postgres.dump`, all current-user-owned mode-0600 regular files.
   The manifest is accepted only as canonical schema version 2 or 3 and must
   bind the exact source receipt and archive. Version 3 requires its exact
   transport binding; version 2 is historical restore/retrieval compatibility
   only. Version 1/count-only archives fail closed.
7. Create a current-user-owned mode-0700 evidence directory for the receipt. The receipt file must not already exist.
8. Independently retain the canonical absolute `pg_restore` path and its exact
   lowercase SHA-256. The basename must be `pg_restore`; bare names, `PATH`
   lookup, symlinks, and unpinned binaries fail closed. The tool must report an
   exact PostgreSQL 17 version.
9. Isolate the disposable target and its credential. No other person, service,
   pool, or automation may hold a usable target credential during the ceremony.
   The restore checks `pg_stat_activity` for zero other client backends before
   mutation, immediately after `pg_restore`, and after verification, but those
   are point-in-time observations rather than durable admission control.

## Exact sequence

Use physical canonical paths (`pwd -P`) throughout.
Every connection-URL or service-key file in this sequence is an exact-byte
input: it must contain one value with no leading/trailing whitespace, CR/LF, or
NUL. With shell tracing disabled, transfer the protected value using a
no-line-ending writer equivalent to `printf '%s' "$VALUE" > "$FILE"`; never
use `echo` or print the value during verification.

```sh
npm run db:postgres:restore:logical -- inspect-target \
  --target-url-file /absolute/private/target-postgres-url
```

Record the returned `targetIdentitySha256` through the protected release-evidence process. The output contains no database name, login, URL, or local path.

For an operational-copy recovery drill, first retrieve the three-file backup
with section 4 of
[postgres-logical-offsite-attestation.md](postgres-logical-offsite-attestation.md).
Use that untouched retrieved directory below; do not substitute the local
pre-upload directory and claim provider retrieval evidence.

Then run the mutation only after an independent operator has compared that hash with the intended disposable database:

```sh
PINTPATH_POSTGRES_LOGICAL_RESTORE=confirmed \
npm run db:postgres:restore:logical -- restore \
  --backup-directory /absolute/private/postgres-logical-backup \
  --backup-manifest-sha256 <trusted-64-hex-manifest-sha256> \
  --pg-restore-file /absolute/reviewed/postgresql-17/bin/pg_restore \
  --expected-pg-restore-sha256 <trusted-lowercase-pg-restore-sha256> \
  --target-url-file /absolute/private/target-postgres-url \
  --target-identity-sha256 <inspected-64-hex-target-identity-sha256> \
  --receipt /absolute/private/evidence/postgres-logical-restore-receipt.json
```

The operator-mutation guard is separate from the exact confirmation. If restore-containment environment variables are present in the shell, the command fails closed.

## Nonzero account-deletion recovery proof

Use only wholly synthetic staging identities with no Supabase Auth or Stripe
identifier. Preparation creates one local Free account, one app session, one
expired deletion request, and one held completion-notification secret through
the restricted runtime repositories. It never calls an email/provider adapter.
The logical backup must be captured after `prepare` and before `complete`.

```sh
PINTPATH_POSTGRES_ACCOUNT_DELETION_RECOVERY_PROOF=confirmed \
npm run db:postgres:deletion:recovery-proof -- prepare \
  --runtime-database-url-file /absolute/private/staging-runtime-url \
  --expected-database-identity-sha256 <staging-database-identity-sha256> \
  --fixture-receipt /absolute/private/evidence/deletion-fixture.json

npm run db:postgres:deletion:recovery-proof -- inspect \
  --runtime-database-url-file /absolute/private/staging-runtime-url \
  --fixture-receipt /absolute/private/evidence/deletion-fixture.json \
  --fixture-receipt-sha256 <fixture-receipt-sha256>
```

Create and verify a new version-3 logical backup at this point. Then complete the
live synthetic deletion. The service-role key file must belong to the isolated
operational-copy project; destination origin and bucket pins must be reviewed
independently before invocation.

```sh
PINTPATH_POSTGRES_ACCOUNT_DELETION_RECOVERY_PROOF=confirmed \
npm run db:postgres:deletion:recovery-proof -- complete \
  --runtime-database-url-file /absolute/private/staging-runtime-url \
  --fixture-receipt /absolute/private/evidence/deletion-fixture.json \
  --fixture-receipt-sha256 <fixture-receipt-sha256> \
  --logical-backup-state-receipt /absolute/private/pre-delete/state-receipt.json \
  --logical-backup-state-receipt-sha256 <state-receipt-sha256> \
  --ledger-authority-output /absolute/private/evidence/deletion-ledger-authority \
  --completion-receipt /absolute/private/evidence/deletion-completion.json \
  --completed-at <canonical-millisecond-UTC> \
  --service-role-key-file /absolute/private/offsite-service-role.key \
  --expected-destination-origin-sha256 <reviewed-origin-sha256> \
  --expected-bucket-name-sha256 <reviewed-bucket-sha256>
```

Retrieve that exact pre-deletion backup from the isolated operational-copy
bucket, then restore it into a fresh inspected disposable target. Retain the
exact lowercase SHA-256 returned only by a successful restore receipt
publication; do not derive replay authority by hashing whichever file is later
present at that pathname. Replay the sealed three-file ledger authority only
after the retrieval receipt, base restore receipt and its retained success
digest, and target identity have been independently checked:

```sh
PINTPATH_POSTGRES_ACCOUNT_DELETION_REPLAY=confirmed \
npm run db:postgres:deletion:replay -- \
  --runtime-url-file /absolute/private/restore-runtime-url \
  --base-restore-receipt /absolute/private/evidence/postgres-logical-restore-receipt.json \
  --expected-base-restore-receipt-sha256 <retained-success-receipt-sha256> \
  --deletion-ledger-authority-directory /absolute/private/evidence/deletion-ledger-authority \
  --expected-target-identity-sha256 <target-identity-sha256> \
  --expected-ledger-current-sha256 <ledger-current-sha256> \
  --expected-ledger-genesis-sha256 <ledger-genesis-sha256> \
  --expected-ledger-checkpoint-sha256 <ledger-checkpoint-sha256> \
  --expected-ledger-immutable-set-sha256 <ledger-immutable-set-sha256> \
  --expected-tombstone-count 1 \
  --receipt /absolute/private/evidence/deletion-replay.json
```

Require the first replay to report one newly applied tombstone and the second to
report one already-applied tombstone with the same semantic projection hash.
The restored request must be completed, its outbox `suppressed_restore`, all app
sessions and recipient secrets absent, and the physical secret checkpoint
acknowledged. Any failure marked `targetDisposalRequired` permanently disqualifies
that disposable database.

The executed staging proof completed this whole sequence with one authentic,
wholly synthetic tombstone produced by the staging deletion workflow. The
first replay reported `newlyApplied=1`; the second reported `alreadyApplied=1`;
both reported the same semantic projection, and restricted runtime readiness
remained green after replay. This closes the logical transport, database
restore, substantive synthetic deletion, and replay-idempotency gates for that
recorded staging set only.

## Failure handling

- The archive is supplied to `pg_restore` through separate, held file descriptors
  for listing and mutation; the validated archive pathname is never reopened by
  either child. The archive command always uses
  `--exit-on-error --single-transaction --no-owner --no-acl`.
- One purpose-bound restore authority retains the reviewed `pg_restore`
  descriptor across version, list, target preflight, and mutation. It rechecks
  the exact binary around each allowed operation, receives a closed fixed
  environment, and is closed exactly once before privilege hardening or receipt
  creation. The caller separately retains full digest-bound archive evidence;
  the authority's archive inode join is supplemental, not a content proof.
- Any rejected, non-zero, or diagnostically non-empty `pg_restore` mutation is
  `restore_rollback_unverified_target_disposal_required`. Reaping the local
  process does not prove that its PostgreSQL backend cannot finish a transaction,
  so an immediate schema-absence query is never treated as rollback proof.
- Any failure ending in `_target_disposal_required` means the database must be discarded in full. Do not repair it, rerun against it, or promote it.
- A source/target state mismatch, inability to finish the repeatable-read target
  scan, or target URL/artifact identity change after restore is
  `verification_failed_target_disposal_required`.
- Tool/archive drift, process uncertainty, a remaining client backend, or any
  authority/archive/target-connection close uncertainty after restore starts
  also requires whole-target disposal. Before mutation, an authority close
  failure fails closed as `tool_unavailable_or_unsupported` without creating a
  restore receipt.
- Success closes the dedicated target session while its session advisory lock
  is still held; it does not issue a separate unlock query before receipt
  creation. The receipt is read back and hashed through its held descriptor,
  file- and parent-directory-fsynced, identity-checked, and closed before its
  hash is returned. A failed close never authorizes a receipt.
- Failed receipt publication may leave an unauthorized final-path leaf because
  the writer never deletes by pathname after losing exact descriptor custody.
  Never consume, locally rehash, or use that leaf to manufacture the replay
  pin. Tombstone replay requires the independently retained digest returned by
  successful publication and compares it with the exact trusted file snapshot
  before receipt parsing, ledger-authority loading, connection, or mutation.
- Replay authenticates that successful digest and the sealed ledger before
  reading its runtime URL, wipes the source buffers after parsing, and reasserts
  all authorities after its sole database session closes. Its output receipt
  must use a different mode-0700 parent from both the runtime credential and
  exact three-file ledger directory. Database/descriptor, file-or-parent
  fsync/close, or CLI success-output uncertainty requires disposal and leaves
  any retained replay leaf unauthorized.
- The tool never drops schemas, uses `--clean`, overwrites a receipt, prints child-process diagnostics, or removes an operator-created target.
- A successful rehearsal target is still disposable. Destroy it after the protected evidence has been retained.

## Deliberate limitations

The receipt proves exact equality between the logical archive's exported
PostgreSQL snapshot and the restored private-schema state. It does not by
itself prove that the earlier SQLite migration source, private evidence tree,
deletion-ledger authority, or provider PITR/Storage/WORM recovery set was
complete. Those remain bound by the migration snapshot, plan, apply receipt,
independent `verify-target` receipt, and the full-scale runbook's provider and
two-person RPO/RTO gates.

The required isolated CI PostgreSQL 17 integration proves the snapshot
invariant by committing a write after receipt hashing but before `pg_dump`;
both the archive and receipt exclude it through the one exported snapshot. Its
source data, CA, route, database, and roles are synthetic and disposable.
Separately, the provider-backed staging proof above retrieved the operational
copy, restored the independently pinned disposable target, and replayed one
authentic synthetic tombstone twice. Neither proof includes private Storage
recovery, a full application boot, PITR, provider-enforced WORM, approved
RPO/RTO objectives, or any production restore/cutover.

Pinned tool custody does not yet bind the pathname Node passes to `spawn`, the
dynamic loader, or libpq/OpenSSL/zstd and the rest of the shared-library tree. A
same-UID pathname toggler can exploit that execution gap, and a substituted
child can call `setsid` outside the reviewed process-group observation. The
entire restore and replay wrappers—not only the tool-authority module—must run
in pristine frozen-intrinsics realms. Ordinary async carriers currently include
plaintext connection material, parsed `PGPASSWORD`, connection capabilities,
tombstone identifiers, and query rows that inherited `then` poisoning could
observe. The current CLIs do not provide that containment.

The restore's three and replay's two backend-quiescence checks cannot prevent a
newly authorized client from connecting after the final observation. Replay
disables idle retirement of its sole pooled backend, rejects any pool error or
non-empty post-close metrics, and places its final advisory-lock proof
immediately before close; activation still requires that reviewed one-session
dependency and exclusive credential custody. Likewise, both receipt writers
retain and fsync the reviewed parent directory, but portable Node does not
provide the fd-relative `openat`/`O_EXCL` operation needed to atomically bind
the new leaf against a hostile current-UID namespace toggler. Activation
therefore also requires exclusive target-credential custody and a protected,
immutable filesystem namespace. These are launch blockers, not properties
proved by the review-only implementation.

The archive intentionally contains no owners or ACLs. The restore command therefore reapplies a fixed least-privilege ACL contract transactionally and records only that contract's SHA-256. Cluster-global roles, role memberships, database settings other than the disposable marker, extensions outside the two private schemas, and provider-level PITR/retention configuration are not part of this archive and must be tested separately.
