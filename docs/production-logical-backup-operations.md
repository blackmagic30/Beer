# Production PostgreSQL logical-backup operations

Status: **scheduled workflow committed but deliberately dormant until the
protected runner, environments, secrets, pins, and provider authorities are
provisioned and approved.** Scheduled jobs and their alert job are skipped
unless `PINTPATH_PRODUCTION_BACKUP_RUNNER_READY=true`; manual dispatches bypass
that scheduling guard and remain fail-closed for prerequisite validation. The
repository change did not connect to a provider or create, upload, restore, or
delete any backup.

`.github/workflows/production-logical-backup.yml` supplies two operations:

- daily at `15 14 * * *` UTC: create the hardened PostgreSQL 17 logical set,
  upload and byte-verify its private operational copy, update the hash-only
  database success state, and write/read/deny-canary the separate 30-day
  Object-Lock WORM set;
- monthly at `45 15 1 * *` UTC: first complete the same fresh backup, then in a
  separate protected job retrieve that exact newly attested operational copy
  and restore it into the current month's pinned disposable target;
- protected manual runs support `backup-only` and
  `backup-and-restore-drill` modes.

Concurrent backup runs queue instead of cancelling. The workflow checks out
only `main`, uses the repository's exact Node/npm versions and lockfile, and
runs data-bearing jobs only on the isolated self-hosted labels
`[self-hosted, linux, x64, pintpath-production-backup]`. PostgreSQL tools never
execute from the host. The backup, archive-list, and restore authorities use
the exact `linux/amd64` platform manifest
`docker.io/library/postgres@sha256:c529722b47431f2478e5bef927f61bfc60433c8fa04e3d011b545192068ec677`
with `--pull=never`; the repository binds its config, complete rootfs layer
projection, tool paths, and tool hashes. The worker launches directly with
Node's frozen-intrinsics and disabled-prototype flags. There is no
GitHub-hosted fallback for database or backup work.

## Owner provisioning actions

Provision a dedicated JIT ephemeral, one-job, non-root self-hosted runner
inside the Railway/private network and give it exactly the
`pintpath-production-backup` label. Do not register that label on a general CI
runner, reuse its host or filesystem for a second job, or permit another
same-UID workload during a ceremony. GitHub must de-register the runner and the
host must be destroyed after every job, including cancellation or runner
disconnect. A persistent or merely single-purpose runner is not authorized. The
runner image must contain Node `22.23.2`, Corepack, the preloaded tagless OCI
image above, the exact root-owned static Docker client and daemon described
below, the destination-restricting network plugin, the reviewed Railway private
DNS and CA path, and two short-lived AWS profiles. It must not depend on host
`pg_dump` or `pg_restore`. The AWS profiles are distinct: append-only WORM
writer and independent read-only verifier. Neither profile may be an
application credential or be stored as a GitHub secret.

Before registration, mount a fresh `tmpfs` at the exact canonical path
`/run/pintpath-production-backup`. It must be owned by the non-root job UID,
mode `0700`, and mounted `rw,nosuid,nodev,noexec`; unencrypted swap must be
disabled. `RUNNER_TEMP` and every persistent runner directory are outside the
data-bearing authority. Destroy the tmpfs with the JIT host after the one job.
Install this exact canonical JSON at the root-owned, single-link, mode `0644`
path `/etc/pintpath/production-backup-ephemeral-runner.json` and pin its byte
SHA-256 independently in both protected environments:

```json
{
  "schemaVersion": 1,
  "kind": "pintpath-production-backup-ephemeral-runner-policy",
  "runnerMode": "jit-ephemeral-one-job",
  "volatileWorkRoot": "/run/pintpath-production-backup",
  "filesystemType": "tmpfs",
  "requiredMountOptions": ["nodev", "noexec", "nosuid", "rw"],
  "unencryptedSwapAllowed": false,
  "concurrentSameUidWorkloadAllowed": false
}
```

The workflow opens and hashes that policy without following symlinks, proves
the exact mount and filesystem magic through `/proc/self/mountinfo` and
`statfs`, proves the current UID/mode, rejects active swap or stale entries, and
only then permits private materialization. A protected variable is not a
substitute for these runtime proofs.

