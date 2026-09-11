# Protected production promotion and recovery authority

Status: **exact-run controller and workflow eligibility are implemented;
live host preparation, credentials, and authentic recovery evidence are still
required. Production promotion remains NO-GO until the candidate-bound live
rehearsal and protected attestation pass.** Unit tests do not stand in for
provider receipts. This successor preserves the existing recovery, network
separation, cleanup policies, and 18-leaf activation artifact contract.

The controlling policy is
`ops/railway/production-promotion-recovery-policy.json`, schema
`pintpath-production-promotion-recovery-policy/v2`, with exact SHA-256:

```text
57f66c1c9dde912586ec510e37c28cc3dfea2c098e67c78edbea189c7dcc9988
```

Any policy-byte change invalidates that pin and requires the executor, route
policy, tests, and operator evidence to be reviewed and re-pinned together.

## Exact release chain

All six stages use the non-cancelling `pintpath-production-rollout`
concurrency group and the exact current `main` candidate:

1. `deploy` — deploy and attest the exact candidate;
2. `scale` — converge the same deployment to exactly two healthy replicas;
3. `close` — remove only the canonical `pintpath.au` route;
4. `activation` (recovery activation, not worker activation) — after the
   separately authorized apply has completed while
   ingress is closed, capture the post-promotion recovery authorities, recover
   them in a different private network, and prove both disposable providers
   absent;
5. `promotion-recovery` — attest the exact successful activation with a
   version-2 authority and two post-activation approvals; and
6. `open` — restore only the canonical route after the exact attestation.

The release verifier enforces the route/recovery evidence chain
`deploy→scale→close→activation→promotion-recovery→open`, including
attempt-one workflow identities, check conclusions, timestamps, artifact IDs,
GitHub digests, sizes, producer jobs, and candidate-bound canonical receipts.
A same-SHA artifact with the wrong producer, order, run attempt, inventory, or
digest is not a substitute.

## Activation topology and data boundary

Dispatch `.github/workflows/activate-production-promotion-recovery.yml` only
after worker fence, deploy, maintenance LOGIN transition, worker activation,
scale, route close, and the separately executed reviewed apply have completed
and their exact receipts are retained for the later attestor.
The activation workflow does not perform or retry the promotion. It has exactly
four jobs:

1. `production-capture` runs on
   `[self-hosted, linux, x64, pintpath-production-backup]` plus its exact
   run/attempt/role label. This must be a JIT,
   ephemeral, one-job runner inside the production private network. It creates
   the schema-v3 logical backup, observes PITR inside this job, and binds that
   observation to the final active deployment from the authenticated scale
   receipt. The observer requires the activation prerequisite to map the
   earlier source-upload deployment to a distinct final active deployment; it
   never substitutes the upload receipt's superseded deployment ID. It captures
   private Storage plus the nonzero deletion authority, writes the logical and
   private recovery sets to their independently verifiable WORM forms, and
   proves the operational logical copy retrievable. The obsolete separate
   post-promotion PITR workflow is not part of this chain.
2. `disposable-recover` runs on
   `[self-hosted, linux, x64, pintpath-disposable-recovery]` plus its exact
   run/attempt/role label. It must be a
   separate JIT, ephemeral, one-job runner attached only to the exact
   disposable Railway/Supabase/Redis private network. It independently reads
   the logical WORM object versions and the private recovery-bundle WORM object
   versions, restores both sets, replays the deletion authority twice, starts
   the compiled candidate as a local child on that private-network runner,
   exercises the recovered Postgres, Redis, Supabase Auth, private Storage,
   source-evidence, role, and privacy boundaries, and purges exactly the
   restored Storage set.
3. `cleanup` runs on GitHub-hosted Ubuntu in the separately protected,
   non-interactive `production-promotion-recovery-cleanup` environment with
   `if: always()`. Its Railway and Supabase teardown steps each also use
   `if: always()`, so one failure cannot suppress the other. It produces two
   independent exact-absence terminals.
4. `finalize` runs only when capture, recovery, and cleanup all succeeded. It
   verifies the exact receipt inventory and publishes the activation artifact.

