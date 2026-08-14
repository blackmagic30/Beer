# PostgreSQL-native private Storage recovery-set foundation

Status: the authenticated capture/restore implementation and protected
promotion-recovery evidence contract are implemented and verified locally. No Supabase, Railway, AWS, production, or
permanent-staging resource was read or
mutated while implementing them. The live private-Storage capture and
empty-destination restore launch gates remain **OPEN** until genuine provider
receipts pass the protected attestation; repository code does not fabricate
that evidence.

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

- PostgreSQL is version 17, direct and non-pooler. Non-test URLs must be the
  exact Railway private `*.railway.internal:5432` authority with one
  `sslmode=verify-full` parameter. Capture and restore require a current-UID
  mode-0600 regular single-link self-signed root CA plus its independently
  reviewed DER SHA-256. They resolve exactly one fd12 address, dial that address
  once, and verify/SNI `localhost` with peer-certificate DER pinning. Generic
  host TLS, `sslmode=require`, `verify-ca`, public proxies, and URL CA paths fail
  closed.
- Database inspection activates `pintpath_migrator` in the PostgreSQL startup
  packet and proves `current_user=pintpath_migrator` while `session_user` is the
  restricted `NOINHERIT` LOGIN. It rejects runtime, maintenance, or any extra
  role membership, database/schema creation authority, and search-path drift.
  The transport is reasserted before and after database work and closed before
  success output.
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
  --root-ca-file /absolute/private/source-railway-root-ca.pem \
  --expected-root-ca-der-sha256 <reviewed-source-root-ca-der-sha256> \
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

`RESTORE_SUPABASE_URL` is the bare default HTTPS disposable destination
project-ref origin; custom domains and aliases are unsupported. No real
disposable Supabase project is checked into repository authority. The restore
therefore requires a canonical, SHA-pinned
`pintpath-private-storage-disposable-authority/v1` envelope signed by an
independently protected Ed25519 key. Its payload binds the frozen candidate,
exact destination origin/hash, target connection URL hash, target database
identity, hashed reviewer and public key, issue time, and expiry no more than
24 hours later. A URL and SHA supplied by the restore invocation alone are not
independent authority.
`--forbidden-origin-sha256s` is a comma-separated, duplicate-free set of
reviewed production, permanent-staging, source, and other protected origin
hashes. The destination origin must match none of them and cannot equal the
captured source even if the list is incomplete.

Do not run the restore command until a real disposable project has that signed
authority. Materialize the envelope, reviewer public key, target URL, target
root CA, and service key as separate current-user-owned mode-0600 files with
shell tracing disabled. Then use the exact command contract:

```sh
export RESTORE_SUPABASE_URL=https://<owned-disposable-project-ref>.supabase.co

PINTPATH_POSTGRES_PRIVATE_STORAGE_RESTORE=confirmed \
npm run --silent db:postgres:restore:private-storage-recovery -- \
  --backup-directory /absolute/private/retrieved/postgres-logical \
  --backup-manifest-sha256 <logical-manifest-sha256> \
  --recovery-set-directory /absolute/private/retrieved/private-storage-set \
  --recovery-set-sha256 <recovery-set-sha256> \
  --recovery-manifest-sha256 <recovery-manifest-sha256> \
  --target-connection-url-file /absolute/private/disposable-postgres-url \
  --target-connection-url-sha256 <reviewed-target-url-sha256> \
  --target-database-identity-sha256 <reviewed-target-identity-sha256> \
  --root-ca-file /absolute/private/disposable-railway-root-ca.pem \
  --expected-root-ca-der-sha256 <reviewed-disposable-root-ca-der-sha256> \
  --destination-origin-sha256 <signed-destination-origin-sha256> \
  --destination-authority-file /absolute/private/destination-authority.json \
  --destination-authority-sha256 <reviewed-authority-file-sha256> \
  --destination-authority-public-key-file /absolute/private/destination-reviewer.pem \
  --destination-authority-public-key-sha256 <protected-reviewer-key-sha256> \
  --expected-candidate-sha <frozen-candidate-sha> \
  --forbidden-origin-sha256s <production,staging,source-origin-sha256s> \
  --bucket-name-sha256 <reviewed-fixed-bucket-name-sha256> \
  --service-role-key-file /absolute/private/disposable-service-role.key
```

