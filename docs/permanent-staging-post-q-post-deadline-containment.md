# Permanent-staging post-Q containment under fresh authority

This runbook covers one independently authorized attempt to stop Railway
deployment `6300a324-9407-4b1c-b651-749c47e9537f` in permanent staging.
Production remains read-only metadata throughout. The successor does not renew,
extend, or reuse the expired v1 authority.

## Why the canonical workflow is reused

GitHub identifies the existing workflow
`.github/workflows/stop-permanent-staging-post-q-deployment.yml` as workflow
`353312302`. Its v1 verifier was already designed to admit only run number 2,
attempt 1, after proving run number 1 could not have written. Keeping that
identity makes the complete, unfiltered workflow history an enforceable
single-use boundary instead of creating a disconnected history.

Run `34255228036` is the sole historical run. Its prepare job failed before
durable intent creation, its apply job was skipped with zero steps, it uploaded
no artifacts, and its Railway writer never existed or started. Its deadline
`2026-09-08T18:57:20.000Z` is expired and is recorded with `reused: false`.
The verifier authenticates the historical workflow bytes at head
`f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7` as Git blob
`0d5efadc53101ae6631e25bbff7c804a30faa672`, 28,866 bytes, SHA-256
`6a452880ccbe3d80d9d771b4aae7bd3be2bcf26beac7dee1af91d0c705e7a9a8`.

Pull request 98 produced the reviewed predecessor
`d27275f4c101b764c6016e8b378969c14719258e`. Its first main CI run
`34262774959` failed only when a Vitest worker exited, but that failed run is
non-authorizing context. The successor candidate must supply a fresh reviewed
pull request, eight fresh successful base checks, and three fresh artifacts.

The archived v1 files remain byte-identical:

- `ops/railway/permanent-staging-post-q-deployment-stop-policy.json`
- `scripts/verify-permanent-staging-post-q-authority.mjs`

The live canonical workflow invokes only the explicitly versioned v2 verifier,
authority parser, and executor adapter.

## Reviewed authorization provenance

The exact source file is
`ops/railway/permanent-staging-post-q-deployment-stop-authorization-v2.json`.
It is exactly 267 bytes: `JSON.stringify(value, null, 2)` followed by one LF.
Its SHA-256 is
`4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779`.
The two normalized messages are:

1. `you are always authorised until we are prod ready`
2. `perfect so can we continue with pint path readyness?`

This is reviewed, non-secret provenance, not a cryptographic user signature.
The dispatch fields below are the action-specific operational confirmation.

## Successor lineage and deadline

The candidate must be a one-parent squash merge directly on
`d27275f4c101b764c6016e8b378969c14719258e`, at the current `main` tip. The
verifier authenticates the full reviewed chain:

`candidate -> d27275f -> f8640f6 -> 606d33f (Q)`

The effective deadline is persisted in reviewed authority and rederived
immediately before the writer as the earliest of:

- current candidate pull-request `merged_at + 4 hours`;
- current workflow `run_started_at + 90 minutes`; or
- the explicit ceiling `2026-09-09T08:00:00.000Z`.

Expiry prevents the write. Once the write attempt begins, expiry cannot suppress
reconciliation, terminal evidence, or finalization.

## Preconditions

- The candidate is the exact current `main` tip with the lineage above.
- All eight required attempt-one `push` checks and all three required artifacts
  are unique, successful, and produced after the candidate merge.
- Complete unfiltered history for workflow `353312302` contains exactly run 1
  and the in-progress run 2; run 2 is attempt 1.
- Railway external writers are frozen for the entire run.
- `permanent-staging-scale-evidence` still holds the two metadata tokens used by
  prepare/finalize and the staging-only scale token used by apply.
- Current UTC is before the derived deadline.

## One allowed dispatch

Dispatch `.github/workflows/stop-permanent-staging-post-q-deployment.yml` from
`main` exactly once with:

- `candidate_sha`: the exact current 40-character `main` SHA
- `authorization_id`:
  `pintpath-post-q-staging-stop-reauthorization-2026-09-09/v2`
- `authorization_source_sha256`:
  `4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779`
- `q_run_id`: `34229745722`
- `q_artifact_id`: `10057495901`
- `expected_deployment_id`: `6300a324-9407-4b1c-b651-749c47e9537f`
- `external_mutation_freeze_attestation`:
  `I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN`
- `confirmation`:
  `REAUTHORIZE_ONE_STAGING_DEPLOYMENT_STOP_6300A324_9407_4B1C_B651_749C47E9537F_FOR_<candidate_sha>_UNDER_V2_FROM_01A02140_8628_7D30_9374_8D29D4A9F3A3`

Do not rerun under any conclusion. Any third history row, run-2 rerun, or writer
already started fails closed and requires a separately reviewed recovery.
The history read is not a provider-side transaction with later dispatches. The
shared non-cancelling concurrency group is the compensating bound: a run 3
created after run 2's final history read remains queued until run 2 completes,
then sees three unfiltered rows and fails before a writer can start.

## Success criteria

Success requires the original-prefix durable intent artifact, exactly one
acknowledged `deploymentStop`, inner and outer terminal/completion pairs, three
stable provider observations showing the exact deployment stopped and zero
active deployments, unchanged topology/source/variables/staged patch, runtime
route absence as supplemental evidence, and unchanged production metadata.

This action cannot satisfy or widen F, V, S, A, or D prerequisites and cannot
dispatch a downstream workflow. The next permitted proof remains a separately
reviewed stopped-topology repair.
