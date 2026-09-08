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
4. Run `apply-refresh-validate` in
   `permanent-staging-venue-directory.yml`, supplying the exact successful
   fenced-deployment run ID. It authenticates that same-candidate fenced
   deployment, applies the sealed venue plan, and proves the exact migration
   ledger, validated constraints, and zero violations.
5. Run `restore` in the bootstrap workflow. It authenticates prepare,
   quiescence, the fenced deployment, and the venue-directory proof in strict
   order, then calls the scale executor once with `bootstrap-staging-one`.
   Success proves the exact candidate at one replica with automatic maintenance
   disabled and candidate bound on `/health`, `/startup`, and `/ready`.
6. Run staging `activate` with the exact `venue_directory_run_id`. The same
   verifier supports an `activate` consumer that authenticates the full prepare
   through venue-directory and restore chain. Activation then enables automatic
   maintenance for the same sole healthy candidate.
7. Run the `active` phase of `deploy-permanent-staging.yml`; its verifier mode
   `active-deploy` authenticates activation. Before scale evidence, verifier
   mode `scale-evidence` authenticates activation followed by the successful
   active closeout deployment.

No bootstrap workflow dispatches a deployment or another provider workflow.
Each operator starts the next protected manual workflow only after inspecting
the prior terminal artifact.

For the current policy-pinned cold/dead successor, replace only the normal
prepare/quiesce entry with `recover-permanent-staging-cold-zero.yml`. Its bridge
pins the complete reviewed lineage: legacy candidate
`838e8c877dcafc0a822a12e5a26afa81c26924a3`, intermediate candidate
`919cbbc9ed4a5bb1d99bc2624f5b534e31ddb604`, and immediate prior candidate
`1161e7ecd421556b104bcae059e8764ebf4a545e`. The legacy runs are prepare
`34152745186`, failed quiesce `34153306935`, and failed read-only reconciliation
`34154020478`. The intermediate prepare `34180322982` may have written before
acknowledgement failed; its `reconcile-prepare` run `34181145015` is a failed
zero-write read-only attempt. The immediate prior has successful prepare
`34186355641` and failed quiesce `34186930666`.

The executable successor must be the exact reviewed direct child of the
immediate prior, perform a fresh same-candidate Supabase replacement and normal
cold prepare, supply that fresh `prepare_run_id`, and finish before the
unchanged `2026-09-08T18:57:20Z` deadline. Successor quiesce accepts exactly
nine all-ref cold-recovery runs split `3 + 2 + 2 + 2` across the legacy,
intermediate, immediate-prior, and executable candidates. Its public
`ambiguous_quiesce_candidate_sha` and `ambiguous_quiesce_run_id` inputs must be
the immediate prior `1161e7ecd421556b104bcae059e8764ebf4a545e` and
`34186930666`; the legacy values remain sealed historical evidence only.

Before the single write, the bridge reads the complete redacted Railway patch
ledger and the Beer-service history, verifies both failed-quiesce windows have
no committed provider write, and binds the exact configured-one dead topology.
Dispatch requires the exact external Railway writer-freeze attestation after
dashboard, API, autodeploy, and every other staging writer are frozen: enter
`I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN`. The serialized
bridge holds metadata-only credentials; the mutation token enters custody only
in the following one-write step.
The write uses one direct `environmentPatchCommit` GraphQL request with the two
allowed regions encoded as JSON `null`; a lost acknowledgement can succeed only
after exact-zero reconciliation and a complete provider-ledger proof, while a
provider rejection cannot. The v6 cold-quiesce receipt binds the artifact
producer run ID to the exact commit message, proves zero matching patches
before the final provider state read, then proves one newest committed,
cross-fetched patch and an otherwise unchanged ledger after the write. Leave
`ambiguous_prepare_run_id` empty and retain the sealed successor bridge plus
reviewed authority. The remaining fenced deployment, venue-directory, restore,
activation, active closeout, and scale sequence stays candidate-bound and
ordered.

## Bootstrap workflow inputs and artifacts

Both `quiesce` and `restore` require `operation`, `candidate_sha`,
`expected_deployment_sha`, `prepare_run_id`, `confirmation`, and
`external_mutation_freeze_attestation=I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN`
after every external Railway writer is frozen. They are original-attempt-only;
a GitHub Actions rerun is rejected before provider access.

- For `quiesce`, `expected_deployment_sha` is the exact non-candidate legacy
  source SHA. `quiesce_run_id` and `fenced_deployment_run_id` must be empty. The
  exact confirmation is
  `QUIESCE_PERMANENT_STAGING_WORKER_BOOTSTRAP_FOR_<candidate>_FROM_<old-source>`.
