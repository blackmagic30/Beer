# Permanent-staging load and soak runbook

This runbook is the executable evidence path for expected-peak, 2x-peak, and
at-least-60-minute soak testing. The runner is intentionally staging-only. It
cannot accept the production domain, a `*.pintpath.au` host, a host without a
`staging` label, a restore-marked environment, an unpinned commit, or an
unpinned Railway identity tuple.

The command sends real writes. Run it only against permanent integrated
staging after the PostgreSQL import, runtime readiness, shared Redis readiness,
logical-backup readiness, complete identity registry, and two application
replicas are green. Never use bootstrap/inert staging, production, preview, or
disposable restore-staging.

The protected end-to-end path is
`.github/workflows/permanent-staging-scale-evidence.yml`, governed by
`ops/railway/permanent-staging-scale-evidence-policy.json`. It verifies the
exact current `main` candidate at one replica, performs one non-retried scale to
two, runs 5-minute expected peak, 5-minute 2x peak, and the minimum 60-minute
soak, then unconditionally converges the same deployment to one replica. The
convergence operation is idempotent and remains available on a workflow rerun;
the scale-out operation does not. Do not cancel the workflow after scale-out.

## What the runner proves

The dependency-free Node runner uses a bounded, deterministic route mix:

- Free-scope public reads: `/health`, `/ready`, `/api/business/config`,
  `/api/business/venues`, `/api/business/price-records`, and
  `/api/business/access`;
- one safe admin read: `/api/admin/status` with a fresh staging-only admin
  session;
- a reviewed single-beer-price submission from disposable user A, sent
  concurrently with one `clientSubmissionId` to prove exactly one create and
  idempotent replays; and
- owner and cross-user reads proving exactly one durable row for user A and no
  visibility to disposable user B.

The write batch runs once before measured traffic and then at the configured
interval (five minutes by default). It stays below the application's write
rate limit. Rows contain the note `Never publish` and must remain moderation
test data until the disposable-user cleanup is complete.

Every route receives its own request counts, HTTP-class counts, contract
failures, and min/mean/p50/p95/p99/max latency. The JSON report fails unless:

- total HTTP 5xx is strictly below 1%;
- aggregate successful public-request p95 is strictly below 2,000 ms;
- aggregate successful admin-request p95 is strictly below 3,000 ms;
- unexpected HTTP statuses, network failures, timeouts, and response-contract
  failures are zero;
- duplicate, lost-write, and cross-user isolation failures are zero; and
- the requested minimum number of distinct, server-produced
  `deployment.replicaIdSha256` values participated.

`/health` and `/ready` replica probes request fresh connections so a
connection-pool stickiness artifact cannot masquerade as two-replica proof.
Every `/health` and `/ready` response must also return the exact
domain-separated project, environment, and service ID hashes derived from the
three reviewed Railway identity pins. The runner rejects a missing or different
hash before load begins and aborts if any hash changes during the profile. The
server returns only domain-separated SHA-256 markers; raw Railway resource IDs
and credentials never enter the report.

## Prepare reviewed identities

Use the exact candidate SHA and protected permanent-staging identity register.
All hashes below are lowercase SHA-256. Do not print database, Redis, session,
or provider credentials while preparing them.

Required target bindings:

```text
PINTPATH_STAGING_LOAD_BASE_URL
PINTPATH_STAGING_LOAD_EXPECTED_HOSTNAME
PINTPATH_STAGING_LOAD_EXPECTED_ORIGIN_SHA256
PINTPATH_STAGING_LOAD_PRODUCTION_ORIGIN_SHA256
PINTPATH_STAGING_LOAD_RESTORE_ORIGIN_SHA256
PINTPATH_STAGING_LOAD_EXPECTED_COMMIT_SHA
PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID
PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID
PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID
PINTPATH_STAGING_LOAD_EXPECTED_IDENTITY_SHA256
```

The three Railway resource IDs must use Railway's exact lowercase canonical
UUID spelling. Leading or trailing whitespace, uppercase letters, and other
noncanonical UUID spellings are invalid; the runner rejects them without
trimming or case-normalizing them.

The base URL must be a bare HTTPS origin whose exact hostname contains a
standalone `staging` label. Use the staging Railway domain, not a production
custom domain. The expected-origin hash must match it. The separately reviewed
production and restore origin hashes must both be present, distinct from one
another, and distinct from the target.

