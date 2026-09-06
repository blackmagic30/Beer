# Protected provider-mutation operations

Status: repository transport implemented; no provider mutation has been run by
this change.

This document is the operator contract for the protected manual workflows that close
the former repository-side transport gaps without granting an unattended path
to Railway:

- `.github/workflows/permanent-staging-provider-mutation.yml` reconciles one of
  the four reviewed Google/OpenAI variables in place, atomically replaces both
  Supabase keys, and exposes the one proof-bound staged-null cleanup plus its
  exact resume/cancel recovery identities. It never uses Railway's direct
  `variableDelete` operation.
- `.github/workflows/permanent-staging-scale-evidence.yml` scales the exact
  reviewed application deployment from one replica to two, runs expected-peak,
  2x-peak, and 60-minute soak proof, and unconditionally converges the service
  back to one replica.
- `.github/workflows/configure-runtime-variable.yml` writes one allowlisted
  application variable in exact permanent staging or production. It also has
  one staging-only PostgreSQL-service target for the compile-time-reviewed
  `PINTPATH_RUNTIME_DATABASE_URL` template. Its worker uses separate protected
  environments and target-scoped tokens.
- `.github/workflows/permanent-staging-supabase-legacy-cutover.yml` runs the
  replacement-key canaries, performs one staging legacy-disable request,
  unconditionally reconciles disabled state, and proves HTTP 401 rejection for
  both retained old keys.
- `.github/workflows/permanent-staging-postgres-build-canary.yml` uploads the
  exact no-ingress Postgres build canary once and accepts only its canonical,
  credential-free, stopped build-only receipt.
- `.github/workflows/repin-production-postgres-source.yml` is the standalone
  recovery for the one policy-pinned production Postgres drift from the
  approved digest-only reference to Railway's mutable `:17` tag with its
  vulnerability updater armed. It may dismiss that exact armed notice once,
  then stage and commit only the reviewed same-digest source lock plus canonical
  disabled auto-update metadata with deploys skipped. It must not change the
  running deployment, instance, snapshot, volume, replica count, or region.
  The approved digest is the already-running PostgreSQL 17.11 deployment,
  which fixes CVE-2026-15741. The armed notice's `currentVersion: 17.10` is the
  pre-remediation baseline retained in Railway metadata, not the desired or
  running version; the checked-in policy enforces that distinction.
- `.github/workflows/close-production-route.yml` deletes the one canonical
  `pintpath.au` custom domain after the exact candidate has deployed, passed
  same-SHA smoke, and converged to two replicas.
  `.github/workflows/activate-production-promotion-recovery.yml` then captures
  production recovery authorities, independently restores them on a separate
  private-network runner, and always reconciles both disposable providers.
  `.github/workflows/attest-production-promotion-recovery.yml` binds the exact
  closed route and exact activation artifact to reviewed promotion and
  complete post-promotion recovery.
  `.github/workflows/open-production-route.yml` later creates that same custom
  domain only after that protected attestation, waits
  for valid public TLS, and binds `/health`, `/startup`, and `/ready` to the
  same healthy candidate. Close and open are separate confirmed dispatches.

All provider-mutation workflows are `workflow_dispatch` only, require the exact
commit currently at protected `main`, use a non-cancelling concurrency group,
and bind their provider write job to a dedicated GitHub Environment. The
permanent-staging provider mutation, application deployment, Supabase legacy
cutover, and general permanent-staging runtime-variable paths all use
`pintpath-permanent-staging-key-rollout` with `queue: max` and
`cancel-in-progress: false`. This retains every waiting run and fully serializes
the group; a newer dispatch cannot replace or cancel an older one.

Before protected credentials, provider mutation, legacy cutover, and the general
runtime-variable worker call `github:reviewed-candidate-authority:verify`. The
provider guard's exact run title is
`Permanent staging provider mutation | <operation> | <candidate>` and keys
history by candidate+operation. The legacy guard's exact title is
`Permanent staging Supabase legacy cutover | <selected-operation> | <candidate>`
and keys complete candidate history by the selected read-only reconcile or
write-capable disable mode. Runtime-variable history is keyed by candidate+target+variable
through `Configure runtime variable | <target> | <variable> | <candidate>`.
The production Postgres source recovery is a separate apply/reconcile pair
bound to `Production Postgres source lock | apply | <candidate>` or
`Production Postgres source lock | reconcile | <candidate>`, its standalone
workflow, job, and exact deploy-suppressed writer step. It is not
permanent-staging provider history and does not consume staging deployment
lifecycle evidence.
Every guard requires a complete authenticated Actions history from the
associated PR's `merged_at` through the authenticated current `run_started_at`,
not its `created_at`, because retained queued runs can start out of creation
order. That `run_started_at` must be no more than 168 hours after `merged_at`.
An older candidate or incomplete history fails closed and requires a newly
reviewed and merged candidate, not an unreviewed waiver or longer lookup
window. The ordinary exception is an exact recovery identity for a selected
original ambiguous run: the original write must still have begun inside 168
hours, while its same-mode or read-only convergence may start for at most 24
hours after that original run's `updated_at`. The one pinned production
Postgres source-lock incident instead has a reviewed 168-hour recovery window.
That exception accepts at most the exact PR #83 recovery bridge, requires its
exact failed run to have skipped the writer, and authenticates every candidate
in the linear chain. Later recovery failures never extend either deadline, and
the candidate must remain the exact current protected-main head.