The two runner labels are different trust and network authorities. Never put
production database or Storage credentials on the disposable runner; never
put disposable restore credentials or cleanup writer tokens on the production
runner. Raw archives, private Storage objects, service keys, database URLs,
root CAs, Redis credentials, and recovery payload bytes must remain in the
run-specific tmpfs and WORM/provider channels. GitHub artifacts contain only
canonical receipts and immutable content addresses. Raw recovery bytes are
never uploaded to or relayed through GitHub artifacts.

The recovered application smoke is not a deployment claim. It launches the
exact compiled artifact as a local child on the disposable runner, which is
attached to the exact disposable private network, and binds the compiled tree,
entrypoint, candidate, database roles, target identities, Redis, Supabase Auth,
and both deletion replays. A localhost child on any other network, an
uncompiled source invocation, or a smoke against production cannot satisfy it.

## Per-run cleanup-authority ceremony

Teardown authorities are one-use records that bind the exact activation
`GITHUB_RUN_ID`, run attempt `1`, candidate, reviewed disposable Railway and
Supabase identities, complete signed Railway workspace identity/project
inventory, and the SHA-256 of a separate signed emergency-cleanup arm. They
cannot be prepared before GitHub assigns the run ID.

Configure both `production-promotion-recovery-activation` and
`production-promotion-recovery-cleanup` with zero required reviewers, zero wait
timers, and deployment branches and tags restricted to protected `main` only.
GitHub Environment entry scopes credentials; it is not a human approval gate.
Distinct cryptographic signer/reviewer identities, Ed25519 verification, exact
target inventories, the singleton arm, and signed change references remain
mandatory.

The activation workflow requires each base network-role label **and** the
exact `pintpath-recovery-<run-id>-1-<job-role>` label. A standing runner that has
only a base label cannot accept these jobs. The controller below checks the
actual queued job and current main before creating an offline JIT registration.
The root-installed registration receipt is verified against the assigned
GitHub job before either data-bearing job receives its first data secret.
Keep zero required reviewers/timers and protected `main` only; human Environment
approval is not this eligibility control.

1. Provision and independently inventory the exact disposable Railway project,
   its sole environment, the disposable Supabase project, and all expected
   target hashes. Prepare both JIT runners but do not expose production
   credentials to the disposable network.
2. Dispatch activation with confirmation
   `ACTIVATE_PRODUCTION_PROMOTION_RECOVERY` through the exact-run
   workflow and record its assigned `GITHUB_RUN_ID`.
3. Create and sign the emergency-cleanup arm for that exact run ID, candidate,
   Railway project/environment/workspace inventories, Supabase target, and the
   two pinned cleanup-policy hashes. Install its secret bytes/key in both the
   activation and cleanup environments. Run `Manage protected production
promotion recovery emergency cleanup arm` with `operation=initial`; it
   creates the protected dedicated state ref
   `refs/heads/pintpath-production-promotion-recovery-emergency-cleanup-state`
   only if no OPEN state exists. The non-force push is a compare-and-swap:
   concurrent or second arms fail mechanically. Capture verifies the exact
   OPEN state head before mutation. Do not make the exact capture job eligible
   until that transition is complete.
4. Authorized reviewers create and sign the Railway and Supabase teardown
   authorities for that exact run ID, attempt `1`, candidate, target inventory,
   and arm-authority SHA-256. Independently verify their bytes and public-key
   pins.
5. Install the cleanup secrets and variables below in
   `production-promotion-recovery-cleanup`. This environment is non-interactive
   during cleanup: no approval prompt may strand disposable resources after a
   cancellation or failure.
6. Only after the arm, both per-run authorities, and both read/delete
   credential pairs are installed and independently checked may the
   exact-run controller make `production-capture` eligible.
7. Follow the run through both absence terminals. The controller changes the
   state to DISARMED only after both fresh provider absences are independently
   reconciled. Revoke the one-use authorities/tokens only after that terminal
   compare-and-swap. If an exact Railway delete
   acknowledgement was lost, workspace-scoped absence is not global deletion
   proof: keep ARMED and obtain provider-global reconciliation.

