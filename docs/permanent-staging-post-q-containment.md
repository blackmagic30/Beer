# Permanent-staging post-Q containment

This one-use recovery path contains the Railway state created by failed cold
quiesce run `34229745722`. That run received an acknowledgement for deleting
the final configured region. Railway therefore applied its documented default:
one replica in the workspace's preferred `us-west2` region, followed by a new
deployment of the unchanged source.

Do not retry the cold-quiesce run and do not run its read-only reconciliation.
An all-zero `multiRegionConfig` is not a supported persistent Railway state:
`0` removes a region, while a service with no configured replica uses one
replica in the workspace's preferred region.

## Bounded containment

The protected workflow
`.github/workflows/stop-permanent-staging-post-q-deployment.yml` is the only
authority for this incident-specific stop. It has a metadata-only preparation
job and a separate writer job. The writer may call `deploymentStop` once for
deployment `6300a324-9407-4b1c-b651-749c47e9537f`; it cannot select another
deployment, environment, service, or project.

The first containment dispatch, run `34255228036`, stopped safely during
GitHub-authority verification before the intent was prepared or persisted. Its
apply job `102160681336` was completed as skipped with zero steps, so the
Railway writer never existed or started. The recovery bridge authenticates that
exact attempt, including its evaluated run name, complete job graph, and empty
artifact inventory. It also binds workflow ID `353312302` to the active static
workflow name and checked-in path. Recovery requires exactly two workflow dispatches: the
current run-number `2` at attempt `1`, plus only failed run `34255228036` at
attempt `1`. No other prior run or rerun is accepted. A started writer, an
indeterminate job inventory, or any artifact on the failed run consumes the
one-use authority.

The repaired reviewed candidate must be a one-parent squash whose direct parent
is the first containment merge `f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7`.
That bridge parent is independently bound to tree
`9978dca9491f7bf7bee77ce39debe1f713e89c53` and sole parent
`606d33facb515dd10bc94c360e43c20beb999cc1`, preserving the original failed-Q
lineage while keeping the repair candidate reviewable as a separate commit.

Before the write, the workflow must authenticate all of the following:

- exact current `main`, a clean checkout, run attempt `1`, and the external
  Railway-mutation freeze attestation;
- the failed Q workflow attempt, its sole writer step, acknowledged patch, and
  immutable five-file artifact;
- the post-Q `us-west2=1` topology, complete secret-safe environment config,
  unchanged source, snapshot and image digest, complete variable inventory,
  empty staged patch, and H14/P127 provider ledgers;
- exact staging scope for the write credential and a passing production/staging
  mutation-boundary proof.

The incident state hash uses the fixed
`pintpath-permanent-staging-post-q-state-projection/v1` field set captured from
the live baseline. Its exact pre-stop digest is
`c5301d50929dd463a45868b5e7c4db869eec9b95113f609b4631fc24ba629425`;
the sole permitted stopped transition has digest
`133afe93ed56697ea4ea621e5c07112833084c8994ac9073fce919dc89f5717b`.
Full environment config and the empty staged patch are bound by separate
hashes; adding fields to the normalized snapshot must not silently redefine the
incident state projection.
The sole writer computes the complete state digest, including the 97-row
secret-safe variable inventory, and the immutable inner terminal artifact binds
that digest. A successful inner artifact is promotable only when the fixed
sibling `stop-apply-terminal-completion.json` canonically binds its exact SHA-256
and byte length. This separate completion marker prevents a late filesystem
error after writing the inner bytes from being mistaken for completed evidence.
The outer credential-free finalizer does not reproduce those raw provider rows;
it revalidates the visible topology, source and deployment commitments, their
hashes, and exact before/terminal collateral equality.

After the one allowed write, the workflow performs bounded read-only polling.
Success requires three identical provider-terminal observations spanning at
least 20 seconds: the exact deployment is stopped with status `SUCCESS`, there
are no active deployments, and environment config, topology, source, variables,
staged patch, and the environment patch ledger are unchanged. The same bounded
window must also show cache-busted, explicit HTTP responses with non-2xx status
from `/health`, `/startup`, and `/ready`. A DNS, TLS, connect, timeout, redirect,
or body-read failure has no usable HTTP status and therefore cannot count as
route absence. Route absence is a required operational confirmation, but it can
never establish stopped state without the provider proof. An ambiguous
acknowledgement, a route that remains live through the observation budget, an
unreachable observer, or any drift is terminal and must not be retried. No
deployment-history event shape is assumed for `deploymentStop`: a single new
newest-prefix history row is preserved only as its digest, count, and position,
never as raw provider metadata, and leaves containment unverified until
separately authenticated.
Each observation records the unique probe-URL and response-body commitments,
but those deliberately varying hashes are excluded from the stable-state
comparison; only the required non-serving status for every route participates.
The convergence loop is capped at 28 rounds and 300 actual monotonic seconds.
It starts no round without the fixed 75-second worst-case read reserve and reads
at most two bounded pages from either provider ledger, so an in-flight read
cannot be hidden by clamping an over-budget duration.

The emitted `stop-intent.json`, inner terminal, optional inner success marker,
`stop-terminal.json`, and optional outer success marker are canonical,
secret-free evidence. A stopped result is promotable only when
`stop-terminal-completion.json` binds the exact outer terminal SHA-256 and byte
length, symmetrically protecting the final write from a late filesystem error.
That completed terminal pair is the prerequisite for the later, separately
reviewed `us-west2=1` to `asia-southeast1-eqsg3a=1` topology repair.
Do not change topology after this stop until that successor is merged and
authorized, because a topology change can deploy the old source again.

The workflow uses the existing `permanent-staging-scale-evidence` GitHub
environment. Its protection is automated: protected `main` is required, with
zero required reviewers and no wait timer. Boundary-read processes may hold the
environment-scoped production project token, which is mutation-capable despite
its `*_METADATA_TOKEN` name. That token is never present in the sole writer
process; the writer receives only the exact staging-scoped token. The boundary
and writer steps still share one reviewed job runner, so this is step-environment
isolation rather than whole-job isolation; that bounded residual is explicitly
accepted for this incident.
