# PostgreSQL rolling connection-budget transition

This repository now budgets the application pools for two steady Railway
replicas while one old and one new deployment generation overlap:

| Authority | Per process | Maximum processes | Shared LOGIN limit |
| --- | ---: | ---: | ---: |
| runtime LOGIN | 2 | 4 | 8 |
| `privacy_maintenance_login` | 1 work + 1 readiness | 4 | 8 |

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
The repository now contains bounded operations for the worker fence, protected
source uploads, the one-time maintenance-LOGIN limit change, and production
scale-out. They remain inactive until their exact GitHub environments, private
runner, scoped secrets, and candidate-bound prerequisite artifacts are
configured and approved. Autodeploy must remain disabled. Do not improvise an
`ALTER ROLE`, variable change, source upload, or scale operation in a provider
console or local shell merely because repository tests are green.

Closing public routing is not sufficient quiescence: existing processes retain
the startup state that enabled their schedulers. Permanent staging therefore
uses a zero-replica bootstrap ceremony before it deploys the fenced candidate.
Production may use its no-deploy fence only after an external, sanitized proof
shows that the old SQLite application is detached from the target Postgres and
cannot run a Postgres maintenance scheduler. The production fence receipt is
then carried through deployment, role-limit, activation, and scale artifacts;
none of those operations may be skipped or replaced with a point-in-time
`pg_stat_activity` observation.

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

Every run below is a new, original-attempt manual dispatch from the exact
candidate at protected `main`. Use the documented run IDs; never infer the
latest run and never retry an uncertain write.

1. In permanent staging, dispatch
   `configure-automatic-maintenance-worker-fence.yml` with `prepare`. It writes
   `false` plus the candidate SHA without deploying and explicitly makes no
   claim that the already-running legacy process is quiescent.
2. Dispatch `bootstrap-permanent-staging-worker-fence.yml` with `quiesce`. It
   consumes the exact prepare artifact and proves the old deployment changes
   from one replica to zero. Dispatch `deploy-permanent-staging.yml` with phase
   `fenced`; it consumes both artifacts and uploads the candidate while the
   service remains at zero replicas.
3. Dispatch the bootstrap workflow with `restore`. It consumes the prepare,
   quiesce, and fenced-deployment artifacts, changes the exact candidate from
   zero to one replica, and proves `/health`, `/startup`, and `/ready` report
   automatic maintenance disabled and candidate-bound. Then dispatch the
   worker workflow with `activate`, followed by the staging deployment workflow
   with phase `active`. Each consumer verifies the complete artifact chronology
   before it can receive a provider token.
4. Dispatch `permanent-staging-scale-evidence.yml` only after the active
   closeout artifact exists. Hold all 8 runtime plus all 8 maintenance slots
   across four process-shaped pool sets, run the expected/2x/60m profiles, and
   perform the controlled rolling replacement. Each accepted load report must
   cover the exact configured two `/ready` replica hashes under one unchanged
   deployment identity and show, for all three pool labels,
   `maxWaitingRequests=0`, `maxCapacityWaitEvents=0`,
   `maxCapacityWaitHighWater=0`, `maxCapacityWaitDurationMs=0`, plus a non-null
   retained `minAvailableConnections`. The workflow always converges staging
   back to one replica.
5. Before production, read-only verify the exact Railway deployment, one-replica
   bootstrap topology, rolling-overlap settings, direct database endpoint,
   runtime LOGIN limit 8, maintenance LOGIN limit 2, `max_connections`, every
   reserved setting, and current `pg_stat_activity` by application/login.
   Record only sanitized counts and identity hashes. Also obtain the external
   proof that the live SQLite source is detached from this Postgres target. If
   production already has two replicas, another generation is active, global
   headroom is below 16 sessions, or that old-runtime proof is absent, stop.
6. Dispatch the worker workflow with production `fence`. It writes automatic
   maintenance `false` plus the candidate SHA with `skipDeploys=true` and emits
   the exact fence artifact. `deploy-production.yml` must consume that run ID
   and independently verify the artifact before uploading the candidate at one
   replica. Wait for the old deployment to disappear and require green
   candidate-bound readiness with runtime maximum 2 and maintenance work and
   readiness maxima 1 while the maintenance LOGIN still has limit 2.
7. Dispatch
   `transition-production-postgres-maintenance-role-limit.yml` in `apply` mode
   with the exact fence and deployment run IDs. Its private runner verifies the
   LOGIN is exactly `privacy_maintenance_login`, `LOGIN`, `NOINHERIT`, a member
   only of the `NOLOGIN` `pintpath_maintenance` group, and currently limited to
   2. It persists a candidate/prerequisite-bound intent artifact before opening
   database credential custody, performs exactly one parameter-free `ALTER
   ROLE ... CONNECTION LIMIT 8`, and requires exact catalog postflight. If the
   outcome is interrupted or uncertain, run only its separately bound
   `reconcile` mode against the original intent artifact; never re-run `apply`.
8. Dispatch the worker workflow with production `activate`, supplying the exact
   successful role-limit run. It must verify fence→deploy→role chronology
   before enabling candidate-bound maintenance and proving all three runtime
   routes. Finally dispatch `production-converge-two-replicas.yml` with the
   exact activation run ID. That workflow verifies the activation artifact and
   unchanged candidate chronology before it can receive the scale token.
9. Re-prove readiness, exact catalog authority, session counts, pool counters,
   global headroom, same-candidate two-replica health, public and authenticated
   smoke, alerting, and rollback evidence. The rollout compatibility check may
   accept exactly limit 2 or 8 so the same reviewed candidate can bridge the
   one-time transition; the protected chain requires 8 before activation and
   scale. Tightening the compatibility branch later is a separate reviewed
   hardening change, not authority to bypass this sequence.

Any missing live capacity evidence, unexpected active session, non-current
candidate, provider drift, failed readiness, or absent protected role-mutation
authority is a no-go. A new candidate restarts the proof.
