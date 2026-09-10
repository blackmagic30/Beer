# Bar pilot test evidence

Recorded on **2026-09-10** for `codex/bar-pilot-ready`. This document records
completed, scoped validation of the first-bar pilot. It does not certify a
consumer/commercial launch, legal approval, or an unexecuted hosted walkthrough.
The candidate status and remaining actions belong in
[bar-pilot-ready.md](bar-pilot-ready.md).

The backend implementation was committed as
`ea2b4bb6f5c6f5bdc10e6520ecb50ee5c6557ea7`; the account-history/fixture work was
committed as `7236f5f`. The runs below used Node **22.23.2** and actual local
PostgreSQL **17.10** where PostgreSQL is identified. Counts are separate test
runs, with overlapping coverage; they must not be added into a unique-test total.

## Completed application tests

| Run | Result | Evidence |
| --- | --- | --- |
| Canonical Pint Points repository and real HTTP loop | **13 passed**, 1 file | [pint-point.repository.integration.test.ts](../test/pint-point.repository.integration.test.ts); `/tmp/pilot-repo-tests.log` |
| Focused business, release and route security regression | **287 passed**, 3 files | [business-demo.test.ts](../test/business-demo.test.ts), [pintpath-release-readiness.test.ts](../test/pintpath-release-readiness.test.ts), [business-routes-hardening.test.ts](../test/business-routes-hardening.test.ts); `/tmp/pilot-focused-final.log` |
| Existing venue unit/service baseline | **332 passed**, 11 files | `/tmp/pintpath-bar-pilot-venue-unit.log` |
| Existing venue PostgreSQL integration baseline | **24 passed**, 10 files | `/tmp/pintpath-bar-pilot-venue-pg.log` |
| Account-history PostgreSQL regression and repository tests | **17 passed**, 2 files | [community-submission.repository.integration.test.ts](../test/community-submission.repository.integration.test.ts), [community-submission.repository.test.ts](../test/community-submission.repository.test.ts); `/tmp/pintpath-pilot-account-pg.log` |
| Restricted pilot fixture preparation/reset | **11 passed**, 1 file | [pilot-demo.test.ts](../test/pilot-demo.test.ts); `/tmp/pintpath-pilot-fixture-test.log` |

The venue baseline covered existing manager isolation, profile/hours/inventory
mutations, stale/concurrent writes, moderation, publication, and migration/import
reconciliation. Working venue repositories were reused.

The account-history repair addresses PostgreSQL's ambiguous optional filter
parameters: explicit text casts allow an empty customer's history to load. The
regression exercises empty history and optional filters against PostgreSQL,
not merely a mocked response.

Fixture tests prove destination restrictions, a read-only preflight, repeatable
setup/reset without deleting the ledger, explicit customer allowlisting, and
rejection of a different account set taking over the fixture.

## Pint Points: 13 PostgreSQL and HTTP checks

The test creates a disposable database from the existing
[canonical schema](../src/db/postgres-schema.sql), uses a login without superuser
or `BYPASSRLS`, and verifies the normal runtime role. The service fixture uses
[the real service and repositories](../test/helpers/pilot-postgres-runtime.ts)
with the legacy SQLite repository unavailable.

1. The runtime is restricted, the ledger has enforced RLS, and runtime
   `TRUNCATE` is denied. Browser/Data API grant denial is additionally covered
   by the Supabase tests below.
2. One purchased alcoholic beverage creates exactly one drink point, consumes
   its customer pass, and creates no contribution-ledger value.
3. Eight simultaneous identical purchase submissions return the same recorded
   transaction; one ledger award exists. A changed payload conflicts.
4. Two customers submitting the same venue receipt produce one successful
   award and a understandable conflict for the other request.
5. Invalid quantities, expired passes, revoked customer sessions, and reused
   passes cannot produce a new purchase award.
6. Nonalcoholic purchases earn zero; supplying an arbitrary requested points
   value does not alter the server-calculated award.
