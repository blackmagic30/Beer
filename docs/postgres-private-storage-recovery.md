# PostgreSQL-native private Storage recovery-set foundation

Status: implemented and verified locally with unit tests plus a restricted-login
PostgreSQL 17 integration test. No Supabase, Railway, AWS, production, or
permanent-staging resource was read or mutated while implementing this
foundation. The live private-Storage capture and empty-destination restore
launch gates remain **OPEN**.

The recovery set joins four authorities that must describe one database
snapshot:

- the exact three-file PostgreSQL logical backup set (version 3 for every new
  capture; historical version 2 is restore-only);
- a repeatable-read inventory of all PostgreSQL logical state and every live
  `supabase_private` `source_evidence_objects` reference;
- a stable, complete inventory and byte-for-byte copy of the fixed private
  `beermap-source-evidence` bucket; and
- the sealed account-deletion current ledger, genesis, and checkpoint.

The canonical version-2 manifest binds every logical-backup hash, source
identity, ready migration-run SHA-256, source environment, independently
expected candidate commit SHA, source URL hash, Storage origin and bucket hash,
original object path, strict MIME, size, byte SHA-256, hashed Storage object
ID/version, live-reference flag, deletion-authority hash, and an exact
version-2 domain-separated recovery-set SHA-256. Original Storage keys remain
verbatim in the manifest. Local payload filenames are deterministic path
hashes, avoiding case-folding and path-depth ambiguity.

## Fixed safety contract

- PostgreSQL is version 17, direct and non-pooler. Production URLs require TLS.
- The versioned backup login is `LOGIN`, `NOINHERIT`, `NOSUPERUSER`,
  `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`; it can set
  only its matching database-OID-scoped backup group, cannot set the migrator
  or runtime roles, and has direct non-grantable `CONNECT` plus
  `pg_control_system()` execution only.
- The source and target PostgreSQL URL bytes are independently SHA-256 pinned.
- The Storage bucket name is exactly `beermap-source-evidence`. It must be
  private, have an exact 8 MiB file limit, and allow exactly PDF, JPEG, PNG,
  WebP, HEIC, and HEIF.
- Capture accepts only the exact repository-owned permanent-staging or
  production environment label and maps that label internally to its one exact
  project-ref Storage origin. A cross-pair, a mismatched origin hash, other
  canonical Supabase projects, custom domains, and aliases fail before either
  credential file is read.
- The operator supplies an independently reviewed 40- or 64-character lowercase
  candidate commit SHA. Before any Storage request or output creation, the
  repeatable-read database inspector requires `schema_metadata.import_state` and
  the referenced `migration_runs` row to be `ready`, requires the run receipt,
  verifier, and completion fields, and proves the metadata/run candidate and
  environment match that independent authority. The same run, environment, and
  candidate are rechecked after the object capture.
- Object paths are canonical and bounded. Objects are non-empty and at most
  8 MiB; one recovery set supports at most 10,000 objects and 50 GiB.
- Capture lists and inspects the complete bucket twice, performs an
  info/download/info identity fence for every object, uses a unique cache nonce
  and `cache: no-store`, bounds streamed bodies, and rechecks bucket privacy and
  policy.
- Every live PostgreSQL reference must match exactly one Storage object by
  path, MIME, and size. Unreferenced bucket objects are retained and identified
  as orphans; missing or mismatched references fail capture.
- Capture writes only to a new current-user-owned mode-700 directory with
  mode-600 files. It reopens and validates the complete generated set before
  returning its hash pins.
- A failed capture does not authorize recursive cleanup or path reuse. Preserve
  its mode-700 partial directory for forensic review and retry with a fresh
  output path. Only a successful hash-only result authorizes later restore.
- Capture accepts only a schema-version-3 logical manifest with the pinned-CA
  transport binding. Restore accepts canonical historical version 2 or current
  version 3; it never upgrades old bytes or lets version 2 authorize a new
  capture.
- Restore requires a distinct canonical Supabase project-ref Storage origin,
  an independently pinned disposable target database, exact source-state
  equality, a private policy-matching bucket, and a completely empty
  destination inventory. Custom domains and DNS aliases are unsupported
  because a different hostname does not prove a different Supabase project.
- Uploads are immutable (`upsert=false`). Each upload is read immediately; the
  complete destination is then listed and re-downloaded with object-ID/version
  binding. PostgreSQL state, references, bucket policy, the exact local
  directory tree, logical backup, and deletion authority are fenced again,
  followed by one final identical destination inventory immediately before
  success.
- Any failure after the first upload is reported with
  `destinationDisposalRequired=true`. Do not repair or reuse that destination;
  dispose of the exact recorded rehearsal resource through the separately
  approved teardown procedure.

## Capture

Use an operator-owned mode-700 evidence root. The logical-backup directory and
deletion-authority directory must each contain exactly their canonical files,
owned by the current user and mode 600. Put the direct PostgreSQL URL and
source-project service-role key in separate current-user-owned mode-600 files.
Do not place either secret in arguments, environment output, logs, or evidence.
Both files are exact-byte inputs: they must contain one value with no
leading/trailing whitespace, CR/LF, or NUL. With shell tracing disabled,
transfer each protected value using a no-line-ending writer equivalent to
`printf '%s' "$VALUE" > "$FILE"`; never use `echo` or print the value during
verification. The same rule applies to the future restore URL/key files.

