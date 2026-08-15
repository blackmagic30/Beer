# Production Postgres immutable source pin

Status: **blocked; do not dispatch**.

The checked-in `DO NOT DISPATCH - blocked production Postgres source pin`
workflow is a fail-closed implementation boundary, not a dry run. Dispatch is
single-use for the candidate: a failed or skipped write run is not reusable.
Do not dispatch it until a new exact merged/current-`main` candidate activates both
of the independent authorities below. Keep the
`production-postgres-source-pin` GitHub Environment for scoped secrets, but do
not configure a required human reviewer: the exact automated authority gates
replace PR and environment approval for this solo-owner operation.

## Why it is blocked

The source currently uses the mutable
`ghcr.io/railwayapp-templates/postgres-ssl:17.10` tag. The only intended write
would set the same observed image digest and atomically set image auto-updates
to `disabled`. Railway's published CLI schema proves the patch shape, but does
not prove that Railway accepts and preserves `tag@sha256`, reports the new
deployment image/digest/patch identity exactly, or leaves all collateral
unchanged. The policy therefore keeps provider compatibility
`UNPROVEN_BLOCKED`.

Cancellation durability is independently blocked. An Actions artifact created
inside the mutation job is not proof that prewrite intent survived force-cancel
or runner loss. Local held-descriptor files and their later upload are diagnostic
evidence only; they are not the immutable intent or activation authority.

## Required work before activation

1. On a disposable, no-data Railway Postgres service, prove the exact
   `environmentPatchCommit` contract for `tag@sha256` plus
   `source.autoUpdates.type=disabled`. Capture exact pre/post configuration,
   deployment ID, snapshot ID, image digest, patch ID, and complete collateral
   inventory in a reviewed compatibility authority. Never test this first on
   production. Replace the checked-in placeholder compatibility parser with an
   exact-key, canonical, self-hashed, provenance-bound verifier for that
   authority; changing only policy booleans or a file hash is forbidden.
2. Implement immutable off-runner prewrite intent as a compare-and-swap state
   reference. A separate job with no provider-mutation credential must persist
   the full canonical preflight inventory, deployment set, recovery authority,
   database-identity observation, candidate, policy, and exact patch before the
   one write can begin.
3. Implement a cancellation-independent read-only reconciler triggered by
   `workflow_run`, with scheduled and manual recovery entry points. It may hold
   only Railway metadata and read-only database authority; it must never receive
   the mutation token and must never retry the write. It must reconcile the CAS
   intent to a terminal exact-success or mutation-uncertain receipt after job
   cancellation or host loss.
4. Hash the verified compatibility and durability authority files, update the
   policy states to their exact active values, and set their
   `productionMutationAllowed` flags to `true` in the same reviewed candidate.
   Do not activate one authority without the other.
5. Configure the protected environment with the three distinct Railway tokens,
   the production backup database URL, root CA PEM, their independently pinned
   hashes, and the existing ephemeral backup-runner policy. Retain a required
   environment with no required reviewers. Neither PR human approval nor
   environment human approval is required by the current v5 merged-candidate
   authority.
6. Capture a fresh same-candidate logical backup, operational copy, WORM
   receipt, retrieval, and exact disposable restore drill. Use its original
   run ID when dispatching the newly activated workflow.
7. Declare and enforce an operator freeze on every production/staging Railway
   console and workflow writer for the execution window. The executor performs
   a second byte-exact full provider inventory and database-identity probe, then
   rechecks live `main` immediately before the non-CAS write, but Railway does
   not expose an accepted config version on `environmentPatchCommit`; the
   residual read/write race must remain an explicit activation risk until a
   provider CAS contract is proven.

## Required future activated execution contract

The secret-free prepare job authenticates the exact merged current-main
candidate, rejects any prior dispatch, checks all active authorities, and
materializes one canonical recovery authority. Its producer-emitted file hash
is passed independently with the uploaded artifact ID and artifact digest.

A future activated implementation must make the protected private-runner job
eligible for environment-scoped credentials only after those checks. It must
reassert live `main` before any protected secret, use the volatile `recovery`
tmpfs work root, run two fresh read-only database identity probes, persist
durable off-runner intent, perform at most one exact provider mutation with no
retry, and reconcile a different healthy deployment with the same database
identity. Any missing proof, ambiguity, collateral change, cleanup failure, or
cancellation must remain blocked or `mutation_uncertain`; it must never
authorize another write.