A first dispatch is eligible only when there is no prior matching run. A fresh
dispatch after prior matches is eligible only when every prior run is an
original completed failure/cancellation/timeout whose exact named provider write
step has conclusion `skipped`. That GitHub run/job proof is the only accepted
`skipped-before-write` case. Success, any reached/ambiguous write step, a rerun,
or incomplete history blocks the key. For cutover, the same finite history must
also contain the selected successful replacement run and no other replacement
run except ones proven skipped before write. Queueing is not retry authority,
and job reruns are never a substitute for a new guarded dispatch. The general
runtime-variable guard is stricter: any prior run for the exact
candidate+target+variable blocks redispatch, even if its write step was skipped;
use a newly reviewed candidate instead.

The permanent-staging provider workflow therefore runs the immutable Railway
production/staging boundary as a separate fail-closed step before it stages any
provider value. The tracked executor repeats the same boundary immediately
before its one write. A failure in the earlier read-only step leaves the exact
named write step `skipped` and preserves the documented same-candidate dispatch
rule. Once the named write step starts, any failure remains ambiguous at the
GitHub authority layer even when an executor log says `attempts: 0`; repair the
pre-write cause and use a newly reviewed candidate instead of weakening the
history guard.

The production Postgres source recovery applies the same separation more
strictly: a metadata-only recovery preflight must first prove that every
canonical boundary check is true except `sourceImageExact` and
`autoUpdatesDisabledExact`, and `sourceReferenceImmutable`, and that the live
service source, config ETag, armed vulnerability notice, schedule, deployment,
instance, snapshot, and volume are the exact policy-pinned baseline. The named
writer step remains skipped on any other apply state. The apply executor repeats
that proof immediately before dismissing the exact notice once, stages the
same observed digest together with canonical disabled auto-update metadata,
double-reads the exact active and selected patch, commits with
`skipDeploys:true`, and proves the complete runtime identity set unchanged.
The production and staging metadata tokens must be distinct from a third
production source-write token.

Do not rerun either GitHub job. A prior same-candidate run permits another
fresh apply only when GitHub proves every prior apply/reconcile writer was
skipped. If an apply writer started and its result is ambiguous, wait at least
60 seconds and dispatch `reconcile` inside the policy's fixed recovery window
with that exact prior run ID and durable intent artifact. The current pinned
source-lock incident permits 168 hours; every ordinary recovery retains its
24-hour limit unless separately reviewed. Authority accepts exactly one such
ambiguous apply and rejects any second possibly-writing run. Reconciliation
never dismisses again: desired state plus an empty patch is read-only success; the
exact dismissed state plus the exact staged patch permits commit only; the
exact dismissed state plus an empty patch permits one stage and commit; the
original armed state plus an empty patch is `not_applied` with no write; every
other state fails closed. Never retry, roll back, or treat desired state alone
as success.

Narrow recovery exceptions remain write-safe. A mode-bound read-only
legacy-key reconciliation may follow exactly one failed, cancelled, or timed-out
disable run whose exact cutover step may have written; the reconciliation
receives no write credential, and any second disable remains blocked. An
older direct-delete OFFSITE path remains forbidden. The authorized cleanup does
not use `variableDelete`: a sealed disposable proof established that exact
service-scoped nulls staged with `environmentStageChanges(merge:false)` appear
as five-asterisk wrappers in masked views and literal nulls in decrypted views,
then commit without a deploy through
`environmentPatchCommitStaged(skipDeploys:true)`. The workflow requires all
four active/selected masked/decrypted views immediately after staging and again
before commit. It accepts only the exact
`commitChanges/<environment>/<patch>` acknowledgement; a lost acknowledgement
is reconciled from the exact committed views without redispatch. Resume/cancel
remain candidate/run-bound recovery modes, not retry authority.

Cold prepare, cold quiesce, staging restore, and staging worker activation also
have distinct runner-loss reconciliation identities. Each binds the exact
original same-candidate failed/cancelled/timed-out run, carries metadata
credentials only, proves the intended live provider/runtime/repository state
before and after, makes zero provider writes, and emits an alternate receipt
that cannot impersonate the normal mutation. Failed/cancelled read-only probe
attempts may be redispatched only when their exact job topology proves the
normal write job skipped; history must be strictly non-overlapping in the order
original -> read-only retry(s) -> exactly one successful reconciliation, all
inside the original run's fixed 24-hour deadline. A reconciled cold-prepare
receipt is accepted as the selected prepare for the later quiesce chain.

The completed `permanent-staging-postgres` runtime-URL repair is closed
historical evidence bound to `f6bfb81…`; the executable cold-recovery chain
does not consume it, it must not be repeated, and it does not freeze later
reviewed cleanup work onto that SHA. Recovery operations themselves are not
transferable across candidates. From the first potentially reached write in
the successor cleanup/provider/recovery chain through final staging closeout,
operations must impose a protected-main merge freeze. If a later merge changes
the current head, the stranded SHA cannot be recovered by rebinding its state
to the new candidate; that condition remains P1/NO-GO.

