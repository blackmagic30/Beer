# Railway application deployment attestation

Status: read-only implementation foundation. No Railway mutation is authorized.

This attestor joins the exact permanent-staging Beer deployment observed by
Railway to the process answering `/health`, `/startup`, and `/ready`. It exists
to replace operator-supplied deployment hashes in the reviewed-price planning
path. A locally generated fixture receipt is implementation evidence only; it
is not provider evidence and cannot remove a launch blocker.

## Fixed boundary

The checked-in policy pins:

- Railway project `48d8c6cd-1c66-4148-874b-20877f48e1a5`;
- permanent-staging environment `a4e0f507-d6d3-4df9-a818-ad92c0071a35`;
- forbidden production environment `13dab015-df74-45c6-b26f-69323daea99a`;
- Beer service `6816c4a2-e392-4ee5-826f-2584cb599ec0`;
- the Railway GraphQL endpoint used only through four fixed metadata queries;
- one replica, one provider-owned `*.up.railway.app` domain, and the three
  readiness routes; and
- a bounded observation window and receipt lifetime.

The runtime exposes domain-separated SHA-256 bindings for Railway project,
environment, service, deployment, and replica identity. It never exposes the
raw IDs. Project, environment, service, and deployment values must be canonical
lowercase UUIDs. Replica identity remains an opaque bounded Railway value; the
public surface contains only its digest.

## Preconditions

Do not run the command until all of these are true:

1. The document-wide Railway mutation stop has been closed independently.
2. The four staging provider-variable gates have been completed through a
   separately activated, reviewed one-operation writer.
3. The exact reviewed candidate has been deployed to the pinned Beer service
   through the protected, candidate-bound
   [source-upload executor](permanent-staging-app-deployment.md). A successful
   workflow receipt proves that upload ceremony; this independent attestor
   still must make a fresh read-only provider/runtime observation for its own
   consumers.
4. Railway shows no undecrypted staged patch for permanent staging.
5. A dedicated environment-scoped project token is present only in the fixed
   macOS login Keychain item at
   `/Users/zac/Library/Keychains/login.keychain-db`, with service
   `au.pintpath.railway.project-upload-token` and account
   `permanent-staging:48d8c6cd-1c66-4148-874b-20877f48e1a5:a4e0f507-d6d3-4df9-a818-ad92c0071a35`.
   Protect it as write-capable authority even though this command uses it only
   for fixed read-only queries. Do not read the item with `security -w` in a
   captured terminal.
6. The output is a new leaf inside a current-UID mode-0700 directory.
7. The reviewed operator boundary is the exact checkout
   `/Users/zac/Desktop/Beer`, operator/home `/Users/zac`, and Node.js
   `22.23.2` binary `/Users/zac/.nvm/versions/node/v22.23.2/bin/node`.

The command rejects generic Railway tokens, production metadata authority,
proxy/TLS override authority, a pre-existing output, a non-canonical target,
and an origin outside Railway's provider-owned application domain. Never put a
token in an environment variable, argv, a plaintext file, externally supplied
IPC, a terminal transcript, logs, or the receipt. The sole approved transfer is the
fixed bounded private stdout pipe from `/usr/bin/security -w` inside the locked
child; its captured byte buffer is wiped on every success and failure path. The
launcher does not inherit outer `PINTPATH_*TOKEN` or `RAILWAY_*TOKEN`
variables and starts the sensitive child with an exact
allowlisted environment. Query shape does not independently prove that Railway
has restricted the token itself to read-only permissions.

## Invocation

```bash
./scripts/run-locked-sensitive-worker.sh attestor \
  --candidate-sha <exact-40-character-git-sha> \
  --target-origin https://<provider-domain>.up.railway.app \
  --target-origin-sha256 <independently-reviewed-origin-sha256> \
  --output-receipt /absolute/private-directory/deployment-attestation.json
```

