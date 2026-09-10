# PintPath bar pilot candidate

This finite candidate supersedes the **Free-only scope** in PR #105 and
`bar-pilot-closeout.md`. It targets the first 2–5 participating bars, public
venue discovery, normal browser venue management, and the drink Pint Points
→ 50-point free-pint → one-use staff redemption loop. It is not a full consumer
or commercial launch. Contribution points remain a separate balance.

## Source and preservation

- Started 2026-09-10 at `11249c343b0d81216b103f669fad1bc4258bd6be`.
- Current main inspected: `e3b0eb821d4d474776c966d94c9061375fbbe4af`.
- PR #105 inspected and reused; recent merged #104/#103/#102/#99/#98/#97 concern
  staging containment. Open dependency/native PRs are outside this pilot.
- Candidate branch: `codex/bar-pilot-ready`, isolated worktree
  `/Users/zac/Desktop/Beer-bar-pilot-ready`.
- Pre-existing work in `/Users/zac/Desktop/Beer` is preserved: modified closeout,
  reviewed-candidate verifier and workflow tests; untracked stopped-topology
  recovery workflow, scripts, policy, tests, and incident evidence. None of
  those changes is included implicitly in this candidate.

## Inspection before implementation

| Area | Existing result | Scoped action |
| --- | --- | --- |
| Claims, manager assignment/revocation | PostgreSQL repositories and permission checks already implemented | Validate and reuse |
| Profile/hours/beer/size/stock/price edits | Existing dashboard, optimistic versions, publication and safeguard boundary | Validate and reuse |
| Contribution points | Existing contribution ledger and account progress | Keep distinct from drink value |
| Drink points, customer pass and reward | Schema exists; service uses legacy synchronous SQLite persistence | Add canonical asynchronous PostgreSQL persistence and atomic contracts |
| Staff/reward interfaces | Existing screens hidden by Free/commercial gating | Enable only enrolled pilot venues; retain paid feature exclusions |
| Customer wallet | Existing wallet UI, insufficiently visible for pilot/mobile and remote updates | Expose pilot wallet, rotating identity, progress and refreshed redemption state |
| Demo data | Legacy SQLite release seed only | Add isolated PostgreSQL fixture and auditable restricted threshold preparation |
| Hosted staging | Read-only health returned HTTP 502; Railway reports stopped app | Preserve honest NOT RUN status until actual candidate walkthrough executes |
| Real-world approvals | No software test can establish legal/venue approval or actual staff training | Owner evidence required before real alcohol reward use |

## Finite acceptance register

Checks are updated only after an observed failure, its scoped fix and relevant
retest. A passing area is not re-audited without a later regression.

| ID | Acceptance area | Status / evidence |
| --- | --- | --- |
| PILOT-01 | Source/PR inspection, isolated candidate, no unrelated changes | PASS; source record above |
| PILOT-02 | Claim, independent approval, manager assignment, staff invitation and revocation | Existing venue contracts passed; pilot staff validation pending |
| PILOT-03 | Profile/hours/3+ beer rows/size/stock/price/create/edit/delete | Existing scoped venue tests passed |
| PILOT-04 | Consumer publication, review boundary, stale-write conflict, cross-venue isolation | Existing scoped venue tests passed |
| PILOT-05 | Canonical PostgreSQL drink ledger, contribution separation, audit associations | IN PROGRESS |
| PILOT-06 | Eligible purchase +1, invalid purchase denied, retry/idempotency +0 | IN PROGRESS |
| PILOT-07 | Rotating identity expiry/session binding/server validation | IN PROGRESS |
| PILOT-08 | Threshold 50, below-threshold denial, reward visibly available | IN PROGRESS |
| PILOT-09 | Atomic one-use redemption, exactly -50, zero award, replay/concurrent denial | IN PROGRESS |
| PILOT-10 | Append-only reversal/history and correct balance | IN PROGRESS |
| PILOT-11 | Limited pilot entitlement, no Pro/payment requirement, role/venue isolation | IN PROGRESS |
| PILOT-12 | Understandable manager setup/staff/history/reward/error/empty screens | IN PROGRESS |
| PILOT-13 | iPhone homepage/search/list/map fallback/details/sign-in/account/wallet/QR/reward | IN PROGRESS |
| PILOT-14 | Connected browser publication/award/reward/redemption/history updates | IN PROGRESS |
| PILOT-15 | Repeatable isolated accounts/venue/3 rows/restricted demo threshold/reset | IN PROGRESS |
| PILOT-16 | Relevant unit/HTTP/PG migration/reconciliation/security/concurrency checks | IN PROGRESS |
| PILOT-17 | Hosted staging exact candidate and legitimate provider-backed identities | NOT RUN; app stopped (HTTP 502) |
| PILOT-18 | Real iPhone, real bar/eligible purchase, owner legal and staff approval | OWNER_ACTION_REQUIRED; only after software acceptance |
| PILOT-19 | Candidate commits, PR, clean worktree, exact test evidence and handoff | IN PROGRESS |

## Evidence recorded during implementation

- Node `22.23.2`, npm `10.9.8`; `npm ci` succeeded, lockfile unchanged,
  dependency audit reported zero vulnerabilities.
- Existing venue baseline: 11 focused unit/service suites, **332 passed**;
  10 PostgreSQL 17.10 integration suites, **24 passed**, including import and
  reconciliation, manager isolation, inventory concurrency, moderation and
  publication. No venue backend rewrite was justified.
- Environment contracts: **149 passed**, including explicit pilot allowlists,
  independent paid-feature flags, approval-reference boundary and production
  rejection of demo threshold access.

## Deferred

Paid plans, Stripe/subscriptions, Pro/Premium, POS, public marketing and Melbourne
coverage, Android/App Store release, push/email marketing, Saved Updates
expansion, advanced reporting/recommendations/social/retention, extra reward
tiers/currencies/gamification, visual redesign, unrelated security/dependency
work, and scaling architecture. These do not reopen this goal.
