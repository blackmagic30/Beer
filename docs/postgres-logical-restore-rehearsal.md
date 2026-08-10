# PostgreSQL logical restore rehearsal foundation

Status: the database restore and nonzero deletion-ledger replay have passed
against an independently pinned disposable Railway PostgreSQL 17 target. The
staging pre-deletion logical set was retrieved byte-for-byte from the isolated
Supabase operational-copy bucket before restore. Neither procedure may target
production or a database that may be reused. Independent live-state review
passed before the exact replay database and its two temporary login roles were
removed; the broader restore project remains retained for the still-open full
application/private-Storage recovery gates.

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

## Exact sequence

Use physical canonical paths (`pwd -P`) throughout.

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
bucket, then restore it into a fresh inspected disposable target. Replay the
sealed three-file ledger authority only after the retrieval receipt, base
restore receipt, and target identity have been independently checked:

```sh
PINTPATH_POSTGRES_ACCOUNT_DELETION_REPLAY=confirmed \
npm run db:postgres:deletion:replay -- \
  --runtime-url-file /absolute/private/restore-runtime-url \
  --base-restore-receipt /absolute/private/evidence/postgres-logical-restore-receipt.json \
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

- `restore_failed` means `pg_restore` failed and the tool verified that both private schemas remain absent. The archive command always uses `--exit-on-error --single-transaction --no-owner --no-acl`.
- Any failure ending in `_target_disposal_required` means the database must be discarded in full. Do not repair it, rerun against it, or promote it.
- A source/target state mismatch, inability to finish the repeatable-read target
  scan, or target URL/artifact identity change after restore is
  `verification_failed_target_disposal_required`.
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

The local disposable PostgreSQL 17 integration proves the snapshot invariant
by committing a write after receipt hashing but before `pg_dump`; both the
archive and receipt exclude it through the one exported snapshot. Separately,
the provider-backed staging proof above retrieved the operational copy,
restored the independently pinned disposable target, and replayed one authentic
synthetic tombstone twice. Neither proof includes private Storage recovery, a
full application boot, PITR, provider-enforced WORM, approved RPO/RTO
objectives, or any production restore/cutover.

The archive intentionally contains no owners or ACLs. The restore command therefore reapplies a fixed least-privilege ACL contract transactionally and records only that contract's SHA-256. Cluster-global roles, role memberships, database settings other than the disposable marker, extensions outside the two private schemas, and provider-level PITR/retention configuration are not part of this archive and must be tested separately.
