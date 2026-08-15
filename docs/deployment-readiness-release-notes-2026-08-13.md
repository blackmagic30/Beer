# Deployment-readiness release notes — 2026-08-13

Candidate baseline: `main` at `f5d8ba6ee5154a52902150bb26bb209f724fc691`.
These changes prepare a new release candidate; they do not deploy an application,
change provider infrastructure, rotate a credential, send mail, or enable billing.

## Runtime and delivery

- Pinned Node `22.23.2` and npm `10.9.8`, added source/type/format gates, and
  made the compiled server artifact self-contained with its static web app.
- Added isolated production-artifact startup smoke coverage for `/health`,
  `/startup`, and direct static routes.
- Added protected, exact-`main` Railway source-upload ceremonies for permanent
  staging and production. They bind one candidate, one target, one write,
  unconditional patch reconciliation, provider health, and retained receipts.
- Added protected provider-variable, Supabase-key containment, and temporary
  two-replica staging ceremonies without embedding credentials.
- Added a candidate-aware GitHub check/artifact verifier and strengthened the
  release gate so an arbitrary ref or incomplete CI run cannot be released.
- Aligned candidate authority with the solo-owner repository policy: a human
  PR approval is not required, while the exact merged same-repository PR,
  protected-main commit, one-parent history, reviewed/candidate tree equality,
  required checks, artifacts, and chronology remain mandatory.

## Data, privacy, and recovery

- Added a narrowly scoped PostgreSQL privacy-maintenance role and a distinct
  `DATABASE_MAINTENANCE_URL`; the runtime role is now append-only on audit,
  contribution, and Pint Point ledgers.
- Activated the reviewed-price PostgreSQL publication kernel with independent
  signed review authorization, transactional idempotent apply, receipt-bound
  quarantine, exact role boundaries, and operator receipts.
- Added a protected daily PostgreSQL logical-backup/operational-copy/WORM
  schedule plus a monthly isolated restore drill and fail-closed alert path.
- Activated a four-job post-promotion recovery ceremony that separately
  captures production evidence, restores on a disposable private runner,
  performs independently authorized provider cleanup, and finalizes only after
  both target-absence terminals are present.
- Added reader-only retrieval for the logical and private WORM sets, a real
  compiled-app recovery smoke against distinct runtime and maintenance roles,
  and strict producer-shaped validation for all 18 evidence leaves in the
  20-file activation artifact.
- Added orderly Railway and Supabase teardown plus a signed singleton `ARMED`
  watchdog outside the activation cancellation domain. It fails closed on
  target transfer, lost deletion acknowledgement, overlapping activation, or
  incomplete provider inventory.
- Reworked permanent-staging cost evidence into a provider-observed,
  candidate-bound receipt with a US$47 maximum and US$3 headroom under the
  approved US$50 ceiling.

## Security and product integrity

- Removed request-controlled publication confidence and prohibited self-review;
  publication confidence is now derived and transactionally rechecked from
  durable evidence and independent confirmations.
- Kept the first PostgreSQL release Free-only until paid, rewards, and alcohol-
  gamification persistence/concurrency contracts exist.
- Moved QR redemption secrets into URL fragments, scrubs them before network
  activity, and retains a bounded compatibility path for old query-form links.
- Expanded secret-pattern coverage, verified local secret-file permissions,
  removed production debug globals, and made scheduled authenticated health
  monitoring fail closed when protected configuration is absent.
- Made every non-dialog browser form use an explicit same-origin POST contract,
  with a bounded non-mutating fallback that prevents credentials, contact
  details, venue operations, or admin inputs from falling back into URLs when
  JavaScript is unavailable.
- Enforced one canonical production origin: reviewed legacy and `www` hosts
  permanently redirect to `https://pintpath.au` with the path and query intact,
  while unknown production hosts fail closed and Railway probes remain healthy.
- Corrected the default venue shortlist so current verified visible prices rank
  ahead of stale, partial, and empty records without hiding any venue, marker,
  coverage count, or needs-data state.
- Fixed the venue portal's commercial-disabled initialization ordering so it
  no longer dereferences DOM removed by the launch gate.
- Bounded the anonymous venue directory to 250-row pages and 160-character
  searches, added a shared Redis/IP read limit and exact origin/auth/cookie
  cache partitioning, kept larger legacy mobile requests backward-compatible while
  clamping their responses, and replaced per-venue profile reads with bounded
  batch metadata queries across the web and native pagination paths.

## Operations and documentation

- Updated the canonical Postgres migration, provider configuration, release,
  smoke, rollback, backup, cost, and owner-action procedures.
- Superseded stale top-level SQLite deployment checklists with canonical
  Postgres runbook pointers.
- Added `TARGET_BEER` and the maintenance connection to the safe environment
  template and enforced template/schema parity.

The release remains externally gated until the exact candidate has current
provider receipts, staging and production smoke, data-quality thresholds,
recovery proof, named operational/legal approvals, and signed iOS/App Store
evidence recorded in `docs/release-evidence.json`.
