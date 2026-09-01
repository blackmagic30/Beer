# Permanent-staging cleanup closeout witness

This directory is the durable, reviewed copy of the secret-free terminal
evidence produced by the one-time permanent-staging cleanup closeout on
2026-08-29. The originating GitHub Actions artifact is subject to GitHub's
artifact-retention expiry, so future release-candidate verification must use
the immutable run identity together with the checked-in hashes and byte counts
recorded in `attestation.json`; it must not depend on the artifact remaining
downloadable.

The historical operation
`reconcile-completed-forbidden-offsite-backup-deletion` completed as the
read-only outcome `cleanup_completed_read_only_reconciled`. It made zero
mutation attempts. The retained files contain no secret material or
secret-derived commitments.

This closeout was intentionally one-time. A later candidate may prove it is a
descendant of the attested anchor, but must never rerun the historical cleanup
closeout operation.
