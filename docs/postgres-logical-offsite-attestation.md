# PostgreSQL logical backup operational-copy attestation

Status: the isolated permanent-staging upload, live database-bound readiness
probe, and one complete byte-for-byte retrieval have passed. This remains a
mutable same-provider operational copy, not provider-enforced WORM evidence.

This runbook publishes an already-created, hardened PostgreSQL 17 logical
backup to the existing private Supabase **operational restore-copy** bucket,
verifies the remote bytes and metadata, and only then records the bounded
hash-only `job:postgres_logical_backup_success` system-state attestation.

It does not run `pg_dump` in the web process, create a provider project or
bucket, change provider billing, prune old objects, or replace the separately
maintained account-deletion tombstone ledger. This operational copy is mutable
and same-provider; it is not the separately administered WORM disaster-recovery
authority required for full-scale recovery assurance.

## 1. Preconditions

Complete these checks from a protected operator host, not a Railway web shell:

- Exact canonical absolute paths to reviewed PostgreSQL 17 `pg_dump` and
  `pg_restore` binaries and their independently retained lowercase SHA-256
  pins are available to the hardened local logical-backup command. Bare names
  and ambient `PATH` lookup are rejected.
- The production backup login is direct, TLS-protected, read-only, separate
  from the runtime login, and named exactly
  `pintpath_logical_backup_d<current-database-oid>_v<positive-version>`. The
  database OID is the canonical positive decimal OID of `current_database()`;
  the version is 1–20 canonical decimal digits. It is `LOGIN`, `NOINHERIT`,
  `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`,
  `NOBYPASSRLS`, and has `CONNECTION LIMIT 2` exactly. It has no children or
  role settings, its catalog `rolvaliduntil` is `NULL` exactly, and it has
  exactly one direct role membership: the matching
  `pintpath_logical_backup_d<current-database-oid>` group with `ADMIN FALSE`,
  `INHERIT FALSE`, and `SET TRUE`; it cannot set `pintpath_migrator`,
  `pintpath_runtime`, or any sibling database-scoped backup role.
- The versioned login has exactly one direct, non-grantable database privilege
  (`CONNECT` on this source database) and one direct, non-grantable function
  privilege (`EXECUTE` on `pg_catalog.pg_control_system()`). It has no direct
  application/control object grants and owns no private objects. Its only two
  `pg_shdepend` rows are the current-database `CONNECT` and
  `pg_control_system()` ACL dependencies. The database-scoped group is
  `NOLOGIN`/`NOINHERIT`, has no parents or settings, database/function grants,
  or ownership, has `USAGE` without `CREATE` on both private schemas, and has
  direct non-grantable `SELECT` on exactly 59 reviewed tables. Its exact 61
  `pg_shdepend` rows are those two schema and 59 table ACLs in this database.
  The current contract contains zero sequences and grants the group no private-
  function execution.
- Every reviewed table has one permissive SELECT-only policy targeted to
  `PUBLIC`, but that policy admits only the exact current user named
  `pintpath_logical_backup_d` plus the live OID of `current_database()`. The
  policies carry no object authority and name no role. Any other private-schema
  policy fails closed, including an arbitrary nonreserved policy for a named
  sibling role. The complete allowlist is exactly 177 runtime/migrator policies
  before the upgrade and 236 policies after adding the 59 backups, with exact
  names, permissiveness, commands, role OID arrays, `USING`, and `WITH CHECK`.
  This makes the dump portable without allowing a source- or sibling-database
  scoped role to see target rows.
- The tracked `db:postgres:backup:login` manager generates the password and
  SCRAM-SHA-256 verifier in process, binds only the verifier after exact logger
  guards, provisions `NOLOGIN` before enabling `LOGIN` last, performs a fresh
  SASL/read-only canary, and writes only fixed secret-free receipts. Its
  repository implementation does not authorize a live ceremony. The manager
  and logical-backup client now share the reviewed
  `railway-stock-localhost-ca-v1` transport, but provisioning, retirement, and
  any later rotation remain operationally **STOPPED** until the exact mode-600
  root certificate, DER pin, private endpoint, source database identity, and
  integrated tracked SHA are independently approved. Do not manually execute
  `CREATE ROLE ... PASSWORD`, use `psql` password substitution, or weaken TLS.