The executors run the production/staging Railway mutation boundary immediately
before and after writes. Every authorized write has a durable secret-free
intent, a maximum of one attempt per named mutation, no automatic retry,
unconditional read-only reconciliation, and secret-free terminal evidence. An
ambiguous provider-value upsert or legacy-cutover write is terminal and cannot
be retried. Route close/open executors have explicitly bounded lost-ack rules
and require their unique exact before→after transition with no collateral
change. They never treat desired state alone, a pre-existing state, or an
incomplete inventory as success.

Railway does not currently expose a staged environment-patch ETag/version or a
provider lock that deploy-suppressed operations can consume. Out-of-band
Railway mutation exclusion therefore remains an operational trust assumption;
every authorized ceremony requires an explicit external-writer freeze and
exact postflight reconciliation.

The paired Supabase operation is one Railway `variableCollectionUpsert` with
`skipDeploys=true`; it is not two CLI writes and has no Railway canary-service
dependency. Its preflight requires only the exact Beer application literals:
an unsealed `SUPABASE_ANON_KEY` and sealed `SUPABASE_SERVICE_ROLE_KEY`, with no
references or same-name shared/foreign rows. Runtime Auth/admin/Storage canaries
later run directly from the protected GitHub runner during legacy cutover. The
operation and response shape
were verified against the pinned Railway CLI 5.32.0 source. It never includes
the key values or a value-derived digest in evidence. A successful mutation is
reported as `acknowledged_pending_runtime_proof`, not as a completed rotation:
the same candidate's second, closeout permanent-staging deployment must then
pass the Auth, Storage, browser, server, mobile, and sealed-variable gates before
a legacy key can be disabled.

Provider reconciliation accepts exactly one of two policy-pinned staging
baselines: the original healthy legacy deployment at one replica, or the
currently observed detached dead state at `replicas=null` with
the exact service-instance, failed/stopped deployment, snapshot, source SHA,
empty active set, domain, port, null image digest, and empty staged patch. A
generic failed, stopped, zero-active, null-replica, or detached service never
qualifies. The current recovery path performs these non-deploying variable
mutations on that exact dead baseline before cold prepare.

## Existing permanent-staging row disposition

- Reconcile the four existing Google/OpenAI Beer rows in place with their
  same-name protected secrets. Do not delete or recreate them.
- Keep the existing Beer `SUPABASE_ANON_KEY` row. Seal the existing Beer
  `SUPABASE_SERVICE_ROLE_KEY` row in place, then replace both values atomically.
  Do not delete or recreate either row.
- Do not recreate the three inherited Beer `OFFSITE_BACKUP_*` rows. Their key
  is revoked and returns 401. Remove only their three pinned row identities
  through the protected staged-null operation after its exact candidate is
  reviewed and merged. Require the operational writer freeze, empty final
  patch, 96-row inventory, and unchanged cold/dead topology.
- Do not recreate the missing Railway canary service. It is not an application
  staging prerequisite; the later protected legacy-cutover runner supplies the
  required direct Auth/admin/Storage runtime proof.

## One-time GitHub setup

Create these GitHub Environments and restrict deployment branches to `main`.
Repository-owner policy intentionally leaves GitHub Environment required-reviewer
and self-review gates disabled for these operator-dispatched workflows. Authority
still requires the exact protected-main candidate, original workflow run,
environment-scoped credentials, reviewed-candidate history, and the workflow's
fail-closed preflight and reconciliation. Do not add an Environment approval gate
unless the repository owner explicitly changes this policy. The production
Postgres source-lock environment is the documented exception: enable a deliberate
release-owner approval gate immediately before the first production dispatch,
after ordinary patching is complete. A solo repository owner may be the required
reviewer with self-review allowed; reserve independent review for the final
production deployment gate.

- `permanent-staging-provider-mutation`
- `permanent-staging-scale-evidence`
- `production-topology-configuration`
- `production-runtime-configuration`
- `permanent-staging-supabase-legacy-disable`
- `permanent-staging-postgres-build-canary`
- `production-postgres-source-repin`
- `postgres-ha-pitr-permanent-staging`
- `postgres-ha-pitr-production`
- `disposable-restore-teardown`
- `production-route-close`
- `production-promotion-recovery-activation`
- `production-promotion-recovery-cleanup`
- `production-promotion-recovery`
- `production-route-open`

`production-promotion-recovery-cleanup` remains intentionally non-interactive.
Protect its secrets and variables, limit them to exact per-run teardown
authority, and never use that authority to grant a capture, restore, promotion,
or route mutation.

Place only the following credentials in the environment that uses them. Values
must never be copied into repository variables, workflow inputs, logs, or
artifacts.

Provider mutation environment secrets:

- `PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN`
- `PINTPATH_RAILWAY_STAGING_METADATA_TOKEN`
- `PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN`
- `PINTPATH_STAGING_GOOGLE_MAPS_API_KEY`
- `PINTPATH_STAGING_GOOGLE_MAPS_MAP_ID`
- `PINTPATH_STAGING_GOOGLE_PLACES_API_KEY`
- `PINTPATH_STAGING_OPENAI_API_KEY`
- `PINTPATH_STAGING_SUPABASE_PUBLISHABLE_KEY`
- `PINTPATH_STAGING_SUPABASE_SECRET_KEY`

