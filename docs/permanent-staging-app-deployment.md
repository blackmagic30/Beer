# Permanent-staging application source-upload scaffold

Status: **HARD_DISABLED_REVIEW_REQUIRED**. This is an offline policy and
blocked-receipt foundation only. It cannot contact Railway, read a credential,
upload source, deploy or redeploy an application, change replicas or routes,
enable PITR, delete a resource, or incur provider spend.

## Fixed boundary

The canonical policy pins Railway project
`48d8c6cd-1c66-4148-874b-20877f48e1a5`, forbidden production environment
`13dab015-df74-45c6-b26f-69323daea99a`, permanent-staging environment
`a4e0f507-d6d3-4df9-a818-ad92c0071a35`, and Beer service
`6816c4a2-e392-4ee5-826f-2584cb599ec0`. It also pins the reviewed Railway CLI
identity, committed `railway.toml` and package-lock hashes, one-replica
postflight shape, read-only deployment-attestation policy hash, and the
US$50/month staging ceiling.

The policy describes only a future single source-upload operation from an
exact clean committed head through a private, independently pinned source
snapshot. It explicitly forbids Git autodeploy, a from-source redeploy,
ordinary redeploy, Railway-native rollback, replica scaling, domain or route
mutation, PITR mutation, deletion, variable or volume mutation, resource
creation, provider network access, and additional unapproved spend.

## Current behavior

There is intentionally no package command, CI job, locked-worker mode,
credential adapter, provider client, network callback, child process, or
mutation transport for this scaffold. The zero-argument runner ignores any
injected arguments and ambient input. It emits one canonical JSON line with
`mode=framework-disabled`, `outcome=blocked`, no candidate or deployment
identity, and every check `false`, then returns exit status `1`.

The checked-in policy is accepted only when its bytes exactly match the
canonical source compiled into the scaffold. Formatting changes, reordered or
additional fields, missing final newline, and any identity, hash, operation,
spend, or activation drift fail closed.

Running the scaffold is implementation evidence only. It cannot authorize a
Railway write, close the application-deployment blocker, create an authentic
deployment-attestation receipt, or satisfy a launch gate.

## Required work before activation

A later, separately reviewed change must add all of the following without
weakening this stop:

1. a complete read-only live topology fixture for the exact staging service,
   including its service instance, deployments, region, replica/resource
   limits, variables metadata, domains, routes, volumes, triggers, and staged
   patch;
2. a clean committed-head source authority and private immutable source
   snapshot whose complete manifest is reasserted immediately before upload;
3. a durable mode-0600 intent in a current-UID mode-0700 directory before any
   write, with recovery-only reconciliation that never repeats an uncertain
   upload;
4. separately locked immediate production/staging mutation-boundary preflight
   and unconditional postflight without inheriting both authorities in an
   ambient shell;
5. exactly one explicitly targeted, bounded source-upload attempt, followed by
   provider reconciliation even if acknowledgement is missing or times out;
6. proof that project, environment, service, replicas, variables, routes,
   volumes, resource limits, and spend authority had no collateral delta;
7. the existing read-only `/health`, `/startup`, and `/ready` deployment
   attestation for the same candidate and sole successful deployment; and
8. durable terminal evidence, cleanup/finalization proof, independent review,
   and a new policy version that deliberately changes the activation state.

After any attempted write, never retry automatically and never perform a
second provider mutation as cleanup. An absent acknowledgement or incomplete
postflight is `mutation_uncertain` and requires read-only reconciliation.

## Separate operations

Keep route creation, scale-to-two, scale-to-one, PITR enablement, and teardown
behind their own exact policies and executors. Route mutation is unnecessary if
complete inventory proves the expected domain already exists. Temporary
scaling requires a separately approved bounded spend window and a reviewed
scale-down operation. PITR remains blocked by the provider-safe image-label and
Singapore-placement review as well as explicit spend approval. Teardown remains
last and additionally requires complete resource/evidence reconciliation plus
specific authorization naming every resource ID.

The Postgres-compatible rollback rehearsal must deploy the separately recorded
`rollbackBuildSha` as a new exact source upload against the current Postgres and
provider configuration. Do not use Railway-native deployment rollback: that
operation restores the previous deployment's custom variables and could
reinstate superseded credentials or configuration.

## STOP conditions

Stop without provider access if the policy is non-canonical, any pin differs,
the checkout is not the reviewed clean committed head, a source snapshot or
durable artifact is unsafe, live topology is incomplete, either environment
has a staged patch, production authority is not exact, provider configuration
is incomplete, the cost ceiling cannot be proved, or any adjacent mutation
would be required. Do not use the Railway dashboard, Git autodeploy, CLI, API,
or an ad-hoc script to bridge a failed check.