### OCI runner trust boundary

Install the official Docker `29.7.2` Linux x86-64 static client at the exact
root-owned, non-group/world-writable path
`/usr/local/libexec/pintpath/docker-static-29.7.2`. The source archive and
installed binary pins are:

```text
source = https://download.docker.com/linux/static/stable/x86_64/docker-29.7.2.tgz
archive sha256 = 803d433f226db4776e1768fd319fc6c6e4935a456acf84fcc0080818b854bc8f
docker binary sha256 = e45381109c685311cf84c5e33a1aca7da81d6b55c0f9aed74091fc08c3a94f13
```

The adapter opens and hashes that client once, retains the descriptor, and
executes `/proc/<worker-pid>/fd/<held-fd>`. It revalidates both the held inode
and original pathname around every Docker call. `/var/run/docker.sock` must be
a root-owned socket, not world-writable, with the runner in its exact group.
The Docker server must also be `29.7.2`, Linux x86-64, `overlay2`, systemd
cgroup v2, default `runc`, built-in seccomp and cgroup namespaces, with swarm,
experimental mode, live restore, and daemon warnings absent. The policy pins
hashes of the daemon ID/name/root, kernel and OS strings, containerd/runc commit
IDs, and sorted security-option projection. Treat the root-managed daemon,
socket group, and runner image as privileged production infrastructure.

Preload the exact platform digest during runner image provisioning. Do not
pull, build, retag, or log in to a registry during the workflow. The adapter
rejects image architecture, config digest, repo digest, or rootfs-layer drift.
It runs one randomly named container per version/list/dump/restore operation,
with a read-only root, non-root job UID/GID, all capabilities dropped,
`no-new-privileges`, private cgroup and IPC namespaces, no published ports,
no logging, no restart, bounded CPU/memory/PIDs/ulimits, and a small
`noexec,nosuid,nodev` tmpfs. It deeply inspects the created container before
starting it and proves exact absence after forced cleanup. Ambiguous
create/start/remove responses do not bypass rediscovery, identity checking, or
the final absence proof.

Install and independently review one Docker network-driver plugin named
`pintpath-egress-v1`. Pin its exact content-derived plugin ID in each policy.
It must implement the declared options as enforcement, not metadata: allow
only the one policy IP and TCP port `5432`, deny DNS, deny instance-metadata
destinations, and deny every other ingress/egress path. Create distinct empty,
non-attachable local networks for backup and restore. The adapter checks the
plugin ID/interface, network ID/name/driver/options/label, and zero attached
containers before and after each data-bearing operation. A bridge/macvlan
network, host networking, an unreviewed plugin, or a policy that merely records
the options is not acceptable.

Create exact canonical JSON policy files at:

```text
/etc/pintpath/production-backup-postgres-egress.json
/etc/pintpath/production-restore-postgres-egress.json
```

Each file must be root-owned, non-group/world-writable, single-link, canonical
JSON with a final newline, and independently pinned by SHA-256 in its GitHub
environment. It contains exactly `schemaVersion=1`,
`kind=pintpath-postgres-oci-egress-policy`, the matching `operationClass`, the
daemon/OS/runtime hashes listed above, `networkId`, `networkName`,
`networkPluginId`, and the exact `host`, single resolved `hostAddress`, and
`port=5432`. Generate and approve the policy from the immutable runner build;
never derive or rewrite it inside the workflow. The backup policy host/address
must match the already reviewed backup transport. The restore policy must
match only the disposable target and must be replaced with each changed target
or address.

Create these GitHub environments:

1. `production-backup`: require an independent reviewer, restrict it to
   protected `main`, and store only backup-specific secrets and reviewed pins.
2. `production-restore-drill`: require an independent recovery reviewer and a
   newly provisioned, isolated target for the current UTC month.
3. `production-backup-alerts`: no database/provider secret; expose only the
   paging webhook. Environment approval must not delay failure paging.

Provision the distinct private Supabase operational-copy project/bucket and
the separately administered Melbourne S3 Object-Lock authority described in
`docs/postgres-logical-offsite-attestation.md` and
`docs/postgres-logical-worm-attestation.md`. These are provider-owner actions,
not repository work. A mutable Supabase copy alone never satisfies retention.

