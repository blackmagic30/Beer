# Permanent-staging post-Q containment under V3 authority

This runbook covers one independently authorized attempt to stop Railway
deployment `6300a324-9407-4b1c-b651-749c47e9537f` in permanent staging.
Production remains read-only metadata throughout. V3 is a distinct successor:
it does not renew, extend, consume, or reuse either earlier authority.

## Why the canonical workflow is reused

GitHub identifies
`.github/workflows/stop-permanent-staging-post-q-deployment.yml` as workflow
`353312302`. Complete, unfiltered history for that numeric workflow ID must
contain exactly the failed historical run 1 and the in-progress run 2. Run 2
must be attempt 1, and its writer must still be queued. A third row, a rerun, or
a started writer fails closed.

Run `34255228036` is the only historical containment run. It failed in prepare
before durable intent creation; apply was skipped with no steps or artifacts,
and no Railway writer started. Its deadline
`2026-09-08T18:57:20.000Z` is expired and recorded as `reused: false`. The V1
policy and verifier remain byte-identical archival evidence.

The complete V2 authority set is also archived by exact path, Git blob OID,
byte size, and byte SHA-256 in the V3 policy. That archive includes the V2
authorization, policy, verifier, authority library, executor adapter, and the
canonical workflow bytes that existed at `78162cf`.

## Why `78162cf` is not eligible

Pull request 99 merged as
`78162cf42a0ef3190343a657ff94f288d4a4c7ca` at
`2026-09-08T21:35:27Z`. Its required attempt-one main CI run
`34281452199` (workflow `275221294`, run number 563, check suite
`92869213373`) failed. The `build-test-scan` job `102248030722` completed with
failure because step 11, `Dependency audit`, failed after the build/test step
succeeded. No containment workflow was dispatched for this candidate, so V2
authority was unused, but a rerun cannot make this candidate eligible.

V3 therefore requires a new reviewed pull request whose one-parent squash merge
is the current `main` tip and has `78162cf` as its sole direct parent. The new
candidate must have eight fresh successful attempt-one base checks and three
fresh artifacts produced after its merge.

## Reviewed authorization provenance

The exact source file is
`ops/railway/permanent-staging-post-q-deployment-stop-authorization-v3.json`.
It is 394 bytes: `JSON.stringify(value, null, 2)` followed by one LF. Its
SHA-256 is
`d2c7b4c9d700a1d7c5219dd6c4245d5900154421497b8c637ac93f9215662549`.
It binds goal thread `01a02140-8628-7d30-9374-8d29d4a9f3a3` and these exact
normalized messages:

1. `you are always authorised until we are prod ready`
2. `perfect so can we continue with pint path readyness?`

This file is reviewed, non-secret provenance, not a cryptographic user
signature. The dispatch confirmation below is the action-specific operational
confirmation.

## Stable Railway baseline projection

The provider returns the whole environment config. V3 first validates and
hashes the exact target service deploy object as the static eligibility wrapper
`{services:{<target-service-id>:{deploy:<exact-deploy-object>}}}` using
recursively sorted, two-space JSON plus one LF. The projection schema is
`pintpath-permanent-staging-post-q-target-deploy-config-projection/v1`; its
size is 540 bytes and its SHA-256 is
`8ab34441af1ec87d5068ce0155975a9fea46a192537b70c54677e64f60ae183e`.

V3 also requires a strict, path-aware schema for the complete current config:
the exact known root, target, Postgres, Redis, and volume paths must be present,
and every unknown or missing path is rejected. Numeric, boolean, and null
metadata values are retained. Every provider string value is replaced by a
fixed path/type descriptor before hashing; its exact raw value is compared only
inside the current process and is never persisted. Every variable name set is
exact and every variable value must be `null`. The two known password-generator
expressions must match the exact
`secret(32, lowercase-then-uppercase ASCII)` grammar and are replaced by that
semantic descriptor before hashing; their raw strings are neither persisted
nor hashed. Only schema and digest are persisted. This dynamic digest is not a
historical baseline: the first eligible observation establishes it, and exact
equality is required at immediate prewrite and every terminal observation.

Source identity, networking domains, all 97 exact variable metadata rows and
collateral hashes, topology, and staged-patch state remain independently bound.
A missing provider `patchId` is normalized only to the locked no-patch value
`null`; every present non-null value is rejected.

## Deadline and write boundary

The effective deadline is persisted in reviewed authority and rederived
immediately before the writer as the earliest of:

- current candidate pull-request `merged_at + 4 hours`;
- current workflow `run_started_at + 90 minutes`; or
- `2026-09-10T08:00:00.000Z`.

Expiry prevents a write from starting. Once the single write attempt begins,
expiry cannot suppress reconciliation, terminal evidence, or finalization.
Prepare and the apply job's boundary checks use only staging and production
metadata credentials. The sole writer receives only the staging scale
credential, and finalize receives no provider credential. No production write
credential or production mutation is allowed.

## Preconditions

- The V3 candidate is the exact current `main` tip and the sole-parent squash
  successor of `78162cf`.
- Its reviewed pull request is newer than PR 99, merged after the ineligible CI
  run completed, and has the required fresh attempt-one checks and artifacts.
- Complete unfiltered history for numeric workflow ID `353312302` contains only
  run 1 and the in-progress run 2; run 2 is attempt 1.
- The apply writer step is exactly queued with null start/completion fields.
- Railway external writers are frozen for the entire run.
- `permanent-staging-scale-evidence` has the two metadata credentials for
  prepare and apply boundary checks, plus the staging-only scale credential
  for the sole writer. Finalize is credential-free.
- Current UTC is before the derived deadline.

## One allowed dispatch

Dispatch `.github/workflows/stop-permanent-staging-post-q-deployment.yml` from
`main` exactly once with:

- `candidate_sha`: the exact current 40-character `main` SHA
- `authorization_id`:
  `pintpath-post-q-staging-stop-reauthorization-2026-09-10/v3`
- `authorization_source_sha256`:
  `d2c7b4c9d700a1d7c5219dd6c4245d5900154421497b8c637ac93f9215662549`
- `q_run_id`: `34229745722`
- `q_artifact_id`: `10057495901`
- `expected_deployment_id`: `6300a324-9407-4b1c-b651-749c47e9537f`
- `external_mutation_freeze_attestation`:
  `I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN`
- `confirmation`:
  `REAUTHORIZE_ONE_STAGING_DEPLOYMENT_STOP_6300A324_9407_4B1C_B651_749C47E9537F_FOR_<candidate_sha>_UNDER_V3_FROM_01A02140_8628_7D30_9374_8D29D4A9F3A3`

Do not rerun under any conclusion. A third dispatch created after run 2's final
history read cannot write: the shared non-cancelling concurrency group keeps it
queued until run 2 completes, after which it observes three history rows and
fails before the writer.

## Success criteria

Success requires the original-prefix durable intent artifact, exactly one
acknowledged `deploymentStop`, inner and outer terminal/completion pairs, three
stable provider observations showing the exact deployment stopped and zero
active deployments, unchanged target/off-target boundaries, and unchanged
production metadata. Runtime route absence is supplemental evidence.

This action cannot satisfy or widen F, V, S, A, or D prerequisites and cannot
dispatch a downstream workflow. The next permitted proof remains a separately
reviewed stopped-topology repair.
