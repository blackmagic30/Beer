# Pint Path Production Readiness Report

Date: 2026-05-25
Latest update: 2026-08-03

## Executive Summary

Pint Path is substantially hardened for a controlled Melbourne launch, but it
is not ready for the requested full-scale production launch. The candidate has
strong server-side price gating, role authorization, provider/configuration
guards, deletion handling, private evidence access, Redis-backed rate limiting,
upload validation, security auditing, and local build/test/security gates.

The remaining blockers include architecture as well as live proof: the current
Railway-volume SQLite service is single-region and cannot substantiate a
high-availability/full-scale claim; the current second-Supabase-project copy is
not provider-enforced immutable disaster recovery; the real staging service is
not reachable at the documented hostname; production data coverage/freshness
fails; and Supabase, Resend, MFA, deletion, restore, monitoring, authenticated
journeys, signed iOS/TestFlight, App Review, and crash symbolication still need
evidence against one frozen SHA. The old production deployment reports Redis,
Storage, and an off-site copy healthy, but that is not candidate or immutable
restore proof.

## Latest Patch: 3 August 2026 production-launch recheck

This candidate adds the launch-blocking account-deletion completion path, closes paid enrolment while pricing is deferred, hardens the staged/production provider gates, and makes iOS Release configuration fail closed. It has not been deployed.

- Added an encrypted SQLite deletion-notice outbox, deterministic Resend idempotency, signed delivery webhooks, bounded retries, retention/purge enforcement, operator resolution, restore suppression, and privacy-safe backup handling in schema 15.
- Added the final Supabase migration that removes all direct `anon` and
  `authenticated` public Data API/table/sequence/RPC/helper privileges. App data
  is Express-only; a real captured pre-deletion JWT denial matrix remains a
  staging gate.
- Changed completed account deletion to remove the user's raw submissions,
  submission items/free text, contribution ledger rows, and public price rows
  derived from those submissions. Local evidence bytes, URLs, sizes, ownership,
  and deletion timestamps are scrubbed inside the same transaction; external
  object cleanup remains post-commit and cannot falsely turn a committed
  deletion into a failed deletion. Reviewer references on other users' records
  are detached.
- Corrected the iOS recovery redirect to the verified `/auth/callback` flow and
  added clear same-email/Forgot-password guidance for existing Google website
  users. Real same-Supabase-ID/no-duplicate provider proof is still required.
- Removed happy-hour discovery, contribution, mission, SEO, pricing, community,
  and promotional surfaces from the public launch scope while preserving
  venue/admin collection and accurate legal disclosure. The server now also
  filters happy-hour/special price rows and happy-hour missions and rejects
  public happy-hour submissions, so changing browser markup cannot bypass the
  launch scope.
- Made the pricing deferral fail closed: production requires both enrolment
  flags false, trial days zero, no payment-method trial, public `pricing: null`,
  and no old consumer/venue amounts or paid-upgrade copy in current public
  responses. Pricing will be a separate later candidate.
- Added `/startup`, deletion scheduler/queue operational readiness, exact canonical production URL validation, isolated deletion-rehearsal constraints, and a documented one-replica/one-region launch constraint while SQLite owns the outbox and webhook correlation state.
- Kept `COMMERCIAL_LAUNCH_ENABLED=false` and `CONSUMER_PAID_ENROLLMENT_ENABLED=false`; Stripe is not a startup requirement while paid enrolment remains closed.
- Restricted the launch auth contract to Google on web and email/password in the first iOS release. Apple remains disabled until token revocation is implemented and tested.
- Added an ignored iOS `Config.xcconfig` path, Release-only Supabase validation, protected CI configuration, and compiled-archive inspection that does not print the public key.
- Verified both Railway TXT ownership records and the `www.pintpath.com.au` CNAME. The live custom domain returns HTTP 200, so the Railway warning shown on 3 August is stale rather than a missing TXT record.
- The GoDaddy apex forward for `pintpath.com.au` currently points through `http://pintpath.au/`; change its destination to `https://pintpath.au/`. The candidate redirects attached `www` and legacy hosts directly to the canonical HTTPS origin.
- The currently deployed production SHA remains `95b9f2da5e9a99692c8cfafba90d2c29e63ccbc8`; its public `/health` and `/ready` checks pass, Redis and off-site backup dependencies report healthy, and the last reported off-site backup success is `2026-08-02T22:57:58.427Z`.
- The documented staging hostname currently returns HTTP 404 and must be reconciled against the actual Railway staging service/domain before any write rehearsal.
- Fresh public data readiness is not launch-ready: 612 public venues, 288 price rows, only 5 of 611 marketed venues meeting the three-current-trusted-price threshold (0.82%), newest qualifying data about 685 hours old, three malformed structured addresses, and zero current happy-hour coverage. The candidate must be deployed to isolated staging and the strict data gate rerun because the old production SHA does not expose every new status/evidence field.
- Release evidence is structurally valid and current but intentionally remains 0/12 complete until real provider, restore, pilot, accessibility, legal, authenticated-role, and TestFlight proof is captured against one frozen SHA.
- The current Supabase off-site copy is classified as a verified operational
  restore copy, not an immutable independent backup. Full-scale launch requires
  a separate provider/region with object lock/WORM, an append/create-only
  application principal, and separately controlled read/retention authority.
