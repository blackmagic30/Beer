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
| Production | `95b9f2da5e9a99692c8cfafba90d2c29e63ccbc8`; 24 commits behind the Free-launch implementation merge; still serving the legacy SQLite authority. The live `/health` and `/ready` responses reconfirmed that exact SHA on 28 August 2026. Railway currently shows the Beer service attached to its `/app/data` volume while the separate PostgreSQL service is merely online. |
| Repository at post-merge reassessment | Local and remote `main` were exact at `01fc932981aa191c5ab799d969cf018580c68984` before this status-only follow-up. PR #57 merged the reviewed Free-launch and retention tree on 28 August 2026; reviewed head `01116d749778ea35abec0bc596685845e58a1811` and merge commit `01fc932…` have the identical Git tree `e821aa8534e1ecabcd54743e1aca940e6aaf8827`. |
| Candidate status | The implementation is merged and suitable as the code basis for permanent-staging proof, but it is not deployed or frozen as a release candidate. The broader iOS visual redesign remains preserved separately at `codex/ios-redesign-retention-wip` commit `1723572` and is not part of the launch implementation. |
| Release register | `release.id`, `reviewedPrHeadSha`, and `candidateSha` are null. All 13 required items are pending: 0/13 complete. |
| Permanent staging application | The public Railway route currently returns `Application not found` for `/health`, `/startup`, and `/ready`. The Beer service has `numReplicas:null`, zero active deployments, and a failed/stopped latest deployment from source `12c0d24…`; its domain correctly targets the documented application port 8080. PostgreSQL, Redis, and Supabase are online, but no current candidate application is serving or proved there. |
| Production PostgreSQL | Provisioned and online, but empty, detached from the production Beer service, not imported, and serving no live traffic. |
| Production Supabase venue directory | The production project is behind the candidate's required directory migration: a read-only candidate query fails with PostgreSQL `42703` because `public.venues.business_status` is absent. The migration exists in Git but must first be applied and proved on the exact permanent-staging project; it must not be rushed into production. |

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

PR #57 has merged the bounded Free-launch and retention implementation into
`main`. It removes public Pricing navigation and stale commercial/Happy-Hour
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

## PostgreSQL staging, migration, and recovery gaps

The following remain unproved against the current candidate and are hard stops
before a production cutover:

- no current permanent-staging application deployment or strict
  `/health`/`/startup`/`/ready` receipt;
- the current failed/stopped staging topology cannot satisfy either the
  provider-mutation or worker-fence one-replica preflight, and no existing
  protected workflow can recover it;
- no current Auth, contributor, venue-Free manager, admin, private Storage, and
  Free-only core-journey evidence;
- the production Supabase venue-directory schema does not yet contain the
  candidate-required operational-status fields. Permanent staging must receive
  and prove the reviewed migration, complete status refresh, constraint
  validation, and candidate map query before any production schema change;
- the additive venue-directory constraints are still `NOT VALID`; a reviewed
  follow-up validation migration is required after staging refresh/data repair;
- no completed Google Maps, Google Places, OpenAI, Supabase replacement-key, or
  legacy-key denial receipts for the candidate;
- protected staging is missing the Supabase management read/write tokens needed
  for legacy-key disable and the user-A/user-B/admin/fixture inputs needed for
  the two-replica scale/load proof;
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
| `Production Health` | Public probes every 15 minutes; authenticated user/venue probes hourly at minute 7. | Latest scheduled run `32460610017` failed: the protected monitoring environment had no Supabase/smoke-account credentials, and the alert environment had no HTTPS monitor webhook. Keep disabled until dedicated verified smoke accounts, exact production Auth values, alert delivery, and external deadman monitoring pass a manual end-to-end run. |
| `Venue Directory Status Refresh` | Daily at `23 14 * * *` UTC. | Latest scheduled run `32383304448` failed the exact production Supabase target check. Keep disabled until the canonical production Supabase origin/key, directory-status schema, Google Places key, dry-run, complete refresh, freshness thresholds, and alert webhook are proved against the exact production target. |
| `Production PostgreSQL logical backup` | Daily at `15 14 * * *` UTC; monthly restore drill at `45 15 1 * *` UTC. | Latest scheduled run `32383029543` waited for the required ephemeral self-hosted `pintpath-production-backup` runner, was cancelled about 24 hours later, and its failure alert had no webhook. The protected backup environments currently lack the required runner-ready authority, database/CA/offsite/WORM inputs, and alert secret. Production is also still SQLite, so this PostgreSQL job must not be represented as protecting live production data. Enable only after the PostgreSQL cutover prerequisites, ephemeral runner, exact targets, operational copy, WORM roles, retrieval/restore drill, cleanup, and alert delivery are proven. |

Re-enable each workflow separately only after a successful manual proof. Do not
set an enable variable merely to make the workflow appear operational.

## Production data-quality baseline

