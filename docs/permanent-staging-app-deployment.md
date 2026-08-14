# Protected Railway application deployment

Status: **ACTIVE ONLY THROUGH PROTECTED GITHUB ENVIRONMENTS**.

Pint Path has two manual, candidate-bound application source-upload paths:

- `.github/workflows/deploy-permanent-staging.yml` deploys one replica to the
  pinned permanent-staging environment;
- `.github/workflows/deploy-production.yml` preserves the pinned production
  environment's exact healthy current topology of either one or two replicas,
  but only after the same candidate is healthy in permanent staging. Initial
  bootstrap is one replica; the separate protected production-convergence
  workflow scales that deployed candidate to two only after source upload
  succeeds.

These workflows are the only application-deployment authority. A package
command run locally, Railway dashboard deploy, Git autodeploy, redeploy,
rollback, or ad-hoc CLI/API call is not authorized. Missing GitHub environment
approval or any required secret leaves the path safely inactive before a
Railway write.

## Immutable boundary

Both version-4 policies pin Railway project
`48d8c6cd-1c66-4148-874b-20877f48e1a5`, Beer service
`6816c4a2-e392-4ee5-826f-2584cb599ec0`, exact target/forbidden environment
IDs, origins and their hashes, allowed replica counts, the committed
`railway.toml` and `package-lock.json` hashes, and the production/staging
mutation-boundary policy hash. Staging is locked to one replica. Production
accepts only an exact healthy preflight topology of one or two replicas and
must preserve that observed count across the source upload. The source must be
the exact clean commit currently at protected `main`, recorded as
`candidateSha`; a private `git archive` snapshot is reasserted immediately
before upload. The GitHub gate separately authenticates the associated merged
PR and its distinct `reviewedPrHeadSha`. Candidate-only release-evidence
checkouts fetch that exact reviewed head into a candidate-bound local ref before
validating its tree. They never substitute an ancestry test: a linear
squash/rebase candidate need not descend from the reviewed head, but their Git
trees must be exactly equal.
The older capability-pure source-fixture parser is retained only as an offline
legacy validator and is explicitly superseded by this protected executor; it
is not a second deployment path.

The runner installs no mutable CLI dependency. Each workflow downloads only
Railway CLI `5.32.0` for `x86_64-unknown-linux-musl` from the pinned GitHub
release URL and verifies both of these hashes before execution:

- archive SHA-256:
  `cd69b2ecb556601751165d85ac31a5fbc38cff46397939356df28d2b96a005f5`;
- executable SHA-256:
  `27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43`.

The one permitted Railway write is exactly one detached source upload:

```text
railway up <private-snapshot> --path-as-root --no-gitignore --detach --json \
  --project <pinned-project> --environment <pinned-target-environment> \
  --service <pinned-service> --message <candidate-and-intent-bound-message>
```

There is no automatic retry. Missing CLI acknowledgement, timeout, or nonzero
exit triggers read-only reconciliation of the candidate; it never triggers a
second write. An indeterminate provider result is `mutation_uncertain` and
needs a new independently approved operator decision after read-only review.
GitHub job reruns are rejected (`run_attempt` must equal `1`); any later action
requires a new manual dispatch and a fresh protected-environment approval.

## GitHub setup and invocation

Create two protected GitHub environments with required reviewers and restrict
them to `main`:

| Workflow          | GitHub environment             | Write secret                               |
| ----------------- | ------------------------------ | ------------------------------------------ |
| Permanent staging | `permanent-staging-deployment` | `PINTPATH_RAILWAY_STAGING_DEPLOY_TOKEN`    |
| Production        | `production-deployment`        | `PINTPATH_RAILWAY_PRODUCTION_DEPLOY_TOKEN` |

Each environment also needs
`PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN` and
`PINTPATH_RAILWAY_STAGING_METADATA_TOKEN`. They must be distinct,
environment-scoped Railway project tokens. The write secret must target only
the named environment. Do not reuse account-wide, production, staging,
database, or emergency authority across roles. Disable Railway Git autodeploy.

