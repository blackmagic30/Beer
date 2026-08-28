# PintPath launch-readiness review — 27–28 August 2026

## Decision

**NO-GO. PintPath is not launch-ready, and this document does not claim launch
readiness.** The repository contains substantial fail-closed PostgreSQL,
migration, deployment, and recovery machinery, but the live system, permanent
staging evidence, operational jobs, data quality, and all 13 external release
gates do not yet support a safe launch.

This is a secret-free status record. Provider credentials, connection strings,
private evidence, and unhashed resource authorities remain outside Git.

## Current version and runtime state

| Item | Verified state |
| --- | --- |
| Production | `95b9f2da5e9a99692c8cfafba90d2c29e63ccbc8`; exactly 26 commits behind current `main`, still serving the legacy SQLite authority. The live `/health` response reconfirmed that exact SHA on 28 August 2026. Railway currently shows the Beer service attached to its `/app/data` volume while the separate PostgreSQL service is merely online. |
| Repository at post-merge reassessment | Local and remote `main` were exact at `31b6355acffeaccb0c517bcb231fd6d5b5eb0803`. PR #57 merged the reviewed Free-launch and retention tree; PR #59 then merged the reviewed external venue-directory bootstrap on 28 August 2026. All PR #59 repository, native, Supabase, PostgreSQL, CodeQL, build, and release-readiness checks completed successfully. |
| Candidate status | Current `main` is suitable as the code basis for permanent-staging proof, but it is not deployed or frozen as a release candidate. A staging-only recovery and production-schema drift-proof change is locally complete on `codex/launch-p0-p1-recovery`: the final Node 22.23.2 gate passed 237 test files / 4,358 tests, with 47 files / 126 tests intentionally skipped by their existing gates, and the recovery audit closes the identified repository evidence/retry dead ends. It does not become release authority unless it is independently reviewed, merged, and proved live. The broader iOS visual redesign remains preserved separately at `codex/ios-redesign-retention-wip` commit `1723572` and is not part of the launch implementation. |
| Release register | `release.id`, `reviewedPrHeadSha`, and `candidateSha` are null. All 13 required items are pending: 0/13 complete. |
| Permanent staging application | The public Railway route currently returns `Application not found` for `/health`, `/startup`, and `/ready`. The Beer service has `numReplicas:null`, zero active deployments, and a failed/stopped latest deployment from source `12c0d24…`; its domain correctly targets the documented application port 8080. PostgreSQL, Redis, and Supabase are online, but no current candidate application is serving or proved there. |
| Permanent staging data services | The reviewed `20260828010000_bootstrap_external_venue_directory.sql` migration is now applied to the exact staging Supabase project. `public.venues` exists, service-role REST access returns 200 with an empty array, and anonymous access fails closed with 401. Railway PostgreSQL reports schema v1/import ready, 56 authoritative application tables, exact runtime/maintenance roles and memberships, SCRAM credentials, and no unsafe runtime role settings after the final legacy `search_path` override was transactionally removed. The Beer service remains stopped and has not authenticated with those credentials. |
| Production PostgreSQL | Provisioned and online, but empty, detached from the production Beer service, not imported, and serving no live traffic. On 28 August its mutable `:17` source was safely changed to the policy-approved digest-only reference under a provider-write freeze. Railway patch `30db986b-4df9-4847-bce0-4cd1c3a3adc7` committed with deploys skipped; the deployment, instance, snapshot, and volume identities remained unchanged. |
| Production Supabase venue directory | The production project is behind the candidate's required directory migration: a read-only candidate query fails with PostgreSQL `42703` because `public.venues.business_status` is absent. The migration is applied and REST-proved on permanent staging, but status refresh, constraint validation, and candidate map-query proof must pass there before it is considered for production. |

The live `/ready` payload exposes SQLite-specific foreign-key checking and the
candidate-only `/startup` endpoint returns 404. The current public smoke passed
9 checks, failed the PostgreSQL logical-backup attestation, and skipped all
three authenticated role journeys because dedicated credentials/tokens are not
configured. Live HTML still exposes Happy Hours and specials on the map,
Happy Hours on submission, and the legacy Pricing page with A$4.99/month,
A$50/year, Venue Pro A$149, Premium, and checkout language. Those are production
parity defects; the locally built Free-scope cleanup described below is not
deployed.

The current code deliberately makes hosted production and permanent staging
select PostgreSQL without a SQLite fallback. Deploying it before the database,
identity, worker-fence, and provider prerequisites are correct should therefore
fail closed. That is the desired safety behavior, not evidence that staging or
production is ready.

## Candidate decision

