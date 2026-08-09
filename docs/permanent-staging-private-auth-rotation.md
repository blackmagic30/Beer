# Permanent-staging private authentication rotation

This runbook covers the credential-rotation proof for the pinned permanent-
staging PostgreSQL and Redis services. It does not authorize a production
change. The live gate remains **OPEN** until the exact reviewed staging build
runs this sequence over Railway private networking and the temporary probe
services are removed.

The probe is deliberately deployed as a separate client service. A command run
inside the database service can traverse a local `trust` HBA rule and cannot
prove password authentication. PostgreSQL acceptance here requires PostgreSQL
17 `psql` with `PGREQUIREAUTH=scram-sha-256`; rejection is accepted only from a
fresh structured PostgreSQL authentication error. Redis uses a bounded raw RESP
`AUTH` plus `PING` exchange so dependency debug logging cannot print an AUTH
argument.

The repository's Docker-exec PostgreSQL 17 test is only a synthetic CI
regression for these semantics. It does not close the live Railway private-
network gate described below.

## Safety boundary

- Keep the staging Beer service provider-stopped and verify it has no active
  deployment or running instance before every credential transition. Railway's
  regional configuration requires at least one desired replica, so do not
  attempt to encode zero there and do not restart, redeploy, or otherwise
  activate Beer during this ceremony. Freeze migrations, backups, restores,
  and scheduled jobs as well.
- Re-resolve the pinned Railway project, environment, Postgres, Redis, and
  temporary probe-service IDs before every mutation. Never target production.
- Require the staging environment to remain the exact persistent fork whose
  `sourceEnvironment.id` is the pinned production environment. Capture the
  production service/volume/domain tuples before creating anything; the
  staging-scoped service-creation exception is accepted only while that fork
  binding remains exact.
- Take a current staging recovery point first. Do not rewrite historical backup
  receipts: their credentialed URL hashes remain immutable historical facts.
- Create two short-lived, source-less client services in the existing staging
  environment. Give them no domain, TCP proxy, volume, public ingress, or API
  token; pin one reviewed commit, Node 22, PostgreSQL client 17, restart `NEVER`,
  one replica, small resource limits, and a 20-minute outer timeout.
- Build those services before adding credential references. Add only Railway
  reference expressions with deploys skipped, then redeploy the exact reviewed
  deployment with GraphQL `usePreviousImageTag: true`. Require the child image
  digest to equal the parent and require zero build-stage records. Ordinary
  Railway CLI redeploy omits this flag and performs a fresh same-source build,
  so it is not valid for this ceremony. Do not copy a resolved URL or password
  through a terminal.
- Select `/railway.auth-probe.toml` explicitly for both temporary instances.
  Railway config-in-code overrides dashboard settings; using the root
  `railway.toml` would run the application predeploy validator, app server,
  `/ready` healthcheck, and restart policy instead of the one-shot probe.
- Never use `railway environment config --json`, `railway run`, or a database-
  service SSH shell for this ceremony. Treat any resolved environment output as
  a new credential incident.
- Invoke the command with `npm run --silent`; its only allowed stdout is one
  JSON receipt line and it writes nothing to stderr on a classified result.

Build the reviewed commit before invoking the compiled command:

```bash
npm run build
npm run --silent staging:auth:probe -- verify-current --target all
```

The executable hard-locks the permanent-staging provider IDs, private hosts,
ports, database, admin login, predecessor runtime login, Redis login, and
resource IDs. Identity failure is a hard failure; there is no override flag.

## Probe environment contract

Each probe deployment receives the following fixed non-secret controls and
protected provider references. Do not materialize or log resolved credentials:

- `STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH`: exactly
  `/railway.auth-probe.toml`; the dispatcher rejects the root config fallback.
- `STAGING_AUTH_PROBE_MODE` and `STAGING_AUTH_PROBE_TARGET`: the exact reviewed
  dispatcher phase and target. Initial source upload uses `build-only`/`all`;
  later deployments use only the probe's fixed live-mode/target enums.
- `STAGING_AUTH_PROBE_EXPECTED_SERVICE_ID`: the exact temporary service's own
  Railway ID.
- `STAGING_AUTH_PROBE_POSTGRES_RESOURCE_ID` and
  `STAGING_AUTH_PROBE_REDIS_RESOURCE_ID`: the exact staging resource IDs already
  pinned by the executable.
- `STAGING_AUTH_PROBE_POSTGRES_ADMIN_URL`: a reference to the staging template
  admin URL.
- `STAGING_AUTH_PROBE_POSTGRES_RUNTIME_URL`: a reference to the predecessor or
  successor runtime URL appropriate to that deployment.
- `STAGING_AUTH_PROBE_REDIS_URL`: a reference to the staging Redis URL.
- `STAGING_AUTH_PROBE_RUNTIME_IDENTITY`: `predecessor` or `candidate`, required
  by `verify-current`; mutation modes derive their phase from the reviewed mode.
  Set it consistently for auditability, but it is not an independent mutation-
  mode input.
- `STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_LOGIN`: a fresh login matching the
  versioned runtime-login pattern.
- `STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_PASSWORD`: an independently generated
  URL-safe high-entropy password.
- `STAGING_AUTH_PROBE_RUNTIME_CANDIDATE_OWNER_SECRET`: a different URL-safe
  43-128 character high-entropy secret. It creates stable domain-separated
  owner and handoff attestations and must not equal any provider password.