The production environment additionally needs
`PINTPATH_PRODUCTION_PROVIDER_READINESS_ENVELOPE_BASE64` and
`PINTPATH_PRODUCTION_PROVIDER_READINESS_ENVELOPE_SHA256`. Before approval, run
strict `readiness:launch` inside the deployed production service as described
in the launch runbook, retain only its sanitized JSON, and have the protected
operator bind it to the proposed candidate SHA, observation time, and observed
production deployment SHA in the canonical version-2 envelope. Version 2 also
binds the readiness result's sanitized `postgresAuthority`: SHA-256 identities
for the exact application URL, distinct maintenance URL, root CA PEM bytes, and
reviewed root CA DER plus true exactness/same-target/distinct-login statuses.
Never put either URL or the CA PEM in any additional envelope field. Version 1
is rejected. The observation must be no more than 24 hours old. The verifier
requires
`production_free_launch`, strict mode, zero warnings/failures, every check
passing, both canonical lower-case private `:5432?sslmode=verify-full`
Postgres login authorities, a valid PEM/DER binding, required
Railway/Redis/Supabase/Storage/Free-scope checks, and exact envelope bytes/hash.
The raw protected envelope is not uploaded; the workflow artifact contains
only its hash-bound authority verification.

Dispatch the relevant workflow from `main` and enter the exact 40-character
protected-main `candidateSha`. The job checks the dispatch ref/SHA, checkout,
`origin/main`, clean worktree, GitHub-authenticated merged PR and reviewed-head
tree, repository gate, current required GitHub checks, and required SHA-bound
artifacts before it can reach the write step. Production
validates the candidate-bound release-evidence register in non-strict mode.
Strict evidence is intentionally post-deployment: production public smoke,
authenticated role proof, and final App Review evidence cannot exist before
the candidate is deployed. Permanent staging is likewise deployable while
external evidence is being collected.

The permanent-staging deployment joins provider mutation, legacy-key cutover,
and general permanent-staging runtime-variable writes in the shared
`pintpath-permanent-staging-key-rollout` concurrency group. `queue: max` with
`cancel-in-progress: false` retains every waiting run and fully serializes them;
no newer dispatch replaces or cancels an older one. Each run must still reassert
the exact current protected-main candidate immediately before its write.
Provider mutation, legacy cutover, and general runtime-variable writes
additionally run `github:reviewed-candidate-authority:verify`, keyed by exact
candidate+operation, exact candidate, and exact candidate+target+variable
respectively. The guard requires complete authenticated history from the
associated PR's `merged_at` through the authenticated current `run_started_at`,
not its `created_at`, because retained queued runs can start out of creation
order. That `run_started_at` must be no more than 168 hours after `merged_at`.
Beyond seven days or with incomplete history, create a newly reviewed and merged
candidate. Provider/cutover redispatch requires every exact prior write step
authenticated as `skipped`; a runtime-variable write allows no prior matching
run, even one skipped before write.

The package aliases below exist for the workflow; they are not standalone
operator authority:

```text
npm run --silent railway:staging:app:deploy -- \
  --candidate-sha <40hex> --evidence-dir <absolute-mode-0700-directory>

npm run --silent railway:production:app:deploy -- \
  --candidate-sha <40hex> --evidence-dir <absolute-mode-0700-directory>
```

Outside exact GitHub Actions `main` context, without the protected credentials,
or without the pinned CLI bytes, the executor fails closed.

## Preflight, reconciliation, and receipts

Before the upload, the executor requires the immediate read-only
production/staging mutation-boundary receipt, empty staged patches, exact
metadata-token scope, a separate write token whose read-only scope query matches
the exact target project/environment, target/service/origin/replica topology, private source
snapshot, verified CLI bytes, and a durable mode-0600 intent in a current-UID
mode-0700 directory. Production additionally requires the same candidate to be
the sole healthy permanent-staging deployment and to pass all three runtime
routes.

After any attempted upload—even when acknowledgement is absent—the executor
performs read-only provider reconciliation. Success requires the exact
candidate to be the sole active `SUCCESS` deployment, the exact preflight
replica count and domain to remain intact, no staged patch, no collateral
identity or domain change, and candidate/deployment-bound `200` responses from
`/health`, `/startup`, and `/ready`. It then re-observes the provider and
requires the deployment, snapshot, active-deployment set, replica count,
domains, and complete collateral inventory to remain unchanged across those
runtime probes. The mutation-boundary postflight runs unconditionally.

The workflow uploads a SHA-bound artifact containing only the GitHub gate
receipt and private execution evidence:

