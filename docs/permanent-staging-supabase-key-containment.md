# Permanent-staging Supabase key containment

Status: legacy offline foundation retained; protected replacement and
replacement-canary/legacy-disable/old-key-denial transports are implemented but
have not been executed.

This slice adds a fail-closed contract for replacing exactly two Railway
variables with Supabase's new key formats:

- `SUPABASE_ANON_KEY` must be one `sb_publishable_…` value.
- `SUPABASE_SERVICE_ROLE_KEY` must be one `sb_secret_…` value.

Permanent staging must not contain `OFFSITE_BACKUP_SUPABASE_URL`,
`OFFSITE_BACKUP_SERVICE_ROLE_KEY`, or `OFFSITE_BACKUP_BUCKET`. Those variables
belong only to canonical production's mutable operational restore copy. A
future staging off-site proof requires its own separately registered destination
and a new reviewed contract; the production destination is never a substitute.

The prior checked-in/live policies coupled staging to that production copy.
Changing this candidate does not prove the Railway rows were deleted. A fresh
complete Railway inventory must report `checks.forbiddenVariablesAbsent=true`
and contain no row with any of the three names above, including a blank or sealed
row, before remediation can pass. No new staging off-site transport is
authorized.

This repository change does not itself read a credential, contact Railway or
Supabase, provision a resource, create a deployment, or spend money. The
existing permanent-staging recurring-cost estimate is unchanged.

## Current public Supabase contract

A read-only review of Supabase's public documentation on 12 August 2026
confirmed the assumptions used by this foundation:

- publishable and secret keys can coexist with legacy `anon` and
  `service_role` JWT keys while consumers are migrated one at a time;
- publishable and secret keys belong in the `apikey` header, while a distinct
  signed-in user's JWT belongs in `Authorization`; duplicating an opaque API
  key into `Authorization: Bearer ...` is not an authenticated-user proof and
  can be rejected as an invalid JWT;
- Supabase provides no automatic legacy-key usage inventory, so browser,
  mobile, CI, scheduled-job, webhook, and backup consumers must all be proved
  independently before legacy keys are disabled; and
- the Management API currently exposes
  `GET /v1/projects/{ref}/api-keys/legacy` and
  `PUT /v1/projects/{ref}/api-keys/legacy`, but documents both endpoints as
  subject to removal. A future HTTP 404 is therefore an unavailable control
  path, not evidence that legacy keys are disabled.