Platform-provided `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
`RAILWAY_SERVICE_ID`, and `RAILWAY_DEPLOYMENT_ID` must all be present and exact.
Debug environment switches, inherited TLS bypasses, wrong provider resources,
shared provider passwords, or an unexpected username fail before network
mutation.

## Temporary-service build contract

Create A and B as source-less services scoped to the exact staging fork. Before
adding any credential reference, configure each instance with the dedicated
auth-probe config, Singapore one-replica placement, 0.1 vCPU/0.5 GB limits,
IPv6 internet egress disabled, zero overlap/draining, and `restartPolicyType`
`NEVER` with the parser-required `restartPolicyMaxRetries` value `1` (restarts
remain disabled by `NEVER`). Set only the reviewed non-secret build controls:
`RAILPACK_PACKAGES="node@22.23.2 postgres@17.10"`,
`RAILPACK_BUILD_APT_PACKAGES="... bison flex uuid-dev"`,
`RAILPACK_DEPLOY_APT_PACKAGES="... libicu72 libreadline8 libssl3 libuuid1 zlib1g"`,
the dedicated config path, dispatcher mode `build-only`, and target `all`.

Upload a pristine archive produced directly from the reviewed green commit.
The build-only dispatcher must emit one fixed receipt after verifying the exact
Node and PostgreSQL client major/minor, then exit without network access. Verify
that the built instances have no repository/image source, predeploy command,
healthcheck, domain, TCP proxy, volume, or secret variable and that production
inventory is byte-for-byte unchanged. Only then add the protected Railway
reference expressions and phase controls with deploys skipped. Every later
execution must redeploy an exact reviewed deployment ID with
`usePreviousImageTag: true`, retain the exact parent image digest and provenance,
and emit no build, export, or image-push records. Never use ordinary
`railway redeploy`, `railway up`, `--from-source`, an omitted or false
`usePreviousImageTag`, or an unreviewed worktree during the ceremony.

## Runtime-login rotation

Use client A to retain the predecessor runtime URL from before the cutover and
client B for the candidate.

1. On A, require `verify-current --target all` to pass. Preserve only its
   fixed-enum receipt.
2. On B, run `provision-runtime-candidate --target postgres-runtime`. The
   command serializes the whole lifecycle with a session advisory lock, creates
   or resumes only its cryptographically owned candidate, proves SCRAM and the
   complete restricted runtime contract, atomically records durable handoff,
   and proves authentication/readiness again after handoff.
3. While the provider runtime URL still names the predecessor, configure A to
   run `watch-old-rejection --target postgres-runtime` and redeploy A. Require
   the exact A deployment to be running, then allow it enough time to make its
   initial private-network authentication attempt before changing any runtime
   authority. Never redeploy A after the runtime reference changes: a redeploy
   would resolve the successor URL and destroy the predecessor proof.
4. With deploys skipped, update the Postgres runtime-password authority, the
   exact versioned runtime URL, the Beer reference, and the staging expected and
   named URL digests. Compute digests in process without printing the URL or
   digest. Provider resource IDs do not change.
5. Redeploy B so it resolves the successor reference. Run
   `verify-current --target postgres-runtime` with identity `candidate` and
   require accepted authentication plus full runtime readiness.
6. On B, run `retire-old-runtime --target postgres-runtime`. It requires the
   exact durable handoff under the same lifecycle lock, invalidates the fixed
   predecessor login before terminating its sessions, proves zero survivors,
   and re-proves the successor.
7. Require both B's retirement receipt and A's transition receipt to pass.
   A must prove that the same retained predecessor reference first authenticated
   and later received an exact authentication rejection; a client that only
   ever rejects cannot pass. Generate a fresh logical backup/recovery receipt
   under the new URL binding.

If candidate creation is incomplete, cleanup can touch only the exact owner
state. It can never clean a handed-off candidate or an unrelated pre-existing
role. After durable handoff, do not roll back to an incident-exposed password;
stop the app and rotate forward to another fresh successor if recovery is
needed.

## Template-admin and Redis rotation

These credentials use Railway's provider-managed regeneration controls. The
probe does not invent a database-template mutation API.

For each authority separately:

1. Deploy A with the old reference and start the matching
   `watch-old-rejection` target.
2. Obtain action-time operator confirmation, then use Railway Database Config
   **Regenerate password** for Postgres admin or Redis. Do not merely edit the
   stored variable: an existing database volume does not consume initialization
   variables again.
3. Redeploy B so it resolves the new provider reference. Run `verify-current`
   for that single target and require `outcome=passed`.
4. Require A to report an accepted-to-rejected transition. PostgreSQL must
   classify the old credential as an authentication rejection; Redis must
   classify it as `WRONGPASS`/`NOAUTH` rather than timeout or disconnect.
5. Recompute the exact staging URL digest, update its expected/named pins, and
   record the deferred production/restore forbidden-pin update. Do not mutate
   those environments during this staging ceremony.

On any inconclusive result, keep Beer stopped and rotate forward again. Never
restore an exposed credential.

## Evidence and cleanup

Accept only a single canonical JSON line with the expected deployment ID,
mode, target, `outcome=passed`, all relevant identity booleans true, and the
required authentication/transition/readiness/mutation classifications. The
receipt intentionally contains no URL, credential, hash, role verifier, Redis
frame, or provider response body.

In a guaranteed cleanup path, delete the two exact temporary staging services
and verify that they have no deployment, domain, TCP proxy, volume, or variable
rows. Stop every exact active deployment before deletion, return staging to
exactly Beer/Postgres-Staging/Redis with no staged changes, and compare the
production service/volume/domain tuples with the captured baseline. Remove
temporary local secret material and retain only protected, secret-free
receipts. Railway variable sealing is a separate irreversible ceremony after
every new value and URL pin is escrowed and proven; it is not part of this
rotation.
