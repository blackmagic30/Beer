# Pint Path Production Follow-Ups

These are the remaining actions after the production-readiness pass. Priorities are based on a full-scale public production deployment, not a small controlled field test.

## P0: Admin MFA / Step-Up Protection

- Why it matters: Admins can approve submissions, publish venue data, assign venue managers, change user status, and access sensitive queues. Password-only admin accounts are too weak for full-scale production.
- Status: Repo-side guard implemented. In production, admin APIs require an authenticated account, admin role/allowlist, verified email, and a fresh `aal2` MFA claim within `ADMIN_MFA_MAX_AGE_MINUTES`.
- Still required: Configure Supabase MFA/Auth Assurance Level enforcement in the Supabase dashboard and verify an admin can step up to AAL2 in staging.
- Blocks production: Yes until provider MFA is configured and tested. The code is fail-closed, so admins without AAL2 will be blocked in production.

## P0: Private Object Storage For Source Evidence

- Why it matters: Menu/tap-list/source evidence can contain private or sensitive data. Inline/demo storage is not appropriate for production scale.
- Status: Public exposure risk is closed in code. Source evidence is now stored behind private object references and short-lived HMAC-signed server URLs. Anonymous/public users cannot fetch raw evidence. Supabase migration now creates a private `beermap-source-evidence` bucket and owner-only Storage policies for provider migration.
- Still required: Move large-scale evidence blobs from the SQLite private evidence fallback to Supabase Storage/private object storage, run a storage access test, and consider malware/image scanning before open public uploads.
- Blocks production: Partially. It no longer blocks a controlled production beta for source evidence privacy, but full-scale uploads should wait for provider storage verification and backup policy.

## P0: Production Backups, Restore Drill, And Incident Ownership

- Why it matters: SQLite on a hosted volume requires a verified backup/restore process. Without it, data loss or migration mistakes cannot be confidently recovered.
- Status: Runbook/checklist has been expanded with RPO/RTO, backup ownership placeholders, restore-test steps, Railway health checks, monitoring, and rollback procedure.
- Suggested fix: Configure automated Railway volume/database backups, document restore owner, run one staging restore drill, and alert on backup age/failure.
- Blocks production: Yes for full-scale production.

## P1: Live Stripe End-To-End Verification

- Why it matters: Billing entitlements are security-sensitive and revenue-critical.
- Suggested fix: Use Stripe test mode and Stripe CLI forwarding to verify Checkout, signed webhooks, replay idempotency, subscription deletion, and invoice failure behavior against the deployed preview.
- Blocks production: Yes for paid launch. Not blocking if checkout is disabled and only free/contributor access is used.

## P1: Supabase RLS Application And Formal Audit

- Why it matters: Supabase Auth/OAuth is supported, but direct browser writes/reads must be protected by RLS before expanding Supabase-backed flows.
- Suggested fix: Apply `supabase/migrations/20260512000000_auth_profiles_activity.sql`, review policies in the Supabase dashboard, and test anonymous/authenticated insert/update behavior.
- Blocks production: Yes if direct browser Supabase writes are enabled. Less critical while public data access remains server-gated through Express.

## P1: Distributed Rate Limiting

- Why it matters: Current in-memory limiter is per-process. Multi-instance Railway scaling or edge bypass can weaken auth, billing, reveal, upload, and feedback abuse controls.
- Status: Redis-backed rate limiting is implemented when `REDIS_URL` is set. Production startup requires `REDIS_URL` unless `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true` is explicitly set. Redis failures fail closed in production unless the same override is set.
- Still required: Provision Railway Redis/Upstash, set `REDIS_URL`, and smoke-test auth/upload/reveal/payment limits in staging.
- Blocks production: No once Redis is provisioned and verified. Blocks horizontal/full-scale launch if the explicit in-memory override is used.

## P1: Production Monitoring And Alerting