The cleanup environment holds these exact secrets:

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

It also holds these exact variables:

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
PINTPATH_RECOVERY_EMERGENCY_CANDIDATE_SHA
PINTPATH_RECOVERY_EMERGENCY_ACTIVATION_RUN_ID
PINTPATH_RECOVERY_EMERGENCY_RAILWAY_PROJECT_ID
PINTPATH_RECOVERY_EMERGENCY_PROJECT_NAME
PINTPATH_RECOVERY_EMERGENCY_RAILWAY_ENVIRONMENT_ID
PINTPATH_RECOVERY_EMERGENCY_RAILWAY_INVENTORY_SHA256
PINTPATH_RECOVERY_EMERGENCY_RAILWAY_WORKSPACE_ID
PINTPATH_RECOVERY_EMERGENCY_RAILWAY_WORKSPACE_NAME
PINTPATH_RECOVERY_EMERGENCY_RAILWAY_WORKSPACE_PROJECT_INVENTORY_SHA256
PINTPATH_RECOVERY_EMERGENCY_SUPABASE_PROJECT_REF
```

Railway and Supabase read tokens must be distinct from their delete tokens and
scoped only to the reviewed disposable target. Cleanup tokens and authorities
must never exist in `production-capture` or `disposable-recover`.
The Supabase read token has exactly the sorted permissions
`organization_projects_read` and `project_admin_read`; its separate delete
token has `project_admin_write`. The executor pins the cleanup policy at
SHA-256 `fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796`.
The Railway executor pins
`ops/railway/protected-production-recovery-cleanup-policy.json` at SHA-256
`4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef`.
Railway cleanup requires both scoped tokens to positively bind the exact
workspace and exhaust its complete project inventory. Because a Railway
project can be transferred out of that workspace, neither pre-existing
workspace absence nor a lost delete acknowledgement is green. Success requires
the exact `projectDelete: true` acknowledgement plus repeated postflight
workspace/target absence.

Supabase cleanup is `orderly` only when it consumes the exact
`storage-purge-receipt.json`; its terminal must bind that purge receipt's
SHA-256. Only `cleanupMode=orderly` can finalize green. `emergency` mode exists
solely to reconcile absence after cancellation or earlier failure; it can
produce useful incident evidence but can never finalize a green activation or
attestation. Both the exact Railway project and exact Supabase project must be
independently proven absent.

The independent
`.github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml`
watchdog is outside the activation run's cancellation domain. It runs after
activation completion and every 15 minutes (or manually) while the durable
state ref is OPEN, re-verifies the signed run/candidate/target/workspace arm
and exact state head, checks out the exact candidate, and invokes both
idempotent cleanup executors in emergency mode from the non-interactive cleanup
environment. Its artifacts are named `...-emergency-cleanup-...` and are never
accepted by activation finalization or attestation. A force-cancelled watchdog
is retried by the schedule, but host/JIT cleanup remains the runner controller's
responsibility. Each exact provider delete-ack terminal is persisted under a
per-activation leaf in that ref. A later run accepts it only after exact
schema/self-hash/repository/run/arm/target verification and a fresh provider
absence proof; raw preflight absence never succeeds. If the 24-hour arm or
teardown authorities approach expiry, sign same-target replacements and use
the manager's `renewal` transition, which must link the prior authority and
preserve the target lineage.

Use only GitHub's standard cancel. **Force-cancel remains forbidden until
separate read-only observations prove both providers absent.** Force-cancel can
suppress an in-run `always()` job or the current watchdog attempt. A
cancellation, emergency cleanup, missing terminal, Railway acknowledgement
ambiguity, or unproved absence is a failed activation even if no disposable
resource is later found. The state remains OPEN until both exact current-run
absence terminals exist; otherwise renew its authorities as needed and
reconcile provider-global Railway state manually.

## Exact-run JIT controller

Use `scripts/control-production-recovery-jit-runner.ts prepare` from a trusted
controller with the reviewed candidate checkout, Node 22, and a private `0700`
persistent journal directory. The controller must have repository Actions,
Contents, Environment variables/secrets metadata read access and runner
Administration write access. Its `GH_TOKEN` stays on the controller; the data
runners receive only the workflow's normal Actions-read token. Do not grant
runner administration or cleanup read/delete credentials to either data job.

Supply the already reviewed canonical signed documents as private `0600`
files in one private directory: `arm.json`, `arm-public.pem`, `railway.json`,
`railway-public.pem`, `supabase.json`, and `supabase-public.pem`. These are the
same documents and public keys installed in the activation/cleanup environments;
no new signing format or approval replaces the existing ceremony.

```sh
node --import tsx scripts/control-production-recovery-jit-runner.ts prepare \
  --candidate-sha "$CANDIDATE_SHA" --run-id "$ACTIVATION_RUN_ID" \
  --role production-capture --runner-group-id "$REVIEWED_RUNNER_GROUP_ID" \
  --authority-directory "$PRIVATE_AUTHORITY_DIRECTORY" \
  --journal-directory "$PRIVATE_CONTROLLER_JOURNAL"
