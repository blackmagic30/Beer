# Security Backlog

These items are intentionally deferred because they are larger than the current P0/P1 beta hardening pass or need infrastructure decisions.

## Full Admin MFA / TOTP

- Priority: P0/P1
- Risk: A compromised admin session or password can approve submissions, assign venue managers, and access sensitive review queues.
- Current status: Repo-side production admin checks require verified email and fresh Supabase AAL2/MFA claims when `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true`.
- Remaining implementation: Configure Supabase MFA factors, prove admin AAL2 in staging, and add a richer recovery/session-management UX later.
- Why still tracked: Provider MFA setup and human recovery process cannot be completed from local code alone.

## Private Object Storage With Signed URLs

- Priority: P0/P1
- Risk: Inline source evidence is not appropriate for sensitive production uploads.
- Current status: Public raw evidence exposure is closed in code through private evidence references and short-lived signed server URLs. Supabase migrations include a private `beermap-source-evidence` bucket posture.
- Remaining implementation: Verify Supabase Storage/provider policies live, decide on malware/image scanning, and document retention/backup rules before large-scale uploads.
- Why still tracked: Provider bucket access, scanning, and retention are operational decisions that cannot be proven by local tests only.

## Redis Or Edge/WAF Distributed Rate Limiting

- Priority: P1
- Risk: In-memory rate limiting is per-process and weaker when Railway scales beyond one instance.
- Current status: Redis-backed rate limiting is implemented and production fails closed by default when Redis is missing unless an explicit temporary override is set.
- Remaining implementation: Provision Redis/Upstash/Railway Redis, set `REDIS_URL`, and smoke-test protected routes in staging.
- Why still tracked: Provider provisioning and alerting remain deployment tasks.

## Formal Supabase RLS Policy Audit

- Priority: P1
- Risk: Future direct browser Supabase reads could bypass Express access controls if RLS is incomplete.
- Current status: Migration contract tests enforce the intended local policy shape, and public exact-price reads remain server-gated through Express APIs.
- Remaining implementation: Apply migrations to the live project, run Supabase Advisor/RLS Tester, confirm table grants/Data API exposure, and test anonymous/user/admin access with real staging accounts.
- Why still tracked: Live provider state can drift from migration files and must be verified in Supabase itself.

## Device And Session Management UI

- Priority: P1
- Risk: Users cannot yet inspect or revoke individual sessions from a UI.
- Proposed implementation: Account page session list with last-used time and revoke controls, using the existing hashed session metadata.
- Why deferred: Logout-all API exists; UI can follow after beta.

## Security Contact / Bug Bounty Page

- Priority: P2
- Risk: Testers may report issues through public channels with sensitive details.
- Proposed implementation: Add a private security contact page and disclosure guidance.
- Why deferred: `SECURITY.md` covers repository guidance for now.

## Annual Penetration Test

- Priority: P2
- Risk: Internal review may miss chained vulnerabilities.
- Proposed implementation: External assessment before wider public launch or paid venue onboarding.
- Why deferred: Not required for the small private Melbourne beta.