This executable invocation from the exact reviewed repository root is the only
authoritative operator ceremony. Its environment-clearing shebang runs before
the shell starts, and it launches only the pinned Node, primordial preload, TSX
loader, and worker by absolute reviewed paths. Before importing TSX, the
launcher requires the exact installed TSX package version and the reviewed
SHA-256 of the loader bytes; the in-process boundary independently repeats both
checks before it can activate. Do not invoke it through
`/bin/sh`, npm, `tsx`, the TypeScript source, or an inherited Node process. The
repository deliberately exposes no npm alias: a hostile `NODE_OPTIONS` can
execute inside npm before npm reaches the environment-clearing launcher.
Changing the operator, home, repository, Node version, TSX version, Keychain
path, service, or account requires a reviewed source and policy update.

The child statically evaluates both reviewed sensitive CLI graphs and the
exact `pg` graph before it seals capabilities; it performs no later dynamic
application import. In one synchronous stack, before the first event-loop
yield or secret read, it hides the CommonJS cache and extension loaders,
restricts pg's two lazy built-in loads to captured `net`/`tls` objects from the
exact pg parent modules, freezes the reachable pg credential graph, revokes
public filesystem/process-spawn/Worker/WASI/inspector/heap hooks, and replaces
Undici's global Agent with a pinned opaque dispatcher facade. The launcher also
uses `--disable-sigusr1`. These controls protect this exact reviewed worker
against post-lock Node callback and module mutation; they are not a general
same-UID or operating-system sandbox.

The policy path is fixed by the implementation. The command has no mutation,
deploy, variable-value, log, shell, or decrypted-configuration query. It reads
only the undecrypted staged patch before and after the runtime probes and does
not use the Railway CLI.

## Required observation

The command fails closed unless it can prove all of the following in one
bounded interval:

- the token is scoped to the exact project and staging environment;
- the staging patch is an empty object before and after the HTTP probes;
- the exact Beer service has one replica and exactly one attached target
  domain;
- the latest deployment is the sole active deployment, has status `SUCCESS`,
  is not stopped, and is bound directly to the expected project, environment,
  service, and candidate commit plus the stable provider-reported snapshot and
  image digest;
- `/health`, `/startup`, and `/ready` each return HTTP 200 with `no-store`
  deployment metadata for the same candidate and the same provider-observed
  project/environment/service/deployment hashes;
- no response indicates active restore-rehearsal state; ordinary readiness may
  report only the exact disabled primary-runtime restore status;
- the three statuses are respectively `ok`, `startup_ready`, and `ready`;
- exactly one replica digest is observed; and
- the canonical provider snapshot is byte-identical before and after.

The output is a new mode-0600 canonical receipt. It contains the public
candidate SHA, permanent-staging label, timestamps, fixed boolean checks, and
hashes only, with domain separation for resource identities. It must not
contain a token, raw Railway ID,
domain, origin, image digest, provider response, application dependency detail,
path, or raw failure.

## Consumption and freshness

The PostgreSQL reviewed-price planner accepts the canonical receipt plus its
independently retained file SHA-256. It rejects the former five free-form
deployment-hash arguments, a non-canonical or stale receipt, candidate or
environment drift, any false check, and any file outside its existing private
artifact authority. The five deployment hashes passed to the plan builder are
derived only from the receipt. Reviewed-price plan version 4 retains the exact
attestation-file and checked-in policy hashes, binds them into its explicitly
non-authorizing offline authority bundle, and emits a separate mode-0600
row-level private review packet. The bundle is required to say that provider,
cryptographic-approval, and mutation authority are absent; neither artifact
closes the provider-observed deployment blocker or authorizes a write.

This receipt is a point-in-time read-only observation. It does not lock a
deployment, authorize promotion, prove provider configuration, or authorize a
Railway write. Re-attest immediately before a future reviewed mutation. Keep
`provider_observed_deployment_authority` and every other activation blocker in
place until an authentic fresh receipt from the live pinned deployment is
independently reviewed and the later plan version explicitly closes only that
blocker.

## STOP conditions

Stop without retrying or mutating Railway on any identity, patch, deployment,
domain, commit, image, response, timing, file, or before/after mismatch. A
failure is evidence that the observation was not authoritative; it is not an
instruction to deploy, redeploy, commit/discard a patch, alter a domain, or
change variables. Resolve those actions only through their separately reviewed
one-operation executors.
