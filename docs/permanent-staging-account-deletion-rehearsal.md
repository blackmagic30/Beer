# Permanent-staging account-deletion rehearsal operations

Status: **STAGING-ONLY, MANUAL DISPATCH, FAIL CLOSED**.

This runbook operates the protected account-deletion rehearsal and its cleanup
guardian. It does not authorize a production deployment, a production provider
mutation, a source upload, an arbitrary variable edit, or reuse of staging
credentials in production. The executable controls remain the source of truth:

- [the rehearsal workflow](../.github/workflows/permanent-staging-account-deletion-rehearsal.yml);
- [the cleanup and containment guardian](../.github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml);
- [the immutable Railway policy](../ops/railway/permanent-staging-account-deletion-rehearsal-policy.json).

## Immutable staging scope

Resolve and visibly recheck every identity before dispatch or incident action:

| Boundary | Exact value |
| --- | --- |
| Railway project | `48d8c6cd-1c66-4148-874b-20877f48e1a5` |
| Permanent-staging environment | `a4e0f507-d6d3-4df9-a818-ad92c0071a35` |
| Beer service | `6816c4a2-e392-4ee5-826f-2584cb599ec0` |
| Railway region | `asia-southeast1-eqsg3a` |
| Public origin | `https://beer-staging.up.railway.app` |
| Staging Supabase origin | `https://bbfibbadwjxzrcdncavy.supabase.co` |
| Forbidden production environment | `13dab015-df74-45c6-b26f-69323daea99a` |
| Forbidden production Supabase origin | `https://jxpubqlmqnnqwadmjgyk.supabase.co` |

Stop if any target differs or cannot be read back. Never infer the target from a
currently selected Railway dashboard project. This rehearsal may scale and
redeploy only the existing permanent-staging Beer source and may apply only its
fixed activation or cleanup variable maps. It must not change source, routes,
database or Supabase configuration, other Railway services, or production. The
intended deletion of the one sacrificial staging identity and its staging data
is in scope; no other Supabase identity or data is.

## Before dispatch

1. Confirm `candidate_sha` is the exact 40-character commit currently at
   protected `main` and already deployed to the permanent-staging Beer service.
   Do not use a PR-head SHA, a local branch SHA, or an older deployment SHA.
2. Confirm the service is in its exact safe initial state: one replica, the
   candidate source, `ACCOUNT_DELETION_NOTICE_MODE=disabled`, and no rehearsal
   marker for another activation.
3. Confirm the GitHub environments `permanent-staging-scale-evidence`,
   `permanent-staging-provider-mutation`, and
   `permanent-staging-deployment` contain the exact authorities required by the
   workflows. Every write authority must be staging-scoped. The workflow uses
   the sealed, capability-bearing production metadata token only through its
   checked-in metadata queries to prove the forbidden production boundary; it
   never passes that token to Railway CLI or a mutation call. Do not copy or
   expose secret values while checking their names.
4. Freeze every external Railway mutation for this project. That includes
   dashboard edits, Git autodeploy, CLI/API writes, and other provider,
   deployment, scale, rollback, or variable workflows. Keep the freeze until an
   exact terminal closeout is retained.
5. Confirm there is no account-deletion rehearsal or reconciliation run queued
   or in progress and no unresolved durable cleanup arm for an older activation.