Scale-evidence environment secrets:

- `PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN`
- `PINTPATH_RAILWAY_STAGING_METADATA_TOKEN`
- `PINTPATH_RAILWAY_STAGING_SCALE_TOKEN`
- `PINTPATH_STAGING_LOAD_USER_A_TOKEN`
- `PINTPATH_STAGING_LOAD_USER_B_TOKEN`
- `PINTPATH_STAGING_LOAD_ADMIN_TOKEN`
- `PINTPATH_STAGING_LOAD_WRITE_FIXTURE_JSON`

Additional workflow-only protected secrets are exact and environment-scoped:

- `production-topology-configuration` holds
  `PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN`.
- `production-runtime-configuration` holds
  `PINTPATH_RAILWAY_PRODUCTION_VARIABLE_TOKEN`.
- `permanent-staging-postgres-build-canary` holds
  `PINTPATH_RAILWAY_STAGING_POSTGRES_CANARY_DEPLOY_TOKEN`.
- `permanent-staging-supabase-legacy-disable` holds
  `PINTPATH_SUPABASE_STAGING_NEW_PUBLISHABLE_KEY`,
  `PINTPATH_SUPABASE_STAGING_NEW_SECRET_KEY`,
  `PINTPATH_SUPABASE_STAGING_OLD_ANON_KEY`, and
  `PINTPATH_SUPABASE_STAGING_OLD_SERVICE_ROLE_KEY`.
- `production-postgres-source-repin` holds
  `PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN`,
  `PINTPATH_RAILWAY_STAGING_METADATA_TOKEN`, and the distinct
  `PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN`. Before the first
  production dispatch, restrict it to protected `main`, require the designated
  release owner, and disable administrator bypass. For a solo owner, allow
  self-review so the explicit approval remains an auditable operator pause without
  requiring a second account. Teams may instead designate an independent reviewer
  and prevent self-review. Environment approval applies to this production
  workflow job, not to ordinary repository patches.

The Supabase legacy-cutover environment also holds separate project-scoped
`PINTPATH_SUPABASE_STAGING_SECRETS_READ_TOKEN` and
`PINTPATH_SUPABASE_STAGING_SECRETS_WRITE_TOKEN`. The Postgres build-canary
environment also holds the two read-only metadata tokens. Runtime configuration
uses the exact target-prefixed value-secret names mapped in
`configure-runtime-variable.yml`; never put a production value in the staging
environment or vice versa.

For the database transport variables, create these exact GitHub Environment
secret names so the reusable worker can materialize the selected value into its
private mode-`600` input file:

- permanent staging:
  `PINTPATH_STAGING_DATABASE_URL`,
  `PINTPATH_STAGING_DATABASE_MAINTENANCE_URL`,
  `PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_PEM`, and
  `PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_DER_SHA256`;
- production:
  `PINTPATH_PRODUCTION_DATABASE_URL`,
  `PINTPATH_PRODUCTION_DATABASE_MAINTENANCE_URL`,
  `PINTPATH_PRODUCTION_PINTPATH_POSTGRES_ROOT_CA_PEM`, and
  `PINTPATH_PRODUCTION_PINTPATH_POSTGRES_ROOT_CA_DER_SHA256`.

The repeated `PINTPATH` segment is intentional: the dispatcher prepends the
target namespace to the exact Railway variable name and the worker verifies
that bijection before reading the protected secret.

For the permanent-staging account-deletion completion notice, place these six
exact secrets only in `permanent-staging-provider-mutation`:

- `PINTPATH_STAGING_RESEND_TRANSACTIONAL_API_KEY`
- `PINTPATH_STAGING_RESEND_WEBHOOK_SIGNING_SECRET`
- `PINTPATH_STAGING_ACCOUNT_DELETION_NOTICE_KEYRING_JSON`
- `PINTPATH_STAGING_ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID`
- `PINTPATH_STAGING_ACCOUNT_DELETION_NOTICE_FROM`
- `PINTPATH_STAGING_ACCOUNT_DELETION_NOTICE_REPLY_TO`

The Resend key must be a dedicated sending-only staging key. The webhook secret
must belong to the staging-only deletion-notice endpoint and its six reviewed
events. Generate the 32-byte recipient-encryption key locally without printing
it; the active key ID must select that exact keyring member. The sender must use
the verified Pint Path sending domain and the reply-to address must be a
monitored privacy/support inbox. Treat the active ID, sender, and reply-to as
protected inputs even though they are not credentials; this prevents a manual
provider write from bypassing candidate and target authority.

After all six protected sources exist, serialize six first-attempt
`configure-runtime-variable.yml` dispatches at the exact current `main`. Write
the keyring before its active ID, then the transactional key, webhook secret,
sender, and reply-to. Use the generated
`UPSERT_<VARIABLE>_IN_PERMANENT_STAGING` confirmation for each dispatch. Every
write is sealed and deploy-suppressed. Do not deploy or enable the notice mode
until all six postflights pass and the separately reviewed rehearsal-activation
path is ready. Production uses independently generated
`PINTPATH_PRODUCTION_<VARIABLE>` secrets and remains outside this staging
ceremony.

