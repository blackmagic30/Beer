# Protected production promotion and recovery authority

Status: the repository boundary is implemented. It does not claim a live
promotion or recovery drill has occurred. Production ingress must remain closed
until a real, candidate-bound receipt from
`.github/workflows/attest-production-promotion-recovery.yml` has passed the
route-open predecessor check.

## Ordered release boundary

The production rollout uses one non-cancelling concurrency group,
`pintpath-production-rollout`, in this order:

1. deploy the exact current `main` candidate;
2. converge that same deployment to two replicas;
3. close the production route;
4. authorize and apply the reviewed-price operation once while ingress remains
   closed;
5. produce and independently retrieve the complete post-promotion recovery
   set, restore it to a disposable target, and replay its deletion authority
   twice;
6. obtain two distinct Ed25519 approvals over one exact authority manifest;
7. dispatch `Attest Pint Path protected production promotion recovery`; and
8. open the route only with the digest-bound attestation artifact.

The attestation workflow first verifies GitHub's deploy→scale→close chain. It
then downloads those three artifact archives by exact artifact ID and GitHub
digest and replaces caller-supplied predecessor copies with the canonical
receipts. The output is
`pintpath-production-promotion-recovery-<candidate-sha>` and contains the
self-hashed canonical receipt, a hash-only result, and the tested commit SHA.
It contains no provider token, database URL, service-role key, root CA, object
path, reviewer identity, or public key.

## Promotion result

Use only the activated Postgres operator commands. The apply authorization and
operation receipts must share the exact operation and authorization UUIDs,
target production, bind the frozen candidate, and identify the same physical
database as the post-promotion logical-backup manifest. A successful chain
accepts only `operationKind=apply` and `sourceApplyOperationId=null`. It permits
no quarantine receipt. Quarantine is a separate failure-only operation
requiring a new approval bound to the failed/uncertain apply; it can never
satisfy this success authority.

## Executable post-promotion evidence

Every file below must be canonical JSON in a current-user-owned mode-0700
custody directory, with each leaf a current-user-owned mode-0600 regular file,
one link, no symlink, and an unchanged descriptor snapshot. Preserve the exact
file bytes returned by each successful command. Do not recreate a receipt by
rehashing a pathname later.

- `pitr-receipt.json`: dispatch
  `.github/workflows/observe-production-post-promotion-pitr.yml`. Its protected
  metadata-only Railway token must be scoped to the fixed production
  environment. The workflow reads provider scope, discovers exactly one
  protected HA root, requires a completed enable workflow, all members healthy,
  one leader, and a provider observation no older than five minutes. It performs
  no mutation. Its input artifact contains only the exact production deployment
  receipt and the post-promotion logical `manifest.json`.
- `logical-backup-manifest.json` and `logical-offsite-result.json`: use the
  schema-version-3 production backup and operational-copy commands. The
  manifest's creation time is the recovery point used for RPO.
- `logical-worm-result.json`: use the independent object-lock writer/readback
  boundary and require distinct writer and reader principal hashes.
- `private-storage-capture-receipt.json` and
  `private-storage-recovery-manifest.json`: run the private Storage capture
  command documented in
  [postgres-private-storage-recovery.md](postgres-private-storage-recovery.md)
  against the same logical manifest, candidate, source database identity, and
  nonzero sealed deletion authority.
- `offsite-retrieval-receipt.json`: retrieve the exact operational copy through
  the separately authorized recovery principal.
- `logical-restore-receipt.json`: restore the retrieved logical set to a new
  isolated target marked `disposable-rehearsal`.
- `private-storage-restore-receipt.json`: restore to an empty, distinct private
  Storage destination using the signed disposable-destination authority in the
  private Storage runbook.
- `deletion-replay-first-receipt.json` and
  `deletion-replay-second-receipt.json`: run the authenticated replay command
  twice against the same target and base restore receipt. The first must report
  every nonzero tombstone as newly applied; the second must report all as
  already applied with the same semantic projection.

The database proof CLIs accept only a direct
`*.railway.internal:5432?...sslmode=verify-full` URL. They open exactly one
stock Railway transport: current-UID mode-0600, regular, single-link root CA;
exact self-signed CA; externally reviewed DER SHA-256; one fd12 resolution;
TLS verification and SNI for `localhost`; and peer DER pinning. They assert the
DNS/file/CA snapshot before and after database work and close it explicitly.
Private Storage inspection activates `pintpath_migrator` in the startup packet.
Deletion replay activates `pintpath_maintenance` in the startup packet and
rejects runtime or migrator membership.

## Signed authority and two-person review

After every recovery operation has completed, build one canonical
`pintpath-production-promotion-recovery-authority/v1` manifest. It contains the
candidate SHA, production deployment identity hash, exact SHA-256 of every
evidence file, close-terminal hash, PITR observation time, recovery point,
start/end times, measured RPO/RTO, and the sorted hashes of exactly two reviewer
public keys. Maximum RPO is 3,600 seconds; maximum RTO is 14,400 seconds.

Each reviewer independently signs the canonical approval payload with a
different Ed25519 key. The payload binds the authority file SHA-256, candidate,
hashed reviewer identity, public-key hash, and approval timestamp. Both
approvals must occur after the second replay and within six hours of protected
attestation. Configure the two public keys as separate protected base64 secrets
and their exact SHA-256 values as protected variables:

- `PINTPATH_PROMOTION_RECOVERY_REVIEWER_ONE_PUBLIC_KEY_BASE64`
- `PINTPATH_PROMOTION_RECOVERY_REVIEWER_TWO_PUBLIC_KEY_BASE64`
- `PINTPATH_PROMOTION_RECOVERY_REVIEWER_ONE_PUBLIC_KEY_SHA256`
- `PINTPATH_PROMOTION_RECOVERY_REVIEWER_TWO_PUBLIC_KEY_SHA256`

The final input artifact name is
`pintpath-production-promotion-recovery-input-<candidate-sha>`. It contains
exactly the 17 non-predecessor evidence files enumerated by the workflow.
Production deployment, scale, and close receipts are not accepted from this
artifact; the workflow materializes them from GitHub's trusted chain.

## Attestation and consumption

Dispatch the attestation with the exact candidate, input-artifact run ID, and
confirmation `ATTEST_PRODUCTION_PROMOTION_RECOVERY`. The protected environment
must require the intended reviewers and prohibit bypass. The command validates
promotion, recovery, transport/role, target, chronology, RPO/RTO, and two-person
bindings and publishes only on complete success.

Route-open consumes the receipt with the strict verifier contract:

```sh
npm run --silent production:promotion-recovery:receipt:verify -- \
  --receipt /absolute/private/production-promotion-recovery-receipt.json \
  --expected-sha256 <github-artifact-receipt-file-sha256> \
  --candidate-sha <exact-current-main-sha> \
  --expected-close-receipt-sha256 <trusted-close-receipt-sha256> \
  --expected-close-terminal-sha256 <trusted-close-terminal-sha256> \
  --expected-deployment-id-sha256 <trusted-production-deployment-id-sha256>
```

The verifier requires canonical bytes, self-hash equality, exact external file
SHA, candidate, deployment and close bindings, `quarantineReceiptSha256=null`,
and every check true. Route-open additionally binds the fixed promotion policy
hash and requires the attestation timestamp to fall inside the trusted
promotion workflow run. Any mismatch leaves ingress closed. Preserve evidence;
do not rerun a write, fabricate a receipt, or calculate a new expected hash
from the file that failed verification.