PR #57 merged the bounded Free-launch and retention implementation and PR #59
merged the staging-first external venue-directory bootstrap into `main`. The
combined tree removes public Pricing navigation and stale commercial/Happy-Hour
presentation, turns the legacy pricing URL into a no-index Free-access
explanation, normalizes stale persisted Pro/Plus venue metadata to Free, adds a
safe one-tap price-confirmation path, tightens public data-readiness semantics,
and adds the retention signals described below. Its reviewed head and protected
merge have identical Git trees. The broader pre-existing iOS redesign and its
assets remain preserved on a separate WIP branch because they require
visual/device review and contain a non-blocking contributor-progress
presentation defect.

Treat the merged tree as the implementation basis for permanent staging, not as
a frozen release candidate. Do not populate the release identity or freeze a
candidate SHA until permanent staging, migration, recovery, and required
external evidence genuinely pass.

## What is already implemented or historically proved

- PostgreSQL 17 schema and least-privilege runtime/migration roles are
  implemented for the Free launch scope.
- A synthetic permanent-staging import was reconciled across 56 authoritative
  tables, 717 columns, 76 foreign keys, and 13,121 rows.
- Historical permanent-staging runtime checks passed without SQLite fallback.
- A logical PostgreSQL backup was restored into a separate disposable database,
  and one synthetic deletion tombstone was replayed idempotently.
- Candidate-bound, fail-closed workflows exist for staging/production deploy,
  worker fencing, provider variables, Supabase key cutover, two-replica scale,
  PostgreSQL HA/PITR, route control, promotion, backup, restore, and recovery.
- The reviewed PR head passed required repository CI, automated-readiness,
  CodeQL, and native-app checks. These are implementation checks, not live
  release evidence.

## Repository P0/P1 fixes in the merged implementation

- Enforced the Free launch gate in backend configuration and public UI: no paid
  enrolment, checkout, Premium/Venue Pro pricing, public happy-hour discovery,
  rewards, reports, or POS/counter launch surface is reachable from the built
  public navigation.
- Converted the legacy pricing route to a no-index Free-access explanation,
  removed stale commercial links/copy, forced venue tier metadata to Free when
  commercial launch is disabled, and normalized legacy persisted Pro/Plus
  snapshots before rendering or re-saving.
- Added an explicit `[hidden]` CSS override after browser testing found that the
  Specials row's component rule could override the browser's hidden-state
  styling. The regression suite now checks that fail-closed presentation.
- Added minimum retention instrumentation for search usefulness, venue views,
  first durable saves, contribution/verification, Tonight plan creation, and
  mature 7-day return cohorts for accounts opted into optional analytics.
- Added the one-tap price-confirmation endpoint and UI with `yes`, `no`, and
  `didnt_order`, including schema-neutral venue-manager price handling and
  signal-only positive evidence that cannot mutate public verification.
- Preserved the reviewed iOS launch-safety behavior from `main`, then added
  bounded consent-gated search usefulness and the signed one-tap confirmation
  outcomes with adaptive 44-point controls. Search measurement now uses one
  cancelable/coalesced task and checks cancellation between catalogue pages, so
  rapid filter changes cannot overlap full-catalogue telemetry crawls.
- Corrected the protected permanent-staging scale attestation to the documented
  Railway application port 8080 and added a fail-closed regression rejecting
  stale port 3000 evidence.
- Corrected the staging runbook order: the four create-only provider values must
  be written with deploys skipped while the legacy app is healthy at one replica
  and before worker preparation. The separate Supabase replacement should also
  run before prepare, but remains safely eligible on the same healthy legacy
  generation after prepare because row metadata cannot prove key replacement;
  it must finish before quiesce or candidate upload. The provider executor
  cannot run at fenced zero.
- Enforced the observable part of that order in the protected executors:
  provider writes and worker preparation now require the exact healthy
  one-replica legacy generation, sole staging service domain on port 8080,
  stable deployment/snapshot identity, an empty patch, and a source SHA
  different from the candidate. Provider writes recheck the complete observable
  snapshot immediately before mutation; worker preparation additionally
  requires all four create-only provider rows and fails closed before durable
  intent if the staging baseline is incomplete.
- Added a no-schema Saved Updates treatment for the 20 most recent saved venues
  and beers. It shows only two claims that existing authority timestamps can
  prove: a trusted price was explicitly verified after the save, or current
  price data crossed the 30-day freshness limit during the last seven days.
  It returns no exact price, fails closed above 100 eligible rows, and adds no
  email, push, read/dismiss, cheaper-price, new-venue, or reconfirmation claim.
- Added a deterministic control/treatment readout anchored on a versioned,
  server-only dashboard event. The D1-D7 primary outcome is a neutral
  authenticated core-loop return; Saved Updates view/open events remain
  diagnostics and cannot make the treatment look retained. Assignment metadata
  freezes Free/contributor population and saved venue/beer eligibility at the
  time of assignment, and only fully matured opt-in denominators are compared.
- Tightened the read-only production data-quality audit so the three-result
  usefulness threshold, current/trusted/actionable semantics, failed/unknown
  checks, and scoped suburb hashes are explicit and reproducible.