`SUPABASE_URL` must be one of the two repository-owned capture-source Storage
origins exactly: permanent staging
`https://bbfibbadwjxzrcdncavy.supabase.co` or production
`https://jxpubqlmqnnqwadmjgyk.supabase.co`. Permanent-staging Phase 5 must use
the permanent-staging origin and that project's server key; a later production
capture must use the production origin and key. The logical state, source
origin hash, and Storage objects must all describe the same selected source.
The Auth custom origin `https://auth.pintpath.au`, other canonical Supabase
projects, custom domains, and aliases fail closed. All SHA-256 values below
must come from an independently reviewed release record or the already verified
logical/deletion receipts; do not bless the current environment by calculating
pins immediately before the command.

Pass `--source-environment permanent-staging` for Phase 5 (or `production` only
for a separately reviewed production capture). Pass the exact candidate SHA
from the frozen release record through `--expected-candidate-sha`; do not derive
it from the database being tested. The CLI verifies the environment-to-origin
mapping and the exact reviewed origin hash before reading either secret file.

```sh
# Permanent-staging Phase 5 (use the production project-ref origin only for a
# separately reviewed production capture):
export SUPABASE_URL=https://bbfibbadwjxzrcdncavy.supabase.co

npm run --silent db:postgres:backup:private-storage-recovery -- \
  --backup-directory /absolute/private/release/postgres-logical \
  --backup-manifest-sha256 <logical-manifest-sha256> \
  --connection-url-file /absolute/private/source-postgres-url \
  --connection-url-sha256 <state-receipt-source-url-sha256> \
  --deletion-authority-directory /absolute/private/deletion-authority \
  --source-environment permanent-staging \
  --expected-candidate-sha <reviewed-frozen-candidate-sha> \
  --ledger-current-sha256 <current-json-sha256> \
  --ledger-genesis-sha256 <genesis-json-sha256> \
  --ledger-checkpoint-sha256 <checkpoint-json-sha256> \
  --ledger-immutable-set-sha256 <immutable-set-sha256> \
  --ledger-tombstone-count <exact-decimal-count> \
  --source-origin-sha256 <reviewed-source-origin-sha256> \
  --bucket-name-sha256 <reviewed-fixed-bucket-name-sha256> \
  --service-role-key-file /absolute/private/source-service-role.key \
  --output-directory /absolute/private/release/private-storage-recovery-set \
  > /absolute/private/release/private-storage-capture-result.json

chmod 600 /absolute/private/release/private-storage-capture-result.json
```

Require `ok=true`, the expected nonzero object/reference/tombstone counts for
the drill, and independently retain `recoverySetSha256` plus
`recoveryManifestSha256`. Standard output contains hashes, timestamps, and
decimal counts only. Its `schemaVersion=1` is intentionally the stable CLI
result-envelope version; it is distinct from recovery-manifest version 2 and
recovery-set binding version 2.

## Restore to an empty distinct destination

First restore and exactly verify the bound logical backup using
[postgres-logical-restore-rehearsal.md](postgres-logical-restore-rehearsal.md).
The target must retain the database-level marker
`pintpath.logical_restore_target_class=disposable-rehearsal`. Create the fixed
Storage bucket in that same separately approved disposable Supabase project
before this command; this tool never creates or reconfigures a bucket.

`RESTORE_SUPABASE_URL` will be the bare default HTTPS disposable destination
project-ref origin; custom domains and aliases are unsupported. No real
disposable Supabase project is currently registered in repository-owned,
candidate-bound release authority. Consequently, the checked-in CLI rejects
every destination before reading the target database URL or service key. A URL
and SHA-256 supplied by the same invocation are not independent authority.
`--forbidden-origin-sha256s` is a comma-separated, duplicate-free set of
reviewed production, permanent-staging, source, and other protected origin
hashes. The destination origin must match none of them and cannot equal the
captured source even if the list is incomplete.

Do not run the restore command until a real disposable project is registered
through an independently reviewed signed/sealed authority bound to the frozen
candidate. The illustrative `bcdef...` project ref formerly shown here was not
an owned project and is deliberately not accepted by the code.

After that authority mechanism exists, require `ok=true`, exact expected
object/byte counts, and the original recovery-set and recovery-manifest hashes.
The deletion-authority-set hash is carried into the result, but this command
does not replay tombstones; run the separately reviewed nonzero deletion replay
and then the full recovered application/privacy checks.

## What remains open

This foundation is not live recovery evidence. Before launch, an authorized
operator and independent verifier must still:

1. capture a substantive private bucket against the exact live logical backup;
2. retrieve any required offsite/WORM authorities through their independent
   failure-domain procedure;
3. restore into an empty, distinct disposable destination and retain the
   hash-only success result;
4. boot and exercise the complete recovered application;
5. replay the nonzero sealed deletion authority and prove prohibited data is
   absent; and
6. measure and approve explicit RPO/RTO objectives before disposing only the
   recorded rehearsal resources.
