# Permanent-staging recurring-cost evidence

Status: **validator and candidate binder implemented; live provider observations
remain protected external evidence.** No provider account was read or changed
while this contract was added.

The authoritative policy is
`ops/railway/permanent-staging-cost-policy.json`:

- schema: `pintpath-permanent-staging-cost-policy/v2`;
- policy ID: `pintpath-permanent-staging-recurring-cost`;
- SHA-256: `57984ced59fa356baa9c19ac1e5018dad9c52829a6d7cc95a05cbd52112ddf86`;
- recurring ceiling: `5000` integer USD cents per month;
- maximum accepted observed bound: `4700` cents;
- required explicit headroom: `300` cents.

The checked-in planning calculation is not live evidence. The active validator
has deliberately been given no network, provider SDK, environment-variable,
or credential capability. It accepts only canonical files derived from
read-only exports captured by authorized provider owners. This prevents a
deployment workflow or repository fixture from inventing provider state.

## Bound topology

Every pre- and post-deployment observation must contain exactly these isolated
permanent-staging authorities:

| Provider row | Required maximum | Required isolation and bound |
| --- | ---: | --- |
| `railway` | 2000 cents | Dedicated staging workspace, exactly `beer`, `postgres`, and `redis`; no shared resource; agent usage disabled or independently zero-bounded |
| `staging-supabase` | 2500 cents | Dedicated staging organization, exactly one Micro project, spend cap enabled, no uncovered add-on or shared resource |
| `staging-external-providers` | 200 cents | Google at most 100, OpenAI at most 100, Resend zero; every surface hard-limited or zero-bounded |

Production operational-copy spend and disposable restore spend are never
folded into this total. Each observation must bind a separate authority hash
for both excluded scopes. This prevents a cheap temporary staging claim from
hiding production backup or restore costs.

## Source observations

Capture Railway, staging Supabase, Google, OpenAI, and Resend inventory,
plan/catalog, usage-cap, quota, add-on, isolation, and hard-limit exports using
read-only provider access outside the repository workflow. Preserve the raw
exports in the private finance/infrastructure register. Do not commit them,
paste them into Actions inputs, or put credentials in an observation.

Normalize the reviewed result to canonical pretty-printed JSON with one final
newline. Its exact field set is:

```text
schemaVersion = pintpath-permanent-staging-cost-observation/v1
releaseId = PP-LAUNCH-YYYY-ID from the protected release register
candidateSha = the verified full 40-character checkout SHA
phase = pre-deployment | post-deployment
environment = permanent-staging
scope = permanent-staging-only
currency = USD
amountUnit = integer-cents
lineItemRounding = ceiling
observationSource = provider-read-only-export
observedAt = canonical UTC timestamp with milliseconds
externalExportSetSha256 = SHA-256 of the separately retained raw export set
providers = exactly three provider rows
excludedScopes = exactly two separate-authority rows
```

Each provider row has exactly:

```text
provider
inventoryArtifactSha256
priceOrCapArtifactSha256
inventoryComplete
upperBoundComplete
scopeIsolationVerified
hardLimitOrZeroBoundVerified
unknownResourceCount
unpricedResourceCount
sharedResourceCount
unboundedResourceCount
upperBoundMonthlyCents
```

All four counts must be zero and all four booleans must be true. Amounts are
non-negative safe integer cents, rounded upward before summing. Credits and
negative offsets cannot reduce the bound.

Each excluded-scope row has exactly `scope`,
`includedInPermanentStagingTotal: false`, and
`separateAuthorityArtifactSha256`. The two exact scopes are
`production-operational-copy` and `disposable-restore`.

Capture the pre observation immediately before the candidate deployment and
the post observation after the deployed topology is reconciled. They must bind
the same release ID and candidate SHA, post must be later than pre, and both
must be no more than 24 hours old when bound.

## Independent approval manifest and binder

After the post observation, two different named people approve a private
canonical manifest with this exact field set:

```text
schemaVersion = pintpath-permanent-staging-cost-gate-manifest/v1
releaseId
candidateSha
environment = permanent-staging
gateId = permanent_staging_cost
preObservationSha256
postObservationSha256
approvedAt
approvedBy = Full name, role
independentlyVerifiedBy = Different full name, role
```

Keep both observations and the manifest as current-user-owned, single-link,
non-symlink mode-`600` files. Create a current-user-owned mode-`700` output
directory and leave the receipt path nonexistent. Bind the files with:

```bash
npm run --silent permanent-staging:cost:receipt:bind -- \
  --policy /absolute/repository/ops/railway/permanent-staging-cost-policy.json \
  --expected-policy-sha256 57984ced59fa356baa9c19ac1e5018dad9c52829a6d7cc95a05cbd52112ddf86 \
  --pre-observation /absolute/private/pre-observation.json \
  --expected-pre-observation-sha256 <reviewed-lowercase-sha256> \
  --post-observation /absolute/private/post-observation.json \
  --expected-post-observation-sha256 <reviewed-lowercase-sha256> \
  --private-manifest /absolute/private/approval-manifest.json \
  --expected-private-manifest-sha256 <reviewed-lowercase-sha256> \
  --expected-release-id <PP-LAUNCH-YYYY-ID> \
  --expected-candidate-sha <full-lowercase-commit-sha> \
  --output /absolute/private/evidence/cost-receipt.json
```

The binder verifies file identities, modes, exact supplied hashes, canonical
schemas, topology completeness, provider caps, order, freshness, candidate,
release, and independent approval. It creates one exclusive mode-`600`
`pintpath-permanent-staging-cost-receipt/v2` receipt. The receipt is sanitized:
it contains hashes, bounded amounts, timestamps, and provider status fields,
not provider IDs, resource names, raw exports, credentials, or approver names.

This is a single combined post-deployment release receipt binding both
observations. It is not a deployment authorization. Permanent-staging deploy
automation may verify the policy contract, but may not claim the cost gate
passed. Copy the sanitized receipt into the private release pack, hash it, and
place the receipt object on the `permanent_staging_cost` item only after the
private manifest digest is recorded as that item's `evidenceSha256`.

Any absent export, incomplete inventory/catalog, shared or unbounded resource,
unknown or unpriced item, provider-cap breach, total above `4700`, headroom
below `300`, stale observation, hash mismatch, candidate drift, or missing
independent approval is a release no-go.