These fixes are merged and tested. They do not repair the stale live deployment,
create staging evidence, migrate production data, enable operational jobs, or
complete any externally owned release gate.

## Recovery-chain P1 fixes awaiting review and merge

The `codex/launch-p0-p1-recovery` change now fails closed across the exact
observed dead staging topology and addresses the final independent recovery
review findings:

- cold prepare and quiesce have exact reviewed-candidate operations and accept
  only one complete normal chain or one complete cold chain. An ambiguous
  prepare or quiesce write can be followed only by its exact read-only
  reconciliation identity; bounded failed/cancelled read-only probe attempts
  are authenticated and ordered before exactly one successful proof;
- the Supabase canary executes against the exact in-memory key pair sent to
  Railway, and cold prepare requires that same-candidate successful replacement
  receipt plus a sealed service-role row;
- cold prepare cannot be freshly redispatched after an attempted write;
- lost acknowledgements for cold prepare, restore `0 -> 1`, and automatic-
  maintenance activation have separate metadata-only reconciliation jobs.
  They prove the exact intended live state before and after, carry no scale or
  variable mutation credential, make zero provider writes, and emit truthful
  alternate receipts rather than claiming a second normal transition;
- a proved `null -> 0` quiescence is accepted after a lost or non-zero CLI
  acknowledgement only when every provider, runtime, repository, collateral,
  and boundary invariant matches; a CLI process group that ignores termination
  is forcibly settled after a bounded grace period;
- Supabase legacy disable and read-only reconciliation have distinct run
  identities. One ambiguous disable may be followed only by read-only
  reconciliation; a second write remains forbidden;
- an ambiguous `OFFSITE_BACKUP_*` cleanup has reviewed candidate/run-bound
  resume and cancel operations that do not depend on a post-write artifact;
  exact staged patches can be finished or cancelled, exact already-completed
  deletions can be closed read-only, and cross-mode retries are rejected;
- every runner-loss recovery remains bound to current protected `main`. The
  original write must begin inside the normal merge-plus-168-hour window; the
  matching recovery has one fixed 24-hour grace measured from that original
  run's completion, never from a later retry;
- the live Railway empty staged-patch sentinel uses ID `<empty>` rather than a
  UUID. The provider parser now accepts that exact ID only for an empty
  `STAGED` patch; every non-empty deletion patch still requires a UUID. A
  live-shape regression prevents the protected provider workflow from failing
  closed before its first write on the canonical empty provider response;
- receipt, policy-hash, artifact-name, workflow-consumer, and downstream
  bootstrap relations are covered by the complete repository gate.

These are repository safety fixes, not staging evidence. No recovery workflow
has been dispatched and no Railway or Supabase state was changed by this patch.

## PostgreSQL staging, migration, and recovery gaps

The following remain unproved against the current candidate and are hard stops
before a production cutover:

- no current permanent-staging application deployment or strict
  `/health`/`/startup`/`/ready` receipt;
- the current failed/stopped staging topology cannot satisfy the normal
  one-replica provider/worker preflight. The staging-only recovery change now
  models the exact observed `null -> null -> 0` path, binds cold prepare to the
  exact canaried Supabase replacement receipt and sealed service-role row,
  provides bounded stranded-patch recovery for only the three forbidden
  staging `OFFSITE_BACKUP_*` rows, and cannot impersonate normal `1 -> 0`
  evidence. It remains unmerged and unexecuted;
- the former mutable production PostgreSQL source blocker is closed. A running
  disposable PostgreSQL service proved stage/cancel/retry and deploy-suppressed
  commit for the exact digest source without changing its deployment, instance,
  or volume. After independent review, production patch
  `30db986b-4df9-4847-bce0-4cd1c3a3adc7` applied the same source-only repair
  with deploys skipped and all protected identities unchanged. See
  `docs/railway-postgres-source-reference-proof-2026-08-28.md`;
- the staging Beer service still has the legacy runtime URL query
  `uselibpqcompat=true&sslmode=require` and is missing the maintenance URL,
  root-CA PEM, root-CA DER pin, and automatic-maintenance candidate SHA. Four
  protected variable runs were stopped after the first failed before any write
  on the production source-boundary mismatch; the three redundant queued runs
  were cancelled rather than consuming more CI time;
- a fresh metadata-only preflight found 128 staging variable rows, which was
  above the protected executors' complete-inventory limit of 100. Three exact
  stopped staging-only probe/canary services with no production instance or
  volume were removed, reducing the inventory to 99 rows with no next page.
  The disposable PostgreSQL source-proof service had also left one unattached
  empty volume; that exact volume is now marked deleted/pending provider
  cleanup. No application or database volume was removed;
- the separately controlled Railway owner seal is complete for the existing
  Beer `SUPABASE_SERVICE_ROLE_KEY` row. Owner confirmation was obtained before
  the irreversible action. Railway patch
  `fe5b65d2-24d4-4e7c-8672-944bd5df2418` committed the single reviewed,
  redacted variable path with deploys suppressed. Postflight proved the same
  row ID, name, environment, service and references with `isSealed:true`, all
  other 98 variable metadata rows unchanged, an empty staged patch, and no
  change to staging or production deployment identities. The value was neither
  displayed nor replaced;