- Why it matters: Full-scale production needs rapid detection of outages, webhook failures, 5xx spikes, billing issues, suspicious auth activity, and DB/volume problems.
- Suggested fix: Add uptime checks for `/health` and `/ready`, app error alerts, Stripe webhook alerts, login/rate-limit alerts, DB size/backup alerts, and incident escalation.
- Blocks production: Yes for full-scale launch.

## P1: Email Verification For Local Accounts

- Why it matters: The bar dashboard is intended for verified accounts; local email/password accounts do not yet include a complete email-verification workflow.
- Status: Production server-side guards now block dashboard/upload/verification actions when `REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true` and the account has no verified email timestamp. Supabase OAuth/session exchange records provider email-confirmation timestamps.
- Still required: Configure Supabase Confirm Email/custom SMTP and avoid local password-only onboarding unless local email verification is added.
- Blocks production: No for Supabase/OAuth verified accounts once configured. Yes for open local email/password self-serve onboarding without verification.

## P1: Provider Configuration Verification

- Why it matters: Google Maps, OpenAI, Supabase, and Stripe all depend on provider-side restrictions/secrets that cannot be verified from local code alone.
- Suggested fix: Verify Google Maps referrer restrictions, Supabase OAuth redirect URLs/RLS, Stripe webhook secret, and OpenAI key scope in staging.
- Blocks production: Yes until completed.

## P1: Supabase Legacy Table Cleanup Verification

- Why it matters: The active product now uses `venue_menu_captures`, `venue_price_records`, and crowdsourced submission tables. Old call-automation tables should not remain part of operational reporting once data has been reviewed/migrated.
- Suggested fix: After applying `supabase/migrations/20260520010000_venue_menu_captures.sql`, verify whether old `call_logs`, `call_queue`, `call_results`, or `guinness_prices` tables contain data you still need. Export/back up anything important, then drop only the confirmed-unused legacy tables manually in Supabase.
- Blocks production: No if the old tables are not exposed to browser clients and are ignored by active code. Should be completed before broad operational analytics cleanup.

## P2: Admin Audit Log UI And Export Controls

- Why it matters: `security_audit_log` exists, but operators need safe review and export workflows for investigations.
- Suggested fix: Add admin-only audit log view with filters, pagination, redacted metadata, and export safeguards.
- Blocks production: No, but important soon after launch.

## P2: Device/Session Management UI

- Why it matters: Logout-all exists, but users/admins cannot inspect active sessions.
- Suggested fix: Add account UI for last-used session fingerprints and revoke controls.
- Blocks production: No.

## P2: Formal Mobile/E2E Test Suite

- Why it matters: The static viewer has a large amount of browser behavior that unit tests cannot fully cover.
- Status: Repo-native Pint Path release-readiness coverage now exists in Vitest for auth, RBAC, submissions, source-evidence privacy, venue-manager pending approval, analytics privacy floors, Supabase migration contracts, and public-page smoke checks.
- Still required: Add Playwright/mobile browser smoke tests for map load, OAuth callback, account dashboard, submission, venue portal pending change, admin approval, and mobile breakpoints.
- Blocks production: Not strictly, but strongly recommended before broad public traffic.

## P2: Local/Staging Dynamic Security Scan

- Why it matters: Static tests cannot catch all browser/runtime issues such as reflected XSS, bad cache headers, or route-specific security regressions.
- Status: Not automated by default because dynamic scanners must never hit `https://pintpath.au` production accidentally.
- Suggested fix: Run OWASP ZAP or equivalent only against local, preview, or staging, then archive the report with the release checklist.
- Blocks production: No for controlled beta. Recommended before broad public traffic.

## P3: Performance Profiling And Bundle Cleanup

- Why it matters: The viewer is static and large. Full-scale usage will benefit from profiling map interactions and reducing client-side work.
- Suggested fix: Add Lighthouse/mobile profiling, split large inline scripts where practical, and cache immutable assets.
- Blocks production: No.