The one exception is the non-secret staging source repair. Select target
`permanent-staging-postgres`, variable
`PINTPATH_RUNTIME_DATABASE_URL`, and confirmation
`UPSERT_PINTPATH_RUNTIME_DATABASE_URL_IN_PERMANENT_STAGING_POSTGRES`. The worker
requires the sentinel value-source identity
`PINTPATH_REVIEWED_FIXED_POSTGRES_RUNTIME_URL`; no GitHub value secret exists or
is read. The executor supplies one compile-time constant whose authority is
exactly `postgres-staging.railway.internal:5432`, database
`pintpath_staging`, login `pintpath_staging_runtime_login`, and sole query
`sslmode=verify-full`, with only the existing same-service password, private-
domain, and port references. Any production pairing, arbitrary input, altered
reference graph, shared shadow, host, database, login, port, or query fails
before the provider write. The acknowledged non-deploying upsert still requires
later startup and authentication proof; metadata cannot reveal the resolved
value.

For each target, configure `DATABASE_URL`, `DATABASE_MAINTENANCE_URL`,
`PINTPATH_POSTGRES_ROOT_CA_PEM`, and
`PINTPATH_POSTGRES_ROOT_CA_DER_SHA256` before deployment. Both URLs must share
the reviewed lower-case private Railway `:5432` authority and use only
`sslmode=verify-full`. The CA secret is the exact multiline PEM bytes, not a
pathname; the DER pin must be captured independently. The worker accepts the
single-certificate PEM form, writes it through one sealed non-deploying
variable mutation, zeroes its input buffer, and never emits the bytes or a
derived digest in evidence. The application then performs cryptographic
certificate/pin validation and fail-closed owned-file materialization at boot.

The production and staging metadata tokens must be read-only, separately held,
environment-scoped Railway project tokens. Each staging mutation token must be
a third, separately held token scoped only to permanent staging and only to the
minimum provider capability. The production source-lock mutation token must be
a separate production-environment token used only by that one protected
environment and workflow. The executors verify token project/environment scope
and reject reused metadata/mutation tokens.

The two PITR environments each hold these four secrets:

- `PINTPATH_RAILWAY_PITR_METADATA_TOKEN`
- `PINTPATH_RAILWAY_PITR_ENABLE_TOKEN`
- `PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN`
- `PINTPATH_RAILWAY_STAGING_METADATA_TOKEN`

The PITR metadata and enable tokens must be separately held, target-scoped
project tokens; the production/staging metadata tokens remain the independent
read-only mutation-boundary observers. Each PITR environment also holds two
protected environment variables: set
`PINTPATH_POSTGRES_HA_PITR_AUTHORITY_TARGET` to exactly `permanent-staging` or
`production` for that environment, and set
`PINTPATH_POSTGRES_HA_PITR_EXPECTED_ROOT_SERVICE_ID` to the independently
reviewed current HA-root UUID for that target. Do not copy a value between
environments. The dispatcher never accepts a root UUID, project UUID, or
environment UUID. It selects only the target label; repository policy maps
that label to the canonical project/environment and GitHub selects the matching
protected environment. Before writing, the executor enumerates the complete
Railway environment service inventory, probes every service as a possible HA
root, requires exactly one provider-discovered root, and compares it to the
protected authority. The target/root authority digest is bound into both intent
and terminal receipts. Missing, stale, duplicated, or cross-target authority
fails before the mutation.

The `disposable-restore-teardown` environment holds only these four distinct,
least-privilege secrets:

- `PINTPATH_RAILWAY_RESTORE_METADATA_TOKEN`
- `PINTPATH_RAILWAY_RESTORE_DELETE_TOKEN`
- `PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN`
- `PINTPATH_RAILWAY_STAGING_METADATA_TOKEN`

It requires an independent reviewer, prevents self-review and administrator
bypass, and is restricted to protected `main`. Never place these credentials
at repository scope: GitHub otherwise auto-creates an unprotected environment
when the name is absent, which is not teardown authority. The restore metadata
token may inspect only the separately reviewed disposable project; the delete
token may delete only that exact project. Production and staging tokens remain
read-only and exist solely to re-prove that forbidden resources are untouched.

The two production-route environments each hold
`PINTPATH_RAILWAY_PRODUCTION_ROUTE_METADATA_TOKEN` plus the two independent
read-only mutation-boundary tokens. The close environment alone holds
`PINTPATH_RAILWAY_PRODUCTION_ROUTE_DELETE_TOKEN` and protected variable
`PINTPATH_PRODUCTION_ROUTE_AUTHORITY_OPERATION=close`; the open environment
alone holds `PINTPATH_RAILWAY_PRODUCTION_ROUTE_CREATE_TOKEN` and
`PINTPATH_PRODUCTION_ROUTE_AUTHORITY_OPERATION=open`. Metadata, delete, and
create credentials are distinct production-scoped tokens. Do not copy either
writer between environments or expose any value as an input, log, or artifact.
`production-promotion-recovery-activation` protects the two data-bearing JIT
jobs. `production-capture` uses only
`[self-hosted, linux, x64, pintpath-production-backup]` inside the production
private network; `disposable-recover` uses only
`[self-hosted, linux, x64, pintpath-disposable-recovery]` inside the exact
disposable private network. The first captures PITR, logical backup, private
Storage and the deletion authority and seals the logical and private sets into
their separate WORM authorities. The second independently retrieves both WORM
sets, restores them, runs the compiled candidate as a local child against the
disposable Postgres/Redis/Supabase network, replays deletion twice, and purges
the restored Storage set. Raw recovery bytes remain in tmpfs and provider/WORM
channels; no GitHub artifact carries them.