### `production-backup` secrets

- `PINTPATH_PRODUCTION_BACKUP_DATABASE_URL`: dedicated versioned
  `pintpath_logical_backup_*` TLS URL, not runtime, migrator, or admin login.
- `PINTPATH_PRODUCTION_RUNTIME_DATABASE_URL`: restricted PintPath runtime URL
  used only to verify source identity and atomically record hash-only success.
- `PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_PEM`: exact private Railway CA.
- `PINTPATH_OPERATIONAL_COPY_SERVICE_ROLE_KEY`: server key belonging only to
  the isolated operational-copy project. Supabase service keys bypass RLS, so
  the separate project and protected runner are mandatory blast-radius bounds.
- `PINTPATH_PRODUCTION_WORM_RECOVERY_ACCOUNT_ID` and
  `PINTPATH_PRODUCTION_WORM_FORBIDDEN_ACCOUNT_IDS`: exact recovery account and
  comma-separated application/provider account deny set.

### `production-backup` variables

Keep `PINTPATH_PRODUCTION_BACKUP_RUNNER_READY` absent or false while the
workflow is disabled and until one manual run has proved the complete setup.
Then set it to `true` to opt scheduled backup, restore, and alert jobs in, and
provide the reviewed source URL/CA and OCI-policy hashes, operational-copy
origin/bucket hashes, WORM bucket/profile/account/role hashes, and a non-secret
named operator reference through:

```text
PINTPATH_PRODUCTION_BACKUP_SOURCE_URL_SHA256
PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_DER_SHA256
PINTPATH_PRODUCTION_BACKUP_EPHEMERAL_RUNNER_POLICY_SHA256
PINTPATH_PRODUCTION_BACKUP_OCI_EGRESS_POLICY_SHA256
PINTPATH_OPERATIONAL_COPY_ORIGIN_SHA256
PINTPATH_OPERATIONAL_COPY_BUCKET_SHA256
PINTPATH_PRODUCTION_WORM_BUCKET
PINTPATH_PRODUCTION_WORM_BUCKET_SHA256
PINTPATH_PRODUCTION_WORM_WRITER_PROFILE
PINTPATH_PRODUCTION_WORM_READER_PROFILE
PINTPATH_PRODUCTION_WORM_ACCOUNT_SHA256
PINTPATH_PRODUCTION_WORM_WRITER_ARN_SHA256
PINTPATH_PRODUCTION_WORM_READER_ARN_SHA256
PINTPATH_PRODUCTION_BACKUP_OPERATOR_ID
```

Missing, empty, malformed, unpinned, shared, wrong-version, or same-profile
values stop before a database connection or provider write.

### `production-restore-drill` inputs

This environment receives the production runtime URL needed to read the
hash-only success state, the exact production runtime trust root in
`PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_PEM`, the isolated operational-copy
server key, `PINTPATH_DISPOSABLE_RESTORE_DATABASE_URL`, and the disposable
target's distinct trust root in `PINTPATH_PRODUCTION_RESTORE_ROOT_CA_PEM`. It
never receives the production backup login or WORM writer. The production CA
is available only for the read-only retrieval connection; it is never supplied
to the disposable target restore path.

Set the common operational-copy pins plus:

```text
PINTPATH_RESTORE_TARGET_URL_SHA256
PINTPATH_RESTORE_TARGET_IDENTITY_SHA256
PINTPATH_RESTORE_TARGET_GENERATION = YYYY-MM for the current UTC month
PINTPATH_RESTORE_TARGET_NETWORK_POLICY = isolated-no-production-route
PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_DER_SHA256
PINTPATH_PRODUCTION_RESTORE_OCI_EGRESS_POLICY_SHA256
PINTPATH_PRODUCTION_RESTORE_ROOT_CA_SHA256
PINTPATH_PRODUCTION_RESTORE_ROOT_CA_DER_SHA256
```

