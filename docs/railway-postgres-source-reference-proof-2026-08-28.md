# Railway PostgreSQL immutable source-reference proof

Date: 2026-08-28 (Australia/Melbourne)

## Scope

This proof used only the permanent `staging` Railway environment, which is a
provider-confirmed fork of `production`. The test services were disposable,
held no application data, exposed no public domain, and had no production
service instance.

The first target reference retained the mutable tag while pinning the exact
image already resolved by the running production PostgreSQL deployment:

`ghcr.io/railwayapp-templates/postgres-ssl:17@sha256:6008e0827c45d3fa6e6eba2140a8932598fe10cea7f0fafafc4af9ab1715e8ad`

The final proof used the repository policy's exact digest-only source:

`ghcr.io/railwayapp-templates/postgres-ssl@sha256:6008e0827c45d3fa6e6eba2140a8932598fe10cea7f0fafafc4af9ab1715e8ad`

## Provider identities

- project: `48d8c6cd-1c66-4148-874b-20877f48e1a5`
- staging environment: `a4e0f507-d6d3-4df9-a818-ad92c0071a35`
- production environment: `13dab015-df74-45c6-b26f-69323daea99a`
- running disposable PostgreSQL service: `c39fe48f-fdf9-4473-b4fe-3737eacccc8e`
- syntax-only disposable service: `107676a4-fe3f-4461-b85d-0bd6583fec00`

Before the source-reference test, the running disposable PostgreSQL service
had:

- source `ghcr.io/railwayapp-templates/postgres-ssl:18`
- deployment `7c323c7c-649c-44cf-b9a8-dffb1f098219`, created at
  `2026-08-28T04:57:14.456Z`
- running instance `a472ca22-1447-4cf9-ad60-8182de120cd6`
- ready volume `808d863f-a03a-4118-be37-a50ea0872026`

## Cancellation, retry, and deploy-suppressed commit

1. `environmentStageChanges(merge:false)` accepted an exact source-only patch
   using the `tag@sha256` reference. Railway assigned staged patch
   `1f8f8fa1-5910-47a4-9320-f71bbfa862b3`.
2. Replacing the staged patch with `{}` cancelled the proposed source change.
   The live source, deployment, instance, and volume remained unchanged.
3. Repeating the exact source-only stage reused the reviewed patch identity and
   produced the exact expected patch body.
4. `environmentPatchCommitStaged(skipDeploys:true)` committed the patch as
   `commitChanges/a4e0f507-d6d3-4df9-a818-ad92c0071a35/1f8f8fa1-5910-47a4-9320-f71bbfa862b3`.
5. Querying that exact patch after the commit returned `COMMITTED`, no apply
   error, and only the expected source field.
6. The service source became the exact `tag@sha256` reference while deployment
   `7c323c7c-649c-44cf-b9a8-dffb1f098219`, running instance
   `a472ca22-1447-4cf9-ad60-8182de120cd6`, and volume
   `808d863f-a03a-4118-be37-a50ea0872026` remained unchanged.
7. Staging the already-live tag-plus-digest value again produced an empty
   patch, proving an exact retry is a provider no-op.
8. The policy's exact digest-only source was then staged as patch
   `d1151c05-03c5-4414-8606-36e9e42268d2` and committed with deploys skipped.
   The patch was `COMMITTED` with no apply error, and the deployment, running
   instance, and volume identities again remained unchanged.

## Conclusion

Railway accepts both the immutable `tag@sha256` source reference and the
repository policy's digest-only source. It can commit either source-only change
with deploys skipped without restarting the running service or replacing its
volume. A production repair therefore required an out-of-band provider-write
freeze, an empty production staged patch, only the exact PostgreSQL service
source, exact patch queries before and after commit, and proof that the
production deployment, instance, snapshot, and volume identities did not
change.

## Production source repair

An independent read-only review gave a conditional GO after inspecting the
disposable proof and exact production baseline. No GitHub provider-writing
workflow was active during the ceremony.

Railway production patch `30db986b-4df9-4847-bce0-4cd1c3a3adc7` was staged with
only the repository policy's digest-only source, queried back exactly, and
committed once with `skipDeploys:true`. Its post-commit state is `COMMITTED`
with no apply error and the production staged patch is empty.

The following production identities remained unchanged:

- deployment `ccb513ee-c850-49a1-a205-9ab8ab7534cc`
- running instance `a73d456f-d2a1-4d8d-aaea-c87b3c8a73d5`
- snapshot `f2a08518-2336-4837-a77b-11852cf2a8ab`
- volume instance `74cbfae2-3383-40b4-8464-21a403ca509d`
- volume `a3585b0a-b57a-4b69-ad45-05f798e739e1`

The live source and running deployment image now both resolve to the exact
policy-approved digest. The PostgreSQL service was not restarted or redeployed.
This closes the mutable production source-reference blocker; it does not import
data or connect the production application to PostgreSQL.

## Cleanup

Both exact disposable services were deleted from the staging fork after the
production repair:

- `c39fe48f-fdf9-4473-b4fe-3737eacccc8e`
- `107676a4-fe3f-4461-b85d-0bd6583fec00`

A fresh provider inventory returned no matching project services, environment
service instances, or volumes. These disposable resources are not recoverable
and held no application data.