7. Other-venue operators are denied. Staff cannot prepare a test balance, and
   revoked staff access is rechecked when the transaction mutates data.
8. A customer below 50 cannot create a reward. Successful redemption consumes
   exactly 50, releases its reservation, creates one redemption record and no
   drink award, and rejects another use.
9. Eight concurrent redemption requests alternating two staff identities have
   exactly one success, one debit, and a nonnegative final balance.
10. Wrong customer, wrong venue, expired reward, and unavailable reserved value
    cannot redeem successfully.
11. Eight concurrent reward-code creations cannot reserve the same 50 points
    more than once.
12. Concurrent corrections append exactly one reversal, retain the original
    award/history, release an affected reward reservation, and leave the
    expected effective balance.
13. Real Express HTTP requests complete the ordinary free customer's pilot
    purchase/reward loop with commercial, paid enrollment, legacy rewards and
    alcohol-gamification flags disabled. The HTTP test verifies an enrolled
    venue, non-enrolled denial, a 1-point award, an identical retry reporting
    **0 additional points**, restricted manager demo preparation, a 50-to-0
    redemption, replay rejection, manager history access and staff history
    denial. Arbitrary client balance fields do not grant value. Counter
    responses contain wallet summaries and do not expose another venue's
    private ledger metadata. The legacy discount endpoint remains disabled.

The required PostgreSQL job in [.github/workflows/ci.yml](../.github/workflows/ci.yml)
sets `PINTPATH_PILOT_POSTGRES_TEST_ADMIN_URL` and runs this suite, so its PostgreSQL
checks are not silently skipped in that job. To reproduce locally, supply that
variable with an explicitly authorized disposable loopback PostgreSQL 17 admin
URL, then run:

```sh
npx vitest run test/pint-point.repository.integration.test.ts --maxWorkers=1
```

## Supabase migration and pgTAP gate

The complete sequence in
[supabase-database-testing.md](supabase-database-testing.md) was executed with
Supabase CLI **2.109.1** and local Docker. It used a fresh temporary workdir,
project ID `pintpath-bar-pilot-gate`, and separate `555xx` ports. All **36**
repository migration files were copied with identical SHA-256 bytes. No original
checkout service or hosted Supabase database was reset.

| Gate | Result |
| --- | --- |
| Local database startup and full migration reset | Passed |
| Venue-directory drift reproduction, bootstrap/constraint migration applied twice, schema verification and legacy-row preservation | Passed |
| Storage-policy drift reproduction and revocation migration applied twice | Passed |
| Storage posture verifier | Passed |
| Schema lint: `public,private,pintpath_app,pintpath_ops`, fail on warning | **0 issues** |
| Security advisor, fail on warning | **0 issues** |
| Performance advisor, fail on error | **0 errors**; warnings described below |
| pgTAP | **68 passed**, **5 files**; `Result: PASS` |

The pgTAP files validate repository schema, browser/Data API privileges, RLS
policies, canonical PostgreSQL runtime protections, and the external venue
directory. Reconciliation tests exercise the actual forward migrations and
repeat them; they are not only source-text assertions.

The performance advisor reported **297 warnings**, all
`multiple_permissive_policies`, across 61 existing tables. They concern overlap
between established runtime/migrator/logical-backup policies. The warning-only
result passes the documented gate; these existing performance refinements are
deferred outside this pilot. No schema or policy rewrite was introduced.

Exact local run records:

- `/tmp/pintpath-bar-pilot-supabase-results.json`
- `/tmp/pintpath-bar-pilot-supabase-pgtap.log`
- `/tmp/pintpath-bar-pilot-supabase-lint.log`
- `/tmp/pintpath-bar-pilot-supabase-security-advisor.log`
- `/tmp/pintpath-bar-pilot-supabase-performance-advisor.log`
- Matching `reset`, `venue-directory-drift`, `storage-policy-drift`,
  `storage-reconcile-first`, `storage-reconcile-second`, and `storage-posture`
  logs under the same `/tmp/pintpath-bar-pilot-supabase-` prefix.

