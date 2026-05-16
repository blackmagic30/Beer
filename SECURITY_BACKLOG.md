# Security Backlog

These items are intentionally deferred because they are larger than the current P0/P1 beta hardening pass or need infrastructure decisions.

## Full Admin MFA / TOTP

- Priority: P0/P1
- Risk: A compromised admin session or password can approve submissions, assign venue managers, and access sensitive review queues.
- Proposed implementation: Add TOTP enrollment, recovery codes, MFA-required admin route middleware, and step-up checks for payment/admin actions.
- Why deferred: Requires account recovery UX, secure secret storage, and migration/testing beyond the current beta hardening window.

## Private Object Storage With Signed URLs

- Priority: P0/P1
- Risk: Inline source evidence is not appropriate for sensitive production uploads.
- Proposed implementation: Use private Supabase Storage or another private bucket, virus/type scanning, signed admin review URLs, and retention controls.
- Why deferred: Needs storage bucket setup, permissions review, and migration away from current demo source evidence handling.

## Redis Or Edge/WAF Distributed Rate Limiting

- Priority: P1
- Risk: In-memory rate limiting is per-process and weaker when Railway scales beyond one instance.
- Proposed implementation: Move limiter buckets to Redis or add Railway/edge/WAF throttling for auth, reveal, billing, submission, and webhook routes.
- Why deferred: Current beta is expected to run on a single instance; adding Redis now is extra operational surface.

## Formal Supabase RLS Policy Audit

- Priority: P1
- Risk: Future direct browser Supabase reads could bypass Express access controls if RLS is incomplete.
- Proposed implementation: Audit all Supabase tables, enforce least privilege RLS, and keep public exact-price reads server-gated.
- Why deferred: Current hosted beta intentionally routes exact-price reads through Express APIs.

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