- Apple-only crash reports may support a controlled cohort with manual review;
  broad expansion requires a privacy-reviewed production crash source, dSYM
  symbolication, alert delivery, zero critical crashes, and the documented
  crash-free threshold.

Current integrated verification on this candidate:

- `npm run build`: passed.
- `npm test -- --reporter=dot`: 74 files and 978 tests passed.
- `npm run security:scan`: passed.
- `npm run security:audit`: zero vulnerabilities.
- `npm run deployment:guard:check`: passed.
- `npm run release:evidence`: valid/current; 12 required items, 0 passed and 12 pending as designed.
- `git diff --check`: passed.
- unsigned iOS Debug simulator build: passed.
- iOS Release without production public config: rejected as designed.
- synthetic unsigned iOS Release archive plus compiled configuration inspection: passed with Xcode 26.5 / iOS 26.5 SDK.
- public production smoke: 9 passed, 0 failed, 3 authenticated-role checks skipped because dedicated credentials were not supplied.

## Latest Patch: 9/10 Launch Gates

This pass converted the final launch-readiness gaps into concrete gates without touching production data or changing database behavior:

- Added `npm run readiness:launch`, a strict production provider preflight that treats warnings as launch blockers.
- Added `docs/launch-9-readiness-gates.md` for provider proof, authenticated owner-journey evidence, monitoring/restore proof, performance budgets, accessibility/device checks, and legal/support review.
- Added an HTTP-level release test for the authenticated owner portal journey: login, assigned venue access, profile, beer/stock, happy-hour, Pro special, support request, cross-owner blocking, and pending-review state.
- Added `/.well-known/security.txt` and `/security.txt` as private security-report discovery paths.
- Increased small-screen nav/footer touch target guardrails.
- Updated Supabase live verification notes for deprecated Postgres 14 and current Data API exposure/grant expectations.

## Latest Patch: Production Guard Tightening

This pass focused on the highest-risk code paths that can be verified locally without touching production:

- Changed production rate limiting to fail closed by default when Redis is not configured. `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION` now defaults to `false`, so in-memory fallback must be an explicit, time-boxed emergency choice rather than the default.
- Hardened Stripe webhook verification by rejecting missing/non-numeric timestamps and signatures outside a five-minute tolerance window. This reduces replay risk while preserving raw-body signature verification and existing idempotency checks.
- Re-ran the core validation suite, dependency audit, secret scan, whitespace check, and a local compiled-server smoke test for `/health`, `/ready`, and `/api/business/config`.
- Confirmed `/api/business/config` returned only browser-safe public configuration during the smoke test; no service-role keys, Stripe secrets, or provider secrets were exposed.

## Latest Patch: Account Controls, Consent, And Incident UX

This pass closed several in-repo product-trust gaps without touching production data:

- Added a browser privacy-choice banner. Optional analytics are off until the user chooses “Allow optional analytics” or saves signed-in privacy settings.
- Added account quick export and deletion-review request endpoints/actions. Quick export returns account/submission/activity data without raw evidence files, raw evidence paths, raw tokens, passwords, or exact stored upload coordinates.
- Added feedback priority/triage metadata so security, privacy, deletion, data export, billing, abuse, and moderation requests rise above general product feedback in admin queues.
- Added a public `/status.html` status-and-incidents page that explains outage, security, privacy, and provider verification paths without claiming external monitoring/backups are already verified.
- Added global skip-to-main-content and focus-visible affordances for baseline keyboard accessibility.
- Updated tests and production checklist entries for consent, account export/deletion review, status page, and support triage.