```

The command verifies exact main, workflow/run/attempt, queued job labels,
absence of an existing matching runner, the current OPEN compare-and-swap
state, all three existing signatures, and the installed authority pins and
cleanup secret names. It repeats those observations immediately before its
single registration request. Sealed secret values are not exposed by GitHub;
the existing data/cleanup executors still validate the actual credentials when
used. Metadata presence alone is not evidence that a restore or cleanup passed.

Registration produces three private journal files prefixed with the exact
runner name: `-intent.json`, `-jit-config`, and `-receipt.json`. It never starts a
listener. A trusted host administrator installs that receipt as root-owned
`0644` `/etc/pintpath/production-recovery-jit-receipt.json` under a root-owned,
non-writable `/etc/pintpath` directory on the correct newly prepared host.
Install and verify the existing root-owned ephemeral runner policy, tmpfs,
no-swap and private-network egress policy before starting the non-root GitHub
runner with `run.sh --jitconfig` and the private config bytes. Use the reviewed
runner binary/group and an otherwise empty host. Neither the JIT config nor
controller token belongs in GitHub artifacts or logs.

Only after production capture succeeds, repeat preparation for
`--role disposable-recover` using its separate clean host/network. The
controller refuses to register recovery before the exact capture job succeeds.
The job-side verifier binds the root-installed receipt to the actual
GitHub-assigned job ID, runner ID, name, group, role and labels, and rechecks
the OPEN arm before data access. It emits a secret-free receipt hash and
job/runner IDs into the workflow log. Preserve both private controller receipts
alongside the authentic activation evidence.

A failed or uncertain registration is never retried automatically. Preserve
the stable run/role intent and independently reconcile the registered runner
inventory; never choose a new journal directory to bypass the intent. A JIT
runner executes at most one job. Destroy its host and raw working storage after
termination, including on failure/cancellation, and prove both host and runner
registration absent. Workflow `always()` cleanup and the external emergency
watchdog remain mandatory; a successful host cleanup is not a substitute for
Railway/Supabase deletion receipts.

GitHub's official [JIT registration API](https://docs.github.com/en/rest/actions/self-hosted-runners#create-configuration-for-a-just-in-time-runner-for-a-repository),
[workflow job API](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt),
and [JIT security guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-just-in-time-runners)
define these registration, assignment and single-job guarantees.

The 2026-09-11 bounded access check found repository admin access and zero
registered runners. The observed production services were Beer, Redis and
Postgres-Production; no recovery host was present in that inventory. The
recovery environments had no credentials and no authentic candidate rehearsal.
This proves missing setup, not that provisioning is necessarily owner-only:
confirm available private-host provisioning authority before classifying that
work as external. Existing GitHub admin access may automate registration once
the hosts, signed authorities, data credentials and upstream promotion gates
are ready. No registration, host provisioning or recovery was executed by this
software change.

## Exact activation inventory

The final activation receipt binds these 18 canonical evidence leaves:

```text
deletion-replay-first-receipt.json
deletion-replay-second-receipt.json
logical-backup-manifest.json
logical-offsite-result.json
logical-restore-receipt.json
logical-worm-result.json
logical-worm-retrieval-receipt.json
offsite-retrieval-receipt.json
pitr-receipt.json
private-storage-capture-receipt.json
private-storage-recovery-manifest.json
private-storage-restore-receipt.json
private-storage-worm-receipt.json
private-storage-worm-retrieval-receipt.json
recovered-smoke-receipt.json
storage-purge-receipt.json
railway-teardown-terminal.json
supabase-teardown-terminal.json
```

The artifact
`pintpath-production-promotion-recovery-activation-<candidate-sha>` contains
exactly 20 files: those 18 leaves plus `activation-receipt.json` and
`tested-commit-sha.txt`. The logical WORM retrieval receipt and private-bundle
WORM retrieval receipt are different authorities; neither can stand in for the
other. The finalizer rejects an extra, missing, substituted, noncanonical,
wrong-mode, wrong-owner, or wrong-hash leaf.

## Post-activation authority and attestation

After the final 20-file activation artifact exists, build one canonical
`pintpath-production-promotion-recovery-authority/v2` manifest. It binds the
activation producer repository/workflow/run/artifact, all 18 evidence hashes,
logical WORM retrieval time, compiled-application readiness, purge and cleanup
chronology, deployment/scale/close/apply identities, RPO/RTO, and the two
reviewer public-key hashes. The version-2 policy requires both approvals to be
created **after final activation**. They must use distinct reviewer IDs and
distinct Ed25519 keys and remain within the six-hour attestation window.
`recoveryStartedAt` is immutably copied from the exact successful activation
workflow's GitHub `run_started_at`; an operator or reviewer cannot select or
backdate the RTO origin.

The protected `production-promotion-recovery` environment receives exactly
these five base64 evidence secrets:

```text
PINTPATH_PROMOTION_RECOVERY_APPLY_AUTHORIZATION_RECEIPT_BASE64
PINTPATH_PROMOTION_RECOVERY_APPLY_OPERATION_RECEIPT_BASE64
PINTPATH_PROMOTION_RECOVERY_AUTHORITY_BASE64
PINTPATH_PROMOTION_RECOVERY_APPROVAL_ONE_BASE64
PINTPATH_PROMOTION_RECOVERY_APPROVAL_TWO_BASE64
```

The two public keys are separate protected secrets and their hashes are
separate protected variables:

```text
PINTPATH_PROMOTION_RECOVERY_REVIEWER_ONE_PUBLIC_KEY_BASE64
PINTPATH_PROMOTION_RECOVERY_REVIEWER_TWO_PUBLIC_KEY_BASE64
PINTPATH_PROMOTION_RECOVERY_REVIEWER_ONE_PUBLIC_KEY_SHA256
PINTPATH_PROMOTION_RECOVERY_REVIEWER_TWO_PUBLIC_KEY_SHA256
```

Dispatch `.github/workflows/attest-production-promotion-recovery.yml` with the
exact `candidate_sha`, successful attempt-one `activation_run_id`, and
confirmation `ATTEST_PRODUCTION_PROMOTION_RECOVERY`. The attestor independently
verifies the GitHub activation run and downloads the exact named 20-file
artifact. Deploy, scale, close, and close-terminal receipts come from the
trusted GitHub release chain, not caller-supplied copies. The output artifact
is `pintpath-production-promotion-recovery-<candidate-sha>` and contains only
the self-hashed receipt, hash-only result, and tested commit SHA.

Route open may consume only that exact digest-bound attestation under the
six-stage release chain and the pinned version-2 policy. Any failure, missing
live evidence, stale approval, emergency cleanup, or mismatch leaves ingress
closed. Preserve the evidence and reconcile read-only; do not fabricate a
receipt, bless a failed file by hashing it, rerun a provider write blindly, or
claim the checked-in capability is live execution.
