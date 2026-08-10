# Pint Path internal readiness audit — 15 July 2026

> Historical, non-executable snapshot. Its Railway update/deploy/region-move
> language is superseded by the current production launch and provider
> runbooks. No provider command here is authority: every Railway write now
> requires the tracked `readiness:railway:mutation-boundary` executor with an
> immediate preflight and unconditional postflight.

## Verdict

The audited candidate has no known internal code, dependency, database-integrity, or release-automation blocker. The complete local gate passes, the linked Supabase migrations are applied, and the live Supabase advisor and schema-lint gates return no warning or error.

That is an internal release-candidate verdict, not a claim that the entire launch is perfect. The remaining work requires provider-console access, a brief infrastructure maintenance window, real devices, real venues, billing/email/store approvals, and the 12 human evidence sign-offs.

## Verified internal state

| Area | Result |
| --- | --- |
| Full application gate | Build, 51 test files, 618 tests, security scan, and production deployment guard pass |
| Dependency security | `npm audit --audit-level=low` reports 0 vulnerabilities; all 232 installed packages have verified registry signatures and 46 have attestations |
| Runtime baseline | Production and CI run Node 22; `.node-version` and Node 22 type declarations now prevent development/runtime API drift |
| Request resilience | Browser API, Redis, Supabase, Storage, Google, OpenAI, Stripe, Resend, backup, restore, import, and smoke-check network paths have bounded deadlines |
| Background jobs | Backup and monthly-report schedulers contain status/lease failures; backup failure or contention retries after 15 minutes rather than waiting 24 hours |
| Session integrity | Session creation and the ten-device cap are atomic; evicted sessions also revoke their discount passes and provider-session reuse when no sibling session remains |
| SQLite integrity | `integrity_check=ok`, WAL and foreign keys enabled, all SQLite foreign keys indexed, and 0 live foreign-key violations |
| Supabase migrations | Local and remote histories align through `20260715010000`; all nine new foreign-key indexes are installed |
| Supabase security | Every public table has RLS; current browser grants are narrow; future `postgres` objects receive no implicit Data API grants; live advisors and lint report no warning/error |
| Supabase health | PostgreSQL 17.6, no blocked or long transactions, all constraints/indexes valid, daily managed backups completing, and 99.997% cache hit in the audit sample |
| Supply chain | npm/Gradle/Actions Dependabot coverage, pinned CodeQL analysis, immutable Actions SHAs, and a checksum-pinned Gradle 8.9 distribution |
| Secret scanning | The local scanner detects provider keys even beside environment fallbacks and never prints matched secret material |
| Railway capacity | 47 MB of 434 MB volume used, no SQLite corruption, and no current resource-exhaustion signal |

## Remediation completed

1. Added and applied nine missing Supabase foreign-key indexes for reward, points, and leaderboard relations.
2. Disabled implicit Data API exposure locally and revoked future public table, sequence, and function defaults for the hosted `postgres` object owner. Future access must be granted explicitly.
3. Made new-session creation and the ten-active-session ceiling one transaction, guaranteed the newly issued token survives tie ordering, and contained provider-session and discount-pass reuse.
4. Corrected field-test readiness so a configured Supabase dependency is always live-probed; optional no longer means falsely healthy.
5. Added bounded Supabase fetches throughout the server, readiness, backup, deletion ledger, restore drill, provider check, venue import, and crawler tools.
6. Added browser request deadlines with friendly retry guidance, longer upload/OCR allowances, and a ceiling on legacy-cookie migration.
7. Added Redis command deadlines and retained the production fail-closed behavior.
8. Prevented database lease faults from being misreported as ordinary lock contention.
9. Contained synchronous and asynchronous backup/report scheduler callback failures and stopped temporary-directory cleanup from masking a completed backup.
10. Removed the obsolete importer and `node-fetch` v2, aligned development types with Node 22, and added a repository Node version marker.
11. Hardened the secret scanner against environment-fallback bypasses and secret echoing; CI now fails on low, moderate, high, or critical npm vulnerabilities.
12. Added CodeQL, npm/Gradle Dependabot coverage, and the official Gradle distribution checksum, with regression contracts for each control.

## Operator work before the weekend field test

### 1. Verify the published candidate

- Wait for CI, automated readiness, native-app checks, CodeQL, Railway deployment, and production health to finish on the same commit.
- Confirm `/ready` identifies that commit and all required dependencies are healthy.
- Confirm the first post-deploy off-site backup succeeds and the stale pre-fix lease state is gone.
- Run public production smoke plus signed-in user, venue, and AAL2 admin smoke against the deployed commit.

### 2. Verify or rotate the public Google Maps browser key

GitHub secret scanning has one open historical Google API-key alert. The value is a browser Maps key and is necessarily delivered publicly, but it must be restricted in Google Cloud before field testing:

- Allow only the exact production/referrer origins that need the key, including `https://pintpath.au/*`.
- Restrict it to the minimum browser Maps APIs; do not allow Places, Geocoding, or server APIs on this key.
- Rotate it if those restrictions were ever absent, update Railway, deploy, and then resolve the GitHub alert with the documented public-client rationale.

### 3. Schedule the Railway region move

The active replica is in Amsterdam while users and Supabase are in Australia. The audit measured roughly 1.52 seconds for a direct Supabase venue request from Railway, contributing to public venue responses around 1.8–3.0 seconds.

- Move the singleton service and attached volume to Railway Singapore (`asia-southeast1-eqsg3a`).
- Schedule a maintenance window because moving an attached volume causes downtime.
- Afterward verify the volume, SQLite integrity, `/ready`, a fresh backup, and at least 20 venue-directory latency samples.

Do not add a second active region while the application uses one attached SQLite volume.

### 4. Finish provider/repository controls

- Enable Supabase database SSL enforcement during a brief maintenance window; Supabase documents a database restart for the change.
- Keep database CIDRs open until Railway and emergency operator egress are known, then replace `0.0.0.0/0` and `::/0` with an evidenced allowlist.
- Add dedicated production smoke credentials for user and venue monitoring. Use a fresh AAL2 admin token only for a manual release gate, never as a long-lived scheduled secret.
- Require CodeQL after its first successful run and decide whether main-branch rules should apply to administrators.
- Add a production-environment reviewer if a second trusted operator is available.

### 5. Close external evidence

All 12 launch evidence records remain intentionally pending: production smoke, all-role smoke, labelled OCR corpus, three venue pilots, POS/manual fallback, restore rehearsal, accessibility/devices, legal/billing, iOS release, and Android release.

Production monthly-report email delivery also remains disabled until the Resend domain, sender, sending-only API key, and dry run pass.

## Non-blocking post-pilot work

- Split the largest service/repository/browser files only after the field-test candidate is frozen and characterization coverage protects behavior.
- Let Dependabot raise compatible library updates as isolated pull requests; there is no known vulnerability requiring a pre-test upgrade batch.
- Evaluate Supabase PITR against the desired recovery-point objective. Daily managed backups and the independent application backup are healthy today.
- After confirming a fresh restorable copy in the independent backup project, remove the 301 legacy backup objects (about 177 MB) retained in the primary Supabase project.
- Revisit the fixed Auth database connection allocation and add performance thresholds when field-test traffic provides realistic measurements.

## Release decision

Internal candidate: **go**.

Weekend field testing: **go after the candidate deploy is verified**; treat latency results as provisional until the Railway region move.

Broad public launch: **no-go until all 12 external evidence items pass against one frozen candidate SHA**.
