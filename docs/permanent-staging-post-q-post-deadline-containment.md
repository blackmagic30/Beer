# Permanent-staging post-Q containment under V4 authority

This runbook covers one independently authorized attempt to stop Railway
deployment `6300a324-9407-4b1c-b651-749c47e9537f` in permanent staging.
Production remains read-only metadata throughout. V4 is a distinct successor:
it archives the failed V3 attempt but does not reuse its consumed workflow
authority or claim that its unused deployment-stop authority was exercised.

## Why the canonical workflow is reused

GitHub identifies
`.github/workflows/stop-permanent-staging-post-q-deployment.yml` as workflow
`353312302`. Complete, unfiltered history for that numeric workflow ID must
contain exactly three rows, in order: the in-progress run 3, failed V3 run 2,
and failed historical run 1. Every row must be attempt 1. A fourth row, a
rerun, reordered history, or a started writer fails closed.

Run `34255228036` is the historical V1 containment run. It failed in prepare
before durable intent creation; apply was skipped with no steps or artifacts,
and no Railway writer started. Its deadline
`2026-09-08T18:57:20.000Z` is expired and recorded as `reused: false`.

V3 run `34304764597` used candidate
`c6f0f66302a96086c5a60962224af739050e8ff1`. Prepare succeeded, but apply job
`102319762173` failed at step 9, `Reauthenticate the exact failed Q run and
artifact`. GitHub represented the future writer as `pending`, while V3
incorrectly required `queued`. Writer step 15 was skipped with no write
attempt, so the application was not stopped and production was untouched.

V4 authenticates all 15 prepare steps and all 23 completed apply rows from run
2, including the writer's skipped timestamps. It also authenticates both exact
run-2 artifacts and their sole members:

- intent artifact `10086316260`, digest
  `sha256:e6882bd5bd659f2d95de84a8163be011722a96802b3a08a2e8eea4216fdd8766`,
  containing only `stop-intent.json` with SHA-256
  `f51921b2dca554008c2e569abb04e2ba6b562d9b1e9f724264a29b3d72a96d1d`;
- terminal artifact `10086412037`, digest
  `sha256:49c92825d47b7c90b3aba605c12b9643990c9091b7b6dac0d207fb57e665d4eb`,
  containing only `boundary-postflight.json` with SHA-256
  `827bc8f797062b613038ae5d6f5c24c9489f50d3beb889d55e92c5593b9bc742`.

The complete V2 and V3 authority sets are archived by exact path, Git blob
OID, byte size, and byte SHA-256 in the V4 policy. The V3 archive includes the
authorization, policy, verifier, authority library, executor adapter, and the
canonical workflow bytes that existed at `c6f0f663`.

## Candidate and reviewed authorization provenance

V4 requires a fresh reviewed pull request numbered greater than 102. Its
one-parent squash merge must be the current `main` tip with `c6f0f663` as its
sole direct parent, and it must merge after run 2 completed at
`2026-09-09T02:58:09Z`. The new candidate must have eight fresh successful
attempt-one base checks and three fresh artifacts produced after its merge.

The exact authorization source is
`ops/railway/permanent-staging-post-q-deployment-stop-authorization-v4.json`.
It is 613 bytes, serialized as `JSON.stringify(value, null, 2)` plus one LF,
with SHA-256
`ccaf9c49e38f97368f6187d7c3ff1c853cffe8334fdfaf3478835c7e93f4028c`.
It binds thread `01a0840a-3590-74d1-9567-0e9eec01a9a4` and this exact message:

> Codex was running for multiple days on two prompts and I had no clue what it did I just stopped them recently because they were eatting away at tokens and the logs were massive. Can you check what they had done, finish of what they were currently working on so there’s no error in the code or bug and tell me what it was doing

This file is reviewed, non-secret provenance, not a cryptographic user
signature. The dispatch confirmation below is the action-specific operational
confirmation binding the candidate, deployment, V4 authorization, and thread.

## Phase-aware no-write verification

The verifier runs at three exact checkpoints. During prepare, the prepare job
must be in progress at verifier step 11 with the observed step prefix exact;
the apply job may only be absent or queued with no steps. During apply
reauthentication, apply step 11 must be in progress. Immediately before the
writer, apply step 16 must be in progress.