## Production Readiness Verdict

**Not ready for full-scale production.**

The codebase is mostly ready for a controlled beta behind careful operations, but full production should wait until the P0/P1 follow-ups in `PROD_FOLLOWUPS.md` are resolved or explicitly accepted by the business owner.

## Stack And Runtime

- Runtime: Node.js 22+ with TypeScript and Express.
- Frontend: static HTML/CSS/JS in `viewer/`.
- Database: SQLite via `better-sqlite3`, initialized additively from `src/db/schema.sql`.
- Auth: Supabase email/password and Google provider identities are exchanged for scoped Pint Path app sessions. Apple OAuth is disabled for this launch until token revocation is implemented. The browser app session uses an HttpOnly cookie; direct Pint Path password signup/login is development/localhost-only. Production admin actions require verified email and, during normal operation, AAL2 step-up claims.
- Payments: Stripe Checkout/webhooks plus demo billing mode guarded by env.
- External services: Supabase, Google Maps, OpenAI, Stripe. Historical phone-call automation code has been removed from the repository and is not built, mounted, or configured.
- Hosting assumptions: Railway, with build `npm run build`, start `node dist/src/server.js`.
- CI: GitHub Actions in `.github/workflows/ci.yml`.

## Major Risks Found

- High-severity dependency advisory in a retired phone-provider dependency chain; patched and then removed with the retired package dependencies.
- Production readiness only had a shallow `/health`; added `/ready` to initialize database-backed routers before allowing traffic.
- Production config could silently start with HTTP public URL, no admin email list, no Google Maps key, missing source-evidence signing secret, no Redis limiter, or disabled admin MFA; added fail-fast guards.
- Error logging redacted structured metadata but not top-level error messages/stacks; patched to redact before logging.
- Unhandled promise rejections were logged but process continued in an undefined state; patched to redact and exit.
- CI ran build/test/secret scan but not dependency audit; added `npm run security:audit`.

## Changes Made In This Pass

- Retired the old phone-call prototype from the app:
  - removed the legacy Twilio/ElevenLabs source/scripts/tests from the repository
  - removed active routes and package dependencies
  - removed active env vars and deployment instructions
- Removed fresh local SQLite call tables from `src/db/schema.sql`.
- Renamed local venue partner tables from old `bar_*` names to `venue_*` names while preserving a startup migration for existing local SQLite databases.
- Added Supabase `venue_menu_captures` migration as the product-correct replacement for the old `call_results` scratch table; it copies existing `call_results` rows forward if present but does not drop production data.
- Updated venue portal and docs to use venue-focused language while preserving bar/pub as a public venue category.
- Added Node runtime declaration and dependency audit script in `package.json`.
- Added Redis-backed rate limiting via `ioredis` with production fail-closed behavior when Redis is unavailable unless an explicit temporary override is set.
- Added production admin MFA/verified-email guards and tests for anonymous, normal, admin-without-MFA, and admin-with-MFA cases.
- Added production verified-account guards for uploads/verifications and tests for unverified users.
- Added private source-evidence object references and short-lived signed server URLs; public submission records no longer expose raw data URLs or external source URLs.
- Added Supabase migration fields/policies for verified email, MFA claims, and the private `beermap-source-evidence` Storage bucket.
- Retired the old phone-call webhook surface from the active runtime.
- Updated `package-lock.json` through `npm audit fix`:
  - `axios` to `1.16.1`
  - `follow-redirects` to `1.16.0`
  - `postcss` to `8.5.14`
- Added high-severity dependency audit to CI.
- Added production env fail-fast checks:
  - `PUBLIC_BASE_URL` must be HTTPS in production.
  - `ADMIN_EMAILS` can be blank while the official owner/admin email is pending; admin routes fail closed until it is configured.
  - `GOOGLE_MAPS_API_KEY` is required in production.
  - `REQUIRE_ADMIN_MFA_IN_PRODUCTION` defaults to enabled. A temporary owner-led field-test exception may set it false only while the admin allowlist and verified email remain enforced.
  - `SOURCE_EVIDENCE_SIGNING_SECRET` must be a unique high-entropy secret of at least 32 bytes; production boot fails without it.
  - `REDIS_URL` can be pending at boot; rate-limited write/auth/payment routes fail closed in production unless the explicit in-memory override is set.
