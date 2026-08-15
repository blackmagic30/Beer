# PostgreSQL rolling connection-budget transition

This repository now budgets the application pools for two steady Railway
replicas while one old and one new deployment generation overlap:

| Authority | Per process | Maximum processes | Shared LOGIN limit |
| --- | ---: | ---: | ---: |
| `pintpath_runtime` | 2 | 4 | 8 |
| `pintpath_maintenance` | 1 work + 1 readiness | 4 | 8 |

The maximum application demand during that overlap is therefore 16 sessions.
This is not the PostgreSQL server-capacity requirement. Before deployment, a
read-only operator proof must show that

`max_connections - superuser_reserved_connections - reserved_connections - declared and observed non-app sessions >= 16`.

Migration, backup, monitoring, and operator sessions must be serialized outside
that 16-session share or receive their own measured headroom. Keep the direct
Railway private `:5432` session endpoint; this budget does not authorize a
transaction pooler.

## Current hard stop

Merging the transition code is not deployment or database-mutation authority.
The live maintenance LOGIN may still have `CONNECTION LIMIT 2`, and this
repository does not yet contain a protected DB-admin workflow that may change
that role to 8. Autodeploy must remain disabled. Do not improvise an `ALTER
ROLE` in a console or dispatch a production deployment merely because unit and
PG17 integration tests are green.

Closing public routing is not sufficient quiescence: existing processes keep
their startup/hourly maintenance schedulers, and those schedulers can reopen a
pool after a point-in-time `pg_stat_activity` check. This repository also lacks
a candidate-bound authority that stops every old scheduler/background run and
holds that fence through deployment overlap. The first transition deployment is
therefore blocked until that authority exists (or another independently proved
zero-downtime sequence removes the race).

The transition build deliberately uses a runtime pool of 2 plus separate
one-slot maintenance work and readiness pools, but accepts only an exact
maintenance LOGIN limit of 2 or 8. The dedicated readiness pool prevents a
legitimate long-running export, anonymisation, or retention transaction from
starving Railway's `/ready` probe. That compatibility is temporary. It
exists solely to permit the expand/contract sequence below; it is not a general
range or an operator override.

Every PostgreSQL `/ready` response now exposes only a fixed, credential-free
`dependencies.database.poolMetrics` array. Its labels are `runtime`,
`maintenance_work`, and `maintenance_readiness`; each entry contains only the
configured maximum plus the driver's total, idle, instantaneous waiting, and
monotonic capacity-wait event/high-water/duration counters.
`connectionCreationHeadroom` is `max - total`; `availableConnections` adds the
already-open idle connections and is the actual immediate checkout capacity.
Invalid or impossible counters fail the database probe instead of being coerced
to zero. These are per-process driver counters, not server-wide capacity
evidence, and they do not replace the required role-limit,
`pg_stat_activity`, reserved-slot, or non-application-session proof.

The permanent-staging load/soak runner validates the exact pool array on every
sampled `/ready` response across the observed replica hashes. Any missing or
extra label, wrong maximum, impossible count/headroom relation, or nonzero
waiter fails the run. Any monotonic capacity-wait event, high-water mark, or
duration also fails even after the live queue has drained. A bounded post-load
sweep must observe the exact frozen replica set under one unchanged deployment
identity before acceptance; a same-commit redeploy or replica replacement fails
the run because it resets process-local counters. The retained report contains
only fixed labels, maxima, sample counts, minimum available connections, and
deployment/replica identity hashes; no response body, URL, role, credential, or
row data is copied into the evidence.

## Required expand/contract sequence

1. From current protected `main`, read-only verify the exact Railway deployment,
   replica count, rolling-overlap settings, direct database endpoint, runtime
   LOGIN limit 8, maintenance LOGIN limit 2, `max_connections`, every reserved
   setting, and current `pg_stat_activity` by application/login. Record only
   sanitized counts and identity hashes.
2. If production already has two replicas, if another generation is active, or
   if the old pools cannot be quiesced below the slots needed for startup, stop.
   The existing workflow cannot safely scale 2 to 1, so a separately bounded
   transition authority is required. Do not rely on low observed traffic.
3. Through a protected, single-use transition authority, close public routing,
   stop every old scheduler and background worker, wait for every active lease
   and run to terminate, and hold that worker fence for the whole overlap. Then
   wait longer than the 30-second pool idle timeout and re-prove the old runtime
   and maintenance sessions are drained immediately before dispatch. The
   current repository cannot establish that fence, so stop here until it can.
   Once implemented, deploy the transition build at one replica only and fail
   closed unless continuous session evidence stays inside the legacy limits for
   the entire old/new overlap.
4. Wait for the old deployment to be fully removed. Verify the transition build
   is current, its runtime pool maximum is 2, and its maintenance work and
   readiness pool maxima are each 1. Require green readiness with the
   still-legacy maintenance limit 2 and exact labeled pool metrics; this
   point-in-time check is not the later load/soak time-series proof.
5. Add and use a separate protected DB-admin operation that can change exactly
   the bound maintenance LOGIN from limit 2 to limit 8 once, with preflight,
   durable intent, postflight catalog proof, cancellation reconciliation, and no
   other role/ACL mutation. No such operation exists yet, so this step is
   currently blocked.
6. Re-prove readiness, exact catalog authority, connection counts, and global
   server headroom at limit 8. Then merge and deploy a strict follow-up that
   removes `allowLegacyTwoConnectionLimitDuringRollout` and accepts only 8.
7. Only after the strict build is current may the protected scale workflow
   converge to two replicas. In permanent staging, hold all 8 runtime plus all 8
   maintenance slots across four process-shaped pool sets, run the expected/2x/60m
   profiles, and perform a controlled rolling replacement. Each accepted load
   report must cover the exact configured two `/ready` replica hashes under one
   unchanged deployment identity and show, for all three pool labels,
   `maxWaitingRequests=0`, `maxCapacityWaitEvents=0`,
   `maxCapacityWaitHighWater=0`, `maxCapacityWaitDurationMs=0`, plus a non-null
   retained `minAvailableConnections`; reject any role-limit failure, dropped
   work, readiness loss, or incomplete post-load replica sweep.

Any missing live capacity evidence, unexpected active session, non-current
candidate, provider drift, failed readiness, or absent protected role-mutation
authority is a no-go. A new candidate restarts the proof.