The temporary stack was stopped using its explicit project ID with
`--no-backup`. Subsequent checks found no containers, associated data volumes,
or listener on port 55522. Temporary logs are machine-local session evidence;
this committed document preserves their sanitized results and reproduction
references.

## Hosted evidence boundary

The actual staging Supabase project
[`bbfibbadwjxzrcdncavy`](https://supabase.com/dashboard/project/bbfibbadwjxzrcdncavy)
was inspected through the authorized CLI Management API using read-only
aggregate queries. The project reported `ACTIVE_HEALTHY` in `ap-southeast-2`.
At that observation:

| Staging Auth aggregate | Count |
| --- | --- |
| Users | **0** |
| Identities | **0** |
| Google identities | **0** |
| Sessions | **0** |

There were no existing provider accounts or sessions to reuse for the pilot.
No API keys were retrieved, no user emails/passwords/tokens were printed, no
hosted writes were made, and the temporary local project association was
removed. The intended hosted Google sign-in ceremony was preserved.

**Hosted connected acceptance was not run in these recorded checks.** Local
PostgreSQL HTTP tests and local Supabase pgTAP do not prove hosted deployment,
Google OAuth, customer sessions, or the full hosted browser/iPhone journey.
Once the staging candidate is available, four distinct controlled accounts
must complete its normal Google sign-in and age/policy flow before the
restricted administrator/manager/staff/customer fixture can be prepared. The
current candidate handoff must record any later hosted execution separately.

## Hosted configuration attempts

The merged product candidate `e1073602985d8008eeded54f2462d100fda380cd`
passed its eight exact-main checks and three required artifact checks before
the protected staging workflow was dispatched.

- [Run 34429415518](https://github.com/blackmagic30/Beer/actions/runs/34429415518)
  acknowledged disabled maintenance and its candidate binding. The maintenance
  URL write lost its acknowledgement, so the workflow stopped before upload.
  Read-only reconciliation found the single scoped variable with the intended
  canonical URL shape and input length. Exact equality with the protected
  secret was not claimed, and the uncertain receipt was preserved.
- A new bounded declared-state operation,
  [run 34429818347](https://github.com/blackmagic30/Beer/actions/runs/34429818347),
  acknowledged the maintenance URL, matching CA material and disabled demo
  setting. After adding the demo flag, the environment had **101 variables**:
  one page of 100 with `hasNextPage: true`, followed by one terminal row. The
  existing verifier rejected that incomplete first page, so upload was again
  skipped. Both postflight failure flags came from an unavailable parsed
  snapshot; they were not proof of a deployment change.

Read-only provider reconciliation confirmed the retained staging deployment
`6300a324-9407-4b1c-b651-749c47e9537f` remained stopped with its single US-West
replica configuration. Production deployment
`a171afac-9104-41ca-b0c2-d50bfc47824a` remained running with its single Singapore
replica configuration. Both staged patches remained empty. No source upload,
retained-source restart, topology change or production mutation occurred in
these attempts.

The scoped follow-up reads bounded metadata pages and requires a consistent
deployment and empty staged patch across every page before using a snapshot.
Its regression covers the observed 101-variable boundary. A later deployment
still needs its own successful workflow and runtime evidence; these attempts
do not establish hosted public or authenticated acceptance.

### Successful configuration and source identity compatibility

[PR #107](https://github.com/blackmagic30/Beer/pull/107) merged as
`befe7fbe7c9339ee45353d34428c6d9f9d9ec80f`. Its exact-main
[CI run 34431841160](https://github.com/blackmagic30/Beer/actions/runs/34431841160)
passed **5,136 tests** in 274 files, with 154 gated skips, the separate **13
PostgreSQL pilot checks**, **68 pgTAP checks**, and the compiled artifact's
six desktop/two mobile routes. All eight release checks, three required
artifacts and the three-language CodeQL run passed for that exact main SHA.
The variable verifier's **29 tests** include 20 pagination cases.

[Protected run 34432814153](https://github.com/blackmagic30/Beer/actions/runs/34432814153)
successfully configured the eight declared values, keeping maintenance and
pilot/demo access disabled. The source deployment stopped before upload with
`writeAttempts: 0`. Read-only diagnosis using actual provider responses found:

- The retained deployment's opaque metadata has valid commit/image identifiers
  but omits the optional `patchId` member. The historical shared snapshot parser
  requires it to be explicitly present.
- Discovery, the empty staged patch, configured US-West single-replica topology,
  and complete collateral inventory (**103 variables**, two volumes, three
  services) pass their existing contracts.
- Pinned Railway CLI **5.32.0** uploads an archive and deployment message; it
  does not submit Git commit metadata and excludes `.git`. Railway documents
  Git variables as GitHub-deployment metadata. Staging has no connected Git
  repository, and automatic Git deployment remains disabled.

These are deployment compatibility failures, not evidence of a hosted product
pass. The pilot-only follow-up uses explicit immutable archive provenance;
it must not manufacture reserved Git variables or provider commit metadata.
The historical production executor, shared Git attestor and original release
policy retain their existing contracts. A later source upload and runtime
walkthrough still require their own successful receipts.

Primary transport evidence: [pinned CLI upload implementation](https://github.com/railwayapp/cli/blob/5a8c5065b5cb929d7a1cadf7e168c2eed9453999/src/controllers/upload.rs),
[Railway variable reference](https://docs.railway.com/variables/reference).

The scoped source identity fix passed **24 executor tests** and **63 runtime,
packaging, metadata and maintenance tests**. These cover the observed missing
metadata, per-upload nonce binding, lost acknowledgement without a write retry,
wrong deployment/candidate/intent, stale image/snapshot, malformed or replaced
manifest, exact staging scope, preserved genuine Git metadata, disabled workers,
actual health-route output and repeatable compiled-artifact verification.
Build, typecheck, JavaScript lint and source formatting passed. Logs:
`/tmp/pintpath-source-attestation-executor-tests.log`,
`/tmp/pintpath-source-archive-runtime-tests.log`, and
`/tmp/pintpath-bar-pilot-source-lint.log`. These remain local tests; the next
protected upload and hosted smoke must supply their own evidence.

At **2026-09-10 03:52:59 UTC**, the new pilot snapshot parser and existing
discovery, empty-patch, topology and paginated collateral parsers also passed
against actual read-only Railway responses. The retained staging deployment
was still stopped at its expected ID with US-West ×1; the inventory contained
103 variables, two volumes and three services with no Git autodeploy.
Production's running deployment, snapshot, source, active rows and Singapore ×1
topology were unchanged from the saved baseline. No executor invocation,
simulated GitHub authority, source upload or provider mutation was used for
this compatibility check.

The source-attestation follow-up's full `npm run check` passed: **276 files,
5,204 tests**, with 48 gated files and 142 gated tests skipped. Typecheck,
JavaScript lint, formatting, production build, isolated artifact smoke,
secret scan (**1,096 files**) and deployment guard checks all passed. Evidence:
`/tmp/pintpath-bar-pilot-source-check.log`. Dedicated PostgreSQL/pgTAP evidence
above remains separate from environment-gated skips; exact remote candidate
checks and a hosted upload are still required before promotion.

## Exact failed-startup recovery (2026-09-10)

Protected run `34437975279` configured all eight declared staging settings and
uploaded the exact merged candidate `1d17eaf937f1c3561f0a42a0e4e3d2d7f356999a`
once. The build passed, but deployment `8b8bfe67-9829-4223-960f-2900d1c08c39`
failed at the database connection identity guard before application health could
pass. Its receipt records one acknowledged write and an uncertain reconciliation;
that original receipt remains unchanged. No hosted acceptance is inferred.

A separate read-only reconciliation bound the failed deployment's actual Railway
`cliMessage` and snapshot to the original source-upload intent. It confirmed the
old retained app was still stopped, staging remained at one `us-west2` replica,
no patch or Git autodeploy was present, and production plus staging collateral
were unchanged. Railway omitted the image digest for this terminal failed
deployment; the pilot parser now represents that absence explicitly. Successful
deployment still requires an immutable image and matching runtime archive
identity on all three health routes.

The database reference named the retired predecessor login. The existing
versioned successor passed PostgreSQL 17 SCRAM authentication and verified TLS
over the approved private endpoint with the configured CA. The read-only proof
confirmed the intended database, restricted login, exact non-admin runtime
membership, no database CREATE/TEMP privileges, forced RLS and runtime read
access. The predecessor remains retired. No role, password, grant or application
data change is needed for the connection-reference correction.

The recovery workflow accepts only this exact stopped failed predecessor and
a separately reviewed, immutable successful database identity correction
receipt. It retains current-main checks, one new source upload, no automatic
retry, unchanged topology/collateral, and all runtime acceptance requirements.
The original production executor and release policy remain byte-identical.

The live configuration correction subsequently passed: **one source-template
write and one atomic paired-pin write**, both with deployments skipped. A
provider read failed between those operations, before the pin intent or write;
the original partial-operation receipt was preserved. The separately reviewed
pin-only operation bound that receipt, performed fresh authentication and
boundary checks, and completed the previously unattempted update. No source
write was repeated. The combined terminal reports `updated`, all checks true,
zero database mutations and zero production mutations. It also verifies that
the retired predecessor remains disabled and the existing successor retains
its exact restricted permissions. The secret-free receipts are retained under
`ops/railway/evidence/bar-pilot-startup-db-*`; the recovery code pins the final
receipt's exact bytes. This configuration proof is not a hosted application
acceptance result.

Final local recovery validation: **104/104 focused tests passed** across the
failed-startup receipt, pilot executor/configuration and protected variable
contracts. Typecheck, JavaScript lint, source formatting and diff whitespace
checks passed. The production build verified all **12 required artifacts**;
the isolated artifact runtime smoke and production/restore deployment guards
passed. The secret scan checked **1,102 files** with no findings. Logs use
`/tmp/pintpath-bar-pilot-failed-recovery-{tests,lint}.log` and
`/tmp/pintpath-bar-pilot-startup-recovery-{build,artifact-smoke,scan,deploy-guard}.log`.
Required GitHub checks and actual hosted runtime acceptance are recorded
separately; these local results do not replace them.

## Hosted runtime recovery and public smoke (2026-09-10)

Merged candidate `cfd8a534336623fdb8e7a9bcc3a22e1b3bff774b` passed all eight
required main checks and three required artifact digests. Main CI `34443225030`
passed **5,221 tests**, with 154 gated skips; dedicated PostgreSQL Pint Points
passed **13/13**, Supabase passed **68**, and artifact browser checks passed
**six desktop and two mobile routes**. The secret scan checked **1,102 files**;
dependency audit reported zero vulnerabilities. CodeQL workflow `34443225024`
and its three uploaded language analyses succeeded. The optional aggregate
check was absent on this push, not counted as a pass or invented as a new gate.

Protected deployment [34444953562](https://github.com/blackmagic30/Beer/actions/runs/34444953562)
completed all eight configuration settings and **one acknowledged source
upload**. The receipt outcome is `deployed`; all deployment checks passed.
The intent hash, archive identity, exact staging scope, disabled maintenance,
and `/health`, `/startup`, `/ready` responses matched. Production and staging
collateral were unchanged, with staging still one `us-west2` replica.

The actual public browser smoke then found two scoped failures rather than
declaring the site ready from health alone:

- `/api/business/price-records` returned a safe generic HTTP 500. A `limit=1`
  probe succeeded in 13.85 seconds; the unseeded demo-venue query returned an
  empty HTTP 200 in 1.47 seconds. Normal price batches enqueue many identity
  lookups against the intentionally bounded two-connection runtime pool.
- When the map was active, the mobile venue rail started closed and its
  `Visible now` opener remained hidden. The existing map-fallback path had
  opened the rail automatically, so earlier fallback tests did not cover this
  condition. The minimal visibility/tap-target fix passed **eight focused
  tests** and **nine rendered 390×844 checks**, with no overflow or exceptions.

The failed report is preserved at
`/tmp/pintpath-bar-pilot-hosted-evidence-0hfmmX/public-smoke.json`. The private
read-only harness now permits only the observed Google Maps `GetViewportInfo`
POST read request; application writes remain blocked. It also keeps PASS status
separate from HTTP status. No forced click or skipped list assertion conceals
the mobile failure. The follow-up candidate must pass its own hosted smoke;
Google sign-in and authenticated hosted acceptance remain owner prerequisites.

The price-feed regression reproduced the queued identity failure, then the
same failure in per-submission evidence reads after identity batching. The
scoped correction batches both reads while keeping the two-connection budget,
alias depth/cycle validation, publication rules, evidence privacy and cursors.
The complete service regression uses **400 PostgreSQL price rows**, two-hop
aliases, mixed evidence presence, two anonymous pages and delayed queries.
Both responses passed with **eight queries per page**; the test enforces a
bounded total rather than per-row fanout. The related ten-file price, identity,
evidence, business-service and fixture boundary passed **308/308 tests**.
The final two-case feed regression completed both delayed-query pages in
**402 ms total**, with 16 queries against a limit of 20. The shared test-pool
change also passed the dedicated **13/13 Pint Points PostgreSQL tests**.
Typecheck, configured lint and source formatting passed. Evidence uses
`/tmp/pintpath-price-batch-{related,final,pintpoints,lint}.log`; the task-owned
PostgreSQL instance was stopped after these checks.

Healthy candidate replacement passed **82 focused rollout tests** and **106
related policy tests**. It requires the exact current deployment and previous
candidate, proves previous-source ancestry and all three existing runtime
routes, then retains the immediate snapshot check, one upload and all new
runtime checks. Actual temporary-Git regressions reject divergent or missing
history, tag-object substitution and reverse ancestry. Historical production
executor and release-policy bytes remain unchanged.

Follow-up packaging passed all **12 required artifacts**, the isolated
`/health`/`/startup`/viewer artifact smoke, production/restore deployment
guards, source formatting, and the **1,106-file** secret scan. The guard was
rerun after the build completed because its first local invocation overlapped
artifact creation; that ordering failure was not an application regression.
Logs use `/tmp/pintpath-bar-pilot-hosted-fix-*.log`. These checks still do not
substitute for the follow-up's new protected deployment and public smoke.

PR #110 passed its required checks and merged as
`64677e28d1b8740634a2d9c684fa69a57757e333`. Its first main CI run,
`34448952280`, was **not a pass**: all 13 Pint Points assertions passed, but
Vitest reported an unhandled PostgreSQL `57P01` connection termination during
test-database teardown. The dependent build/test job correctly stopped, and
the new feed test was not reached in that run. The staging replacement was
not dispatched. A focused test-lifecycle correction must preserve the
assertions and complete fresh required checks before deployment; rerunning
until a green result is not evidence that cleanup is correct.

The cleanup correction waits for every connected test client's public `end`
event after `pool.end()`, checks that the fixture database has zero remaining
connections, and uses an ordinary database drop. It does not swallow database
errors, change production pools, or update dependencies. The related five-file
run passed **31/31 tests**: points 13, price feed 2, fixture setup/reset 11,
browser destination 3, and deterministic delayed-close/error-propagation 2.
No unhandled errors occurred. Lint, typecheck and formatting passed. Starting
the real PostgreSQL browser fixture and sending SIGTERM also exited 0,
removed its database without force, and removed its temporary credentials
file. The task-owned PostgreSQL instance was stopped afterwards. Evidence:
`/tmp/pintpath-pg-pool-cleanup-related.log`,
`/tmp/pintpath-pg-pool-cleanup-lint.log`, and
`/tmp/pintpath-pg-cleanup-browser-result.json`. Fresh PR/main checks and the
hosted replacement remain required; these local results do not imply either.