- `pintpath-permanent-staging-deployment-<candidateSha>`;
- `pintpath-production-deployment-<candidateSha>`.

The current-main verifier first requires the exact associated merged PR,
`merge_commit_sha=candidateSha`, one-parent linear history, and exact
reviewed/candidate tree equality. For each eligible non-author reviewer it uses
only that reviewer's latest effective `APPROVED`, `CHANGES_REQUESTED`, or
`DISMISSED` review on `reviewedPrHeadSha`; at least one resulting approval must
belong to a collaborator/member/owner who still has repository `write`,
`maintain`, or `admin` permission. An earlier approval superseded by that
reviewer's later effective review is not authority. It then requires the exact
successful base checks listed
in `.github/release-required-checks.json`. Each check is bound to its declared
workflow path and trigger event through the GitHub Actions run associated with
that check; a same-name check from another workflow or trigger cannot satisfy
the gate. Except for the staging deployment's exact-two rule below, more than one
successful check from the intended workflow/event fails closed. The verifier
also requires the same-run, non-expired,
digest-bearing base artifacts `pintpath-mission-discovery-scale-evidence`,
`pintpath-postgres-tool-runtime-closure-v4-observation`, and
`pintpath-automated-readiness-evidence`. Production additionally requires
exactly two successful workflow-dispatch deployments for the same candidate:
the initial permanent-staging deployment and the post-plan closeout redeploy.
Both must complete before the one protected two-replica scale/soak run starts;
the gate selects the second deployment and rejects zero, one, more than two, or
ambiguous completion chronology. It also requires the selected deployment and
scale runs' digest-bearing artifacts and the protected iOS production
configuration check. The post-deployment release gate requires both the
same-SHA topology-preserving production source-upload artifact and the separate
candidate-bound proof that that deployed candidate is exactly two replicas.
For the initial launch this is a one-replica upload followed by convergence;
for the evidence-closeout redeploy the upload preserves two replicas and the
convergence workflow emits its same-SHA `already_converged` proof. Never scale
the older production deployment before uploading the initial candidate; it may
still be the SQLite build.

Receipts hash Railway resource identities, CLI output, runtime responses, and
pre/postflight evidence. They do not contain Railway tokens or raw provider
responses. A failed or partial receipt is evidence of uncertainty, not
permission to retry.

## Cost evidence is a separate release gate

The staging deployment policy pins the active read-only external-observation
cost policy, schema `pintpath-permanent-staging-cost-policy/v2`, and SHA-256
`57984ced59fa356baa9c19ac1e5018dad9c52829a6d7cc95a05cbd52112ddf86`.
This proves policy-byte agreement only. It neither fabricates provider facts
nor claims that the cost gate passed.

An authorized finance/infra operator must capture the protected pre-deployment
and post-reconciliation provider exports out of band. A separate verifier then
binds both observations and the private manifest into the single combined
version-2 cost receipt described in
[`permanent-staging-cost-evidence.md`](./permanent-staging-cost-evidence.md).
The receipt cannot authorize deployment; it is required later for release.

## Adjacent operations require separate authority

This executor cannot mutate variables, routes/domains, replicas, volumes,
resource limits, services, databases, PITR, backups, or provider billing
controls. It cannot use Railway redeploy/native rollback, delete resources, or
commit/discard a staged patch. Protected successors exist for the reviewed
runtime/provider-variable, Supabase-cutover, build-canary, scale, PITR, and
exact disposable-restore teardown operations. Each remains behind its own
tracked policy, protected workflow, and executor; none inherits authority from
an application deployment receipt. Unlisted operations remain blocked under
the document-wide mutation boundary.

For application rollback, deploy a separately frozen, reviewed SHA through the
same protected source-upload ceremony after proving it against the current
Postgres schema. Never use Railway-native rollback because it can restore
superseded custom variables.

## STOP conditions

Stop before provider mutation on any policy/hash/identity/source/CLI/GitHub
context mismatch, missing approval or secret, failed current-main check,
missing required artifact, unsafe evidence path, nonempty staged patch,
unexpected topology, unhealthy same-SHA staging prerequisite, failed boundary
preflight, or adjacent-mutation requirement. After the write begins, perform
only the built-in read-only reconciliation and unconditional postflight. Never
rerun merely because acknowledgement or evidence is incomplete.
