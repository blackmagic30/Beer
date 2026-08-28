# Permanent-staging masked patch cancellation — 28 August 2026

## Decision

**TERMINAL / CLOSED. Do not retry or resume this operation.**

The reviewed incident-only candidate
`daecb51aeff56aeabd1948e4ce082912c395278c` made exactly one acknowledged
Railway cancellation attempt in GitHub Actions run
[`33173709464`](https://github.com/blackmagic30/Beer/actions/runs/33173709464).
The original staged patch remains identifiable, but its live patch body is now
exactly empty, unapplied, and noncommitted. Independent provider reconciliation
proved that the 99-row permanent-staging variable metadata baseline, the
cold/dead Beer application topology, and production deployment identities did
not change.

This directory is a secret-free durable copy of the run's retained evidence and
final logged receipt. It contains no credential values or secret-derived
commitments.

## Bound authority

- Rescue PR: [#66](https://github.com/blackmagic30/Beer/pull/66)
- Rescue merge: `daecb51aeff56aeabd1948e4ce082912c395278c`
- Reviewed head: `5d3d79759e08a7c0a7e4ee587dee952e790fff89`
- Identical reviewed/merge tree: `ab27bfb8c42fb0b49a4b974615e862584a9d9ef6`
- Sole merge parent: `ac7130e0306802825922d21a4c61135b84edd43b`
- Cancellation run: `33173709464`, attempt 1, `success`
- Original incident run: `33164687424`
- Cancellation artifact: `9686786783`
- Artifact digest:
  `sha256:91d679bd9be6fb62167092679aeb91847bd3d4184bae914c4fc966ced70dacd6`
- Artifact expiry in GitHub: `2026-09-27T13:07:54Z`

## File integrity

| File                 | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `intent.json`        | `08fcdf32bf7ab2b727b846937e64a448416bada72a966f0ce9fa7475205f2167` |
| `dispatch.json`      | `f5b9f03479c60dc0e78c152ba9487994d82bb2908d4521b6903bf251681c5218` |
| `terminal.json`      | `fdb24e12af4310f24e3fd9dc73639f4701e16d6bad85d9b70f735eaf6c1948df` |
| `artifact.json`      | `33adce297d5f233fb54d957733c4e63ce19e9be88007e93b52a73a8e78310636` |
| `final-receipt.json` | `43c3b7bf6fd3d720436f590ce3a0fd6affee17338bfbf076a9dfa8e98f92f925` |

`terminal.json` is the intentionally self-hash-free artifact form. The workflow
log's final receipt in `final-receipt.json` binds its exact SHA-256 and records
`terminalEvidenceExact:true`.

## Live postflight

- Selected and active patch identity:
  `63b3cc8a-f68f-4b99-adb7-70dfdfa7d6ae`
- Patch status: `STAGED`
- Patch body: `{}`
- `appliedAt`, `message`, and `lastAppliedError`: null
- Normalized 99-row staging baseline:
  `c88c7915e91f391c4d40e4869d18b44783746a2b4e153c99637f34333c021abd`
- Staging Beer remains cold/dead with no active deployment.
- Production remains on application commit
  `95b9f2da5e9a99692c8cfafba90d2c29e63ccbc8`; no production patch or
  deployment changed.

## Residual containment

The cancellation removed the destructive staged patch, not the three prohibited
permanent-staging rows. `OFFSITE_BACKUP_BUCKET`,
`OFFSITE_BACKUP_SERVICE_ROLE_KEY`, and `OFFSITE_BACKUP_SUPABASE_URL` still
exist. Treat the service-role credential as live until its owner proves
invalidation or rotation. Remove the rows only through a newly reviewed,
provider-verifiable operation; do not reuse the masked deletion path.

Railway did not provide a patch ETag, CAS token, or provider lock. The exact
postflight proves that this risk did not materialize in the completed incident,
but every future provider mutation still requires a continuously enforced
external writer freeze and exact before/after reconciliation.

The rescue SHA is incident-only. The release verifier intentionally rejects
mixing its successful incident cancellation history with normal provider
operations. Use only a later reviewed protected-`main` SHA as the fresh
SHA-scoped permanent-staging evidence basis. Every provider write on that
successor still requires the external writer freeze and exact reconciliation.
This record does not freeze a release ID or candidate SHA and does not claim
launch readiness.