- The exact 236 portable-policy inventory with the current-database scoped
  group absent is a safe, inert `policy-only` state, not backup authority.
  PostgreSQL 17 gives a role created by a non-superuser `CREATEROLE` principal
  an automatic administrator child that the creator cannot revoke, so the
  reviewed migrations never create the scoped group in that context. Continue
  only after a true cluster superuser runs the reviewed forward SQL or a
  separately reviewed helper atomically establishes and verifies the full
  zero-child group plus exact 61 ACL dependencies. A merely pre-created inert
  group is an unaccepted mixed state.
- The runtime login is the canonical `pintpath_runtime` login used by the app.
  It verifies runtime identity, supplies the exact connection-URL bytes whose
  SHA-256 is bound into the immutable attestation/latest pointer and success
  state, and writes the lease/attestation rows in `pintpath_app.system_state`.
- `OFFSITE_BACKUP_SUPABASE_URL` is a different HTTPS origin from `SUPABASE_URL`.
- `OFFSITE_BACKUP_BUCKET` already exists in that operational-copy project, is
  private, permits `application/json` and `application/octet-stream`, and its
  object limit is at least the archive size. Do not provision or resize it as
  part of this command.
- The approved release record contains the independently reviewed SHA-256 of
  the exact destination HTTPS origin and bucket name. Supply those protected
  pins verbatim. Do not calculate them from the current operator environment
  during this invocation; doing so would turn a misconfigured destination into
  first-use authority for the full archive.
- The service-role key is scoped to that operational-copy project. Treat it as
  destructive because it can overwrite the mutable latest pointer.
- The destination project must expose non-empty, bounded `id` and `version`
  values from Supabase Storage `info()` for every uploaded object. The command
  fails closed if this capability is absent.
- No restore-rehearsal marker is active. The shared operator mutation guard
  rejects this command inside a restore rehearsal.

Create four separate operator-owned paths. All secret files must be regular,
non-symlink files readable only by the current user; the backup output must not
exist yet.

```sh
umask 077
export RELEASE_ROOT=/absolute/private/pintpath-release-YYYYMMDDTHHMMSSZ
mkdir -m 700 "$RELEASE_ROOT"

export BACKUP_CONNECTION_FILE="$RELEASE_ROOT/postgres-backup-url"
export RUNTIME_DATABASE_URL_FILE="$RELEASE_ROOT/postgres-runtime-url"
export OFFSITE_SERVICE_ROLE_KEY_FILE="$RELEASE_ROOT/offsite-service-role.key"
export LOGICAL_BACKUP_DIRECTORY="$RELEASE_ROOT/postgres-logical-backup"
: "${EXPECTED_SOURCE_URL_SHA256:?inject the reviewed trimmed backup URL SHA-256}"
: "${EXPECTED_ROOT_CA_DER_SHA256:?inject the reviewed root certificate DER SHA-256}"
export POSTGRES_ROOT_CA_FILE="$RELEASE_ROOT/railway-postgres-root-ca.pem"
: "${PG_DUMP_FILE:?inject the reviewed canonical absolute pg_dump path}"
: "${EXPECTED_PG_DUMP_SHA256:?inject the reviewed lowercase pg_dump SHA-256}"
: "${PG_RESTORE_FILE:?inject the reviewed canonical absolute pg_restore path}"
: "${EXPECTED_PG_RESTORE_SHA256:?inject the reviewed lowercase pg_restore SHA-256}"

test -f "$BACKUP_CONNECTION_FILE" && test ! -L "$BACKUP_CONNECTION_FILE"
test -f "$RUNTIME_DATABASE_URL_FILE" && test ! -L "$RUNTIME_DATABASE_URL_FILE"
test -f "$OFFSITE_SERVICE_ROLE_KEY_FILE" && test ! -L "$OFFSITE_SERVICE_ROLE_KEY_FILE"
test -f "$POSTGRES_ROOT_CA_FILE" && test ! -L "$POSTGRES_ROOT_CA_FILE"
chmod 600 \
  "$BACKUP_CONNECTION_FILE" \
  "$RUNTIME_DATABASE_URL_FILE" \
  "$POSTGRES_ROOT_CA_FILE" \
  "$OFFSITE_SERVICE_ROLE_KEY_FILE"
test ! -e "$LOGICAL_BACKUP_DIRECTORY"
```