6. Confirm the cleanup guardian is enabled and its discovery window has not
   expired. See [Guardian lifetime](#guardian-lifetime).
7. Use only a sacrificial, verified permanent-staging account for the deletion
   proof. Never copy production customer data into staging.

If any check fails, do not dispatch.

## Dispatch exactly once

In GitHub Actions, open **Rehearse Pint Path permanent-staging account
deletion**, choose **Run workflow** from `main`, and enter exactly:

- `candidate_sha`: the verified protected-`main` commit;
- `confirmation`: `RUN_ACCOUNT_DELETION_REHEARSAL_IN_PERMANENT_STAGING`;
- `external_mutation_freeze_attestation`:
  `I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN`.

Dispatch once and record the resulting GitHub run ID as `activation_run_id`.
The workflow first retains its durable cleanup arm and only then exposes any
mutation authority.

After dispatch:

- do not dispatch a second activation for the candidate;
- do not click **Re-run jobs**, because every mutation is bound to run attempt
  `1` and every operation has one durable attempt arm;
- do not cancel or force-cancel the rehearsal or a reconciliation run, even
  after a job appears stalled; let its timeout and the guardian handle it;
- do not change Railway, Supabase, GitHub environment secrets, or the deployed
  source while the cleanup arm is unresolved;
- do not scale a contained service back up during the same activation.

A failed or timed-out run is not permission to retry its write. The failed main
run automatically triggers the reconciliation workflow. The scheduled guardian
will independently revisit unresolved cleanup arms.

## Recovery dispatch

Normal recovery is automatic. The workflow
**Reconcile Pint Path account-deletion rehearsal cleanup** runs after a failed
main workflow and at minutes `17` and `47` of every hour.

Only when no main or reconciliation run for this activation is queued or in
progress, a release owner may start one fresh reconciliation workflow dispatch
using the original values:

- `activation_run_id`: the recorded original rehearsal run ID;
- `candidate_sha`: the candidate stored in that run's cleanup arm;
- `confirmation`: `RECONCILE_ACCOUNT_DELETION_REHEARSAL_CLEANUP`.

Never use GitHub's rerun control, invent a replacement activation ID, or start a
new main rehearsal to recover the old one. After one manual reconciliation
dispatch, wait for workflow-triggered or scheduled recovery rather than
repeatedly dispatching it.

## Evidence and artifact inspection

Artifacts are retained for 90 days. Download them from the original and
reconciliation runs without editing or re-uploading them.

1. Before any mutation, the original run must contain
   `pintpath-account-deletion-rehearsal-arm-<candidate_sha>-<activation_run_id>`
   with exactly `cleanup-arm.json` and `github-authority.json`. Both must bind
   the exact candidate, activation run, project, staging environment, and
   service above.
2. Each attempted operation has a retained
   `pintpath-account-deletion-rehearsal-attempt-<operation>-...` artifact. Treat
   the existence of an attempt arm as a consumed attempt even if the later
   mutation step failed or was cancelled. In particular, inspect the
   prefix-contiguous containment history:
   `quarantine-zero`, `quarantine-zero-retry-1`, then
   `quarantine-zero-retry-2`.
3. Inspect the latest read-only state and provider evidence. Candidate SHA,
   activation run ID, project, environment, service, region, deployment source,
   replicas, instances, staged patch, and rehearsal row names must all be exact.
   An `UNKNOWN` or partially matching observation is not closeout evidence.
4. Accept a validated closeout artifact for the activation:
   `pintpath-account-deletion-rehearsal-closeout-<candidate_sha>-<activation_run_id>`
   or
   `pintpath-account-deletion-rehearsal-reconcile-closeout-<candidate_sha>-<activation_run_id>`.
   It must contain exactly `closeout.json`, `provider-evidence.json`,
   `authority.json`, and `attempt-inventory.json`.
5. Require `exact=true`, `secretMaterialIncluded=false`, and
   `mutationCredentialExposed=false` wherever those fields appear. Do not put
   tokens, secret values, recipient addresses, raw customer data, or decrypted
   evidence into an incident record.
6. Match the terminal state to the complete attempt inventory:

| Attempt history | Only acceptable exact terminal state |
| --- | --- |
| No `cleanup-contained-zero` or quarantine arm | `SAFE_ONE_PREACTIVATION`, `SAFE_ONE_FINAL`, or `QUARANTINED_ZERO` |
| Any `cleanup-contained-zero`, `quarantine-zero`, `quarantine-zero-retry-1`, or `quarantine-zero-retry-2` arm | `QUARANTINED_ZERO` |

`SAFE_ONE_FINAL` is not valid closeout after containment history exists, even if
the provider currently reports one healthy replica. A quarantined closeout is
safe containment, not permission to restore service.

## Bounded automatic containment

Recovery first tries only the state-specific, one-shot cleanup, safe redeploy,
or converge operation permitted by the fresh live observation. If safety cannot
be proven, it advances monotonically through three independent containment
slots:

1. `quarantine-zero`;
2. `quarantine-zero-retry-1`;
3. `quarantine-zero-retry-2`.

Each slot receives a fresh global attempt inventory and exact live topology
before its single scale-to-zero attempt. A later slot is permitted only when
every earlier slot has a durable arm. No slot restores replicas. Once any
containment arm exists, normal cleanup can complete only at zero and the final
state must remain `QUARANTINED_ZERO`.

At zero replicas with no instances, recovery may spend the separate one-shot
`cleanup-contained-zero` operation to apply and read back the exact fixed
cleanup map. Exhausting all three containment slots, or exhausting
`cleanup-contained-zero` without exact cleanup, produces
`MANUAL_FAIL_CLOSED`. It must not be converted into an automatic fourth retry.

## Manual fail-closed escalation

Use this break-glass procedure only when the retained attempt inventory proves
that `quarantine-zero`, `quarantine-zero-retry-1`, and
`quarantine-zero-retry-2` are all consumed without an exact
`QUARANTINED_ZERO` observation, or when `cleanup-contained-zero` is consumed
while exact cleanup is still pending.

1. Declare an incident and continue the external Railway mutation freeze.
   Record the candidate SHA, original activation run ID, reconciliation run IDs,
   artifact names and digests, last exact/failed classification, and which
   one-shot arms were consumed. Never record credential values.
2. In read-only views, independently re-resolve the exact Railway project
   `48d8c6cd-1c66-4148-874b-20877f48e1a5`, permanent-staging environment
   `a4e0f507-d6d3-4df9-a818-ad92c0071a35`, Beer service
   `6816c4a2-e392-4ee5-826f-2584cb599ec0`, and region
   `asia-southeast1-eqsg3a`. Stop on any ambiguity.
3. If the exact service is not already contained, perform one incident-reviewed
   break-glass Railway scale action that sets **only that permanent-staging Beer
   service in that region to 0 replicas**. Do not change production, another
   service, source, deployment, variables, routes, domains, Postgres, or
   Supabase in this step. Do not retry an ambiguous write.
4. Refresh provider state and verify both `replicas=0` and an empty instance
   list twice, at least 60 seconds apart. Preserve non-secret screenshots or
   provider receipts from both observations. If either observation is not exact,
   keep the incident open and do not make another write without a new reviewed
   incident decision.
5. Keep replicas at zero. Allow the next guardian run, or one fresh manual
   reconciliation dispatch using the original IDs, to apply the fixed cleanup
   and create an exact recovery closeout.
6. If `cleanup-contained-zero` is already consumed and cleanup remains pending,
   use one separately incident-reviewed break-glass provider mutation to apply
   only this fixed variable map to the exact service while it remains at zero:

   | Variable | Required stored result |
   | --- | --- |
   | `ACCOUNT_DELETION_NOTICE_MODE` | `disabled` |
   | `ACCOUNT_DELETION_REHEARSAL_ENABLED` | removed |
   | `ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID` | removed |
   | `ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID` | removed |
   | `ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID` | removed |
   | `ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL` | removed |
   | `ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL` | removed |
   | `ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT` | removed |
   | `ACCOUNT_DELETION_REHEARSAL_RUN_<activation_run_id>` | removed |

   Do not modify `SUPABASE_OAUTH_PROVIDERS`, the retained deletion-notice
   credential rows, or any unrelated variable. Read back the exact non-secret
   names and stored/absent status twice. Label the evidence honestly as a manual
   incident action; never manufacture a protected-executor receipt.
7. Let the guardian classify the fixed zero state and seal a
   `QUARANTINED_ZERO` closeout. If it cannot, retain zero replicas and escalate
   for code/incident review. Do not disable the guardian to make the run look
   complete.
8. Never scale the service back up as part of this activation. Restoration is a
   separate, newly reviewed staging operation after the incident is resolved
   and the exact quarantined closeout is archived.

## Guardian lifetime

The guardian schedule is `17,47 * * * *` in UTC. It discovers the oldest
unresolved durable arm created on or after `2026-09-01T00:00:00Z` and operates
only within its reviewed 89-day discovery horizon. That horizon ends at
`2026-11-29T00:00:00Z`, one day before the oldest 90-day artifacts can expire.

Before that deadline, merge a reviewed recovery change that deliberately
advances the discovery epoch and horizon, then rerun the contract tests. Do not
extend the window through an unreviewed runtime edit, disable the schedule, or
dispatch a new rehearsal after expiry. If the window expires with an unresolved
arm, keep the service fail closed and resolve it as an incident.

## Closeout

Release the external Railway mutation freeze only after all of these are true:

- no main or reconciliation job for the activation is queued or running;
- at least one trusted four-file closeout binds the original candidate and
  activation run, and any failed or untrusted same-name artifact has been
  rejected rather than substituted for it;
- its state and complete attempt history satisfy the terminal table above;
- provider evidence confirms the exact target staging service, while its
  boundary checks retain empty protected-production environment patches and
  the pinned production Postgres state; any separately required non-target
  scope evidence is attached to the incident or change record;
- incident actions, if any, are recorded without secrets; and
- a quarantined service remains at zero pending a separate reviewed restoration.

The rehearsal is staging evidence only. It does not approve or perform any
production change.