At both apply checkpoints, the complete observed step prefix/order must match
the canonical V4 workflow and writer row 17 must exist as exactly `pending`
with null conclusion, start, and completion fields. A missing writer row,
`queued`, `in_progress`, completed, timestamped, or renamed writer, or any
unexpected executable step fails closed. The phase is a runtime predicate only;
it is not serialized into Q authority, so prepare and apply authorities retain
the byte-stable shape required by the durable intent and executor.

Run-2 artifact bytes are authenticated read-only. Apply reauthentication and
prewrite may therefore verify the same downloaded evidence directories without
creating a second sealed directory or changing custody.

## Stable Railway baseline projection

V4 inherits V3's final containment contracts. It validates and hashes the exact
target service deploy object as the static eligibility wrapper
`{services:{<target-service-id>:{deploy:<exact-deploy-object>}}}` using
recursively sorted, two-space JSON plus one LF. The projection schema is
`pintpath-permanent-staging-post-q-target-deploy-config-projection/v1`; its
size is 540 bytes and its SHA-256 is
`8ab34441af1ec87d5068ce0155975a9fea46a192537b70c54677e64f60ae183e`.

The strict current-config schema remains unchanged: all known root, service,
volume, variable, topology, networking, source, and staged-patch paths must be
present and every unknown or missing path is rejected. Provider strings are
compared only in process and redacted before hashing; raw strings and secret
derived commitments are never persisted. The first eligible observation sets
the dynamic digest, with exact equality required at prewrite and every terminal
observation.

## Deadline and write boundary

The effective deadline is persisted in reviewed authority and rederived
immediately before the writer as the earliest of:

- current candidate pull-request `merged_at + 4 hours`;
- current workflow `run_started_at + 90 minutes`; or
- `2026-09-10T08:00:00.000Z`.

Expiry prevents a write from starting. Once the single write attempt begins,
expiry cannot suppress reconciliation, terminal evidence, or finalization.
Prepare and apply boundary checks use only staging and production metadata
credentials. The sole writer receives only the staging scale credential, and
finalize receives no provider credential. No production write credential or
production mutation is allowed.

## Preconditions

- The V4 candidate is the exact current `main` tip and sole-parent squash child
  of `c6f0f66302a96086c5a60962224af739050e8ff1`.
- Its reviewed pull request is greater than 102, merged after failed V3 run 2,
  and has all eight fresh attempt-one checks and three fresh artifacts.
- Complete workflow `353312302` history is exactly run 3, run 2, run 1; every
  run is attempt 1 and the two prior runs have exact authenticated no-write
  dispositions.
- At apply checkpoints, writer row 17 is exactly `pending` with all terminal
  fields null and the observed V4 step order is exact.
- Railway external writers are frozen for the entire run.
- `permanent-staging-scale-evidence` has the two metadata credentials for
  prepare/boundary checks and the staging-only scale credential for the sole
  writer. Finalize is credential-free.
- Current UTC is before the derived deadline.

## One allowed dispatch

Dispatch `.github/workflows/stop-permanent-staging-post-q-deployment.yml` from
`main` exactly once with:

- `candidate_sha`: the exact reviewed 40-character current `main` SHA
- `authorization_id`:
  `pintpath-post-q-staging-stop-reauthorization-2026-09-09/v4`
- `authorization_source_sha256`:
  `ccaf9c49e38f97368f6187d7c3ff1c853cffe8334fdfaf3478835c7e93f4028c`
- `q_run_id`: `34229745722`
- `q_artifact_id`: `10057495901`
- `expected_deployment_id`: `6300a324-9407-4b1c-b651-749c47e9537f`
- `external_mutation_freeze_attestation`:
  `I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN`
- `confirmation`:
  `REAUTHORIZE_ONE_STAGING_DEPLOYMENT_STOP_6300A324_9407_4B1C_B651_749C47E9537F_FOR_<candidate_sha>_UNDER_V4_FROM_01A0840A_3590_74D1_9567_0E9EEC01A9A4`

Do not rerun under any conclusion. Any fourth dispatch or rerun observes a
noncanonical history/attempt and fails before the writer.

## Success criteria

Success requires the original-prefix durable intent artifact, exactly one
acknowledged staging-only `deploymentStop`, inner and outer terminal/completion
pairs, three stable provider observations showing the exact deployment stopped
and zero active deployments, unchanged target/off-target boundaries, and
unchanged production metadata. Runtime route absence is supplemental evidence.

This action cannot satisfy or widen F, V, S, A, or D prerequisites and cannot
dispatch a downstream workflow. The next permitted proof remains a separately
reviewed stopped-topology repair.