`production-promotion-recovery-cleanup` is a separate, non-interactive
environment used only by the `if: always()` cleanup job. Its exact secrets are:

```text
PINTPATH_RECOVERY_RAILWAY_TEARDOWN_AUTHORITY_BASE64
PINTPATH_RECOVERY_RAILWAY_TEARDOWN_AUTHORITY_PUBLIC_KEY_BASE64
PINTPATH_RECOVERY_RAILWAY_READ_TOKEN
PINTPATH_RECOVERY_RAILWAY_DELETE_TOKEN
PINTPATH_RECOVERY_SUPABASE_TEARDOWN_AUTHORITY_BASE64
PINTPATH_RECOVERY_SUPABASE_TEARDOWN_AUTHORITY_PUBLIC_KEY_BASE64
PINTPATH_RECOVERY_SUPABASE_READ_TOKEN
PINTPATH_RECOVERY_SUPABASE_DELETE_TOKEN
PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_BASE64
PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_PUBLIC_KEY_BASE64
```

Its exact protected variables are:

```text
PINTPATH_RECOVERY_RAILWAY_TEARDOWN_AUTHORITY_SHA256
PINTPATH_RECOVERY_RAILWAY_TEARDOWN_AUTHORITY_PUBLIC_KEY_SHA256
PINTPATH_RECOVERY_SUPABASE_TEARDOWN_AUTHORITY_SHA256
PINTPATH_RECOVERY_SUPABASE_TEARDOWN_AUTHORITY_PUBLIC_KEY_SHA256
PINTPATH_RECOVERY_SUPABASE_ORGANIZATION_SLUG
PINTPATH_RECOVERY_SUPABASE_ORGANIZATION_SLUG_SHA256
PINTPATH_RECOVERY_TARGET_SUPABASE_ORIGIN_SHA256
PINTPATH_RECOVERY_DESTINATION_RESTORE_AUTHORITY_SHA256
PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_SHA256
PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_PUBLIC_KEY_SHA256
```

The emergency target tuple is not held in mutable repository variables. The
arm manager compare-and-swaps its canonical, self-hashed OPEN/DISARMED record
under the protected dedicated state ref
`refs/heads/pintpath-production-promotion-recovery-emergency-cleanup-state`.
An OPEN state rejects a different or second arm; a renewal must retain the
exact activation/target tuple, link the previous arm SHA-256, and advance its
lineage sequence. Only a DISARMED state permits the next initial arm.

Each teardown authority must be signed for the exact activation
`GITHUB_RUN_ID`, attempt `1`, candidate, and reviewed disposable identities.
Dispatch the activation and leave its environment approval pending, record the
assigned run ID, create and independently verify both authorities, install
their pins and distinct read/delete tokens in the cleanup environment, and
only then approve capture. The Railway and Supabase cleanup steps run
independently with `if: always()`. Supabase `cleanupMode=orderly` must bind the
exact Storage purge receipt to finalize green; `emergency` cleanup is only a
failure/cancellation safety path and can never finalize green. Use standard
cancel only. Force-cancel is forbidden until independent read-only evidence
proves both disposable providers absent.

Before capture, the same exact run/candidate/targets and complete Railway
workspace inventory must also be bound into the signed singleton emergency arm
and exact OPEN state. Never dispatch or arm a second activation while that
state remains OPEN.
The completion/15-minute/manual controller retries emergency cleanup outside
the activation cancellation domain; its distinct artifacts never green
activation. Exact per-activation delete-ack terminals persist in the state ref;
later runs require their exact bytes plus fresh provider absence. The controller
compare-and-swaps DISARMED only after both providers are terminal. Railway
workspace absence may mean transfer, so `already_absent` and lost delete
acknowledgement are not green; exact `projectDelete: true` plus repeated
postflight absence is required.

The Supabase cleanup read token has exactly the sorted fine-grained permissions
`organization_projects_read` and `project_admin_read`: the first authorizes the
complete organization inventory and the second authorizes direct exact-project
preflight, reassertion, and absence reads. Its separate delete token has
`project_admin_write`; neither credential substitutes for the other. The
checked-in cleanup executor pins
`ops/supabase/protected-disposable-project-teardown-policy.json` at SHA-256
`fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796`.
The Railway cleanup policy pin is
`4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef`.

The later `production-promotion-recovery` environment has no provider writer
or canonical-route writer. It contains exactly five protected base64 evidence
secrets:

```text
PINTPATH_PROMOTION_RECOVERY_APPLY_AUTHORIZATION_RECEIPT_BASE64
PINTPATH_PROMOTION_RECOVERY_APPLY_OPERATION_RECEIPT_BASE64
PINTPATH_PROMOTION_RECOVERY_AUTHORITY_BASE64
PINTPATH_PROMOTION_RECOVERY_APPROVAL_ONE_BASE64
PINTPATH_PROMOTION_RECOVERY_APPROVAL_TWO_BASE64
```

