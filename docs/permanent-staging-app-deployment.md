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
integer `5000` USD-cent permanent-staging ceiling. Its spend contract pins
`ops/railway/permanent-staging-cost-policy.json`, which is currently
`SCAFFOLD_ONLY_PROVIDER_OBSERVATION_REQUIRED`.

The cost policy and pure evaluator are offline scaffolding only. They have no
provider collector or observation-binding capability, and the policy keeps
both `providerCollectorImplemented` and
`providerObservationBindingImplemented` false. A caller-authored inventory or
receipt therefore cannot satisfy the deployment or release gate. The
approximately US$46.80/month figure recorded in older planning is a historical
combined estimate for permanent staging plus the separate production
operational copy; it is not staging-only provider evidence and is never used as
the gating total.

The credential-free public-price planning audit reviewed on 2026-08-13 now
establishes a stricter blocker. At Railway's published US$20/vCPU-month,
US$10/GB-memory-month, and US$0.15/GB-volume-month rates, the documented Beer,
Postgres, and Redis maxima plus a fully used 50 GB staging Postgres volume total
US$26/month. Supabase's published Pro price with one Micro project, after the
plan's standard US$10 compute entitlement, is US$25/month. The resulting
US$51 partial configured maximum is already US$1 above the staging ceiling
before Railway egress, non-Postgres storage/backups, Supabase add-ons, or
Google/OpenAI/Resend. This is planning evidence only—not a live provider cost
receipt—but it proves the current maximum configuration cannot satisfy the
upper-bound contract. Do not activate the collector or deployment policy until
a separately reviewed capacity/cost redesign brings the configured maximum
below US$50 with enough headroom for every remaining bounded item.

The public-doc remediation design narrows that redesign without authorizing
it. A dedicated staging-only Railway Pro workspace with a US$20 compute hard
limit and a dedicated staging-only Supabase Pro organization with exactly one
Micro project, Spend Cap on, and no uncovered add-ons would reserve US$45 and
leave only US$5 for every external provider. This requires provider mutations
and may take Railway workloads offline at the hard limit; neither consequence
is approved here. Railway Agent usage must be disabled or independently
zero-bounded, and the present US$26 Railway resource maximum does not fit the
US$20 target.

Resend's published Free quota is a plausible zero-dollar staging target, but
the live plan/team/add-on state is unobserved. The source-derived Google
inventory now covers Dynamic Maps, Directions Legacy, Geocoding, Text Search
Pro and Enterprise, Nearby Search Enterprise, and Place Details Enterprise.
Places API (New) and Dynamic Maps document per-minute quotas, while Geocoding
and Directions also expose daily controls; none supplies the monthly hard
request reservation needed for this cost envelope. Google also warns that
quota and billing measurements can differ, so a cloud budget alert or a quota
set exactly at a free-usage threshold is not a conservative monthly bound.

The two OpenAI OCR call sites now disable SDK retries, use finite `high` image
detail, and cap every response at 8,192 output tokens. An admin submission can
still make up to three model calls (primary, fallback, and review), discovery
can make two per image, PDFs have no proved page/input-token ceiling, model
environment overrides fail closed outside the reviewed `gpt-5.6-sol` and
`gpt-4.1` allowlist. A new opt-in cost-bound path additionally pins
`gpt-4.1-mini-2025-04-14`, forbids PDFs and standalone discovery OCR, caps
prompt plus response-schema bytes at 49,152, and atomically reserves five
cents in shared `system_state` before each attempt until a US$1 UTC-month
ceiling. It is disabled and unobserved: the exact mini snapshot has not passed
the labelled corpus, no live price/project receipt is bound, and no two-replica
restart/denial evidence exists. OpenAI project hard-spend-limit enforcement is
also not instantaneous and has no documented maximum overshoot. These controls
reduce exposure but cannot yet ceiling-sum a live month. Consequently the
remaining US$5 is not yet a proved upper bound, and no Google, OpenAI, Resend,
Railway, or Supabase configuration change is authorized by this design. No
provider cost-control mutation is authorized.

The policy describes only a future single source-upload operation from an
exact clean committed head through a private, independently pinned source
snapshot. It explicitly forbids Git autodeploy, a from-source redeploy,
ordinary redeploy, Railway-native rollback, replica scaling, domain or route
mutation, PITR mutation, deletion, variable or volume mutation, resource
creation, provider network access, and additional unapproved spend.

## Current behavior

There is intentionally no package command or CI job that invokes the deployment
executor, and no locked-worker mode, credential adapter, provider client,
network callback, child process, or mutation transport for this scaffold. The
credential-free `permanent-staging:cost:contract:check` package command and
manual release workflow run only the offline fail-closed policy tests; they do
not invoke the runner or observe/deploy a provider resource. The zero-argument
runner ignores any injected arguments and ambient input. It emits one canonical JSON line with
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
   volumes, resource limits, and spend authority had no collateral delta,
   including fresh pre- and post-deployment provider-observed cost receipts for
   the same frozen candidate;
7. the existing read-only `/health`, `/startup`, and `/ready` deployment
   attestation for the same candidate and sole successful deployment; and
8. durable terminal evidence, cleanup/finalization proof, independent review,
   and a new policy version that deliberately changes the activation state.

The future read-only cost collector and receipt binder must inventory every
permanent-staging Railway resource, the staging Supabase project, and all
staging external-provider accounts/caps. Each provider row must have complete
inventory and price-or-cap evidence, ceiling-rounded integer USD cents, and
zero unknown, unpriced, shared, or unbounded resources. Their summed recurring
upper bound must be at most `5000` cents. The production operational-copy and
disposable-restore resources require separately hashed cost authorities and
must not be included in the staging total.

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
is incomplete, the fresh candidate-bound provider cost receipt is absent, the
scaffold-only cost policy remains inactive, the `5000`-cent ceiling cannot be
proved, or any adjacent mutation
would be required. Do not use the Railway dashboard, Git autodeploy, CLI, API,
or an ad-hoc script to bridge a failed check.