The Free-scope public, read-only production audit was rerun from the merged
implementation at `2026-08-27T23:58:18Z` and reconfirmed:

- 612 venues;
- 288 price rows;
- 62 trusted price rows, all stale under the current freshness policy;
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

- Production is 24 commits behind the Free-launch implementation merge and
  still authoritative on SQLite, while the intended launch runtime is
  PostgreSQL.
- The current application is not deployed and proved on permanent staging.
- Permanent staging is failed/stopped with no active application deployment,
  and the protected chain has no reviewed recovery operation for that topology.
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
- Any retained disposable restore environment and its current cost must be
  re-inventoried before staging closeout; the repository review did not treat a
  historical provider-cost estimate as current evidence.

## Do not rush the candidate authority window

The protected provider/cutover guard permits candidate-bound operations only
within 168 hours of the associated PR merge. PR #57 merged at
`2026-08-27T23:45:47Z`, so the guard window associated with implementation merge
`01fc932…` ends at `2026-09-03T23:45:47Z`.

That time bound is not release evidence or permission to bypass the failed
staging baseline. Do not compress staging, provider, recovery, or review work to
use the window. No candidate is frozen, and current staging has not been
deployed. If this status-only follow-up or any later merge makes `01fc932…` no
longer the current protected-main head, that SHA is ineligible for protected
candidate operations; use the new reviewed protected-main merge and its own
authority window.

## Exact next staging chain

The Free-scope and retention implementation is reviewed and merged, but the
permanent-staging application is failed/stopped. Continue only in this order:

1. Have the Railway owner export the complete current Beer staging topology,
   failed-deployment logs, variable names/references without values, staged
   patches, autodeploy state, and last successful source/deployment identity.
   Review and approve a provider-supported cold-recovery plan, then restore and
   independently verify the exact healthy one-replica legacy baseline. The
   current failed/stopped service has no active deployment and cannot be safely
   recovered by an existing protected workflow; do not dispatch a mutation
   workflow before this baseline exists.
2. Verify the implementation merge's required checks, protected-environment
   inputs, empty Railway staged patches, disabled Git autodeploy, exact target
   identities, and rollback-build SHA. Do not freeze the release register yet.
3. While the legacy staging deployment is still the sole healthy one-replica
   deployment, execute the four exact create-only provider variable
   operations—Google Maps key and map ID, Google Places key, and OpenAI key.
   Start the separate atomic Supabase publishable/secret-key replacement here
   where possible. It may safely complete after worker preparation because row
   metadata cannot prove replacement, but it must complete before quiesce or
   candidate upload. Every operation must use the protected candidate-bound
   workflow with `skipDeploys=true`; require the deployment identity, topology,
   and runtime to remain unchanged. These are configuration writes only and
   must not roll out the candidate yet.
4. Dispatch `configure-automatic-maintenance-worker-fence.yml` for permanent
   staging in `prepare` mode, binding automatic maintenance disabled to the
   exact candidate.
5. Dispatch `bootstrap-permanent-staging-worker-fence.yml` in `quiesce` mode to
   prove the legacy staging deployment moves exactly from one replica to zero.
6. Dispatch `deploy-permanent-staging.yml` with phase `fenced` and the exact
   prepare/quiesce run IDs. This is the first of exactly two allowed successful
   same-candidate staging deployments.
7. Link only the exact permanent-staging Supabase project; dry-run and apply the
   reviewed venue-directory migration there, complete the status refresh, and
   prove `business_status`, `last_checked_at`, `directory_eligible`, and the
   named constraints before the candidate application is allowed to depend on
   them. Do not apply this migration to production in this phase.
8. Dispatch the worker bootstrap `restore` operation to move the exact candidate
   from zero to one replica. Require `/health`, `/startup`, and `/ready` to bind
   the candidate with automatic maintenance still disabled.
9. Dispatch the staging worker-fence `activate` operation for the same candidate.
10. Dispatch `deploy-permanent-staging.yml` with phase `active` and the exact
   activation run ID. This is the second and final allowed successful staging
   deployment and the selected closeout artifact.
11. Prove strict provider readiness, Auth and role isolation, contributor and
   venue-Free flows, private Storage, Free-only surface absence, account
   deletion, current data quality, and every server/browser/mobile/scheduled
   consumer. Then run the protected Supabase canary-B, legacy-disable, and
   old-key-denial ceremony using the exact replacement and closeout run IDs.
12. Run the PostgreSQL build canary, temporary two-replica overlapping-worker
    and connection-budget proof, expected/2x load, 60-minute soak, restart,
    rolling-deploy, and PostgreSQL-compatible rollback-build rehearsal; return
    permanent staging to one replica.
13. Prove provider-safe PITR, logical/private Storage backups, independent WORM
    retrieval, complete disposable recovery, deletion replay, recovered-app
    smoke, RPO/RTO, and exact teardown.
14. Only after every staging and recovery gate passes, freeze the candidate and
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
