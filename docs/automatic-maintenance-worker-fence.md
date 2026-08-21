# Candidate-bound automatic-maintenance worker fence

The protected worker-fence operation controls only these two Railway application
service variables in one `variableCollectionUpsert` call:

- `PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED`
- `PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA`

It is locked to Railway project
`48d8c6cd-1c66-4148-874b-20877f48e1a5`, application service
`6816c4a2-e392-4ee5-826f-2584cb599ec0`, permanent-staging environment
`a4e0f507-d6d3-4df9-a818-ad92c0071a35`, and production environment
`13dab015-df74-45c6-b26f-69323daea99a`.

## Operations

| Operation | Target | Enabled | Candidate | `skipDeploys` | Required precondition | Terminal outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `prepare` | permanent staging only | `false` | exact current main | `true` | reviewed candidate; provider state must remain unchanged | `prepared` |
| `fence` | production only | `false` | exact current main | `true` | reviewed candidate plus external proof that the old runtime is SQLite/detached from Postgres | `fenced` |
| `activate` | permanent staging or production | `true` | exact current main | `false` | candidate is the sole active, successful, unstopped, unpatched deployed source and the target-specific prerequisite chain below is current | `activated` |

`prepare` is allowed only in permanent staging. It writes the disabled state and
next candidate binding without deploying, and proves the deployment, source,
replica/domain topology, and collateral variable metadata did not change. The
current staging source predates this runtime fence, so `prepare` makes no claim
that its schedulers stopped. Its receipt is explicitly insufficient until a
separate exact 1-to-0 scale receipt proves quiescence. A production `prepare` and
a permanent-staging `fence` are rejected before token scope checks or a write.

`fence` proves that the production deployment did not change. It does not update
the already-running production process; the rollout may use it only when
separate evidence proves that process is SQLite-backed and detached from
Postgres. `activate` polls the provider until the same candidate is again the
sole healthy deployed source, then polls `/health`, `/startup`, and `/ready`
together until every route reports the same candidate and `automaticMaintenance` equal to
`{ "enabled": true, "candidateBound": true }`.

Permanent-staging activation requires four distinct successful run IDs for the
same candidate: `prepare_run_id`, `quiesce_run_id`,
`fenced_deployment_run_id`, and `restore_run_id`. Before any provider token is
available, the workflow downloads the four exact named artifacts and runs the
staging bootstrap verifier in `activate` mode. It includes the resulting
`prerequisites-verification.json` in the worker artifact.

Production activation instead requires one `role_limit_run_id` and rejects all
four staging run IDs. Before provider-token custody, the workflow downloads the
exact `pintpath-production-maintenance-role-limit-apply-<sha>-<run-id>` artifact,
requires unique root `intent.json`, `terminal.json`, `receipt.json`, and
`prerequisites-verification.json` files, and runs the production prerequisite
verifier in `production-activate` mode. The resulting
`production-activation-role-limit-verification.json` is included in the worker
artifact. Immediately before the variable upsert, the executor independently
consumes that verification, binds its SHA-256 and role-limit run ID in the
durable intent, and requires all of the following:

- the sole live successful candidate deployment ID matches
  `rolePrerequisites.productionDeployment.deploymentIdSha256`;
- `/health`, `/startup`, and `/ready` all identify that same deployment and
  candidate; and
- all three routes report automatic maintenance disabled and candidate-bound.

This proves the application is still on the exact disabled-worker deployment
that the protected 2-to-8 maintenance LOGIN transition consumed. The upsert is
not attempted if any prerequisite file, run binding, deployment identity, or
runtime response differs.

## Manual authority and serialization

Dispatch `.github/workflows/configure-automatic-maintenance-worker-fence.yml`
from `main` with an exact current-main SHA, target, operation, and confirmation:

```text
<PREPARE|FENCE|ACTIVATE>_AUTOMATIC_MAINTENANCE_IN_<TARGET_WITH_UNDERSCORES>_FOR_<40_HEX_SHA>
```

The run must be attempt 1. The workflow validates the merged reviewed tree,
current main ref, exact workflow run identity, and absence of a prior matching
run. It runs the complete repository check before Railway token custody and
reasserts current main immediately before custody.

`prepare` and `fence` reject every prerequisite run-ID input. Staging
`activate` requires exactly its four distinct staging IDs and rejects the role
ID. Production `activate` requires only the role ID. No prerequisite run ID may
equal the current workflow run ID.

Production uses concurrency group `pintpath-production-rollout`. Permanent
staging uses `pintpath-permanent-staging-key-rollout` with `queue: max`. Both use
`cancel-in-progress: false`, so the operation cannot overlap the corresponding
deployment or rollout mutation.

## Token wiring

The protected GitHub environments must expose both environment metadata tokens
and the appropriate target write token:

- `PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN`
- `PINTPATH_RAILWAY_STAGING_METADATA_TOKEN`
- production write: `PINTPATH_RAILWAY_PRODUCTION_VARIABLE_TOKEN`
- staging write: `PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN`

The workflow maps the selected metadata and write tokens to
`PINTPATH_RAILWAY_TARGET_METADATA_TOKEN` and
`PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN`. The two environment metadata tokens
must differ, and the write token must differ from both. Both selected tokens
must independently attest the exact target project and environment scope.

## Evidence and terminal receipt

The uploaded artifact name is exactly:

```text
pintpath-automatic-maintenance-worker-fence-<target>-<operation>-<candidate-sha>
```

It has 30-day retention and contains bounded, private-at-creation, secret-free
JSON files:

- `dispatch.json`: manual input binding.
- `authority.json`: schema
  `pintpath-automatic-maintenance-worker-fence-authority/v1`; binds repository,
  branch, workflow path/title, original run, reviewed pull request/tree,
  candidate, target, operation, and Railway IDs.
- `intent.json`: schema
  `pintpath-automatic-maintenance-worker-fence-intent/v1`; durably written before
  the mutation and binds the exact variable pair, `skipDeploys`, policy hash,
  authority hash, preflight provider hash, boundary hash, one-attempt limit, and
  no-retry rule. For production activation it also binds the verified role-limit
  run ID, prerequisite-verification SHA-256, exact deployment ID SHA-256, and
  disabled/candidate-bound preflight response hashes.
- `automatic-maintenance-worker-fence-terminal.json`: schema
  `pintpath-automatic-maintenance-worker-fence-terminal/v1`.
- staging activation only: `prerequisites-verification.json`.
- production activation only:
  `production-activation-role-limit-verification.json`.

The terminal receipt has these exact top-level fields:

```text
schemaVersion
executorState
binding
bindingSha256
outcome
attempts
retryAllowed
failureCode
authoritySha256
intentSha256
providerEvidence
runtimeEvidence
mutationBoundaryEvidence
checks
stagingBootstrapVerification
productionDeploymentVerification
secretMaterialIncluded
secretDerivedCommitmentsIncluded
```

`binding` contains the policy SHA-256, candidate SHA, target, operation, exact
project/environment/service IDs, the exact two configured string values, and
`skipDeploys`. `bindingSha256` is SHA-256 of the canonical pretty-printed JSON
binding plus its final newline. A consumer must recompute it and must also hash
the downloaded terminal file itself; the executor reports that external file
hash as `terminalSha256` in its bounded stdout result.

For a successful production fence, require all of the following:

- `outcome` is `fenced`, `attempts` is `1`, `retryAllowed` is `false`, and
  `failureCode` is `null`.
- The binding is exactly production, `fence`, the deploy candidate, enabled
  value `false`, candidate value equal to the deploy candidate, and
  `skipDeploys: true`.
- `providerEvidence.mutationCallCount` is `1`, acknowledgement is exact, and
  before/after deployment ID hashes match.
- Every receipt check is `true`; both mutation-boundary receipt hashes are
  present.
- `productionDeploymentVerification.eligible` is `true` and the required
  filename is `automatic-maintenance-worker-fence-terminal.json`.
- `productionDeploymentVerification.oldRuntimeSafetyPrerequisite` is
  `EXTERNAL_SQLITE_DETACHED_FROM_POSTGRES_PROOF`; the receipt truthfully records
  that this operation did not verify that prerequisite.
- Both secret-material flags are `false`.

For a successful staging prepare, additionally require `outcome: "prepared"`, a
permanent-staging `prepare` binding with `skipDeploys: true`, an enabled value of
`false`, and the next candidate SHA. The before/after deployment ID, topology,
source, and collateral-variable hashes must match. Require
`stagingBootstrapVerification.preparedReceiptExact: true`,
`sufficientWithoutQuiescenceProof: false`,
`nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF"`, and
`legacySourceRuntimeFenceClaimed: false`. Its `runtimeEvidence` must say
`required: false`, `observed: false`, and contain no expected source or
automatic-maintenance state.

## Rollout wiring

1. Permanent-staging prepare: dispatch `prepare` with the exact next candidate
   and verify its `prepared` receipt and completely unchanged provider state.
   Do not treat this as scheduler quiescence.
2. Permanent-staging quiescence: scale the legacy runtime exactly from one
   replica to zero and require its separate candidate/target-bound quiescence
   receipt before any source upload.
3. Permanent-staging bootstrap deployment: consume both the prepare and 1-to-0
   receipts, upload the bound candidate while the service remains at zero, then
   scale exactly from zero to one and attest all three runtime routes with
   automatic maintenance disabled and candidate-bound.
4. Permanent-staging activation and closeout: dispatch `activate` for the same
   candidate, accept only its `activated` receipt, then run the active closeout
   deployment/attestation requiring enabled and candidate-bound workers.
5. Production deployment: dispatch `fence` for production. The protected
   deployment workflow downloads and verifies that exact `fenced` artifact,
   then deploys the same candidate with automatic maintenance disabled and
   candidate-bound.
6. Production activation: after the production deployment and the protected
   production maintenance LOGIN limit transition, dispatch `activate` with that
   exact successful role-limit run ID. Accept only an `activated` receipt with
   the verified role/deployment chain, sole healthy candidate proof, and hashes
   for all three enabled, candidate-bound runtime routes.
7. Production scale: the protected scale workflow downloads both the exact
   activation terminal and its production activation prerequisite verification,
   validates the full role-to-activation chronology, and only then performs the
   scale under the shared `pintpath-production-rollout` concurrency group.

Both `prepare` and `fence` use `skipDeploys: true`, so neither can prove that the
already-running process observed the new values. Production depends on the
stated external SQLite/detached-from-Postgres proof. Permanent staging instead
requires the separate exact 1-to-0 quiescence proof before candidate upload.

## Failure behavior

The executor emits one bounded JSON line with a fixed failure code. It never
retries and can call `variableCollectionUpsert` at most once. Once a write is
attempted, target metadata and the production-staging mutation boundary are
reconciled read-only even if the acknowledgement is missing. An ambiguous result
is terminal `mutation_uncertain`; it is never inferred safe from metadata alone
because Railway metadata intentionally does not disclose plaintext values.