References: [Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys),
[Migrating to publishable and secret API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys),
and the [Management API reference](https://supabase.com/docs/reference/api/getting-started).
This documentation snapshot is evidence for the offline contract only; it
must be reviewed again immediately before any authorized provider action.

## Offline consumer compatibility gate

Run `npm run supabase:keys:consumer-compatibility:check` before any candidate
is allowed to use the replacement keys. The named, environment-independent
gate executes the pinned browser SDK against synthetic publishable and legacy
keys, proves the shared server wrapper's opaque-key header and redirect
behavior, pins canonical production browser Auth to
`https://auth.pintpath.au`, enforces
the permanent-staging hosted-key shapes, checks the iOS and Android Release
boundaries, exercises password-auth smoke without an API-key bearer, and keeps
an exact inventory of SDK factories, manual `apikey` transports, provider
endpoints, browser bundles, and dependency pins. The release workflow runs it
before any protected secret or authenticated smoke step.

This is a fail-closed reachability and compatibility tripwire, not live
provider evidence. It cannot prove that a syntactically valid key belongs to
the reviewed project, that every historical deployment or archived mobile
binary has stopped using a legacy key, or that Auth and Storage accept the
exact replacement values. Those facts still require the separately authorized
staging canary, consumer inventory, deployment identity, and live smoke
evidence before legacy disablement.

## Deprecated offline hard stop and protected successor

The earlier Railway replacement, canary-B, and Supabase legacy-key policies use
`HARD_DISABLED_REVIEW_REQUIRED`. They are retained only as adversarial fixture
kernels and are not canonical operator paths. Their fixed blocked CLIs must not
be invoked for a live operation.

The fixture kernel under `scripts/lib` exists only to exercise the state
machine with injected in-memory test doubles. It is not a live transport and is
not called by the CLI.

The protected successor is
`.github/workflows/permanent-staging-provider-mutation.yml`, governed by
`ops/railway/permanent-staging-variable-mutation-policy.json` and
`docs/protected-provider-mutation-operations.md`. It accepts both replacement
keys only from a protected GitHub Environment and sends them in one atomic
`variableCollectionUpsert` with `skipDeploys=true`. It permits one original
workflow attempt, never retries a write, runs unconditional metadata and
production-boundary postflight, and emits no value or value-derived digest.
The legacy local CLI and its fixture policy remain hard-disabled and deprecated.
The protected successor does not depend on the obsolete Railway canary service.
It requires only the two exact Beer application rows with no references; the
secret row must already be sealed. The later cutover executor performs the live
Auth/admin/Storage canary directly from its protected GitHub runner.

Even a successful replacement receipt is only
`acknowledged_pending_runtime_proof`. After deploying and proving every tracked
consumer, the protected successor for the remaining ceremony is
`.github/workflows/permanent-staging-supabase-legacy-cutover.yml`, governed by
`ops/supabase/protected-permanent-staging-supabase-cutover-policy.json`. It runs
replacement-key canary-B directly against the exact staging Auth/admin/Storage
endpoints. When Management reports legacy keys enabled, the retained old `anon`
key must return the pinned Auth-settings HTTP 200 shape using `apikey`, and the
retained old `service_role` key must return the pinned admin-list HTTP 200 shape
using the same key in both `apikey` and `Authorization: Bearer`. The executor
then issues one Management API PUT with no retry, unconditionally reconciles
with the separately held read token, reruns canary-B, and reuses those exact
old-key requests to require the exact HTTP 401
`{"message":"Invalid API key"}` response.

If Management already reports `enabled=false`, both retained old-key requests
must already return that exact 401 shape. The executor persists a distinct
candidate-bound reconciliation intent, performs a second complete read-only
Management/canary/old-key observation, records `attempts=0`, and succeeds only
without issuing a PUT. This operation is selected explicitly and accepts no
write-token argument or file; the workflow does not materialize the protected
write secret in its job step. Mixed states, a still-accepted old key, an enabled
project in reconciliation mode, or any ambiguous response stop without a write.
Neither key material nor key-derived commitments enter evidence.

## Locked replacement shape

The future replacement is constrained to one Railway project, the permanent
staging environment, and the Pint Path application service. Both values
must be present in one `variableCollectionUpsert` merge with `skipDeploys=true`.
The contract allows one attempt, forbids retries, and requires an external
mutation freeze. Before and after observations must prove:

- the exact two application-service literals exist with their expected seal
  state;
- the dedicated canary service has only the corresponding exact references;
- there is no environment-shared or foreign-service shadow for any key;
- there is no staged patch; and
- the complete deployment inventory is byte-for-byte unchanged.

Any partial set, extra key, wrong target, acknowledgement drift, staged patch,
deployment delta, transport error, or ambiguous response means stop with no
retry. A durable secret-free intent must precede the sole attempt. Terminal
evidence contains only fixed identities, policy metadata, booleans, and attempt
counts; it contains neither values nor value-derived commitments.

## Input custody

The input boundary accepts exactly two `Buffer` values in fixed name order.
It validates the formats without converting the values to JavaScript strings,
copies the inputs once, and immediately zeroizes the caller's buffers. The held
buffers can be published to one writer once. Resolve, rejection, cancellation,
close, invalid input, and second-use paths all close the handle and zeroize held
bytes.

Cancellation remains active after publication. The custody registers the
captured native `AbortSignal` listener before calling the writer. A later abort
immediately zeroizes the published buffers and deterministically rejects with
`key_input_unavailable`, even if the writer promise never settles. Resolve and
reject handlers stay attached to that writer promise, so a later rejection is
handled and cannot become an unhandled secret-bearing diagnostic. The fixture
state machine records a post-publication abort as one ambiguous attempt and
still forbids retry.

Security-critical parsing, evaluation, custody, cleanup, and fixture transport
construction use native intrinsics captured when the modules load. They do not
trust live `Array`, `Object`, `RegExp`, `Set`, `String`, `Buffer`, `Promise`,
`EventTarget`, `AbortSignal`, or `Reflect` prototype methods after import. Exact
own-data records and dense arrays are revalidated without invoking accessors or
ambient iterators. Adversarial tests poison the former `Array.prototype.every`
and `Object.values` bypasses plus the adjacent intrinsic surfaces and require
zero poison calls. Security-boundary array traversal and projection use
descriptor snapshots and a captured `Object.defineProperty` to build verified
dense results; they never call species-creating `map`, `filter`, `slice`,
`concat`, `flatMap`, `flat`, or `splice`. A post-import
`Array.prototype.constructor[Symbol.species]` proxy therefore cannot substitute
valid rows for an invalid inventory, and the exact regression requires zero
constructor/species/proxy trap calls.

This API is deliberately not wired to stdin, Keychain, environment variables,
or a provider client. A separately reviewed secret-custody worker would be
needed before any real activation.

## Canary-B gate

The hard-disabled fixture policy describes the former dedicated service
`34a312cd-0920-4a7e-90db-8561c1e0746b`, configuration
`/railway.supabase-key-canary.toml`, and start command
`node dist/scripts/staging-supabase-key-canary.js`. That service is absent and
must not be recreated. The fixture required restart policy `NEVER`, no public
domain, no TCP proxy, three exact references from the application service, and
only these read-only checks:

- staging Auth settings;
- staging Auth admin list with limit one;
- staging private Storage bucket metadata.

The canary receives no operational-offsite reference and cannot target the
production operational-copy project or bucket.

The older Railway-service canary policy still lacks immutable deployment/source
locks and remains fixture-only. The protected successor avoids claiming a
Railway deployment identity: it performs the same three read-only checks on a
protected runner with the exact candidate and project origin immediately before
and after legacy disablement. Candidate-bound application deployment evidence
remains a separate prerequisite.

## Legacy-key disable gate

The pure policy pins only the permanent-staging project ref
`bbfibbadwjxzrcdncavy`. The future management operation is modeled exactly as:

```text
PUT /v1/projects/{projectRef}/api-keys/legacy?enabled=false
```

The only accepted response body is `{"enabled":false}`. Pure before/after
fixtures require `enabled=true` before and `enabled=false` afterward for that
project. The successor does not need individual key IDs because the provider
operation disables both legacy JWT families project-wide. It validates the
retained inputs' `anon` and `service_role` roles before provider access. An
enabled-state transition requires both inputs to be accepted before intent and
denied afterward. An already-disabled reconciliation requires both inputs to be
denied in two read-only observations and proves zero Management write attempts.
The older ID-bound evaluator remains fixture-only.

Old-key denial is a separate read-only fixture classifier. It accepts no key
material and has no fetch implementation. Only an exact completed read-only
canary with an explicit gateway rejection and HTTP 401 is classified as
denied. A 2xx gateway acceptance is not denied. A 403, unknown 401, 5xx,
timeout, transport failure, or contradictory status/decision is ambiguous and
requires stop/no-retry. Denial evidence is ineligible until it binds to a
reviewed legacy key ID.

## Required operator work before the protected cutover

1. Re-review the then-current Supabase changelog, API-key migration guide, and
   Management API reference immediately before the operation. The 12 August
   2026 public-doc review above does not authorize a later provider call.
2. Review the protected replacement and cutover policies, workflows, and
   executors together and configure their non-bypassable GitHub Environments
   with a read token. Configure a separate write token only before selecting the
   enabled-state disable operation; the already-disabled reconciliation rejects
   write-token custody.
3. Prove a complete Railway preflight with no shared shadows or staged patch and
   establish the external mutation freeze. For the current recovery, require
   the fully policy-pinned detached dead/null service identity; do not treat a
   generic failed or zero-active service as equivalent. Complete these
   non-deploying remediations before cold prepare. If the three inherited
   `OFFSITE_BACKUP_*` Beer rows are present, first use the protected
   `remove-forbidden-offsite-backup-variables` operation. Its exact
   `merge=false` patch may contain only those three null deletions; its commit
   uses `skipDeploys=true` and must prove the rows absent with every collateral
   variable, deployment, topology, and production boundary unchanged.
   If that run ends after staging the exact patch but before commit, do not rerun
   cleanup or manually commit/discard the patch. Dispatch exactly one
   `resume-forbidden-offsite-backup-deletion-patch` or
   `cancel-forbidden-offsite-backup-deletion-patch` operation with the failed
   cleanup run ID. Reviewed GitHub history binds the candidate/run; a retained
   artifact is checked as additional evidence when available, while live
   metadata binds the fixed patch identity. If the commit already completed
   before runner loss, `resume` closes the exact rows-absent/empty-patch state
   read-only with zero mutation attempts. If live state proves the cleanup had
   no effect, `resume` may perform one exact stage and one exact commit, while
   `cancel` closes an already-empty patch read-only. An ambiguous recovery may
   be redispatched only in the same mode after re-proving exact state; switching
   between resume and cancel remains forbidden. The original cleanup must start
   inside merge plus 168 hours; recovery has one fixed 24-hour grace measured
   from that original cleanup's completion and retries never extend it. Keep
   the candidate as exact current protected `main` and freeze merges until the
   patch is converged and closeout completes. Railway exposes no usable patch
   ETag/version or lock for these deploy-suppressed calls, so the immediate
   patch-identity reassertion and external mutation freeze narrow but do not
   eliminate the out-of-band TOCTOU; this remains a P1/NO-GO trust assumption.
4. Seal the Beer application `SUPABASE_SERVICE_ROLE_KEY` row through the
   separately protected owner action. Then use only the protected replacement
   workflow and private mode-0600 file
   custody. Persist the intent and perform at most one all-or-nothing
   publishable/secret-key `skipDeploys=true` merge; stop without retry on any
   ambiguous outcome. Never pass keys in arguments, generic environment
   variables, logs, or artifacts.
5. After that exact atomic replacement completes, deploy the exact same
   current-`main` candidate through `Deploy Pint Path permanent staging` and
   retain its successful candidate-bound artifact. Prove every server, browser,
   mobile, CI, scheduled, webhook, backup, and archived consumer uses the
   replacement format, and complete the live Auth, admin, role, private-Storage,
   provider, and Free-scope checks.
6. Only then approve the protected legacy-cutover workflow. Supply
   the exact atomic-replacement, fenced zero-replica deployment, and active
   closeout run IDs. Before any provider-secret custody, its GitHub verifier
   requires the exact successful same-candidate attempt-one artifacts and
   receipts, authenticates the exact fenced and active run titles, requires the
   active closeout to be a zero-write `already_deployed` reconciliation, and
   proves replacement completion precedes fenced deployment, fenced completion
   precedes active closeout, and active completion precedes cutover. A single
   ambiguous fenced predecessor is accepted only when the selected fenced
   receipt proves the exact candidate was already present; no deployment run is
   accepted after the selected active closeout.
   Replacement, permanent-staging deployment, cutover, and every general
   permanent-staging runtime-variable write share one non-cancelling rollout
   concurrency group. The general workflow hard-fails either Supabase key so it
   cannot bypass the paired replacement path; exact-name artifact uniqueness
   rejects a second same-candidate replacement or deployment.
7. Run the direct replacement-key Auth/admin/Storage canary. If legacy keys are
   enabled, require the single disable write, postflight reconciliation, and
   both old-key 401 denial proofs. If they are already disabled, require two
   exact read-only disabled/canary/old-key-denial observations and a receipt
   proving `attempts=0`, no Management write, and no write credential received
   by the executor. If the one disable run ends ambiguously, the only permitted
   follow-up is the mode-bound read-only reconciliation; it can reconcile the
   disabled state but cannot issue a second write. Production and its operational-copy project require
   separate, production-scoped authorities.

Until every item is reviewed and evidenced, this work is a launch-safety
foundation, not permission to mutate a provider.

## Offline verification

Run with the reviewed Node 22 binary:

```sh
PATH=/Users/zac/.nvm/versions/node/v22.23.2/bin:$PATH \
  ./node_modules/.bin/vitest run \
  test/permanent-staging-supabase-key-input.test.ts \
  test/permanent-staging-supabase-key-replacement.test.ts \
  test/permanent-staging-supabase-key-canary-b.test.ts \
  test/permanent-staging-supabase-legacy-key-disable.test.ts \
  test/permanent-staging-supabase-old-key-denial.test.ts

PATH=/Users/zac/.nvm/versions/node/v22.23.2/bin:$PATH \
  ./node_modules/.bin/tsc --noEmit --project tsconfig.json --pretty false
```
