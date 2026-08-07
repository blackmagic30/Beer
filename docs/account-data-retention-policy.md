# Account data export, erasure, and retention policy

Policy version: `2026-08-03`. The executable source of truth is
`ACCOUNT_DATA_RETENTION_POLICY` in `src/db/business.repository.ts`.

## Self-service export

The account export includes the account/profile fields, legal and age state,
billing identifiers and entitlement state, preferences/privacy choices, saved
items and searches, submissions and verifications, feedback and trust queues,
venue claims/assignments, missions, rewards/redemptions/points, account activity,
session and provider-revocation metadata, security audit records, deletion
requests, and Stripe webhook records linked to the account. Raw passwords,
session tokens, reward codes, and evidence file bytes are excluded; evidence
metadata is included.

## Account deletion

- Delete authentication sessions, provider revocations, device/network session
  metadata, preferences, saved data, analytics/activity, age-provider records,
  verifications, missions, venue access, rewards, redemptions, and points records.
- Delete private evidence in its storage provider, sever submission links, and
  clear exact coordinates, client IDs, notes, and source references.
- Delete the account's raw community submissions, submission items and free
  text, contribution ledger, private evidence, and every public price record
  whose authority is that submission. A future publisher-curated factual record
  may be retained only through a separate, fully de-linked ingestion path after
  written privacy/legal and App Review approval. Preserve support/workflow rows
  only after removing contact fields, free text, staff links, and account
  identifiers.
- Preserve security/billing event envelopes only for the retention periods below;
  immediately remove request fingerprints and linked Stripe payloads for a
  deleted account.
- Replace the account/profile identity, provider, MFA, legal, age, billing, and
  entitlement fields with a suspended deletion surrogate.
- Before destructive provider work starts, store the completion-notice
  destination separately from account data using AES-256-GCM with a dedicated,
  rotatable key. The destination stays held while provider deletion is retried,
  is released only in the same transaction that commits anonymisation, and is
  never exposed in the admin response or queue.
- Queue the deterministic completion notice after deletion commits. Purge the
  encrypted destination as soon as delivery to the recipient mail server is
  verified, when an authorised operator records an audited terminal resolution,
  or no later than 30 days after completion. Delivery failures require operator
  attention. A prepared destination for a deletion that has not completed has a
  60-day safety cap.

## Scheduled retention

- Expired or revoked app sessions: delete after 30 days.
- Per-device provider-session revocation hashes: retain as a one-way security
  denylist until account deletion, because a provider refresh session can outlive
  a short fixed window. Rows made redundant by a verified provider-global logout
  or password reset are deleted after 90 days.
- Successfully applied Stripe webhook payloads: redact after 30 days; delete the
  event envelope after 400 days.
- Security audit IP/user-agent hashes: redact after 30 days; delete the remaining
  audit envelope after 400 days.
- Pending source-ingestion images: mark overdue after 90 days and irreversibly
  clear the embedded image bytes at 180 days even when review is still open.
  Venue/source references, OCR output, and review metadata remain available so
  an admin can finish or re-source the review without retaining the image blob.
- Account-deletion completion-notice destinations: encrypted while held,
  delivery is pending, or a failure needs review; purge on verified delivery, an
  audited terminal resolution, or no later than 30 days after completion. A
  pre-completion held destination is purged after at most 60 days. Retain only
  non-identifying provider event IDs, status, timestamps, hashes, and audit
  metadata after destination purge; delete webhook receipts after 400 days.
- Encryption-key rotation: keep an old key only while a live encrypted
  destination references its key ID. Startup fails closed if a referenced key is
  missing. Never store key material in SQLite, logs, release evidence, or source
  control.

The leased hourly evidence-retention job runs these database retention actions,
records source-evidence and pending-ingestion held/overdue counts plus purged
volume in its operational result, and is awaited during shutdown.

## Backups and deletion suppression

- Production launch requires an immutable snapshot copy in a separate provider
  or region, written by an application principal that cannot overwrite, delete,
  or shorten retention; deletion/retention authority is separately controlled.
  The private Supabase backup project remains an operational restore copy and
  does not satisfy this requirement by itself. Copies are retained for at most
  30 days unless a documented legal hold applies. A snapshot may physically contain pre-deletion
  PII only until that snapshot reaches the retention limit. This general backup
  lag does not apply to the separate completion-notice destination: every backup
  and automatic pre-migration copy removes the recipient-secret rows, securely
  compacts the copied SQLite artifact, and keeps only suppression/retry-safe
  outbox metadata before the artifact can be retained or uploaded.
- Before an account-deletion request can become `completed`, its minimal
  tombstone must be written to and verified from the independent append-only
  ledger. A failed ledger write leaves deletion failed/retryable; there is no
  completed-deletion window in which an old restore may reactivate identity.
- Every restore and rehearsal fails closed without the latest aggregate ledger.
  It applies all tombstones and removes affected private evidence before the
  restored copy can pass validation.
- The suppression ledger contains only deletion request ID, internal user ID,
  and completion time. The scheduled backup (at most every 24 hours) reconciles
  it, while snapshot retention never deletes the independent ledger controls.
