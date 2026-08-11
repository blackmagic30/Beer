# Permanent-staging Supabase key containment

Status: offline foundation only; live activation is hard-disabled.

This slice adds a fail-closed contract for replacing exactly three Railway
variables with Supabase's new key formats:

- `SUPABASE_ANON_KEY` must be one `sb_publishable_…` value.
- `SUPABASE_SERVICE_ROLE_KEY` must be one `sb_secret_…` value.
- `OFFSITE_BACKUP_SERVICE_ROLE_KEY` must be a different `sb_secret_…` value.

It does not read a credential, contact Railway or Supabase, provision a
resource, change a package command, create a deployment, or spend money. The
existing permanent-staging recurring-cost estimate is unchanged.

## Hard stop

The checked-in Railway replacement, canary-B, and Supabase legacy-key policies
all use `HARD_DISABLED_REVIEW_REQUIRED`. The only CLI in this slice emits one
fixed secret-free blocked receipt and exits non-zero. It has no provider
transport and does not read arguments, environment credentials, or stdin key
material.

The fixture kernel under `scripts/lib` exists only to exercise the state
machine with injected in-memory test doubles. It is not a live transport and is
not called by the CLI.

## Locked replacement shape

The future replacement is constrained to one Railway project, the permanent
staging environment, and the Pint Path application service. All three values
must be present in one `variableCollectionUpsert` merge with `skipDeploys=true`.
The contract allows one attempt, forbids retries, and requires an external
mutation freeze. Before and after observations must prove:

- the exact three application-service literals exist with their expected seal
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

The input boundary accepts exactly three `Buffer` values in fixed name order.
It validates the formats without converting the values to JavaScript strings,
requires the two secret keys to differ, copies the inputs once, and immediately
zeroizes the caller's buffers. The held buffers can be published to one writer
once. Resolve, rejection, cancellation, close, invalid input, and second-use
paths all close the handle and zeroize held bytes.

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

The policy reuses the existing dedicated service
`34a312cd-0920-4a7e-90db-8561c1e0746b`, configuration
`/railway.supabase-key-canary.toml`, and start command
`node dist/scripts/staging-supabase-key-canary.js`. It requires restart policy
`NEVER`, no public domain, no TCP proxy, six exact references from the
application service, and only these read-only checks:

- staging Auth settings;
- staging Auth admin list with limit one;
- staging private Storage bucket metadata; and
- offsite private Storage bucket metadata.

No deployment ID, reviewed Git commit, source hashes, Railway configuration
hash, or image digest was available offline. Those policy fields therefore
remain `null` and explicitly review-required. The evaluator cannot return
`passed` until exact reviewed values replace every null and the activation
state is separately reviewed.

## Legacy-key disable gate

The pure policy pins the permanent-staging project ref
`bbfibbadwjxzrcdncavy` and operational offsite-copy ref
`hfbmhdxrwtihukmixxta`. The future management operation is modeled exactly as:

```text
PUT /v1/projects/{projectRef}/api-keys/legacy?enabled=false
```

The only accepted response body is `{"enabled":false}`. Pure before/after
fixtures require `enabled=true` before and `enabled=false` afterward for both
projects. Actual non-secret legacy anon and service-role key IDs were not
available offline, so all four IDs remain `null` and review-required. The
evaluator is therefore unable to activate even when synthetic state fixtures
otherwise match.

Old-key denial is a separate read-only fixture classifier. It accepts no key
material and has no fetch implementation. Only an exact completed read-only
canary with an explicit gateway rejection and HTTP 401 is classified as
denied. A 2xx gateway acceptance is not denied. A 403, unknown 401, 5xx,
timeout, transport failure, or contradictory status/decision is ambiguous and
requires stop/no-retry. Denial evidence is ineligible until it binds to a
reviewed legacy key ID.

## Required work before any provider action

1. Review the then-current Supabase changelog and official API-key documentation.
   This online verification was intentionally not performed in this offline,
   zero-network slice.
2. Obtain provider inventory through the separately reviewed read-only path and
   review the exact legacy key IDs, canary deployment ID, Git commit, source and
   configuration hashes, and immutable image digest without exposing secrets.
3. Update each JSON policy, its in-code canonical lock, and its adversarial tests
   together; obtain independent review of the exact diff.
4. Prove a complete Railway preflight with no shared shadows or staged patch and
   establish the external mutation freeze.
5. Integrate the three-buffer custody with the separately reviewed locked
   secret worker and a bounded provider transport. Do not add a generic CLI,
   environment, npm, or direct-source secret path.
6. Persist the intent, perform at most one all-or-nothing skip-deploy merge, and
   stop without retry on any ambiguous outcome.
7. Prove the complete postflight, then deploy the exact no-ingress canary-B
   source and pass all four read-only checks.
8. Only after replacement-key proof, separately approve and execute both legacy
   disable calls, prove exact disabled state, and prove denial for every reviewed
   old key using read-only canaries.

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