The target must be a new database carrying the repository's disposable-target
marker, with private application schemas absent before the drill. Its account,
project/environment, network policy, login, routes, callbacks, Redis, and
provider credentials must be distinct from production. It must have no route
to production services and no production application/provider credential. The
workflow hashes the URL without printing it, proves it differs from the runtime
URL, binds the protected identity hash, and refuses a reused or populated
target. The retrieval URL must use `sslmode=verify-full`; the retriever holds
the exact current-UID-owned mode-`600` production CA file, validates its single
self-signed CA certificate against
`PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_DER_SHA256`, accepts only the exact
lower-case production `*.railway.internal:5432` authority, resolves and fences
one canonical `fd12::/16` address, and makes node-postgres dial that address
while authenticating the stock leaf with the pinned CA, `servername=localhost`,
the fixed `localhost` identity callback, and TLS 1.2 or newer. The retriever
rechecks the URL authority, DNS answer, source CA descriptor, private held copy,
and DER pin before and after its database operations, then closes the database
before destroying the transport authority. Separately,
`PINTPATH_PRODUCTION_RESTORE_ROOT_CA_SHA256` is the SHA-256 of the exact
disposable-target PEM bytes materialized as `restore-root-ca.pem`. The restore
URL must use `sslmode=verify-full`; the restore worker validates that exact
mode-`600`, single-certificate, self-signed target CA and its PEM and DER hashes
before connecting. It resolves the reviewed `*.railway.internal` URL once to
one `fd12::/16` address, dials only that address, and authenticates the Railway
stock leaf as `localhost` for both Node target inspection and isolated
`pg_restore` (`PGHOST=localhost`, pinned `PGHOSTADDR`). It continuously fences
the original URL authority, CA descriptor/copy, and resolved transport.
Neither connection relies on the runner's ambient system trust store, and the
two CA paths are never interchangeable. After
retaining the hash-only receipt, the recovery owner must
destroy that target and record disposal; the next month cannot reuse it because
both the generation and empty-target checks fail closed.

## Runtime custody

The OCI adapter receives no ambient process environment: Docker and the
container command each get a closed allowlist. Backup credentials remain in
the existing exclusive mode-`600` pgpass file; restore converts `PGPASSWORD`
to a newly generated exclusive pgpass file, removes the password from container
arguments/environment, and truncates, fsyncs, unlinks, and closes that file on
every return path. Root CAs and pgpass files are bind-mounted read-only from
held `/proc/<worker-pid>/fd/*` descriptors. Their mutable host pathnames are
revalidated around execution.

All URLs, keys, CAs, raw archives, and restore inputs live only below the exact
volatile run directory derived from `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`.
The workflow exports that cleanup root immediately after creation and before
the first private write. Its unconditional cleanup independently recomputes the
same path from those immutable GitHub values, compares any exported value,
refuses symlinks or cross-device entries, performs bounded device-checked
traversal, and proves both the child and mount are empty. It never trusts a
possibly missing late `$GITHUB_ENV` value. Cleanup failure is fatal;
cancellation and runner loss are covered by mandatory JIT host and tmpfs
destruction, not by claiming that unlink erases persistent media.

The archive pathname never enters Docker. The existing schema-version-3
backup/restore code retains its mode-`600` archive descriptors and supplies
only standard input/output streams to the held Docker client. The digest-pinned
container receives those bytes through attach streams. Timeout and output
limits kill and reap the client process group; the one-shot lifecycle then
rediscovers and removes any possibly running container before returning.

This is the operational schema-version-3 boundary used only when the exact OCI
profile, operation class, policy file, and policy hash are all present. The
ordinary host-tool CLI path remains available for local tests/manual review and
is not authorized for a live ceremony. The separately named V4 contracts stay
passive/offline: their capability booleans remain false, their scratch-restore
completion remains unimplemented, and this workflow does not grant them
runtime, source, archive, artifact, activation, or cutover authority.

## Post-promotion activation integration

The daily/monthly workflow above remains a separate backup operation. The
frozen release chain additionally invokes the schema-v3 boundary from
`.github/workflows/activate-production-promotion-recovery.yml` after route
close and the reviewed promotion. Its controlling policy is v2 SHA-256
`57f66c1c9dde912586ec510e37c28cc3dfea2c098e67c78edbea189c7dcc9988`.

The activation has a deliberate cross-network split:

