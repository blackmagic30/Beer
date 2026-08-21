# Protected production PostgreSQL maintenance LOGIN transition

This operation changes one PostgreSQL attribute only:

```sql
ALTER ROLE privacy_maintenance_login CONNECTION LIMIT 8;
```

It does not mutate `pintpath_maintenance`. That role remains the exact
`NOLOGIN`, `NOINHERIT`, `CONNECTION LIMIT -1` group authority. It does not
grant privileges, change a password, deploy an application, scale a service,
or authorize either of those later operations.

The policy is
`ops/postgres/protected-production-maintenance-login-limit-policy.json`. The
prerequisite verifier is
`scripts/verify-production-maintenance-role-limit-prerequisites.ts`, the only
executor is
`scripts/execute-protected-production-maintenance-role-limit.ts`, and the only
operator entry point is the manual
`transition-production-postgres-maintenance-role-limit.yml` workflow.

## Required protected wiring

Create the GitHub environment
`production-postgres-maintenance-role-limit`. Require an independent reviewer,
prevent self-review, do not allow administrator bypass, and restrict it to
`main`. Do not reuse an application-deployment or general production secret
environment.

The job deliberately requires an ephemeral, single-job self-hosted runner with
all four labels:

- `self-hosted`
- `linux`
- `x64`
- `pintpath-production-postgres`

The runner must be able to resolve and route directly to
`postgres-production.railway.internal:5432`. It must start from a clean image,
run as one unchanged non-root UID/EUID, expose no `PG*`, `DATABASE_URL`, or
`DATABASE_MAINTENANCE_URL` environment variables, and be destroyed after the
job. A GitHub-hosted runner cannot be substituted for this private-network
contract.

Configure only these protected values:

- Secret `PINTPATH_PRODUCTION_POSTGRES_ROLE_ADMIN_URL`: the exact
  `postgresql://postgres:...@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full`
  authority. Never put this URL in a workflow input, command argument, log, or
  artifact.
- Secret `PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_PEM`: the independently reviewed
  Railway root CA.
- Variable `PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_DER_SHA256`: the exact
  lowercase SHA-256 of that certificate's DER encoding.

The URL and CA exist as environment values only in the custody-materialization
step. That step writes owner-only `0600` files beneath a `0700` runner-temporary
directory. The executor accepts file paths, never credential values, and
rejects ambient libpq/application database authority.

Before enabling the environment, update the repository's central immutable
action-count assertion in `test/release-workflows.test.ts`. This new workflow
adds one checkout reference, one setup-node reference, two upload-artifact
references, and three v8.0.1 download-artifact references. Until that existing
test is updated, `npm run check` fails before credential custody, so the
operation remains safely non-dispatchable.

## Apply

Apply is valid only after the same exact candidate has a successful protected
production worker-fence run and a later successful protected production
deployment run. The verifier uses GitHub's API to bind both exact run IDs to
the repository, `main`, candidate, original attempt, workflow path/name,
successful conclusion, unique unexpired artifact ID/digest/size, chronology,
and a complete bounded run-history window. Any later production fence or
deployment run blocks the role transition.

The fence terminal must prove an atomic candidate-bound `false` variable
transition while preserving the running deployment, topology, source, and
collateral variables. The later deployment receipt must have every exact v5
executor check true. Bound to the pinned production deployment policy and
same-candidate workflow authority, those checks prove that `/health`,
`/startup`, and `/ready` reported workers disabled and candidate-bound, and
that exactly one active, successful, non-stopped deployment generation served
the candidate at exactly one replica. A two-replica production receipt is a
hard stop at this stage. This later sole-healthy deployment is the closure for the fence
producer's explicit `EXTERNAL_SQLITE_DETACHED_FROM_POSTGRES_PROOF` boundary.

Independent reviewed capacity evidence must still show that limit 8 is safe;
the role transition does not infer server, reserved, or non-application
connection capacity from these application receipts.

Dispatch from `main` with:

- `candidate_sha`: exact current 40-character `main` SHA
- `operation_mode`: `apply`
- `prior_run_id`: empty
- `worker_fence_run_id`: the successful production `fence` run
- `production_deployment_run_id`: the later successful production deployment
  run
- `confirmation`:
  `ALTER_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_2_TO_8`

The workflow runs the complete repository gate, downloads the exact named
artifacts by run ID, and runs the GitHub/receipt verifier before database
secrets are referenced. The verifier emits canonical, secret-free
`prerequisites-verification.json`, valid for 15 minutes. The executor then
creates a canonical `intent.json` binding its SHA-256, both producer run IDs,
the candidate, policy, consumer run, and time. The workflow uploads that intent
as an immutable artifact and proceeds only after the upload succeeds. Database
credentials do not exist on the runner before that point.