- Added `/ready` readiness route that initializes lazy routers/database-backed services.
- Added `Cache-Control: no-store` to `/config.js`.
- Redacted top-level production error messages and development stack logs.
- Redacted uncaught exception/unhandled rejection logging and made unhandled rejections terminate the process.
- Added a regression test proving production error responses/logs redact Stripe/Bearer-like secrets.
- Updated deploy docs with `/ready`, `npm run security:audit`, and production env requirements.

## Existing Critical Controls Verified In The Branch

- Public exact-price records are server-gated and redacted by default.
- Anonymous and free accounts receive only the fixed server-owned preview; non-preview exact prices require premium, contributor, or admin access.
- Admin APIs return unauthorized/forbidden to unauthenticated/non-admin callers.
- Legacy call/result APIs are removed from the active router and return not found; they are not an admin API surface.
- Venue managers are scoped to assigned venues only.
- Venue-manager submitted changes are saved as pending review and do not publish until admin approval.
- Pending venue-manager changes are visible only to the owning manager and admins.
- Rejected pending changes do not publish.
- Contribution points are awarded only after admin approval and are ledgered.
- Users cannot verify their own submissions.
- Uploads validate MIME/magic bytes/size and reject unsafe URL extensions.
- Production source evidence uses private references and signed URLs; inline demo evidence is not exposed publicly.
- Stripe webhooks reject missing/invalid signatures outside demo mode and use event idempotency.
- Security audit logs redact sensitive metadata.
- Analytics buckets below the privacy threshold are suppressed.

## Verification Commands Run

| Command | Result | Notes |
| --- | --- | --- |
| `git status --short --branch` | Passed | Confirmed working branch and dirty files. |
| `find .. -name AGENTS.md -print` | Passed | No project-specific `AGENTS.md` found. |
| `npm audit --audit-level=high` | Failed initially | Found high-severity `axios` advisory. |
| `npm audit fix` | Passed | Updated vulnerable transitive packages. |
| `npm audit --audit-level=high` | Passed | `found 0 vulnerabilities`. |
| `npm install --package-lock-only` | Passed | Synced lockfile after package script/engine edits. |
| `npm ci` | Passed | Clean dependency install; npm reported zero vulnerabilities. |
| `npm run build` | Passed | TypeScript build and schema copy succeeded. |
| `npm test -- --runInBand test/business-demo.test.ts` | Failed | Vitest does not support Jest's `--runInBand`; no tests executed. |
| `npm test -- test/business-demo.test.ts` | Passed | 43 tests passed. |
| `npm run security:scan` | Passed | 115 tracked files checked. |
| `npm run security:audit` | Passed | `found 0 vulnerabilities`. |
| `npm test` | Passed | 18 test files, 217 tests passed. |
| `npm run check` | Passed | Build, full tests, and secret scan passed. |
| `git diff --check` | Passed | No whitespace errors. |
| local compiled-server smoke: `/health` and `/ready` on port `3137` | Passed | First curl attempt happened before bind, retry succeeded; `/ready` initialized backend services. |
| `npm install ioredis` | Passed | Added Redis client dependency for distributed rate limiting. |
| `npm run build` | Failed initially | `ioredis` import/type shape needed adjustment under `moduleResolution: NodeNext`. |
| `npm run build` | Passed | After switching to named `Redis` import. |
| `npm test -- test/business-demo.test.ts` | Passed | 46 targeted business/security tests passed. |
| `npm test` | Passed | 18 test files, 220 tests passed. |
| `npm run check` | Passed | Build, full tests, and secret scan passed. |
| `git diff --check` | Passed | No whitespace errors. |
| `npm run security:scan` | Passed | 115 tracked files checked. |
| `npm run security:audit` | Passed | `found 0 vulnerabilities`. |
| `npm ci` | Passed | Clean dependency install; npm reported zero vulnerabilities. |
| `npm run check` | Failed once after clean install | Local `node_modules/better-sqlite3` was missing packaged `lib/methods/*`; removed/reinstalled package and reran `npm ci`. |
| `rm -rf node_modules/better-sqlite3 && npm install` | Passed | Rehydrated missing package files. |
| `npm ci` | Passed | Clean install succeeded after cache/package rehydration. |
| `npm audit --audit-level=high` | Passed | `found 0 vulnerabilities`. |
| `npm run check` | Passed | Build, 220 tests, and expanded tracked/untracked secret scan passed. |
| local compiled-server smoke: `/health` and `/ready` on port `3138` | Passed | Built server booted, `/health` and `/ready` returned success. Local interface self-check logged unreachable link-local interfaces, but loopback readiness passed. |
| `npm run build` | Passed | TypeScript build and schema copy passed after latest account/consent/status patch. |
| `npm test -- test/business-demo.test.ts test/account-page.test.ts` | Passed | Vitest ran the repo test suite; 16 files and 151 tests passed. |
| `npm test` | Passed | 16 test files and 151 tests passed. |
| `npm run check` | Passed | Build, full tests, and secret scan passed. |
| `npm run security:scan` | Passed | 154 tracked/untracked files checked. |
| `npm run security:audit` | Passed | `found 0 vulnerabilities`. |
| `git diff --check` | Passed | No whitespace errors after latest patch. |
| `npm run check` | Failed once, then passed | Initial failure was a stale Stripe webhook timestamp regression test using the fake test clock incorrectly; patched the test and reran successfully. Final run: build passed, 19 test files and 179 tests passed, secret scan passed. |
| `npm run security:audit` | Passed | `found 0 vulnerabilities` after latest production guard pass. |
| `npm audit --audit-level=high` | Passed | `found 0 vulnerabilities` after latest production guard pass. |
| `git diff --check` | Passed | No whitespace errors after latest production guard pass. |
| local compiled-server smoke: `/health`, `/ready`, `/api/business/config` on port `3141` | Passed | Built server booted locally. `/health` and `/ready` returned success; `/api/business/config` returned browser-safe config only. |

