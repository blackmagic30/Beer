# Pint Path Production Readiness Report

Date: 2026-05-25

## Executive Summary

Pint Path is substantially hardened for a controlled Melbourne beta, but it is not yet ready for full-scale production deployment without provider/dashboard verification. The application now has strong server-side price gating, admin/venue-manager authorization tests, pending-review workflows for venue-manager changes, production admin MFA step-up guards, private source-evidence references with signed server URLs, Redis-capable rate limiting, Stripe webhook signature handling, upload validation, security audit logging, production config guards, and a CI path that runs build/test/secret scan/dependency audit.

The remaining blockers are now mostly provider and operations verification: Supabase MFA/AAL2 must be configured and tested, private Supabase Storage should be verified before broad source-evidence uploads, Redis must be provisioned for production rate limiting, backup/restore and monitoring must be tested, and live Stripe/Supabase/Google configuration must be verified in staging. The old phone-call automation surface has been retired from the active app.

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
- Auth: local Pint Path bearer sessions plus optional Supabase OAuth session exchange; production admin actions require verified email and AAL2 step-up claims.
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
  - `REQUIRE_ADMIN_MFA_IN_PRODUCTION` must remain enabled in production.
  - `SOURCE_EVIDENCE_SIGNING_SECRET` can be pending at boot; source-evidence links fail closed until configured.
  - `REDIS_URL` can be pending at boot; rate-limited write/auth/payment routes fail closed in production unless the explicit in-memory override is set.
- Added `/ready` readiness route that initializes lazy routers/database-backed services.
- Added `Cache-Control: no-store` to `/config.js`.
- Redacted top-level production error messages and development stack logs.
- Redacted uncaught exception/unhandled rejection logging and made unhandled rejections terminate the process.
- Added a regression test proving production error responses/logs redact Stripe/Bearer-like secrets.
- Updated deploy docs with `/ready`, `npm run security:audit`, and production env requirements.

## Existing Critical Controls Verified In The Branch

- Public exact-price records are server-gated and redacted by default.
- Anonymous/free reveal limits are enforced server-side.
- Admin APIs return unauthorized/forbidden to unauthenticated/non-admin callers.
- Legacy call/result APIs remain admin-only.
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

If this document changes after final validation, rerun all commands in `PRODUCTION_CHECKLIST.md`.

## Remaining Blockers

See `PROD_FOLLOWUPS.md` for owner/action details.

P0 blockers for full-scale production:
- Supabase/provider MFA setup and staging AAL2 verification are not completed. The code guard is implemented and fail-closed.
- Private source evidence is no longer publicly exposed, but production Supabase Storage/private object storage must still be provisioned and tested before large-scale public uploads.
- Production backup/restore, monitoring, alerting, and incident ownership have not been verified.

P1 blockers before broad paid/public rollout:
- Live Stripe Checkout/webhook flow needs provider-backed test verification.
- Supabase RLS migration/policies need to be applied and audited before any direct browser writes. The migration has been expanded but not applied to a real project here.
- Redis-backed rate limiting must be provisioned and smoke-tested with `REDIS_URL`; do not use the in-memory production override for full-scale launch.
- Supabase Confirm Email/custom SMTP must be configured for verified-account onboarding. Local email/password self-serve remains blocked for production until verification is implemented.
- Production observability is currently mostly logs/checklists rather than alerting/tracing/SLOs.
- Legal/privacy review of Terms, Privacy, cookie/analytics consent, account export/deletion wording, and alcohol/responsible-service wording remains a human/provider task before broad public scale.

## Assumptions Made

- No production deployment or production data was touched.
- Local/test SQLite data only was used.
- Live Stripe, Supabase, OpenAI, and Google provider credentials were not available locally, so provider-level verification remains a production/staging action.
- The current target is full-scale production readiness, not merely a small private beta.

## Recommended Next Steps Before Launch

1. Configure Supabase MFA/Auth Assurance Level and verify an admin receives `aal2` before using admin routes in staging.
2. Provision Supabase Storage/private object storage for `beermap-source-evidence` and verify signed evidence access.
3. Configure production backups, monitoring alerts, log retention, and incident ownership, then run a restore drill.
4. Run Stripe CLI signed-webhook tests against staging with real test keys.
5. Apply and audit Supabase RLS policies in the real Supabase project.
6. Provision Redis/Upstash/Railway Redis and set `REDIS_URL`; avoid `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true` outside emergency beta windows.
7. Run a mobile browser smoke test and at least one staged end-to-end user/venue/admin approval path before launch.
