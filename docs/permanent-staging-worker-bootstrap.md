# Permanent-staging worker-fence bootstrap

This chain moves the permanent-staging application from the legacy source that
predates the candidate-bound automatic-maintenance variables to the reviewed
current-main candidate without allowing that candidate to start schedulers
before the old process is absent.

The protected operations are serialized by
`pintpath-permanent-staging-key-rollout`, use `queue: max`, and never cancel an
in-progress transition.

## Required order

1. Run `prepare` in
   `configure-automatic-maintenance-worker-fence.yml`. It writes exactly
   `PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED=false` and
   `PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA=<candidate>` with
   `skipDeploys:true`. This is metadata preparation only and is not a runtime
   fence for the legacy source.
2. Run `quiesce` in
   `bootstrap-permanent-staging-worker-fence.yml`. It authenticates the exact
   prepare run and artifact, then calls the scale executor once with
   `quiesce-staging-zero` and the exact legacy deployment source SHA. Success
   proves the same deployment at zero replicas and runtime absence.
3. Run the `fenced` phase of `deploy-permanent-staging.yml`. Its prerequisite
   verifier inputs are the same prepare and quiesce runs. The fenced deployment
   policy uploads the candidate while the service remains at zero replicas.
4. Run `restore` in the bootstrap workflow. It authenticates prepare,
   quiescence, and the fenced deployment in strict order, then calls the scale
   executor once with `bootstrap-staging-one`. Success proves the exact
   candidate at one replica with automatic maintenance disabled and candidate
   bound on `/health`, `/startup`, and `/ready`.
5. Run staging `activate`. The same verifier supports an `activate` consumer
   that authenticates the full prepare through restore chain. Activation then
   enables automatic maintenance for the same sole healthy candidate.
6. Run the `active` phase of `deploy-permanent-staging.yml`; its verifier mode
   `active-deploy` authenticates activation. Before scale evidence, verifier
   mode `scale-evidence` authenticates activation followed by the successful
   active closeout deployment.

No bootstrap workflow dispatches a deployment or another provider workflow.
Each operator starts the next protected manual workflow only after inspecting
the prior terminal artifact.

## Bootstrap workflow inputs and artifacts

Both `quiesce` and `restore` require `operation`, `candidate_sha`,
`expected_deployment_sha`, `prepare_run_id`, and `confirmation`.

- For `quiesce`, `expected_deployment_sha` is the exact non-candidate legacy
  source SHA. `quiesce_run_id` and `fenced_deployment_run_id` must be empty. The
  exact confirmation is
  `QUIESCE_PERMANENT_STAGING_WORKER_BOOTSTRAP_FOR_<candidate>_FROM_<old-source>`.
- For `restore`, `expected_deployment_sha` is the candidate SHA and both
  `quiesce_run_id` and `fenced_deployment_run_id` are required. The exact
  confirmation is
  `RESTORE_PERMANENT_STAGING_WORKER_BOOTSTRAP_FOR_<candidate>`.

The workflow emits exactly one named terminal artifact:

- `pintpath-permanent-staging-worker-bootstrap-quiesce-<candidate>`; or
- `pintpath-permanent-staging-worker-bootstrap-restore-<candidate>`.

Each artifact contains the canonical
`prerequisites-verification.json` plus the existing scale executor's intent,
terminal, and final receipt. The final receipt is respectively
`quiesce-staging-zero-receipt.json` or
`bootstrap-staging-one-receipt.json`, with schema
`pintpath-permanent-staging-scale-operation/v2`.

## Verifier consumer interface

All consumers set these values before invoking
`scripts/verify-permanent-staging-worker-bootstrap-prerequisites.ts`:

- `GITHUB_ACTIONS=true`, the exact repository/ref/SHA/run ID/run attempt,
  `GITHUB_API_URL=https://api.github.com`, and `GITHUB_TOKEN`;
- `PINTPATH_STAGING_WORKER_BOOTSTRAP_OPERATION=<mode>`; and
- `PINTPATH_STAGING_WORKER_BOOTSTRAP_GITHUB_ENVIRONMENT` to the exact protected
  environment in the policy.

Every invocation also supplies `--operation`, `--candidate-sha`, and an
absolute `--output .../prerequisites-verification.json`. The operation-specific
receipt inputs are:

| Consumer mode | Required producer inputs |
| --- | --- |
| `quiesce` | `--expected-deployment-sha <old>`, `--prepare-run-id`, `--prepare-terminal-file` |
| `fenced-deploy` | prepare inputs plus `--quiesce-run-id`, `--quiesce-receipt-file`, `--quiesce-verification-file` |
| `restore` | `--expected-deployment-sha <candidate>`, prepare and quiesce inputs, plus `--fenced-deployment-run-id`, `--fenced-deployment-receipt-file` |
| `activate` | prepare, quiesce, and fenced-deployment inputs, plus `--restore-run-id`, `--restore-receipt-file`, `--restore-verification-file` |
| `active-deploy` | `--activate-run-id`, `--activate-terminal-file`, `--activate-verification-file` |
| `scale-evidence` | all three activate inputs plus `--active-deployment-run-id`, `--active-deployment-receipt-file` |

The verifier accepts only attempt 1 manual runs on the exact current-main SHA,
re-proves that the SHA is the tree-equivalent merge commit of exactly one
reviewed pull request, queries the exact upstream workflow path/ref and run
title, captures the exact GitHub artifact name and `sha256:` archive digest,
parses canonical receipt schemas, rejects a later matching run, and enforces
strict completion-before-start chronology. It contacts only the GitHub API.

The verification receipt schema is
`pintpath-permanent-staging-worker-bootstrap-prerequisites/v1`. It records the
reviewed PR authority, consumer identity, ordered producer run IDs, artifact
IDs/names/digests/sizes, receipt hashes and source/replica bindings, policy SHA,
verification expiry, and all checks. It contains neither secrets nor hashes of
secrets. A verification is valid for 15 minutes; upstream receipts must be no
more than 24 hours old.

## Immutable policy bindings

The prerequisite policy SHA is
`f97f246b71bf5beebb439572a891e6ce07c738859ebc7d3a1bf5626ae442ec73`.
Its producer hashes are:

- worker prepare/activate policy:
  `685539a691f290e2d870d69de452fe1fcbd0635065276e9a51b51864aaf29d27`;
- scale policy:
  `164d53a5bccff4a861c8568abebe5caa06352f64245ac7e734e55c056c2be608`;
- fenced zero-replica deployment policy:
  `a46ee1af6d8b3afcfe38d595767e28fcae53a9716730e4cff33b9da39e0ff7df`;
- active one-replica deployment policy:
  `c73fe315f98c5736f4ac31963e11361b059881d7ec5774292e7e8048ff6f8986`.

Any producer policy change deliberately invalidates this verifier until all
contracts are reviewed and the prerequisite policy and embedded digest are
updated together.