The illustrative `bcdef...` project ref formerly shown here was not an owned
project and remains unauthorized.

After that authority mechanism exists, require `ok=true`, exact expected
object/byte counts, and the original recovery-set and recovery-manifest hashes.
The deletion-authority-set hash is carried into the result, but this command
does not replay tombstones; run the separately reviewed nonzero deletion replay
and then the full recovered application/privacy checks.

## Frozen production-activation integration

The protected production ceremony is implemented in
`.github/workflows/activate-production-promotion-recovery.yml` under policy v2
SHA-256
`57f66c1c9dde912586ec510e37c28cc3dfea2c098e67c78edbea189c7dcc9988`.
It does not turn an operator-host example above into a live authority.

`production-capture` runs only on the JIT label
`pintpath-production-backup` inside the production private network. It captures
this private Storage set against the exact new logical manifest and deletion
authority, then seals the complete private recovery bundle into its WORM
authority. PITR observation occurs in the same capture job. Its GitHub artifact
contains only receipts and immutable content addresses, never Storage objects,
logical archive bytes, service keys, URLs, or root CAs.

`disposable-recover` runs only on the different JIT label
`pintpath-disposable-recovery` in the exact disposable private network. It
performs two independent reads: the logical-backup WORM reader creates
`logical-worm-retrieval-receipt.json`, while the private recovery-bundle WORM
reader creates `private-storage-worm-retrieval-receipt.json`. The latter
reconstructs this recovery-set directory directly into disposable tmpfs. The
job restores logical Postgres first, restores private Storage into the empty,
signed destination, replays the nonzero deletion set twice, and launches the
compiled candidate as a local child against the disposable Postgres, Redis,
Supabase Auth, and private Storage network. It then purges exactly the restored
Storage object set and emits `storage-purge-receipt.json`.

The separate always-run cleanup job must independently prove the exact Railway
and Supabase projects absent. A green Supabase terminal requires
`cleanupMode=orderly` and the SHA-256 of that exact purge receipt. Emergency
cleanup exists only for cancellation or an earlier failure and can never
finalize a green activation. The final activation binds 18 evidence leaves;
with `activation-receipt.json` and `tested-commit-sha.txt`, its exact artifact
contains 20 files. Use standard cancel only, and never force-cancel before both
provider absences are independently established. Before capture, install the
signed singleton run/candidate/target/workspace emergency arm and publish its
OPEN record through the protected dedicated-ref compare-and-swap manager. The
completion/15-minute/manual watchdog retries outside the activation run and
never supplies green activation evidence. It persists exact delete
acknowledgements and accepts them later only with fresh absence. Never create a
second arm before DISARMED; Railway workspace absence without an exact delete acknowledgement
is transfer-ambiguous and remains cleanup-needed.

## What remains open

The integration above is checked-in capability, not live recovery evidence.
Before launch, an authorized owner and independent verifier must still:

1. capture a substantive private bucket against the exact live logical backup;
2. retrieve the logical and private-bundle WORM authorities separately through
   their independent failure-domain readers;
3. restore into an empty, distinct disposable destination and retain the
   hash-only success result;
4. boot and exercise the complete recovered application;
5. replay the nonzero sealed deletion authority and prove prohibited data is
   absent; and
6. purge the restored Storage set, obtain orderly Supabase cleanup, prove both
   disposable providers absent, and measure and approve explicit RPO/RTO
   objectives; and
7. create the version-2 authority and two distinct approvals only after final
   activation, with `recoveryStartedAt` equal to immutable GitHub activation
   `run_started_at`, then pass protected attestation before route open.

Until genuine candidate-bound provider receipts satisfy every step, live
private-Storage recovery and the overall launch remain **NO-GO**.
