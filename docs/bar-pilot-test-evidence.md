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