- For `restore`, `expected_deployment_sha` is the candidate SHA and
  `quiesce_run_id`, `fenced_deployment_run_id`, and `venue_directory_run_id`
  are required. The exact confirmation is
  `RESTORE_PERMANENT_STAGING_WORKER_BOOTSTRAP_FOR_<candidate>`.

The workflow emits exactly one named terminal artifact:

- `pintpath-permanent-staging-worker-bootstrap-quiesce-<candidate>`; or
- `pintpath-permanent-staging-worker-bootstrap-restore-<candidate>`.

Each artifact contains the canonical
`prerequisites-verification.json` plus the existing scale executor's intent,
terminal, and final receipt. The final receipt is respectively
`quiesce-staging-zero-receipt.json` or
`bootstrap-staging-one-receipt.json`, with schema
`pintpath-permanent-staging-scale-operation/v4`. Scale writes use one direct
Railway `environmentPatchCommit` request (never `railway service scale`), bind
the current GitHub run ID in the commit message and receipt, and require the
external-mutation freeze attestation. Staging requests always include both
reviewed regions, encoding every zero-replica region as JSON `null`. Success
also proves an empty staged patch, exact non-secret configuration collateral,
and an unchanged provider-history suffix; a lost acknowledgement is accepted
only after the exact run-bound patch is cross-fetched and reconciled.

The bootstrap-restore runner-loss reconciliation terminal is version 2. Its
structured `configuredTopologyEvidence` is derived from Railway
`environment.config`; nullable legacy replica fields are observation-only.

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

| Consumer mode    | Required producer inputs                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `quiesce`        | `--expected-deployment-sha <old>`, `--prepare-run-id`, `--prepare-terminal-file`                                                           |
| `fenced-deploy`  | prepare inputs plus `--quiesce-run-id`, `--quiesce-receipt-file`, `--quiesce-verification-file`                                            |
| `restore`        | `--expected-deployment-sha <candidate>`, prepare and quiesce inputs, fenced-deployment inputs, plus `--venue-directory-run-id`, `--venue-directory-receipt-file` |
| `activate`       | prepare, quiesce, fenced-deployment, and venue-directory inputs, plus `--restore-run-id`, `--restore-receipt-file`, `--restore-verification-file`                |
| `active-deploy`  | `--activate-run-id`, `--activate-terminal-file`, `--activate-verification-file`                                                            |
| `scale-evidence` | all three activate inputs plus `--active-deployment-run-id`, `--active-deployment-receipt-file`                                            |

The verifier accepts only attempt 1 manual runs on the exact current-main SHA,
re-proves that the SHA is the tree-equivalent merge commit of exactly one
reviewed pull request, queries the exact upstream workflow path/ref and run
title, captures the exact GitHub artifact name and `sha256:` archive digest,
parses canonical receipt schemas, rejects a later matching run, and enforces
strict completion-before-start chronology. It contacts only the GitHub API.

The verification receipt schema is
`pintpath-permanent-staging-worker-bootstrap-prerequisites/v6`. It records the
reviewed PR authority, consumer identity, ordered producer run IDs, artifact
IDs/names/digests/sizes, receipt hashes and source/replica bindings, policy SHA,
verification expiry, and all checks. It contains neither secrets nor hashes of
secrets. A verification is valid for 15 minutes; upstream receipts must be no
more than 24 hours old.

## Immutable policy bindings

The prerequisite policy SHA is
`aaaecea008dab4c79dfec6d623d23c3a0ec35636e3a0e013aede329bd4f4c552`.
Its producer hashes are:

- worker prepare/activate policy:
  `3178685f32c9d49e359d089d5afd7c2d8c62860899a0cc70b25760155c8d7236`;
- scale policy:
  `e960db6dde4c367ae26148d5e4c0e013b8f8cb5e4923bdced9a606d965673cb0`;
- fenced zero-replica deployment policy:
  `9cea6cacfd33a2f4500532ecf2d4564c1dbc9595eb6835e2935ff9e2df5186f5`;
- active one-replica deployment policy:
  `49367b816eb1ad86e32aa85dd9bd1e2297743760e113a23c882b3776b5afad77`;
- venue-directory policy:
  `3474e28c413e908b7dac76190709553e753fed39df753a1cd273b29f161bfcef`.

Any producer policy change deliberately invalidates this verifier until all
contracts are reviewed and the prerequisite policy and embedded digest are
updated together.
