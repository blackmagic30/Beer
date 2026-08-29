# Railway staged-null deletion proof — 29 August 2026

This directory contains the secret-free repository attestation for the
disposable Railway proof that enabled PintPath's protected permanent-staging
OFFSITE residue cleanup.

The proof used a separate project, an immutable image, and two public non-secret
probe variables. It established the exact masked/decrypted staged-null shapes,
`environmentPatchCommitStaged(skipDeploys:true)`, normal acknowledgement shape,
deterministic lost-ack reconciliation with no retry, and deployment/event/
topology invariance for more than ten minutes. Two independent reviewers found
no P0/P1. The disposable project was then soft-deleted once and reconciled as an
exact tombstone absent from active inventory for more than ten minutes.

`attestation.json` contains the exact target IDs and sealed artifact hashes. It
contains no secret material or secret-derived commitment. The repository policy
pins that file at SHA-256
`e1faa9daff1ff4927c852ccf08b917f77b7893f77a04c20bbe192f556e276de2`.

This evidence proves provider transport semantics only. It is not proof that
the PintPath 99-to-96 cleanup has run, that permanent staging is healthy, or
that PintPath is launch-ready.