- staging PostgreSQL's source now uses the digest already running in Singapore.
  Railway applied the source-only `serviceInstanceUpdate` directly rather than
  creating the expected staged patch, so no commit or retry was attempted. An
  independent postflight proved the deployment, running instance, snapshot,
  volume, region, backup schedule, and replica count unchanged. This closes the
  mutable-source drift but is not runtime, PITR, migration, or recovery evidence;
- no current Auth, contributor, venue-Free manager, admin, private Storage, and
  Free-only core-journey evidence;
- the staging Supabase venue-directory migration and REST authorization are
  proved, but production Supabase still lacks the candidate-required
  operational-status fields. Staging must still complete status refresh,
  constraint validation, and candidate map-query proof before any production
  schema change;
- the additive venue-directory constraints are still `NOT VALID`; a reviewed
  follow-up validation migration is required after staging refresh/data repair;
- no completed Google Maps, Google Places, OpenAI, Supabase replacement-key, or
  legacy-key denial receipts for the candidate;
- protected staging is missing the Supabase management read token needed to
  reconcile the already-disabled legacy keys. The revised read-only mode no
  longer asks for a write token or performs a PUT. Dedicated user-A/user-B,
  admin, and fixture inputs are also missing for two-replica scale/load proof;
- no two-replica overlapping-worker, connection-pool, load, 60-minute soak,
  restart, rolling-deploy, or PostgreSQL-compatible rollback-build proof;
- no representative permanent-staging query-plan evidence;
- managed PITR is not enabled or proved. A prior staging-only image-label trial
  unexpectedly began moving the volume toward Europe and was reverted; a
  provider-safe Singapore placement sequence must be reviewed and proved before
  another attempt;
- no live provider-enforced WORM authority, complete private Storage recovery,
  full recovered-application smoke, approved RPO/RTO, or final disposable
  environment teardown proof;
- no production SQLite snapshot/import/reconciliation receipt, post-import
  recovery set, reviewed-data promotion receipt, or monitored reversible
  cutover.

Production migration must not begin until the permanent-staging and complete
recovery evidence above passes. The existing SQLite deployment is not an
acceptable launch runtime, but it must not be replaced by an unsafe cutover.

## Operational job status

All three required workflows are currently `disabled_manually` in GitHub. Their
schedule declarations remain in source, but no schedule is operational while a
workflow is disabled.

| Workflow | Intended schedule | Current evidence and why enabling is unsafe |
| --- | --- | --- |
| `Production Health` | Public probes every 15 minutes; authenticated user/venue probes hourly at minute 7. | The dedicated `production-monitoring` and `production-monitoring-alerts` environments currently contain no secrets or variables. Smoke credentials exist under the broader `production` environment but are intentionally unavailable to the least-privilege monitoring job. Keep disabled until dedicated verified smoke accounts, exact production Auth values, alert delivery, and external deadman monitoring pass a manual end-to-end run. |
| `Venue Directory Status Refresh` | Daily at `23 14 * * *` UTC. | The production environment has the expected Supabase and Google Places secret names, but the production directory schema is still behind the candidate and `production-monitoring-alerts` has no webhook. Keep disabled until the production schema is approved, the exact target passes dry-run and full refresh, freshness thresholds pass, and alert delivery is proved. |
| `Production PostgreSQL logical backup` | Daily at `15 14 * * *` UTC; monthly restore drill at `45 15 1 * *` UTC. | The `production-backup` and `production-backup-alerts` environments currently contain no required inputs and `production-restore-drill` does not exist. The ephemeral self-hosted runner is also unproved. Production is still SQLite, so this PostgreSQL job must not be represented as protecting live production data. Enable only after PostgreSQL cutover prerequisites, the ephemeral runner, exact database/CA targets, operational copy, WORM roles, retrieval/restore drill, cleanup, and alert delivery are proven. |

Re-enable each workflow separately only after a successful manual proof. Do not
set an enable variable merely to make the workflow appear operational.

## Production data-quality baseline

The Free-scope public, read-only production audit was rerun again from the
candidate implementation at `2026-08-28T05:02:36.739Z` and reconfirmed:

- 612 venues;
- 288 price rows;
- 62 trusted price rows, all stale under the current freshness policy; the
  oldest trusted verification is now 53.9 days old and no qualifying core row
  has a current verification timestamp;
- 239 rows whose exact price is redacted from the Free public API and 49 rows
  with a public numeric price; the audit therefore labels its actionability
  result as Free-public evidence rather than a complete private-data census;
- zero qualifying current trusted price rows and therefore zero venues with at
  least three qualifying current trusted prices;
