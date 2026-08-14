# Protected provider-mutation operations

Status: repository transport implemented; no provider mutation has been run by
this change.

This document is the operator contract for the protected manual workflows that close
the former repository-side transport gaps without granting an unattended path
to Railway:

- `.github/workflows/permanent-staging-provider-mutation.yml` creates one of
  the four reviewed Google/OpenAI variables or atomically replaces both
  Supabase keys in permanent staging.
- `.github/workflows/permanent-staging-scale-evidence.yml` scales the exact
  reviewed application deployment from one replica to two, runs expected-peak,
  2x-peak, and 60-minute soak proof, and unconditionally converges the service
  back to one replica.
- `.github/workflows/configure-runtime-variable.yml` writes one allowlisted
  application variable in exact permanent staging or production. Its worker
  uses separate protected environments and target-scoped tokens.
- `.github/workflows/permanent-staging-supabase-legacy-cutover.yml` runs the
  replacement-key canaries, performs one staging legacy-disable request,
  unconditionally reconciles disabled state, and proves HTTP 401 rejection for
  both retained old keys.
- `.github/workflows/permanent-staging-postgres-build-canary.yml` uploads the
  exact no-ingress Postgres build canary once and accepts only its canonical,
  credential-free, stopped build-only receipt.
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

All provider-mutation workflows are `workflow_dispatch` only, require the exact current `main`
SHA, use a non-cancelling concurrency group, and bind their provider write job
to a dedicated GitHub Environment. They run the production/staging Railway
mutation boundary immediately before and after writes. Every write has a
durable secret-free intent, a maximum of one attempt, no automatic retry, an
unconditional read-only reconciliation, and secret-free terminal evidence.
An ambiguous write exits non-zero and must not be retried unless the executor
can prove the one exact before→after transition with no collateral change. The
route close/open executor records that exceptional case as the explicit
`*_reconciled_after_lost_ack` success outcome; it never treats desired state
alone, a pre-existing state, or an incomplete inventory as success.

The paired Supabase operation is one Railway `variableCollectionUpsert` with
`skipDeploys=true`; it is not two CLI writes. The operation and response shape
were verified against the pinned Railway CLI 5.32.0 source. It never includes
the key values or a value-derived digest in evidence. A successful mutation is
reported as `acknowledged_pending_runtime_proof`, not as a completed rotation:
the same candidate must subsequently be deployed to permanent staging and pass
the Auth, Storage, browser, server, mobile, and sealed-variable gates before a
legacy key can be disabled.

## One-time GitHub setup

Create these GitHub Environments and restrict deployment branches to `main`.
Except for the cleanup environment called out below, require reviewers,
prevent self-review, and do not allow administrators to bypass protection:

- `permanent-staging-provider-mutation`
- `permanent-staging-scale-evidence`
- `production-topology-configuration`
- `production-runtime-configuration`
- `permanent-staging-supabase-legacy-disable`
- `permanent-staging-postgres-build-canary`
- `postgres-ha-pitr-permanent-staging`
- `postgres-ha-pitr-production`
- `disposable-restore-teardown`
- `production-route-close`
- `production-promotion-recovery-activation`
- `production-promotion-recovery-cleanup`
- `production-promotion-recovery`
- `production-route-open`

`production-promotion-recovery-cleanup` is intentionally non-interactive: it
must not require an approval that can strand disposable resources after an
earlier failure or standard cancellation. Protect its secrets and variables,
limit them to exact per-run teardown authority, and never use this exception to
grant a capture, restore, promotion, or route mutation.

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
environment-scoped Railway project tokens. Each mutation token must be a third,
separately held token scoped only to permanent staging and only to the minimum
provider capability. The executors verify token project/environment scope and
reject reused metadata/mutation tokens.

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

1. Merge and pass all required checks on the exact candidate at `main`.
2. Run `Deploy Pint Path permanent staging` at one replica and retain its
   candidate-bound deployment evidence. This merge-first order is mandatory:
   the workflow and executor both reject a PR-head or any SHA other than the
   exact commit currently at protected `main`.
3. Run `Mutate Pint Path permanent-staging provider variables` once per absent
   Google/OpenAI variable. The confirmation is
   `MUTATE_<UPPERCASE_OPERATION_WITH_UNDERSCORES>_IN_PERMANENT_STAGING`.
4. If rotating Supabase keys, run the same workflow with
   `supabase-key-replacement`. Both keys are supplied to one atomic mutation.
5. Re-run the permanent-staging application deployment for the same candidate,
   then run the provider, Auth, Storage, consumer-compatibility, and sealed
   variable gates. A mutation receipt alone is not runtime proof.
6. Run `Permanent staging Supabase legacy-key cutover` only after every tracked
   consumer has moved. A 404, ambiguous acknowledgement, non-401 old-key
   response, or failed replacement-key canary is a hard stop with no retry.
7. Run `Permanent staging Postgres build canary` and retain its candidate-bound
   stopped build receipt before accepting the pinned PG17 build/tool chain.
8. Run `Prove Pint Path permanent-staging two-replica scale` with confirmation
   `SCALE_PERMANENT_STAGING_TO_TWO_FOR_EVIDENCE`. Do not cancel it. The final
   protected step converges the service to one replica even after an earlier
   failure. A workflow rerun cannot scale out again but may perform convergence.
9. Retain the candidate-bound artifacts and bind their hashes into the private
   release evidence register.
10. Production deploy, two-replica convergence, route close, recovery
    activation, promotion-recovery attestation, and route open share the non-cancelling
    `pintpath-production-rollout` concurrency group. After the production source
    upload, same-SHA public smoke, and exact two-replica convergence have
    passed—but before price promotion—dispatch
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