It also contains the two independently protected reviewer public keys and
their SHA-256 variables. The version-2 authority and both distinct Ed25519
approvals are created only after the final activation artifact exists. The
authority's `recoveryStartedAt` is immutably bound to the successful GitHub
activation workflow `run_started_at`, not chosen by an operator or reviewer. Its
output is a secret-free, candidate- and deployment-bound receipt consumed by
route open. The controlling policy is schema v2 at SHA-256
`57f66c1c9dde912586ec510e37c28cc3dfea2c098e67c78edbea189c7dcc9988`.

## Exact execution order

1. Freeze `reviewedPrHeadSha` and merge it through protected linear `main`.
   Record the resulting current protected-main merge commit as `candidateSha`;
   fetch the associated PR head separately and require exact tree equality, not
   ancestry. Human PR approval is not required in this solo-owner repository;
   require the exact merged non-draft same-repository PR and pass all required
   checks on the exact candidate.
2. The disposable staged-null proof is complete and pinned by
   `docs/incident-evidence/railway-staged-deletion-proof-2026-08-29/attestation.json`
   at SHA-256
   `e1faa9daff1ff4927c852ccf08b917f77b7893f77a04c20bbe192f556e276de2`.
   Do not use `variableDelete`. Under the external-writer freeze, dispatch the
   reviewed `remove-forbidden-offsite-backup-variables` operation once for the
   exact current protected-main candidate. If and only if runner loss strands
   the exact authenticated patch, use its reviewed same-candidate resume/cancel
   identity; never redispatch the original. Prove the 96-row inventory, empty
   patch, and unchanged cold/dead topology before cold prepare.
3. Run `Mutate Pint Path permanent-staging provider variables` once per
   Google/OpenAI variable that needs reconciliation. Existing exact Beer rows
   are adopted in place; an absent row may be created. Shared, foreign, sealed,
   or referenced target rows fail closed. The confirmation is
   `MUTATE_<UPPERCASE_OPERATION_WITH_UNDERSCORES>_IN_PERMANENT_STAGING`. The run
   guard reserves the exact candidate+operation; redispatch only when every
   prior matching run's exact write step is authenticated as skipped.
   The provider value remains unreadable in Railway metadata, so the successful
   receipt is still pending runtime proof rather than proof of value equality.
4. If rotating Supabase keys, first seal the Beer application
   `SUPABASE_SERVICE_ROLE_KEY` row through the separately protected owner action,
   then run the same workflow with
   `supabase-key-replacement`. Supply both publishable and secret keys to one
   atomic `skipDeploys=true` mutation. No Railway canary service is required.
   Its receipt is not runtime proof.
5. For the current dead/null recovery, prove the exact staging `profiles` Data
   API prerequisite from the protected runner, run cold `prepare` without
   changing the null runtime, then authenticate cold quiesce from null to zero.
   Upload the candidate only at explicit zero, then restore it from zero to one
   with automatic maintenance disabled and candidate-bound. A healthy legacy
   route instead uses the normal prepare and one-to-zero quiesce proof. Never
   mix receipts between those two paths. Retain every authenticated artifact;
   the fenced upload is the first of exactly two same-candidate staging
   deployment successes.
   Run any general runtime-variable operation at most once for its exact
   candidate+target+variable guard; even a skipped prior run requires a new
   reviewed candidate. Complete those reviewed runtime writes while the
   restored candidate remains worker-disabled. Then run staging worker
   `activate`, which independently authenticates the full prepare→quiesce→
   fenced-upload→restore chain. Run the `active` deployment phase once at one
   replica and require both its activation terminal and sibling full-chain
   prerequisite verification. Retain this second successful candidate-bound
   artifact as the active closeout. Prove every tracked server, browser,
   mobile, CI, scheduled, webhook, backup, and archived consumer plus Auth,
   admin, role, private Storage, provider, and Free-scope behavior uses the
   final configuration.
   The workflow rejects a PR head or any SHA other than protected `main`; its
   GitHub receipt separately authenticates
   the reviewed PR head, the unique merged non-draft same-repository PR, the
   not-required human-approval policy, merge commit, linear history, and exact
   tree equality.
6. Only then run `Permanent staging Supabase legacy-key cutover`, supplying the
   exact replacement, fenced zero-replica deployment, and active closeout run
   IDs. Its verifier authenticates all three same-candidate attempt-one
   artifacts, the exact fenced/active run titles, their receipts, and strict
   replacement -> fenced -> active -> cutover chronology before secret custody.
   The active closeout must be a zero-write `already_deployed` reconciliation;
   a fenced retry may adopt an already-present exact candidate only after one
   authenticated earlier ambiguous fenced run, and no deployment dispatch may
   follow the selected active closeout. Its candidate-keyed guard permits a
   later fresh dispatch only when
   every prior matching cutover run's exact write step is authenticated as
   skipped, and the replacement history has exactly the selected success plus
   only safely skipped earlier attempts. It also rejects any same-candidate
   provider mutation or permanent-staging runtime-variable run whose
   `updated_at` is at or after the selected closeout deployment's
   `run_started_at`; no configuration write may make that deployment stale. The
   shared `queue: max` group serializes replacement, deployment, cutover, and
   general permanent-staging runtime writes without dropping a queued run. The
   general single-variable workflow hard-fails permanent-staging Supabase key
   writes. A 404, ambiguous acknowledgement, non-401 old-key response, or failed
   replacement-key canary is a hard stop with no write retry.