- three malformed structured addresses;
- five failed and two unknown audit checks, all seven of which remain strict
  blockers rather than being silently treated as passes.

This is a P1 retention and launch-quality risk. Broad Melbourne coverage is not
useful if searches cannot return actionable choices. Concentrate verification,
venue onboarding, and contributor missions in one or two launch suburbs, then
measure the percentage of searches returning at least three current, trusted,
actionable results. The revised read-only audit now evaluates one canonical
search per marketed suburb as an explicit readiness proxy: 0 of 112 suburb
searches currently return at least three useful venue options (0%). This is not
historical user-search telemetry. Candidate search events now record total and
useful-result counts, and the admin KPI response aggregates measured,
unmeasured, successful, inconsistent, and 0/1/2/3+ result buckets. Production
still has no value for this metric because that candidate is not deployed.

A second run explicitly scoped `PINTPATH_DATA_MARKETED_SUBURBS=Brighton` and
matched exactly one directory suburb with seven marketed venues (scope hash
`e0fbc10d634fef21a94b856101ae69ba2208f829f35091211e2b54d0f8eeed97`).
Brighton also returned zero useful venue options and failed the one scoped
search. All 62 trusted rows in the complete public response are older than the
30-day policy, so the zero qualifying result is not caused only by Free-price
redaction. The three address repairs requiring authorised data changes are
Bridge Road Brewers and Pizza Al Taglio (corrupted postcode `N0L`) and Captain
Melville (missing suburb/postcode).

### First launch-area mission wave: Brighton

Use **Brighton** as the first bounded launch cell. The public directory contains
seven Brighton venues and 35 price rows. Twenty-seven rows were previously
photo-verified, but every one is now stale. Half Moon and Brighton Beach Hotel
are the only two Brighton venues with that reusable evidence base. This is a
better starting cell than attempting to refresh central Melbourne's 116 venues.

The first field wave is:

1. Obtain a current, permission-safe menu photo or venue-manager confirmation
   for at least three numeric, on-tap pint prices at Half Moon.
2. Do the same at Brighton Beach Hotel.
3. Onboard one additional beer-led Brighton venue—start with Hotel Brighton,
   then Mothers Milk Brighton if the first pilot declines—and capture at least
   three numeric, on-tap pint prices.
4. Independently review the evidence and promote only current trusted rows;
   re-run the production data-readiness audit after promotion.

The first measurable target is three distinct Brighton venues, each with at
least three qualifying current trusted pint prices: nine qualifying rows and a
canonical Brighton search with at least three useful venue options. The stricter
readiness target remains at least five of seven Brighton venues covered, because
the configured suburb coverage floor is 70%. No production data was changed by
this repository review; completing this wave requires venue/pilot owners,
contributors, moderation, and authorised production promotion.

## Retention-loop instrumentation and bounded MVP status

The merged implementation now records the requested loop without turning
analytics into release evidence:

- search events include visible result count, query-context useful-result count,
  the three-result success threshold, and a
  `client_visible_current_trusted_pint_v1` source label. Beer searches count
  only the requested beer; unrelated current beers cannot make that search
  successful. The server/admin rollup applies a server-controlled observation
  end, excludes currently opted-out accounts, derives success from the reported
  count, and reports inconsistent client flags. These client-observed values
  are directional product telemetry, not formal release evidence;
- existing venue-detail events remain the venue-view signal;
- signed-in venue, beer, suburb, and night-plan saves emit add events only on
  the first durable insertion, not on every upsert;
- the first successfully persisted account night plan emits
  `tonight_plan_created`; anonymous local plans emit the same event only after
  the first local stop is added;
- a signed, rate-limited price-confirmation endpoint accepts `yes`, `no`, and
  `didnt_order` only for visible, current, numeric, on-tap pint records from a
  contribution-eligible account. It is alias-safe and idempotent per outcome
  and a non-sensitive authority version derived from record identity and
  verification/update timestamps, not the low-entropy exact price. Account
  export therefore cannot recover an expired contributor-only price from either
  a literal metadata field or a brute-forceable price fingerprint. `yes`
  persists server-only, signal-only evidence and cannot refresh public trust or
  freshness by itself. A later `no` from the same account suppresses that
  earlier positive signal. For community records, `no`
  uses the existing record-bound deduplicated wrong-price queue. Current,
  actionable `bar_beer:*` venue-manager rows are also eligible: their `no`
  report validates the canonical venue/beer source, stores no invalid community
  price-record foreign key, deduplicates by reporter and subject, and never
  changes venue-manager verification or trust. `didnt_order` is stored only
  with optional-analytics consent and is purged with that scope. This is a safe
  feedback slice, not public price reconfirmation;
- the admin D1-D7/D1-D30 cohort uses UTC calendar days, excludes signup day,
  reports only fully matured denominators, and labels unmatured cohorts instead
  of reporting false zero retention. Its population is explicitly limited to
  accounts currently opted into optional analytics and begins at the current
  opt-in episode reconstructed from privacy activity (with a legacy consent-time
  fallback); it is directional product-loop retention, not signup retention for
  every account.

