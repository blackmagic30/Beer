# Pint Path bar-pilot closeout

Checklist frozen: `2026-09-09T08:02:52Z`  
Starting commit: `e3b0eb821d4d474776c966d94c9061375fbbe4af` (`main`, identical to `origin/main`)  
Starting worktree: clean; no tracked or untracked changes reported by Git  
Working branch: `codex/bar-pilot-closeout`

This is the single closeout record for a finite, Free bar-pilot candidate. The
numbered acceptance checks below are frozen. Later edits may record results and
evidence, but may not change a check unless a reproducible included-scope
failure, release security/privacy/data-integrity issue, or task-caused
regression is cited against that check.

## Resolved scope

Included:

- anonymous Free map and fixed three-beer price preview;
- Supabase-backed account access, legal/18+ confirmation, sessions, preferences,
  saved items, contribution progress, requests, and account privacy controls;
- missions, community price/menu/photo submissions, private evidence, admin
  review, contribution points, and contributor catalogue unlock;
- verified venue claim, independent admin approval, manager assignment,
  assignment isolation, and revocation;
- assigned Free venue profile and ordinary opening-hours maintenance;
- assigned Free venue beer/menu rows, price, on-tap/in-stock state, edit,
  bulk-save, and guarded removal;
- internal venue/admin happy-hour capture, with no consumer happy-hour surface;
- admin submission/catalogue/claim/safeguarded-change review, operational
  dashboards, partner workflow, support, and wrong-price queues; and
- real Postgres runtime, Supabase Auth/private Storage, shared Redis, deployment,
  restart, rollback, and isolated recovery paths already selected by the repo.

Explicitly deferred:

- paid consumer enrolment, Stripe checkout, Venue Pro/trials, specials, venue
  reports/delivery, individual venue analytics, counter staff, POS, discount
  codes, leaderboard prizes, Pub Golf, public happy-hour discovery, Android,
  App Store work, notifications, and broad public marketing;
- production migration, production deployment, production records, and real bar
  invitations, all of which require their existing protected owner controls; and
- drink-related Pint Points and the 50-point Free Pint Reward. The dormant flow
  is not the same as contribution points and is not ready for the canonical
  Postgres runtime.

Scope resolution for manager edits: routine assigned-manager profile, ordinary
hours, and verified beer/stock/price edits remain venue-supplied updates that
can appear immediately. Community submissions and safeguard-triggered or
restricted changes remain pending until admin review. This follows the current
Free-pilot implementation; changing every manager write to pre-publication
review would be a separate product/operations decision.

Rewards resolution: contribution points reward approved catalogue work and can
unlock the full map. Drink Pint Points are a separate ledger. The latter has a
dormant SQLite implementation, but Postgres startup rejects the enabling flags,
the required Postgres repository/concurrency path is absent, earning currently
requires full-access users, redemption currently requires a Pro venue, and the
legal/RSA/venue approval reference is absent. This candidate must keep
`COMMERCIAL_LAUNCH_ENABLED`, `PINT_POINTS_REWARDS_ENABLED`, and
`ALCOHOL_GAMIFICATION_ENABLED` false. The full rewards-based pitch is blocked,
not silently redefined as the Free demo.

## Frozen acceptance checks