- `production-capture` uses the exact JIT label
  `[self-hosted, linux, x64, pintpath-production-backup]`. It observes PITR in
  the capture job, creates the logical set, writes and verifies its operational
  copy, seals the logical set into WORM, captures and separately seals the
  private Storage/deletion bundle, and uploads receipts/content addresses only.
- `disposable-recover` uses the different JIT label
  `[self-hosted, linux, x64, pintpath-disposable-recovery]`. It never receives
  the production backup login or WORM writer. Its read-only WORM authority
  separately retrieves the logical object versions and private recovery-bundle
  object versions into disposable tmpfs. Only those independently retrieved
  bytes may feed logical/private restore, deletion replay, and the compiled
  recovered-application smoke against the disposable private network.

No raw logical archive, manifest payload set, private Storage object, URL, key,
CA, or Redis secret crosses a GitHub artifact. The exact receipt-only activation
inventory has 18 evidence leaves; `activation-receipt.json` and
`tested-commit-sha.txt` make the final activation artifact exactly 20 files.
The two WORM retrieval receipts are mandatory independent leaves.

Cleanup is a third, GitHub-hosted `if: always()` job in the separate
`production-promotion-recovery-cleanup` environment; finalization is the fourth
job and requires capture, recovery, orderly purge-bound Supabase cleanup, and
both provider-absence terminals to be green. Standard cancellation does not
authorize skipping cleanup, and force-cancel is forbidden until independent
read-only observations prove both disposable providers absent. The signed
singleton run/candidate/target/workspace arm plus dedicated-ref CAS state gates
capture; a separate completion/15-minute/manual watchdog retries emergency
cleanup while that state is OPEN, and its artifacts never green activation.
It persists exact delete acknowledgements across partial runs and reuses one
only with a fresh absence proof. Do not arm or queue a second activation until
the state is DISARMED after both
absence terminals. Railway workspace absence without exact delete
acknowledgement is transfer-ambiguous. The checked-in
workflow is executable capability only: no production capture, AWS retrieval,
restore, provider cleanup, or final activation is claimed by this document.
For the later version-2 attestation, RTO begins at the exact immutable GitHub
activation workflow `run_started_at`; neither operator nor reviewer supplies
that timestamp.

## Retention, freshness, and evidence

The operational command re-downloads and verifies every uploaded object. The
WORM command independently verifies versioning, Object Lock `COMPLIANCE`,
30-day default retention, exact object versions, and writer denial of read,
list, versioned deletion, unversioned delete-marker creation, and retention
controls. At workflow completion at least 29 days
must remain on every WORM object, allowing only the bounded upload duration
from the provider's exact 30-day creation-time retention.

Both operational and WORM completion timestamps must be no more than two hours
old and no more than five minutes in the future. The public readiness endpoint
continues to enforce its backup freshness contract; a daily workflow does not
waive that runtime check.

GitHub retains the documented hash-only backup results for 30 days and monthly
retrieval/restore results for 90 days. Raw dumps, URLs, keys, account IDs,
bucket names, object keys, and customer data are not uploaded as Actions
artifacts. Private runner paths are mode `700`, secret leaves are mode `600`,
cleanup is constrained to the exact run-specific tmpfs directory, and the
one-job host is destroyed after each run. Hash-only artifacts do not establish
that destruction; retain the runner-controller termination audit alongside the
workflow receipt.

## Failure and alert semantics

Every provider, identity, freshness, retention, retrieval, restore, hash, or
cleanup failure makes the workflow fail. A separate GitHub-hosted alert job has
no database or provider access and posts only repository/run/result metadata to
the protected `PINTPATH_PRODUCTION_BACKUP_ALERT_WEBHOOK_URL`. Configure the
on-call system to page on that event and independently deadman-monitor the
daily workflow completion; a missing/offline self-hosted runner can leave a job
queued before an in-workflow failure job can run. GitHub email alone is not the
launch alert.

Treat any missed daily completion, operational-copy/WORM divergence, WORM
retention under the bound, backup age beyond the readiness window, missed
monthly restore, failure page, or undisposed restore target as a production
incident. Do not weaken the workflow to `ubuntu-latest`, public database
networking, `sslmode=require`, unpinned tools, mutable-only storage, or a reused
restore database.