The bounded Saved Updates MVP is now implemented without a new table or exact
price baseline. It deliberately avoids claims that existing data cannot prove.
For the 20 most recent venue/beer saves, one alias-safe indexed query ranks the
complete current public authority set first, then applies trust, on-tap pint,
positive-price, and explicit authority rules only to the winning row. This
prevents an older trusted row being resurrected when a newer pending, disputed,
off-tap, null-price, unverified-manager, or future-dated row has superseded it.
The feed shows at most 20 seven-day cards and fails closed when more than 100
eligible rows are found. Cards reveal venue/beer context and a map link, never
the exact price.

The experiment is assigned deterministically per account. A versioned
server-only dashboard event freezes the account's variant, Free/contributor
status, and whether a venue/beer save existed at assignment. Treatment exposure
is recorded only after that neutral assignment request completes and only when
the Saved panel is visible with a server-validated current revision. The admin
readout compares mature control and treatment intent-to-treat D7 return rates;
eligibility and exposure are diagnostics, and view/open events are excluded
from return. It is explicitly directional and limited to accounts currently
opted into optional analytics. Because the candidate is not deployed, it has no
production assignments or mature retention result and does not yet prove an
improvement.

Cheaper-price, new-verified-venue, and price-reconfirmed cards remain deferred.
Those historical before/after claims still require a private versioned baseline
and a corresponding backup/restore contract update. Do not hide that baseline
in exported metadata, and do not add push or email until the bounded in-app
experiment produces a trustworthy mature D7 result.

## Verification completed in this review

- TypeScript typecheck, JavaScript lint, source-format, build, isolated artifact
  startup smoke, security scan, and production/restore deployment-guard checks
  passed.
- Rendered artifact smoke passed six desktop routes and two mobile routes with
  no provider calls.
- The complete pinned-Node-22 `npm run check` passed: 233 test files and 4,273
  tests passed; 47 files and 126 tests were skipped by their configured
  environment gates. The security scan checked all 917 tracked/untracked files
  in the isolated candidate, and the dependency audit reported zero
  vulnerabilities.
- A disposable PostgreSQL 17.10 run passed eight native integration tests across
  the Saved Updates authority query and admin analytics, including alias/current
  authority supersession, bounded failure, JSONB assignment metadata, UTC D7
  maturity, opt-in filtering, and neutral return semantics.
- A separate disposable PostgreSQL 17 regression proved exact-ID combined
  manager/community confirmation authority, including alias and quarantined
  ingestion handling.
- Swift parse, API fixture decoding, both privacy/property-list checks, and an
  unsigned generic iOS Simulator Swift 6 build passed under Xcode 26.5. The
  focused iOS retention/launch suites passed 60/60. No physical-device Dynamic
  Type/UI automation was performed.
- A final local in-app browser reload proved the built map, legacy pricing route,
  logged-out account, venue portal, and admin shell expose no visible Pricing,
  Premium, Venue Pro, checkout, reward, counter/POS, public happy-hour, or
  specials surface. The legacy pricing route is `noindex` and Free-only; the
  Specials row computes to `display:none` when hidden.
- The current production smoke remains 9 pass, 1 fail, 3 skip. The failure is
  the PostgreSQL logical-backup attestation; user, venue, and admin journeys are
  skipped because their dedicated credentials are not configured.
- `release:evidence` validates its schema but remains honestly not ready: null
  release identity and 0 of 13 required gates complete.

## Required external release gates

Source: `docs/release-evidence.json` schema version 4.

| Gate ID | Owner | Status |
| --- | --- | --- |
| `production_public_smoke` | Release engineer and operations owner | pending |
| `production_role_smoke` | Release engineer, identity owner, and security verifier | pending |
| `account_deletion_completion_notice` | Privacy operations owner and release engineer | pending |
| `ocr_labelled_corpus` | OCR/data QA lead and independent label reviewer | pending |
| `venue_pilot_one` | Pilot lead and participating venue 1 owner | pending |
| `venue_pilot_two` | Pilot lead and participating venue 2 owner | pending |
| `venue_pilot_three` | Pilot lead and participating venue 3 owner | pending |
| `moderation_operations` | Moderation owner, backup operator, privacy owner, and independent verifier | pending |
| `backup_restore` | Operations/SRE lead, second operator, and incident owner | pending |
| `accessibility_devices` | Accessibility QA lead and release owner | pending |
| `legal_billing` | Company owner, Australian legal/privacy reviewer, and finance owner | pending |
| `ios_release` | Apple Account Holder, iOS release engineer, QA lead, and release owner | pending |
| `permanent_staging_cost` | Release owner, finance owner, and independent infrastructure verifier | pending |

No gate may be waived or converted to `not_applicable`. Do not populate the
release ID or candidate SHA until the candidate and its staging evidence are
genuinely ready to freeze.

