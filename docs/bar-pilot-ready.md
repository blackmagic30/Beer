# PintPath bar pilot candidate

This finite candidate supersedes the **Free-only scope** in PR #105 and
`bar-pilot-closeout.md`. It targets the first 2–5 participating bars, public
venue discovery, normal browser venue management, and the drink Pint Points
→ 50-point free-pint → one-use staff redemption loop. It is not a full consumer
or commercial launch. Contribution points remain a separate balance.

## Source and preservation

- Started 2026-09-10 at `11249c343b0d81216b103f669fad1bc4258bd6be`.
- Initial main inspected: `e3b0eb821d4d474776c966d94c9061375fbbe4af`.
- PR #105 inspected and reused; recent merged #104/#103/#102/#99/#98/#97 concern
  staging containment. Open dependency/native PRs are outside this pilot.
- Candidate branch: `codex/bar-pilot-ready`, isolated worktree
  `/Users/zac/Desktop/Beer-bar-pilot-ready`.
- PR #106 merged as `e1073602985d8008eeded54f2462d100fda380cd` after all
  required checks and the aggregate CodeQL gate passed; PR #105 is superseded
  and closed. A scoped follow-up, `codex/bar-pilot-staging-pagination`, fixes
  the observed 101-variable hosted configuration boundary described below.
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
| PILOT-02 | Claim, independent approval, manager assignment, staff invitation and revocation | PASS locally; existing venue contracts and real PostgreSQL pilot role/revocation tests |
| PILOT-03 | Profile/hours/3+ beer rows/size/stock/price/create/edit/delete | Existing scoped venue tests passed |
| PILOT-04 | Consumer publication, review boundary, stale-write conflict, cross-venue isolation | Existing scoped venue tests passed |
| PILOT-05 | Canonical PostgreSQL drink ledger, contribution separation, audit associations | PASS; restricted-role PostgreSQL integration |
| PILOT-06 | Eligible purchase +1, invalid purchase denied, retry/idempotency +0 | PASS; eight-way duplicate award records one point; signed receipt reuse adds zero |
| PILOT-07 | Rotating identity expiry/session binding/server validation | PASS; invalid, expired, replaced, consumed and revoked-session identities denied |
| PILOT-08 | Threshold 50, below-threshold denial, reward visibly available | PASS locally; PostgreSQL threshold tests and connected mobile wallet |
| PILOT-09 | Atomic one-use redemption, exactly -50, zero award, replay/concurrent denial | PASS; eight concurrent requests across two staff yield one success, balance zero |
| PILOT-10 | Append-only reversal/history and correct balance | PASS; backend invariants and browser reversal, original transaction retained with linked correction |
| PILOT-11 | Limited pilot entitlement, no Pro/payment requirement, role/venue isolation | PASS; pilot runs with old commercial/reward/gamification flags false; protected route and cross-venue tests |
| PILOT-12 | Understandable manager setup/staff/history/reward/error/empty screens | PASS local browser; setup checklist, role-specific actions, clear redemption and correction states |
| PILOT-13 | iPhone homepage/search/list/map fallback/details/sign-in/account/wallet/QR/reward | PASS at 390×844 in Chromium; actual iPhone/hosted Google ceremony remains owner verification |
| PILOT-14 | Connected browser publication/award/reward/redemption/history updates | PASS; 21 checks against real PostgreSQL, zero page exceptions |
| PILOT-15 | Repeatable isolated accounts/venue/3 rows/restricted demo threshold/reset | PASS tooling and local fixture; hosted setup awaits legitimate Google identities |
| PILOT-16 | Relevant unit/HTTP/PG migration/reconciliation/security/concurrency checks | PASS on the product candidate; 5,129 local aggregate tests plus explicitly enabled PostgreSQL and Supabase runs below; required PR #106 and merged-main checks passed |
| PILOT-17 | Hosted staging exact candidate and legitimate provider-backed identities | Authenticated acceptance OWNER_ACTION_REQUIRED; provider disabled and zero accounts. Public deployment must have its own successful exact-candidate workflow receipt; not inferred from local tests |
| PILOT-18 | Real iPhone, real bar/eligible purchase, owner legal and staff approval | OWNER_ACTION_REQUIRED; only after software acceptance |
| PILOT-19 | Candidate commits, PR, clean worktree, exact test evidence and handoff | Recorded in [PR #106](https://github.com/blackmagic30/Beer/pull/106), this isolated branch and the final handoff; merge/deployment require the protected candidate checks |

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
- Drink-points PostgreSQL integration: **13 passed** with the real application
  service/router and a restricted, non-superuser, non-`BYPASSRLS` database role.
  Focused backend, authorization and release contracts: **287 passed**.
- Existing Supabase migrations remain unchanged. An isolated reset and drift
  rehearsals passed; database lint and security advisor returned zero issues,
  and **68 pgTAP checks across five files passed**. Existing performance warnings
  are outside the finite pilot scope.
- Read-only staging Supabase inspection found zero users, identities and sessions.
  Hosted Google identities were not fabricated, and no hosted sign-in or connected
  acceptance is claimed from local password-based fixtures.
- The public staging Google authorization entry returned HTTP **400** with
  `validation_failed`: **provider is not enabled**. The Management API Auth
  configuration read returned **403** with the available credential. Owner
  provider configuration is therefore required before the four Google sign-ins;
  a callback/complete OAuth session has not been verified.
- Connected paired-browser acceptance: **21 passed**, zero page exceptions;
  mobile viewport **390×844**, touch enabled, scale factor 3. Evidence is in
  `/tmp/pintpath-pilot-browser-evidence/results.json` and the adjacent
  `iphone-wallet.png`, `iphone-venue.png`, `iphone-venue-beers.png`, and
  `manager-history.png`. The screenshots were visually inspected. Focused UI,
  commercial-gating, serving-size and wallet regressions: **147 passed**.
  Real browser findings fixed were distinct serving sizes collapsing into one
  row, an anonymous venue-link/cookie-dialog conflict, and low-contrast wallet
  hover/locked controls. No redesign was needed.
- Product candidate aggregate local suite: **274 files passed**, **5,129 tests passed**;
  48 environment/platform-gated files and 142 tests skipped. Those skips are
  not passes: required PostgreSQL and Supabase cases were also run explicitly
  as documented in [the test evidence](bar-pilot-test-evidence.md).
- Typecheck, JavaScript lint, format, production build (12 required artifacts),
  isolated artifact runtime smoke, secret scan (**1,093 files**), and production/
  restore deployment guard checks passed. The compiled artifact browser passed
  six desktop and two mobile routes with no provider calls. Dependency audit:
  **zero vulnerabilities**. Aggregate log: `/tmp/pintpath-bar-pilot-security-fix-check.log`.
- Scoped deployment configuration: **93 passed**, five existing Linux-only
  skips; isolated pilot executor/production compatibility: **103 passed**, five
  existing Linux-only skips; dedicated GitHub candidate-policy and historical
  compatibility checks: **141 passed**. Remote Linux CI runs the relevant
  platform-specific checks. The production executor and original release policy
  retain their exact historical bytes; the new pilot executor accepts only its
  explicit staging policy.
- The merged product candidate passed all eight required main checks and
  produced the three required deployment artifacts. Main CI passed **5,116
  tests** with **154 gated skips**, plus the dedicated **13 PostgreSQL pilot
  tests** and **68 pgTAP checks**. CodeQL passed in all three languages. The
  two PR tooling findings were fixed, not dismissed.
- Actual protected staging attempts are recorded in
  [the hosted evidence boundary](bar-pilot-test-evidence.md#hosted-configuration-attempts).
  Configuration reached 101 environment variables, exposing the existing
  verifier's one-page limit. The follow-up adds bounded metadata pagination;
  it does not relax deployment, staging-patch, or production isolation checks.

The required remote checks and later hosted deployment are live evidence on
[PR #106](https://github.com/blackmagic30/Beer/pull/106) and the
[protected staging workflow](https://github.com/blackmagic30/Beer/actions/workflows/deploy-bar-pilot-staging.yml).
Do not treat creation of a workflow or a local test result as a hosted pass.
Authenticated hosted acceptance remains open until the owner prerequisites in
[the runbook](venue-pilot-runbook.md) are completed.

## Runtime and owner boundaries

The canonical pilot uses PostgreSQL and explicit `BAR_PILOT_ENABLED` plus
`BAR_PILOT_VENUE_IDS`. Paid plans and the previous broad rewards/gamification
flags remain disabled. Real venue enrolment is separate from demo access.
`BAR_PILOT_DEMO_ENABLED` and `BAR_PILOT_DEMO_CUSTOMER_IDS` limit test credits to
the isolated labelled staging fixture. The public customer API cannot set a
balance, and ordinary staff cannot choose arbitrary point values.

The customer identity lasts five minutes, belongs to the authenticated session,
and is consumed by a new purchase. An identical signed purchase retry returns
the prior result; a new transaction requires a fresh customer identity.
Redemption is a separate one-use reward operation. A correction appends history
and cannot make the balance negative; spent points cannot be reversed until
sufficient points are available.

The live production site is a separate older candidate and was not promoted by
this work. Staging deployment and authenticated acceptance must be recorded
separately. Google sign-in, real iPhone/camera use, physical purchases and bar
staff practice are not proven by desktop Chromium emulation. Alcohol-promotion
approval remains an owner action; passing software tests is not legal approval.

## Deferred

Paid plans, Stripe/subscriptions, Pro/Premium, POS, public marketing and Melbourne
coverage, Android/App Store release, push/email marketing, Saved Updates
expansion, advanced reporting/recommendations/social/retention, extra reward
tiers/currencies/gamification, visual redesign, unrelated security/dependency
work, and scaling architecture. These do not reopen this goal.