7. Run `Permanent staging Postgres build canary` and retain its candidate-bound
   stopped build receipt before accepting the pinned PG17 build/tool chain.
8. Require exactly the two successful same-candidate staging deployment runs
   from steps 2 and 5: the fenced zero-replica upload and active one-replica
   closeout. Both must have completed before scale starts; the release verifier
   selects the second closeout run and rejects zero, one, more than two, or
   ambiguous same-candidate successes. Then run `Prove Pint Path
   permanent-staging two-replica scale` with confirmation
   `SCALE_PERMANENT_STAGING_TO_TWO_FOR_EVIDENCE`. Do not cancel it. The final
   protected step converges the service to one replica even after an earlier
   failure. A workflow rerun cannot scale out again but may perform convergence.
9. Retain the candidate-bound artifacts and bind their hashes into the private
   release evidence register.
10. Production worker fence, source upload, maintenance LOGIN transition,
    worker activation, two-replica convergence, route close, recovery
    activation, promotion-recovery attestation, and route open share the
    non-cancelling `pintpath-production-rollout` concurrency group. Require the
    exact fence→deploy→LOGIN 2→8→worker-activate→scale sequence and its
    cross-bound receipts. After the same-SHA public smoke and exact two-replica
    convergence have passed—but before price promotion—dispatch
    `Close Pint Path protected production route` with
    `CLOSE_PINTPATH_PRODUCTION_ROUTE`. Require the custom domain absent with
    every collateral route and candidate-deployment field unchanged. Close
    first downloads the exact deployment and scale artifacts by GitHub artifact
    ID, SHA-256 digest, size, producer check, run, and candidate. Their canonical
    receipts must prove the same deployment, exactly two healthy replicas, and
    strict deploy-before-scale-before-close chronology.
11. Keep the route absent through promotion. Dispatch `Activate protected
production promotion recovery` only after the per-run cleanup-authority
    ceremony. Its four jobs capture production, independently retrieve the
    logical and private WORM sets into disposable tmpfs, restore and exercise
    the compiled application, purge the restored Storage set, independently
    prove Railway and Supabase absence, and finalize exactly 18 evidence leaves
    plus `activation-receipt.json` and `tested-commit-sha.txt` (20 final files).
    No raw recovery byte crosses a GitHub artifact.
12. After successful final activation, create the version-2 authority and both
    post-activation approvals, then dispatch `Attest Pint Path protected
production promotion recovery` with the exact activation run ID. Its
    two-reviewer receipt binds the exact close receipt and terminal digest,
    deployment and scale receipts, apply-only promotion, activation producer
    and artifact, post-promotion recovery/restore/twice-replayed deletion set,
    compiled-app smoke, orderly purge, both absence terminals, candidate,
    deployment identity, RPO/RTO, and chronology. Only then separately dispatch
    `Open Pint Path protected production route` with
    `OPEN_PINTPATH_PRODUCTION_ROUTE`; require the provider transition, valid
    TLS, exactly two replicas, and all three candidate-bound runtime probes
    before observation. Open first materializes the exact digest-bound close and
    promotion-recovery receipts.
    Never rerun a provider write after ambiguity; use its read-only reconciled
    terminal result.

Repository contract verification is available as:

```sh
npm run railway:staging:protected-mutation:contract:check
```

## Recovery and topology successors

`Converge Pint Path production to two replicas` provides the one-way protected
production topology prerequisite; it cannot scale production down. `Enable
Railway Postgres HA PITR` accepts only a production/permanent-staging selector,
maps it to a distinct protected GitHub environment and canonical Railway
environment, independently discovers exactly one HA root from the complete
provider inventory, requires it to equal that environment's protected root
authority, and requires a healthy multi-member cluster. It then invokes the
reviewed Railway 5.32.0 GraphQL workflow once and reconciles `DONE` and healthy
membership. `Delete one exact
disposable restore project` rejects the canonical Pint Path project and both
protected environments, requires a separate temporary project with one
ephemeral environment and a complete canonical inventory hash observed by two
distinct tokens, performs one `projectDelete`, and independently re-verifies
absence.

These paths remain inactive without protected secrets, exact live IDs,
approvals, and provider state. They do not themselves prove a restorable PITR
window, full application/Storage/tombstone recovery, WORM, signed RPO/RTO, or
disposal of separately administered Supabase/evidence authorities. The exact
production `pintpath.au` close/open pair above is the only route mutation in
scope; every other route/domain and provider billing change remains outside.

References: [Railway CLI](https://docs.railway.com/cli),
[Supabase API keys](https://supabase.com/docs/guides/api/api-keys), and
[Supabase key migration](https://supabase.com/docs/guides/api/api-keys/legacy-keys).