## Current P0 and P1 risks

### P0 — launch blockers

- Production is 26 commits behind current `main` and
  still authoritative on SQLite, while the intended launch runtime is
  PostgreSQL.
- The current application is not deployed and proved on permanent staging.
- Permanent staging is failed/stopped with no active application deployment.
  The exact cold-recovery implementation is local-only, unmerged, and
  unexecuted, so it is not yet release authority or staging evidence.
- Production PostgreSQL is empty and detached; no production import or
  reconciliation exists.
- The exact production Supabase venue-directory project is missing the
  candidate-required `business_status` schema, and a provider-backed candidate
  venue query therefore fails closed with PostgreSQL `42703`.
- A complete, reversible recovery path has not been proved before cutover.
- The formal release pack is 0/13 with no frozen release identity.
- The Free-only launch contract and live public surfaces must be reconciled
  before any candidate freeze; stale public pricing, Premium, checkout, reward,
  report, POS/counter, or happy-hour discovery is a no-go condition.

No new repository-level P0 security exploit was identified in this review. The
P0 findings are deployment, data-integrity, recovery, and release-evidence
blockers.

### P1 — urgent pre-launch risks

- Production Postgres now advertises the exact policy-approved digest source.
  Railway still offers no patch-ID/ETag/CAS argument on the deploy-suppressed
  staged-commit operation, so every provider-writing ceremony must retain the
  operational writer freeze and exact before/after patch reconciliation.
- Production health, venue refresh, and PostgreSQL backup/restore schedules are
  non-operational and cannot currently deliver their alerts.
- Current-price coverage is effectively zero under the launch trust/freshness
  policy, undermining the search-to-return retention loop.
- Historical user-search success is not available until the candidate telemetry
  and admin rollup are deployed; the current 0% figure is a suburb readiness
  proxy only.
- One-tap `yes` is intentionally a durable feedback signal rather than a trust
  refresh. Product/operations owners still need a reviewed moderation policy
  for how many independent signals, and what evidence, can cause a future
  public reconfirmation.
- Saved Updates is implemented only for verification-after-save and
  became-stale cards. Production has no assignments or mature D7 comparison
  until the candidate is deployed; cheaper-price, new-venue, reconfirmation,
  persistent read state, and any push/email delivery remain deferred.
- The Saved Updates query is bounded and indexed but has no representative-scale
  permanent-staging `EXPLAIN ANALYZE` or load evidence; popular beer scopes can
  still scan and sort their matching history before the 101-row fail-closed
  limit is applied.
- Two-replica connection-budget, worker overlap, load/soak, and rollback evidence
  is missing.
- The safe Singapore PITR/HA sequence and independent WORM authority are
  unresolved.
- A fresh complete staging inventory has not proved prohibited production
  operational-copy variables absent.
- The staging Beer service-role variable is now sealed under committed Railway
  patch `fe5b65d2-24d4-4e7c-8672-944bd5df2418`; this specific prerequisite no
  longer blocks the protected atomic Supabase replacement. The replacement
  workflow itself remains unexecuted and must still prove its same-custody
  canary and exact post-write metadata.
- Staging PostgreSQL source drift is closed at the exact already-running digest.
  The provider applied the source-only update directly with no deployment; do
  not assume that API stages a patch for any future source operation.
- Any retained disposable restore environment and its current cost must be
  re-inventoried before staging closeout; the repository review did not treat a
  historical provider-cost estimate as current evidence.
- Recovery dispatch still requires the stranded candidate to remain the exact
  current protected-main head. A later merge can make that candidate
  undispatchable while a provider patch or partially completed transition is
  still stranded. Treat a temporary protected-main merge freeze from the first
  write through successful recovery/closeout as an explicit P1 operational
  prerequisite; there is no cross-candidate waiver.
- Railway's staged environment-patch API does not expose a patch ETag/version
  or provider lock that can be supplied to the deploy-suppressed commit/cancel
  calls. The workflow reasserts the exact patch and records its provider patch
  identity immediately around the call, but exclusion of out-of-band Railway
  mutations remains an operational freeze/attestation rather than a provider-
  enforced CAS. This residual TOCTOU is P1 and a launch NO-GO unless the
  external mutation freeze is actively controlled for the ceremony.
- The 24-hour recovery grace is a cleanup window, not additional deployment
  authority. If an ambiguous run is not converged and closed out inside that
  fixed window, the candidate remains P1-blocked and must not be represented as
  release evidence.

## Do not rush the candidate authority window

The protected provider/cutover guard permits candidate-bound operations only
within 168 hours of the associated PR merge. PR #57 merged at
`2026-08-27T23:45:47Z`, so the guard window associated with implementation merge
`01fc932…` ends at `2026-09-03T23:45:47Z`.