The backup URL must contain exactly one `sslmode=verify-full` value. The backup
library requires `railway-stock-localhost-ca-v1`: it holds the exact mode-600
single-certificate CA file, pins the X.509 DER hash, resolves exactly one
private `fd12::/16` address, authenticates the stock leaf as `localhost`, and
uses the same address and CA for Node and libpq with TLS 1.2 or newer. `require`,
`verify-ca`, system-root fallback, duplicate modes, and every `disable`
value fail before tool opening or a database connection. The runtime URL retains
its separately reviewed TLS contract. Obtain `EXPECTED_SOURCE_URL_SHA256` and
`EXPECTED_ROOT_CA_DER_SHA256` from the reviewed provisioning authority, not by
rehashing the mutable files during the ceremony. The exact URL and all supplied
pins and paths are snapshotted before tool opening. The URL pin is checked before
the sequential tool probes; the held CA file, DER pin, and transport contract
are checked after those probes but before database connection, output creation,
or temporary credential creation. Never put either URL, the CA path
or bytes, or the service-role key in command output, shell tracing, logs, Git,
screenshots, or the attestation evidence file.

The stock Railway Postgres SSL image cannot satisfy ordinary system-root
hostname verification: its private self-signed root is absent from the system
trust store and its [server leaf names only
`localhost`](https://github.com/railwayapp-templates/postgres-ssl/blob/35fb8234ad6c88d400c4be1f19d9a11d6c6c3564/init-ssl.sh), not the Railway private
DNS hostname. The named profile is the only accepted stock-image bridge. Keep
the live ceremony stopped until its exact CA file, DER pin, private endpoint,
and source database identity are independently approved. Rotation, DNS drift,
or fewer than 24 hours of CA validity requires a new approval. Do not weaken
either path to `sslmode=require`.

The complete non-secret provisioning/retirement flag set, mutation-arm
environment, escrow lifecycle, and forward-only recovery contract are in the
full migration runbook. In particular, a successful active login must retain
catalog `rolvaliduntil IS NULL` exactly; `infinity` and every timestamp fail
both manager and backup-runtime validation. Preserve the mode-600 provision
receipt and its external SHA-256 with the release authority. Retirement may
run only after the protected successful backup/retrieval evidence authorizes
loss of that credential; it disables the exact receipt-bound role before
terminating sessions and dependency-gated drop. It never performs overlapping
rotation, wildcard cleanup, `DROP OWNED`, or `CASCADE`.

## 2. Create the hardened local logical backup

```sh
export BACKUP_RESULT="$RELEASE_ROOT/logical-backup-result.json"
npm run --silent db:postgres:backup:logical -- \
  --connection-file="$BACKUP_CONNECTION_FILE" \
  --expected-source-url-sha256="$EXPECTED_SOURCE_URL_SHA256" \
  --transport-profile=railway-stock-localhost-ca-v1 \
  --root-ca-file="$POSTGRES_ROOT_CA_FILE" \
  --expected-root-ca-der-sha256="$EXPECTED_ROOT_CA_DER_SHA256" \
  --pg-dump-file="$PG_DUMP_FILE" \
  --expected-pg-dump-sha256="$EXPECTED_PG_DUMP_SHA256" \
  --pg-restore-file="$PG_RESTORE_FILE" \
  --expected-pg-restore-sha256="$EXPECTED_PG_RESTORE_SHA256" \
  --output="$LOGICAL_BACKUP_DIRECTORY" \
  >"$BACKUP_RESULT"
chmod 600 "$BACKUP_RESULT"

jq -e '.ok == true
  and .schemaVersion == 3
  and (.manifestSha256 | test("^[a-f0-9]{64}$"))
  and (.archiveSha256 | test("^[a-f0-9]{64}$"))
  and (.stateReceiptSha256 | test("^[a-f0-9]{64}$"))
  and (.overallStateSha256 | test("^[a-f0-9]{64}$"))' \
  "$BACKUP_RESULT"

export EXPECTED_MANIFEST_SHA256="$(jq -er '.manifestSha256' "$BACKUP_RESULT")"
test "$(stat -f '%Lp' "$LOGICAL_BACKUP_DIRECTORY" 2>/dev/null || stat -c '%a' "$LOGICAL_BACKUP_DIRECTORY")" = 700
```

The backup command creates exactly these mode-`600` files in the mode-`700`
directory:

- `pintpath-postgres.dump`
- `manifest.json`
- `state-receipt.json`

New manifests are schema version 3 and bind the exact named transport plus the
validated root-certificate DER SHA-256. The offsite writer and live readiness
gate reject historical version-2 manifests. Retrieval and restore retain strict
version-2 compatibility so existing evidence is not rewritten or stranded.

The URL password is never placed in `PGPASSWORD`. Immediately before
`pg_dump`, the command creates one exclusive mode-`600` pgpass leaf in a new
mode-`700` directory beneath the canonical operating-system temporary root.
It escapes the single exact host/port/database/user/password record, fsyncs and
snapshots it, exposes only `PGPASSFILE` to `pg_dump`, validates the same inode
and content afterwards, and removes it nonrecursively before inspecting the
dump result. Version probes and `pg_restore` never receive `PGPASSFILE`.
Missing, changed, multiply linked, replaced, or unexpectedly populated
temporary state returns `cleanup_failed`; an untrusted replacement path is
never deleted.

The archive pathname is not delegated to either PostgreSQL child. The command
requires the canonical output parent and newly created output directory to be
current-user-owned mode-`700` directories and retains guards for both. It then
creates and retains one exclusive mode-`600` archive descriptor. `pg_dump`
writes only to a pipe; the parent synchronously copies those bytes into the
held descriptor, so neither the child nor one of its descendants receives the
writable archive descriptor. After fsync and an exact inode/hash snapshot, the
command opens and validates a separate read-only descriptor for the same inode
and passes that descriptor as `pg_restore --list` standard input. The two
independently opened file descriptions prevent the dump's end-of-file offset
from affecting TOC parsing. Both descriptors remain held until their child has
settled and the archive identity, size, timestamps, mode, link count, and
SHA-256 have been revalidated. An ancestor-directory or leaf-path replacement
therefore cannot redirect the bytes written or parsed and is treated as archive
tampering. PostgreSQL tools run in dedicated process groups. Reaping starts when
the leader exits, and timeout or output-limit failure destroys the parent pipe
before settlement; ordinary same-group descendants are killed and the group is
proved empty before return.

The production wrapper now accepts only canonical absolute `pg_dump` and
`pg_restore` paths plus lowercase SHA-256 pins. It opens each reviewed binary,
holds and hashes that descriptor, requires exact PostgreSQL-17 version evidence,
and revalidates descriptor and pathname identity around its one permitted
operation. The dump, list, and version argument/environment/timeout surfaces are
purpose-bound; the generic process runner and test filesystem seam are not
exposed by the production factories.

This remains review-only. Node still launches the executable by pathname, so a
hostile same-UID actor can attempt a pathname execution ABA between preflight
and `spawn`. Hashing the executable alone does not bind its dynamic loader or
complete shared-library dependency tree. Activation therefore still requires
an immutable digest-pinned runtime (or reviewed descriptor-native launcher)
that binds those dependencies, runs the exact pre-bound process runner in a
pristine worker with locked Promise primordials, and retains the archive's
independently reviewed external digest guard across recovery. The process-group
proof also cannot observe a substituted child that calls `setsid`; such a child
could retain the credential environment or read-only archive descriptor even
though the parent-only pipe prevents it retaining writable archive authority.
Do not authorize a live backup ceremony until every boundary is independently
reviewed and approved.
The exact canonical state receipt and manifest are independently hashed against
their in-memory canonical bytes and held by validated descriptors through the
same post-cleanup revalidation; a replacement cannot become its own baseline.
When a failure is known before descriptor release, the command truncates and
fsyncs every still-held archive, manifest, and receipt inode before closing it.
A failure discovered while closing a descriptor is `cleanup_failed` and leaves
the retained set untouched for incident review. The command never recursively
deletes the output pathname: a pathname check followed by recursive removal
would permit a rename/swap to redirect deletion. A separately reviewed operator
procedure must inspect and remove that exact private mode-`700` marker;
rerunning the command against it fails closed.

It already validates the PostgreSQL 17 tools; versioned login attributes,
live-database-OID binding, sole membership options, direct ACL/dependency
allowlist, and inability to set the migrator, runtime, or sibling group; the
effective database-scoped read-only group and its exact children,
schemas/tables/PUBLIC-policy/functions/zero-sequence contract; exported
snapshot; archive TOC; schema/ACL scope; migration contract; authoritative
table inventory; control tables; and state receipt. `pg_dump` imports the
exported snapshot with
`--role=pintpath_logical_backup_d<validated-source-database-oid>
--enable-row-security`. It retains the portable dynamic policies but uses
`--no-acl`, so a restore requires no source-OID role. PostgreSQL renders the
default `PUBLIC` target without a `TO` clause; the restored catalog must still
contain `polroles = ARRAY[0]`, permissive `SELECT`, no `WITH CHECK`, and the
exact live-database-OID predicate on all 59 tables. The off-site command
re-parses the exact restore
authority's manifest and receipt contract before any Storage write.

## 3. Upload, verify, and attest the operational copy

Choose a non-secret, stable operator/change reference. The command stores only
its SHA-256 hash.

```sh
: "${SUPABASE_URL:?set the production Supabase HTTPS origin}"
: "${OFFSITE_BACKUP_SUPABASE_URL:?set the distinct operational-copy HTTPS origin}"
export OFFSITE_BACKUP_BUCKET="${OFFSITE_BACKUP_BUCKET:-pintpath-backups}"
: "${EXPECTED_OFFSITE_DESTINATION_ORIGIN_SHA256:?set the reviewed destination-origin SHA-256}"
: "${EXPECTED_OFFSITE_BUCKET_NAME_SHA256:?set the reviewed bucket-name SHA-256}"
printf '%s\n' "$EXPECTED_OFFSITE_DESTINATION_ORIGIN_SHA256" \
  | grep -Eq '^[a-f0-9]{64}$'
printf '%s\n' "$EXPECTED_OFFSITE_BUCKET_NAME_SHA256" \
  | grep -Eq '^[a-f0-9]{64}$'
export OPERATOR_REFERENCE="approved-change-reference"
export OFFSITE_ATTESTATION_RESULT="$RELEASE_ROOT/logical-offsite-attestation.json"

PINTPATH_POSTGRES_LOGICAL_OFFSITE=confirmed \
SUPABASE_URL="$SUPABASE_URL" \
OFFSITE_BACKUP_SUPABASE_URL="$OFFSITE_BACKUP_SUPABASE_URL" \
OFFSITE_BACKUP_BUCKET="$OFFSITE_BACKUP_BUCKET" \
  npm run --silent db:postgres:backup:logical:offsite -- \
    --backup-directory="$LOGICAL_BACKUP_DIRECTORY" \
    --backup-manifest-sha256="$EXPECTED_MANIFEST_SHA256" \
    --expected-destination-origin-sha256="$EXPECTED_OFFSITE_DESTINATION_ORIGIN_SHA256" \
    --expected-bucket-name-sha256="$EXPECTED_OFFSITE_BUCKET_NAME_SHA256" \
    --runtime-database-url-file="$RUNTIME_DATABASE_URL_FILE" \
    --service-role-key-file="$OFFSITE_SERVICE_ROLE_KEY_FILE" \
    --operator-id="$OPERATOR_REFERENCE" \
  >"$OFFSITE_ATTESTATION_RESULT"
chmod 600 "$OFFSITE_ATTESTATION_RESULT"

jq -e --arg manifest "$EXPECTED_MANIFEST_SHA256" \
  '.ok == true
   and .schemaVersion == 1
   and .manifestSha256 == $manifest
   and (.attestationSha256 | test("^[a-f0-9]{64}$"))
   and (.latestPointerSha256 | test("^[a-f0-9]{64}$"))
   and (.remoteObjectSetSha256 | test("^[a-f0-9]{64}$"))
   and (.backupIdSha256 | test("^[a-f0-9]{64}$"))' \
  "$OFFSITE_ATTESTATION_RESULT"
```

The command performs this fixed sequence:

1. validates the private directory, exact file set, ownership, modes, regular
   files, link count, stable inode/timestamps/size, trusted manifest hash,
   archive hash/size, receipt hash, and manifest-to-receipt state binding;
2. verifies the source and destination Supabase origins differ, the destination
   origin and bucket match the protected reviewed hashes, and the supplied
   Storage transport is bound to that destination;
3. hashes the exact protected runtime URL without emitting it or its digest,
   and verifies the connected runtime PostgreSQL database identity is exactly
   the source identity bound into the manifest, before any Storage mutation;
4. verifies the existing destination bucket is private and compatible and the
   runtime PostgreSQL role/schema/import/ACL isolation contract is healthy;
5. acquires the fenced
   `lease:postgres_logical_backup_offsite_attestation` system-state lease;
6. uploads immutable archive, manifest, and state receipt objects beneath
   `_control/postgres-logical-backups/v2/backups/` (the archive uses the
   Supabase TUS endpoint with the required 6 MiB chunks and bounded retries);
7. re-downloads every object with cache bypass, streams and checks its exact
   bytes/SHA-256, and independently checks size, MIME, cache policy, and custom
   hash metadata; the Storage `id` and `version` must also remain identical
   across the pre-download and post-download `info()` calls;
8. re-hashes the local files to detect mutation during transfer;
9. writes and re-verifies an immutable canonical attestation, then writes and
   re-verifies the canonical latest pointer;
10. compare-and-set writes the exact hash-only
    `job:postgres_logical_backup_success` value and releases the lease.

The immutable attestation, latest pointer, and hash-only success state bind the
runtime connection-URL SHA-256 to the same manifest, state receipt, and source
database identity. The success output deliberately omits that URL digest. It
contains timestamps, other non-secret evidence hashes, and schema version only;
it contains no URL, object path, bucket name, operator reference, credential,
database row, or customer data.

## 4. Retrieve the exact operational copy

Use the protected release register's independently captured SHA-256 of the
complete canonical `job:postgres_logical_backup_success` value. Do not derive
that expected hash, the destination-origin pin, or the bucket-name pin from the
same mutable environment being tested. The output parent must be a physical,
current-user-owned directory with no group/other permissions, and the requested
output directory must not exist.

```sh
: "${SUPABASE_URL:?set the source Supabase HTTPS origin}"
: "${OFFSITE_BACKUP_SUPABASE_URL:?set the distinct operational-copy HTTPS origin}"
export OFFSITE_BACKUP_BUCKET="${OFFSITE_BACKUP_BUCKET:-pintpath-backups}"
: "${EXPECTED_LOGICAL_SUCCESS_STATE_SHA256:?set the reviewed success-state SHA-256}"
: "${EXPECTED_OFFSITE_DESTINATION_ORIGIN_SHA256:?set the reviewed destination-origin SHA-256}"
: "${EXPECTED_OFFSITE_BUCKET_NAME_SHA256:?set the reviewed bucket-name SHA-256}"
export RETRIEVED_LOGICAL_BACKUP_DIRECTORY="$RELEASE_ROOT/retrieved-postgres-logical-backup"
export OFFSITE_RETRIEVAL_RESULT="$RELEASE_ROOT/logical-offsite-retrieval.json"

test ! -e "$RETRIEVED_LOGICAL_BACKUP_DIRECTORY"
SUPABASE_URL="$SUPABASE_URL" \
OFFSITE_BACKUP_SUPABASE_URL="$OFFSITE_BACKUP_SUPABASE_URL" \
OFFSITE_BACKUP_BUCKET="$OFFSITE_BACKUP_BUCKET" \
  npm run --silent db:postgres:backup:logical:retrieve -- \
    --expected-success-state-sha256="$EXPECTED_LOGICAL_SUCCESS_STATE_SHA256" \
    --expected-destination-origin-sha256="$EXPECTED_OFFSITE_DESTINATION_ORIGIN_SHA256" \
    --expected-bucket-name-sha256="$EXPECTED_OFFSITE_BUCKET_NAME_SHA256" \
    --output-directory="$RETRIEVED_LOGICAL_BACKUP_DIRECTORY" \
    --runtime-database-url-file="$RUNTIME_DATABASE_URL_FILE" \
    --service-role-key-file="$OFFSITE_SERVICE_ROLE_KEY_FILE" \
  >"$OFFSITE_RETRIEVAL_RESULT"
chmod 600 "$OFFSITE_RETRIEVAL_RESULT"

jq -e --arg state "$EXPECTED_LOGICAL_SUCCESS_STATE_SHA256" \
  '.ok == true
   and .schemaVersion == 1
   and .kind == "pintpath-postgres-logical-offsite-retrieval"
   and .successStateSha256 == $state
   and (.archiveSha256 | test("^[a-f0-9]{64}$"))
   and (.manifestSha256 | test("^[a-f0-9]{64}$"))
   and (.stateReceiptSha256 | test("^[a-f0-9]{64}$"))
   and (.localArtifactSetSha256 | test("^[a-f0-9]{64}$"))' \
  "$OFFSITE_RETRIEVAL_RESULT"
```

The retriever is read-only at the provider. It performs this fixed contract:

1. checks canonical arguments, the distinct source/destination origins, both
   reviewed destination pins, canonical runtime readiness, and the connected
   source database identity;
2. reads and strictly parses the complete live success state, requires its
   canonical SHA-256 to equal the operator pin, and retains the state revision
   as the first half of an execution-wide fence;
3. requires the bucket to remain private, then downloads and verifies the
   canonical latest pointer and immutable attestation against their hashes,
   custom metadata, exact Storage `id`, and exact Storage `version`;
4. checks all three attested artifact descriptors, creates one new exact
   mode-`700` output directory, and streams the manifest, state receipt, and
   archive into exclusive mode-`600` regular files with independent byte-count
   and SHA-256 checks;
5. compares each object's complete normalized Storage metadata, `id`, and
   `version` before and after its stream, re-hashes each local file, strictly
   parses the restore manifest and receipt, and verifies their full binding;
6. re-downloads the latest pointer and rereads the live success-state revision
   after all bytes are durable, failing if either authority changed; and
7. emits only timestamps, decimal byte counts, and hashes. It never emits the
   raw backup ID, object path, bucket, origin, credential, database identity
   components, or local path.

Success leaves exactly `pintpath-postgres.dump`, `manifest.json`, and
`state-receipt.json` in the new restore-compatible directory. Failure retains
the private marker and zeroizes artifacts still under held writable custody;
it never recursively deletes a pathname. An unexpected entry, descriptor-close
failure, or directory-identity change fails cleanup closed and preserves the
set for incident review. The staging recovery proof retrieved the pre-deletion set by
this contract and matched all three remote objects byte-for-byte before restore.
On a distinct-database-OID restore, the source scoped role is not a prerequisite
and must not appear in the rendered archive. The restored catalog must contain
the exact 59 dynamic `PUBLIC` policies while the target-OID scoped group and
versioned-login namespace remain absent. This is the only accepted
`restored_policy_only` state. Applying the reviewed
`20260810003612_add_pintpath_logical_backup_role.sql` forward migration then
acquires its fixed transaction advisory lock and creates the target-OID group
and its exact 61 ACL dependencies only when executed by a true cluster
superuser; a non-superuser preserves the inert policy-only state. A fully exact
state is verification-only. A target backup login is provisioned separately
only after the full zero-child group/ACL contract is exact and the stopped
SCRAM-verifier helper has been reviewed.
That closes only operational-copy transport evidence. Private application
Storage recovery, a full application boot, PITR, provider-enforced WORM,
approved RPO/RTO objectives, and production restore/cutover remain open.

## 5. Readiness meaning

The SystemState value is accepted only when it has the exact kind/version,
canonical timestamps, and complete SHA-256 binding set. A migrated legacy
SQLite value such as `{ "completedAt": "..." }` is invalid. Attestation v2
also fails closed on a v1 state/pointer/attestation; create a fresh v2
attestation instead of translating old evidence. Historical v2 artifacts from
before the runtime-URL binding remain readable for retrieval, but they do not
contain that proof and cannot close a new credential-rotation gate. Generate a
fresh attestation for the candidate runtime URL. No live v1 provider
attestation existed when this contract was introduced.

The read-only readiness probe validates freshness from `backupCreatedAt`, the
live connected runtime database identity, and destination/bucket hashes. It
downloads and verifies the fixed latest pointer plus its immutable attestation,
and checks that all three bound backup objects still exist with the attested
size/MIME/cache/custom metadata and exact hash-only Storage `id`/`version`
binding. Every probe also downloads and SHA-256 verifies the bounded manifest
and state receipt, strictly parses both, and rechecks their complete binding;
it does not re-download the archive, which may be as large as 50 GiB. It
performs no Storage write or delete. The web `/ready` path must pass the
complete SystemState value and a freshly computed runtime database identity to
this probe; it must never accept `value.completedAt` by itself.

Supabase Storage `id` plus `version` detects replacement through the normal
Storage API (`version` changes on upsert; `id` changes on delete/recreate). It
is an opaque provider generation binding, not S3 bucket versioning, Object
Lock, WORM, or independent proof that the archive bytes are unchanged.
Storage `info()` ETag/size values are upload metadata; a TUS/multipart ETag is
not a whole-object SHA-256 and is deliberately not a content authority here.
The initial attestation always streams and hashes the full archive. Residual
protection against privileged Storage database/backend replacement requires a
scheduled full streamed archive hash or, preferably, the separately
administered WORM authority plus restore proof.

## 6. Replay and failure recovery

- Exact replay is safe. Immutable objects are never overwritten; existing
  objects must match their full byte and metadata contract. The latest pointer
  is overwritten only after all immutable evidence is verified.
- A different manifest with the same backup timestamp, or any backup older
  than the current valid Postgres attestation, is rejected as state regression.
- Before the latest pointer is written, failure cleanup can remove only the
  exact objects newly created by that invocation under the dedicated logical
  backup `backups/` or `attestations/` namespaces. It cannot list, prune, or
  address `_control/account-deletion-*` paths.
- From the moment mutable latest-pointer mutation is attempted, all immutable
  evidence is intentionally retained, including when the server may have
  committed the pointer before returning a transport error. If pointer
  verification or the final SystemState CAS fails, readiness remains closed
  because state and pointer do not agree. Resolve the database/lease issue and
  rerun the exact command; do not hand-edit Storage or SystemState.
- A crashed invocation leaves a bounded six-hour lease. Do not delete or edit
  the lease. Investigate the operator host, then retry after expiry.
- TUS and this operational-copy authority have a 50 GiB per-archive bound. If
  the logical archive reaches that bound, move the reviewed design to the
  separately administered large-object/WORM authority; do not split or weaken
  the manifest contract ad hoc.

No retention deletion is performed here. Any future operational-copy retention
job needs a separate review, must preserve the latest verified recovery set,
and must remain unable to alter the deletion tombstone ledger authority.