The consumed producer artifacts and receipt schemas are:

- `pintpath-automatic-maintenance-worker-fence-production-fence-<sha>` /
  `automatic-maintenance-worker-fence-terminal.json` /
  `pintpath-automatic-maintenance-worker-fence-terminal/v1`
- `pintpath-production-deployment-<sha>` / `deployment-receipt.json` /
  `pintpath-railway-application-deployment-executor/v5`

The role workflow publishes the durable pre-write artifact
`pintpath-production-maintenance-role-limit-intent-<sha>-<run-id>`, containing
both `intent.json` and its exact `prerequisites-verification.json`, and the
always-attempted terminal artifact
`pintpath-production-maintenance-role-limit-<mode>-<sha>-<run-id>`.

The executor performs a serializable read-only catalog preflight. It requires:

- PostgreSQL 17 and the exact production database/admin identity
- `privacy_maintenance_login` at connection limit 2 with LOGIN, NOINHERIT, no
  elevated attributes, no expiry, no role settings, no child roles, and exactly
  one membership
- the sole membership is `pintpath_maintenance` with `ADMIN FALSE`,
  `INHERIT FALSE`, and `SET TRUE`
- `pintpath_maintenance` remains safe NOLOGIN/NOINHERIT, limit -1, with no
  parents, no role settings, and exactly the canonical LOGIN as its sole member

Any drift stops before `ALTER ROLE`. Immediately before the write, the
executor re-fetches `main`, requires a clean exact candidate, begins one
transaction, obtains the policy-pinned transaction advisory lock, and repeats
the complete catalog check. It can issue at most one fixed `ALTER ROLE`
statement. Automatic retry and workflow rerun are forbidden.

After every attempted ALTER, including a lost acknowledgement or connection
failure, the executor opens a fresh connection for a read-only catalog
postflight. Limit 8 with the complete checked role-attribute and membership
contract is recorded as either `updated` or
`reconciled_after_ambiguous_write`. Any other result remains
`mutation_uncertain`; it never retries.

## Reconcile an interrupted apply

Never rerun the canceled/failed apply job. Freeze merges to `main` until the
result is resolved, because both the protected checkout and reconciliation
authority require the original candidate to remain exact current `main`. Start
a new manual dispatch with that same candidate:

- `operation_mode`: `reconcile`
- `prior_run_id`: the original apply run containing the durable intent artifact
- `worker_fence_run_id`: empty
- `production_deployment_run_id`: empty
- `confirmation`:
  `RECONCILE_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_8`

The workflow downloads only the artifact whose name binds that candidate and
prior run. Before database credential custody, the verifier authenticates the
prior apply run and unique, unexpired artifact through GitHub's API, downloads
the archive independently, fails hard on an archive-digest mismatch, and
requires the local intent and prerequisite bytes to equal the unique archive
entries. The executor then requires the same candidate and policy, exact
prerequisite digest and producer run bindings, a different current run,
original attempt 1, and age within 30 days. It does not require new mutation
prerequisites. Reconciliation is catalog-read-only and contains no ALTER path.
Exact limit 8 is recorded as `reconciled_from_prior_intent`; exact unchanged
limit 2 is recorded as `not_applied_after_prior_intent`. Any other state, or an
already-8 state without that exact prior authority, is blocked.

Each run always attempts to upload canonical terminal and receipt evidence.
Evidence contains only fixed identities, timestamps, SHA-256 bindings, outcome,
attempt count, and boolean checks. It contains no URL, password, CA PEM,
database response body, or secret-derived commitment. If a runner is forcibly
terminated before terminal upload, the separately persisted pre-write intent
remains available for the new read-only reconciliation dispatch.

## Rollback boundary

This workflow cannot and must not issue an 8-to-2 rollback. Reducing the limit
can strand maintenance clients and is safe only after separate, fresh evidence
shows the maintenance session count has drained below the proposed limit and
application/readiness probes remain healthy. If a confirmed 2-to-8 transition
must be reversed, stop the rollout, retain all evidence, obtain a newly reviewed
protected rollback authority with its own exact policy and one-write/no-retry
contract, and reconcile that operation independently. Never improvise the
rollback in a provider console or reuse this workflow's intent.

## Remaining boundaries

- The workflow proves the exact worker-fence and application-deployment state
  described above. It does not prove independent PostgreSQL connection
  capacity or authorize application scaling; those remain separate hard gates.
- The protected `postgres` authority is intentionally exact but broad. Replacing
  it with a narrowly provisioned, independently reviewed role administrator is
  preferable and requires a new policy/version.
- This operation is not a Supabase migration and must never be copied into the
  migration history.
- No production environment, runner, secret, or variable is configured by the
  repository change itself.