That time bound is not release evidence or permission to bypass the failed
staging baseline. Do not compress staging, provider, recovery, or review work to
use the window. No candidate is frozen, and current staging has not been
deployed. If this follow-up or any later merge makes `01fc932…` no
longer the current protected-main head, that SHA is ineligible for protected
candidate operations; use the new reviewed protected-main merge and its own
authority window. Once any candidate-bound write may have happened, however,
do not merge a replacement candidate until its exact state is reconciled and
closed: recovery cannot be transferred across candidate SHAs. The only age
exception is the fixed 24-hour read-only/same-mode recovery grace measured from
the selected original ambiguous run's completion.

## Exact next staging chain

The Free-scope and retention implementation is reviewed and merged, but the
permanent-staging application is failed/stopped. Continue only in this order:

1. **Completed 28 August:** a disposable running PostgreSQL service proved the
   exact immutable source can be staged, cancelled, retried, and committed with
   deploys skipped without changing its deployment, instance, or volume. After
   independent review, production patch
   `30db986b-4df9-4847-bce0-4cd1c3a3adc7` applied the exact digest-only source
   with the production deployment, instance, snapshot, and volume unchanged.
   Both disposable services and their staging-only volume were then deleted.
2. Independently review and merge `codex/launch-p0-p1-recovery`, then re-export
   the exact Beer staging topology, variable metadata without values, staged
   patch, Git-autodeploy state, and failed deployment identity. Verify the new
   protected-main SHA and all required checks; do not freeze the release register.
3. If the three forbidden OFFSITE rows remain, run their exact protected
   cleanup. Use its resume/cancel operation only when that candidate's fixed
   deletion patch is provably stranded. Then reconcile the four provider rows
   and execute the atomic Supabase replacement whose exact pair passes the
   same-custody canary. All changes must keep deploys skipped.
4. Select that successful replacement run and dispatch cold `prepare` against
   the policy-pinned `numReplicas:null` topology, then select the successful
   prepare run and dispatch cold `quiesce` to initialize explicit zero. Do not
   mix cold receipts with the separate healthy `1 -> 0` path. If the prepare
   acknowledgement is lost but exact prepared-null state is live, use only
   `reconcile-prepare`; if quiesce acknowledgement is lost at exact zero, use
   only `reconcile-quiesce`. Both paths are read-only and remain bound to the
   original ambiguous run and fixed 24-hour grace.
5. Dispatch `deploy-permanent-staging.yml` with phase `fenced`, bootstrap path
   `cold-dead`, and the exact cold prepare/quiesce run IDs. This is the first of
   exactly two allowed successful same-candidate staging deployments.
6. The staging Supabase venue-directory migration is already applied. Run the
   status refresh, validate its deferred constraints, and prove
   `business_status`, `last_checked_at`, `directory_eligible`, Auth isolation,
   and candidate map-query behavior. Do not apply the migration to production
   in this phase.
7. Dispatch the worker bootstrap `restore` operation to move the exact candidate
   from zero to one replica. Require `/health`, `/startup`, and `/ready` to bind
   the candidate with automatic maintenance still disabled. If the scale
   acknowledgement is lost but exact candidate-at-one is already proved, use
   only `reconcile-restore`; do not issue a second scale write.
8. Dispatch the staging worker-fence `activate` operation, then the phase
   `active` deployment for the same candidate. This is the second and final
   allowed successful staging deployment and the selected closeout artifact.
   If activation acknowledgement is lost but the candidate-bound enabled
   runtime is exact, use only `reconcile-activate`; do not upsert again.
9. Prove strict provider readiness, contributor and venue-Free flows, private
   Storage, Free-only surface absence, account deletion, current data quality,
   and every server/browser/mobile/scheduled consumer. Reconcile or disable
   legacy Supabase keys only through the mode-bound ceremony using the exact
   replacement, fenced-deployment, and active-closeout run IDs.
10. Run the PostgreSQL build canary, temporary two-replica overlapping-worker
    and connection-budget proof, expected/2x load, 60-minute soak, restart,
    rolling-deploy, and PostgreSQL-compatible rollback rehearsal; return
    permanent staging to one replica.
11. Prove provider-safe PITR, logical/private Storage backups, independent WORM
    retrieval, complete disposable recovery, deletion replay, recovered-app
    smoke, RPO/RTO, and exact teardown.
12. Only after every staging and recovery gate passes, freeze the candidate and
    release ID, schedule the controlled SQLite-to-PostgreSQL production import,
    and follow the protected production rollout. Do not perform an unsafe
    production migration.

## Primary repository evidence

- `docs/release-evidence.json`
- `docs/postgres-migration-execution-status.md`
- `docs/full-scale-postgres-migration-runbook.md`
- `docs/permanent-staging-app-deployment.md`
- `docs/permanent-staging-worker-bootstrap.md`
- `docs/production-launch-runbook.md`
- `.github/workflows/production-health.yml`
- `.github/workflows/venue-directory-refresh.yml`
- `.github/workflows/production-logical-backup.yml`