Compute the origin hash without credentials or a trailing slash:

```sh
printf '%s' 'https://beer-staging.up.railway.app' | shasum -a 256
```

The identity digest binds the exact protected Railway project, environment,
and service IDs with this algorithm:

```sh
PINTPATH_LOAD_PROJECT_ID='replace-with-reviewed-staging-project-id'
PINTPATH_LOAD_ENVIRONMENT_ID='replace-with-reviewed-staging-environment-id'
PINTPATH_LOAD_SERVICE_ID='replace-with-reviewed-staging-service-id'

PINTPATH_STAGING_LOAD_EXPECTED_IDENTITY_SHA256="$(
  PINTPATH_LOAD_PROJECT_ID="$PINTPATH_LOAD_PROJECT_ID" \
  PINTPATH_LOAD_ENVIRONMENT_ID="$PINTPATH_LOAD_ENVIRONMENT_ID" \
  PINTPATH_LOAD_SERVICE_ID="$PINTPATH_LOAD_SERVICE_ID" \
  node --input-type=module -e '
    import crypto from "node:crypto";
    const hash = crypto.createHash("sha256")
      .update("pintpath/permanent-staging-load-identity/v1\0", "utf8")
      .update(process.env.PINTPATH_LOAD_PROJECT_ID, "utf8")
      .update("\0", "utf8")
      .update(process.env.PINTPATH_LOAD_ENVIRONMENT_ID, "utf8")
      .update("\0", "utf8")
      .update(process.env.PINTPATH_LOAD_SERVICE_ID, "utf8")
      .digest("hex");
    process.stdout.write(hash);
  '
)"
```

Have a second operator compare the target origin, candidate SHA, all three
Railway IDs, and the three origin hashes to the protected identity register
before enabling mutation.

## Prepare disposable credentials and the pinned write fixture

Use two distinct staging-only ordinary-user accounts and one staging-only
admin account. Both ordinary accounts must have role `user` and be eligible to
submit. The admin token must be a fresh reviewed session. Tokens must remain
valid longer than the planned profile; any expiry or authorization failure
fails the run.

Create an owner-only temporary directory and three separate owner-only regular
files containing only the raw Pint Path bearer token, with no `Bearer` prefix:

```sh
PINTPATH_LOAD_PRIVATE_DIR="$(mktemp -d)"
chmod 700 "$PINTPATH_LOAD_PRIVATE_DIR"

export PINTPATH_STAGING_LOAD_USER_A_TOKEN_FILE="$PINTPATH_LOAD_PRIVATE_DIR/user-a.token"
export PINTPATH_STAGING_LOAD_USER_B_TOKEN_FILE="$PINTPATH_LOAD_PRIVATE_DIR/user-b.token"
export PINTPATH_STAGING_LOAD_ADMIN_TOKEN_FILE="$PINTPATH_LOAD_PRIVATE_DIR/admin.token"
export PINTPATH_STAGING_LOAD_WRITE_FIXTURE_FILE="$PINTPATH_LOAD_PRIVATE_DIR/write-fixture.json"
```

Populate the three token files from the approved secret channel, then set mode
`0600`. Do not put tokens on the command line, in the fixture, in shell tracing,
or in evidence. The runner rejects symlinks, non-owner files, group/world
permissions, empty/oversized files, repeated file paths, malformed tokens, and
identical credentials.

Save exactly this JSON shape as `write-fixture.json`, replacing only the
reviewed staging venue and measurement fields. `beerName` must remain one of
the three Free-scope tracked beers.

```json
{
  "schemaVersion": 1,
  "purpose": "permanent-staging-disposable-load",
  "reviewed": true,
  "venueId": "replace-with-reviewed-existing-staging-venue-id",
  "venueName": "Replace with reviewed staging venue",
  "suburb": "Carlton",
  "beerName": "Guinness",
  "servingSize": "pint",
  "price": 13.75,
  "isOnTap": "yes"
}
```

The venue must already exist in staging. Do not use a real user's venue, attach
private evidence, create a new venue, select a mission, or include happy-hour
data. Review the exact bytes, set mode `0600`, then pin them:

```sh
chmod 600 \
  "$PINTPATH_STAGING_LOAD_USER_A_TOKEN_FILE" \
  "$PINTPATH_STAGING_LOAD_USER_B_TOKEN_FILE" \
  "$PINTPATH_STAGING_LOAD_ADMIN_TOKEN_FILE" \
  "$PINTPATH_STAGING_LOAD_WRITE_FIXTURE_FILE"

export PINTPATH_STAGING_LOAD_WRITE_FIXTURE_SHA256="$(
  shasum -a 256 "$PINTPATH_STAGING_LOAD_WRITE_FIXTURE_FILE" | awk '{print $1}'
)"
```

## Configure the bounded profile

Set the reviewed expected peak, not the provider's theoretical maximum:

```sh
export PINTPATH_STAGING_LOAD_EXPECTED_RPS='2'
export PINTPATH_STAGING_LOAD_EXPECTED_CONCURRENCY='4'
export PINTPATH_STAGING_LOAD_EXPECTED_REPLICA_COUNT='2'
export PINTPATH_STAGING_LOAD_REQUEST_TIMEOUT_MS='10000'
export PINTPATH_STAGING_LOAD_WRITE_INTERVAL_SECONDS='300'
export PINTPATH_STAGING_LOAD_WRITE_CONCURRENCY='4'
```

Bounds are deliberately small for the Free launch:

- reviewed expected rate: 0.1-4 requests/second;
- reviewed expected concurrency: 2-8 and never below the configured write
  concurrency;
- 2x profile hard caps: 8 requests/second and concurrency 16;
- request timeout: 1,000-30,000 ms;
- write interval: 120-1,800 seconds; and
- idempotency batch concurrency: 2-6.

The `2x-peak` profile doubles only the reviewed expected rate and concurrency.
Expected-peak and 2x-peak durations must be 5-30 minutes. Soak duration must be
60-480 minutes.

After the second-operator check, enable the two explicit mutation gates:

```sh
export PINTPATH_STAGING_LOAD_MUTATION='confirmed'
export PINTPATH_STAGING_LOAD_DISPOSABLE_USERS='confirmed'
```

All `RESTORE_REHEARSAL_*` markers must be absent. The target `/health` and
`/ready` responses must report the exact candidate commit, `environment` equal
to `production`, no `restoreRehearsal` field, and a valid replica digest. The
Free configuration flags must remain disabled. Any mismatch stops before or
during sustained traffic.

## Run in order

Capture stdout directly into a protected evidence file. The runner emits one
JSON document and never emits credentials, account IDs, fixture contents, raw
Railway replica IDs, or the target origin.

```sh
npm run staging:load:soak -- \
  --profile=expected-peak \
  --duration-minutes=10 \
  > "$PINTPATH_LOAD_PRIVATE_DIR/expected-peak.json"

npm run staging:load:soak -- \
  --profile=2x-peak \
  --duration-minutes=10 \
  > "$PINTPATH_LOAD_PRIVATE_DIR/two-x-peak.json"

npm run staging:load:soak -- \
  --profile=soak \
  --duration-minutes=60 \
  > "$PINTPATH_LOAD_PRIVATE_DIR/soak-60m.json"
```

Do not proceed to the next profile after a nonzero exit. Investigate Postgres
pool waiting, failed queries and transactions, Redis health, Railway CPU/RAM,
lock waits/deadlocks, rate-limit responses, deploy/restart events, and provider
budgets. Fix the cause, freeze a new candidate if code changes, renew all pins,
and rerun from expected peak.

## Accept and retain evidence

For each report require `passed=true`, an empty `failureCodes` array, the exact
profile/duration/rate/concurrency/commit/target/identity/fixture hashes, at least
two replica hashes, completed mutation cycles, and zero duplicate/lost/isolation
failures. Confirm every expected route has samples and review per-route p95/p99
and error counts, not only the aggregate thresholds.

Correlate the report's UTC interval with sanitized Railway, Postgres, Redis,
Supabase Auth/Storage, and alerting evidence. Record pool headroom, lock waits,
deadlocks, queue growth, CPU/RAM, provider usage, replica/restart/deploy events,
reviewer, and frozen SHA in the launch evidence pack.

Finally revoke all three sessions, complete the approved disposable-user/data
cleanup, verify no `load-soak-*` submission can be published, and remove the
temporary credential files. Retain only the redacted JSON reports and reviewed
operational evidence in the protected evidence store.