If this document changes after final validation, rerun all commands in `PRODUCTION_CHECKLIST.md`.

## Remaining Blockers

See `PROD_FOLLOWUPS.md` for owners, proof, and pass criteria. The P0 set is:

- Migrate authoritative SQLite/outbox/job state to shared Postgres and prove
  replicas for the requested full-scale launch, or explicitly reduce the launch
  to a measured single-region cohort that is not described as full-scale/HA.
- Reconcile the actual isolated Railway staging service; the documented hostname
  returned 404 on 3 August.
- Repair and reverify production data until every marketed suburb independently
  passes the signed coverage/freshness/status/evidence thresholds.
- Apply the final Supabase revoke migration and prove anonymous/authenticated/
  captured-old-JWT denial for Data API, RPC, Storage, and the Pint Path API;
  prove Google web auth, iOS same-account password recovery, admin AAL2, and SMTP.
- Run the complete account-deletion/Resend rehearsal in isolated staging.
- Create a separate-failure-domain, provider-enforced WORM/object-lock backup and
  prove a schema-15 restore, integrity, RPO/RTO, and two-person teardown.
- Complete capacity, Redis outage, monitoring, alerting, DAST, breach tabletop,
  accessibility, and first-72-hour operating evidence.
- Complete legal/entity/App Privacy review and signed iOS archive, physical-device
  TestFlight, crash, App Review, and storefront evidence.
- Reach 12/12 release-evidence items on one frozen SHA with no critical/high open
  defects.

Stripe lifecycle, report delivery, public specials/happy hours, rewards,
counter/POS, Android, and final pricing are deliberately deferred and are not
blockers while all associated flags and public surfaces remain disabled.

## Assumptions Made

- No production deployment or production data was touched.
- Local/test SQLite data only was used.
- Live Supabase, Resend, Apple, OpenAI, Google, Railway staging, and monitoring
  authority was not available locally, so provider-level verification remains a
  staging/release-owner action.
- The current target is full-scale production readiness, not merely a small private beta.

## Recommended Next Steps Before Launch

Follow `docs/production-launch-runbook.md` in order. The next safe actions are:

1. Leave the working Railway TXT records alone; correct only the GoDaddy apex
   forwarding target to `https://pintpath.au/` and verify the redirect matrix.
2. Restore and identify the exact isolated staging stack and deploy this candidate
   there with the Supabase revoke migration and schema 15.
3. Complete the Supabase/Auth/deletion/Resend denial and lifecycle proofs.
4. Repair the production data set and rerun the strict data gate.
5. Finish immutable backup/restore and choose/prove the full-scale Postgres
   architecture before capacity and failure testing.
6. Complete monitoring, security, legal, accessibility, and iOS release evidence.
7. Freeze one SHA, rerun every automated/live gate, deploy closed/free, reach
   12/12 evidence, obtain App Review approval, and use a controlled rollout.

Do not enable pricing during this sequence. Handle pricing and any venue free
offer later as a new reviewed candidate.