Statuses are `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, or `NOT APPLICABLE`.

| ID | Gate and exact expected result | Verification |
| --- | --- | --- |
| BP-01 | **G1 / source identity.** The recorded start is preserved, the release diff contains only intended work, and no existing file or change is discarded. | `git status --short --branch`; `git diff --check`; `git diff --stat e3b0eb8...HEAD` |
| BP-02 | **G1 / lockfile install.** Node `v22.23.2`, npm `10.9.8`, and Supabase CLI `2.109.1` are used; `npm ci` succeeds without changing the lockfile. | `source ~/.nvm/nvm.sh && nvm use 22.23.2`; version checks; `npm ci`; `git diff -- package-lock.json` |
| BP-03 | **G1 / local candidate.** Typecheck, lint, format, production build, isolated artifact smoke, all Vitest tests, secret scan, deployment guard, and low-severity dependency audit pass without weakened checks. | `npm run check`; `npm run smoke:artifact:browser`; `npm run security:audit` |
| BP-04 | **G1 / remote candidate.** Required GitHub CI, release-readiness, CodeQL, Supabase/Postgres, and applicable native informational checks are green for the exact pushed candidate; pending external evidence stays pending. | `gh pr checks <PR> --watch`; workflow/run links recorded below |
| BP-05 | **G2 / Supabase schema.** A clean local Supabase rebuild and repeated migration chain pass the venue-directory verifier, lint, security/performance advisors, and all pgTAP tests; Data API and Storage browser grants remain revoked. | Exact sequence in `docs/supabase-database-testing.md` using Docker and CLI `2.109.1`, followed by `supabase stop --no-backup` |
| BP-06 | **G2 / canonical Postgres upgrade.** The existing SQLite-to-Postgres contract, populated upgrade/import path, 56-table relationships, reconciliation, restricted runtime/maintenance roles, and current schema generation pass on PostgreSQL 17; no SQLite production fallback is possible. | `npm run db:postgres:schema:check`; `npm run db:postgres:migration:contract:check`; required `postgres-migration-integration` CI job and its exact-SHA artifact |
| BP-07 | **G2 / durability and atomicity.** Profile, hours, beer bulk-save, community publication, claim assignment, revocation, and support writes survive repository reload; retries/interruption do not duplicate rows, points, evidence, or audit events; stale/concurrent writes fail safely. | Focused repository/integration and HTTP suites in `test/pintpath-release-readiness.test.ts`, `test/business-demo.test.ts`, and `test/*repository*.integration.test.ts`; browser/API scenario P4 below |
| BP-08 | **G2 / recovery.** A current candidate-bound logical backup plus private Storage/tombstones is retrieved and restored only in authorized disposable staging; reconciliation, replay idempotency, application boot, RPO/RTO, and safe teardown pass. No production write is used as a test. | Protected recovery receipts and `docs/release-evidence.json`; historical/dry-run evidence is not PASS |
| BP-09 | **G3 / role enforcement.** Anonymous users cannot mutate; user A cannot read user B; an unapproved claimant gains no venue access; managers reach only assigned venues; revocation removes access; direct API calls match UI restrictions. | `npm run test:permissions`; candidate HTTP role tests; deployed API scenario P2-P6 |
| BP-10 | **G3 / sessions and admin.** Supabase exchange produces only the scoped HttpOnly app cookie; logout, logout-all, expiry, fresh login, and two-session revocation work. Production admin requires allowlisted verified identity plus current provider-checked AAL2/MFA and fails closed when stale/unavailable. | Candidate auth/session tests plus real Supabase browser/API scenario P1/P6 |
| BP-11 | **G3 / privacy.** Private evidence, object paths, account/private records, credentials, privileged keys, exact location, and raw clickstream do not appear in public responses, browser config/bundle, logs, errors, or committed evidence. The private Storage denial/signed-URL path passes. | `npm run security:scan`; source-evidence/privacy tests; browser network inspection; hosted anon/user-A/user-B/service-role matrix |
| BP-12 | **G4 / public and contributor loop.** The map shows public venues and only the fixed Guinness/Carlton Draught/Stone & Wood Pacific Ale exact preview; non-preview and happy-hour rows remain gated; account, mission, contribution, approval, points, and contributor unlock behave as documented. | `npm run test:e2e:pintpath`; browser scenario P1/P3/P5 |
| BP-13 | **G4 / venue access loop.** A verified user submits one known-venue claim; access remains denied while pending; a separate admin approves or rejects; approval assigns exactly one venue; a second user and changed venue ID are denied; revocation removes access without deleting public data/audit history. | Candidate venue-access HTTP/repository tests; browser scenario P2/P6 |
| BP-14 | **G4 / profile and hours.** An assigned manager can create/edit only their venue's public profile and ordinary opening hours. The acknowledged write survives refresh, new login, and service restart; stale versions return `409` and do not overwrite. | Candidate venue HTTP/repository tests; browser scenario P4 |
| BP-15 | **G4 / beer, stock, price, removal.** An assigned manager can add at least three rows, edit price/tap/stock, bulk-save atomically, and remove a row. Current verified on-tap/in-stock venue-supplied data appears in the consumer API; guarded deletion bursts wait for admin; retries and concurrent stale versions do not duplicate or overwrite. | Candidate venue-inventory/public-price tests; browser/API scenario P4/P5 |
| BP-16 | **G4 / review and publication.** Community and venue-manager internal submissions remain pending, private evidence stays private, beer-catalog exceptions are resolved, admin approval publishes the correct public row once, rejection publishes nothing, and reload/separate session sees only approved data. | Candidate submission/evidence/catalogue tests; browser scenario P3/P5 |
| BP-17 | **G4 / support and admin operations.** Wrong-price, contact/support, missing-item request, moderation/review queues, KPI/coverage/retention/partner views, and operational health load for admin and remain isolated from public/manager roles. | Candidate admin/support tests; browser scenario P6 |
| BP-18 | **G4 / disabled scope and rewards truth.** Commercial, Pro, reports, specials, reward/prize, counter, redemption, POS, Pub Golf, and public happy-hour controls are absent from Free UI and their direct routes fail closed. Contribution points are labelled separately. Drink rewards are not claimed or demonstrated. | Free-scope config/route/UI tests; `npm run smoke:artifact:browser`; direct API denial matrix |
| BP-19 | **G5 / focused security review.** Enabled routes, auth/RLS, uploads, public inputs, origin/session protections, secrets, dependencies, and database/storage grants receive one release-diff-focused review; every confirmed included-scope finding is fixed and tested. | `npm run security:scan`; `npm run security:audit`; Supabase gate; diff review recorded below |
| BP-20 | **G5 / abuse cases.** Relevant SQL/command injection, reflected/stored XSS, CSRF/origin bypass, unsafe MIME/magic bytes/size, rate-limit failure/bypass, oversized payload, replay, and expensive-request paths are denied without leaking sensitive errors. | Existing hardening/upload/rate-limit/large-payload tests plus targeted regression tests for any repair |
| BP-21 | **G6 / artifact and configuration.** The exact built artifact starts with the documented command, `/health`, `/startup`, and `/ready` behave correctly, browser config is safe, missing mandatory provider/config values fail closed, connections/timeouts/retries are bounded, and no temporary process remains. | `npm run build`; both artifact smokes; env/provider/deployment tests; `npm run readiness:providers` |
| BP-22 | **G6 / deployed permanent staging.** The exact candidate is deployed only through the protected staging workflow with real Postgres, Supabase Auth/private Storage, Redis, Google Maps/Places, and OCR configuration; `/health`, `/startup`, `/ready`, callbacks/domain, logs, and one-replica journeys pass. | Protected deployment/readiness receipts and scenario P1-P6 on the deployed URL; local or `railway run` output is not PASS |
| BP-23 | **G6 / multi-instance and rollback.** The same candidate temporarily passes the existing two-replica concurrency, retry, restart, rolling-deploy, Redis-outage, pool-headroom, load/soak, and Postgres-compatible rollback-build contract, then safely returns to the approved topology. | Existing protected scale/load/rollback receipts; no ad-hoc Railway mutation |
| BP-24 | **G7 / repeatable demo.** Isolated labelled accounts/data run the complete P1-P6 walkthrough without production pollution or real invitations/payments. The reset removes only that fixture and is proved before the demo. | Local: `npm run test:seed:pintpath` / `npm run test:reset:pintpath` against an explicit safe test DB. Hosted: approved staging fixture/reset evidence; credentials remain outside Git |
| BP-25 | **G8 / evidence and handover.** Tested runtime SHA/artifact, environment, commands, outcomes, browser/provider evidence, limitations, owner prerequisites, and reset instructions are recorded here and in the existing release-evidence process with secrets/personal data redacted. `NOT RUN` and simulations never become PASS. | This document, exact commit/PR links, and `npm run release:evidence`; strict evidence only after every external item is real |

## Feature reference

| Feature | Where / role | State for this pilot | Backend and demonstration result |
| --- | --- | --- | --- |
| Public venue/price discovery | `/`; anonymous | Included | Express reads canonical venue/current price repositories. Show the fixed three-beer preview, freshness, and wrong-price action; no happy-hour or special rows. |
| Account and contribution access | `/account.html`; member | Included | Supabase identity exchanges for an HttpOnly Pint Path session; private dashboard reads the user's own records. Contribution points unlock catalogue access and are not drink points. |
| Missions and submissions | `/missions.html`, `/submit.html`; verified 18+ member | Included | Submission, optional private photo/menu evidence, catalogue normalization, and points eligibility are stored pending review. |
| Venue claim | `/venue-portal`; verified member with no assignment | Included | Claiming a known venue creates a pending request only. It grants no access. |
| Claim/manager administration | `/admin.html` → Partners; admin+AAL2 in production | Included | An independently verified claim can atomically create the manager assignment; manual assignment/revocation uses the same scoped repository and audit trail. |
| Free venue profile/hours | `/venue-portal` → Profile; assigned manager | Included | Routine venue-supplied fields persist immediately with optimistic concurrency. Restricted state/tier changes remain unavailable. |
| Beer/menu/stock/price | `/venue-portal` → Beers / stock; assigned manager | Included | Rows persist in the shared inventory; verified, active, on-tap/in-stock rows feed the server-gated consumer price view. Bulk save is atomic; stale edits fail. |
| Internal happy-hour capture | `/venue-portal` → Happy hours; assigned manager/admin | Included, internal only | Stored for venue/admin operations. It must produce no public API row, filter, badge, mission, SEO claim, or pitch claim. |
| Community/admin publication | `/submit.html`, `/admin.html` → Review; member/admin | Included | Pending submissions and private evidence are reviewed; approval publishes one normalized price record and eligible contribution points atomically. |
| Support and operations | Map report action, `/feedback.html`, account requests, `/admin.html`; relevant roles | Included | Private support/wrong-price/request queues and aggregate admin dashboards are role-restricted. |
| Menu OCR/admin capture | `/admin.html` → Data capture; admin | Included only when the real staging OpenAI/private-evidence provider gate passes | OCR output remains reviewable and cannot publish unresolved catalogue noise. Do not present it as available if provider readiness is blocked. |
| Venue Pro, reports, specials, billing | Commercial routes/tabs | Disabled | Must be absent from Free UI and denied server-side. |
| Pint Points / 50-point Free Pint Reward | Dormant account/counter/reward routes | Disabled and technically incomplete for Postgres | Do not demonstrate or claim. Requires a separately approved product/legal release and Postgres repository/concurrency implementation. |

## Repeatable bar walkthrough

Use a normal member, a prospective manager, a different negative-control user,
and an admin. Use clearly labelled synthetic data and separate browser contexts.
Never put passwords or provider tokens in this file.

### Main pitch (about 10 minutes)

1. Open `/` logged out. Search the labelled test venue, open its card, and show
   the fixed price preview, freshness, and “Report wrong price.” Value: Pint
   Path helps a bar keep discoverable facts current without exposing private
   customer data.
2. In a second browser, sign in as the prospective manager and open
   `/venue-portal`. Submit a claim for the known test venue. Show the pending
   message and failed attempt to open a different venue. Backend: a pending
   claim is stored; no assignment exists yet.
3. As admin, open `/admin.html` → Partners, independently verify the synthetic
   claim, and approve it. Return to the manager browser and refresh. Expected:
   exactly the assigned venue opens.
4. Open Profile. Change the description and an ordinary weekday interval, save,
   refresh, then sign out/in and re-open. Expected: the update persists. Value:
   the venue controls routine public facts with conflict protection.
5. Open Beers / stock. Add three labelled rows (for example Guinness pint $14,
   Carlton Draught pint $13, and Stone & Wood Pacific Ale pint $15), mark them
   on tap/in stock and confirmed, save, then edit one price, set one out of
   stock, and remove one safe row. Expected: final portal state is exact and a
   stale second-browser edit receives a refresh/conflict error.
6. Return to `/` in the anonymous browser and reopen the venue. Expected:
   current eligible venue-supplied rows appear; the out-of-stock/removed row
   does not masquerade as current; no happy-hour, special, reward, or Pro claim
   appears. Value: venue maintenance reaches consumers through the real API.
7. From `/submit.html`, submit one separate community price/photo update. In
   admin Review, show private evidence and approve it. Refresh the map in a new
   context. Expected: one normalized approved row appears and contribution
   points are awarded only to the contributor.
8. Submit one wrong-price report and one support message, show their private
   admin queues, then revoke the manager in Partners. Expected: the manager is
   denied immediately while public data and audit history remain.

### Complete scenarios

- **P1 — account:** `/account.html`; create/sign in with the configured
  Supabase flow, accept the current policies, confirm 18+, refresh, open a new
  session, exercise logout and session revocation. Expect no provider token in
  page storage or ordinary app requests.
- **P2 — claim/isolation:** `/venue-portal`; submit the known test venue ID,
  verified account email, synthetic role/contact details, and a clear test
  note. Expect `pending`, no portal access, admin-only approval, one assigned
  venue afterward, and denial for the control user/other venue.
- **P3 — community publication:** `/missions.html` → chosen test venue →
  `/submit.html`; enter observed time, one beer/serve/price/tap row and approved
  test evidence. Expect pending status; admin resolves any catalogue item and
  approves; consumer sees one current record and contributor sees points.
- **P4 — venue maintenance:** `/venue-portal` → Profile and Beers / stock; save
  the changes in steps 4–5, reload, re-login, restart the service in the
  controlled environment, and repeat one request with the same idempotency or
  version identity. Expect one durable final state and no duplicate event.
- **P5 — public truth:** `/` in an anonymous fresh context; compare the public
  API/card with the final approved/venue-supplied state. Expect only current
  eligible rows and the fixed Free preview; internal happy hours and all
  deferred commercial/reward surfaces remain absent.
- **P6 — operations/revocation:** map wrong-price action, `/feedback.html`,
  account request, and `/admin.html` Review/Partners/Analytics. Expect isolated
  private queues, aggregate-only admin data, successful revocation, and denied
  former-manager API access.

### Reset

For a local SQLite rehearsal, point `PINTPATH_TEST_DATABASE_PATH` at a dedicated
non-production path, run `npm run test:seed:pintpath`, complete the walkthrough,
then run `npm run test:reset:pintpath` against the identical path and verify the
`pintpath-release:*` accounts/venues/events are gone. The scripts refuse a
production origin and remove only the namespaced fixture.

The SQLite reset is not a Postgres staging reset. Permanent-staging PASS needs
an approved fixture/reset receipt against the exact isolated staging target;
until that exists, use disposable labelled accounts/venue data and the normal
account-deletion/revocation flows, and do not claim the hosted reset check has
passed.

## Results and evidence

Initial assessment only; acceptance verification has not yet run on the task
candidate. Current external facts are blockers, not inherited PASS results:

- the starting SHA's current GitHub CI/readiness/native/CodeQL runs are green;
- permanent staging is intentionally stopped and `/health`, `/startup`, and
  `/ready` return the provider's `502` fallback;
- production serves an older SQLite-era SHA and is outside this task's mutation
  authority; and
- every required item in `docs/release-evidence.json` is pending.

Final per-check statuses, exact candidate identity, commands, and evidence links
will be recorded here after the maximum three repair/verification passes.

## Owner-controlled prerequisites

These do not authorize an operation by appearing here:

1. Decide whether the bar pitch remains the approved Free pilot above. Adding
   drink Pint Points requires written eligibility/venue-tier/identity rules,
   Victorian liquor/RSA/privacy approval, participating-venue acceptance, and a
   separately reviewed Postgres implementation candidate.
2. Supply/confirm the protected permanent-staging provider authority and run
   the existing Google Maps/Map ID, Google Places, OpenAI, Supabase key,
   deployment, and sealed-variable sequence. The stopped staging deployment
   cannot be restarted or replaced ad hoc.
3. Run the exact-candidate one- then temporary two-replica staging, Auth/role,
   private Storage, recovery, load/soak, rollback, and fixture-reset evidence.
4. Only after those pass, separately authorize the prepared production
   migration/deployment sequence. This task does not merge, migrate, or deploy
   production.
