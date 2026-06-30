# Security and Supabase Hardening Audit

Date: 2026-06-30

Scope: main Pint Path/BeerMap website, Express API, viewer pages, Supabase usage, environment handling, secret scanning, and route hardening. Mobile app folders were checked only for local secret/config files and were not edited by this pass.

References checked:
- Supabase API security guide: https://supabase.com/docs/guides/api/securing-your-api
- Supabase Row Level Security guide: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase changelog: https://supabase.com/changelog

## What Is Already Good

- Browser-facing config is explicit and allowlisted in `/config.js`; it exposes only public/browser-safe values such as Supabase URL, anon key, Google Maps browser key, pricing labels, and feature flags.
- No service-role key was found in viewer code. `viewer/config.js` exists locally but contains placeholders only and is ignored by git.
- `.gitignore` covers `.env`, local SQLite/data files, uploads/reports/logs, `viewer/config.js`, Android local properties/signing files, and iOS local config/build user files.
- Supabase service-role usage is server-side only in the admin/import paths. The browser uses Supabase only for OAuth/session bootstrap with anon/publishable config.
- Admin routes require server-issued account sessions, production admin allowlisting, verified email, and optional MFA step-up.
- Venue-owner dashboard access is server-enforced through active venue manager assignments; cross-venue access is blocked and audited.
- RLS-focused Supabase migrations exist for historical/direct Supabase tables, including revoking browser writes on deprecated contributor tables and tightening helper function execution.
- API inputs are mostly validated with Zod schemas before service methods run.
- Error responses and logs use redaction helpers and avoid logging full query strings in central error/not-found handling.
- Source evidence uploads are validated by type, size, file signature, private storage path, and short-lived signed URLs in production.
- Rate limiting already existed for auth, public price reads, writes, billing, events, lookups, and most admin mutations.
- Dependency audit currently reports no high-severity vulnerabilities.

## Fixes Made

- Added `writeLimiter` to account mutation routes that were missing it:
  - `/account/discount-pass`
  - `/account/free-pint-reward-code`
  - `/account/age-confirm`
  - `/account/legal-acceptance`
  - `/account/preferences`
  - `/account/privacy-settings`
  - `/account/delete-request`
  - `/account/saved-items`
  - `DELETE /account/saved-items`
- Added `adminWriteLimiter` to `POST /api/business/missions`, which is admin-only but previously lacked the admin mutation limiter.
- Expanded `scripts/security-scan.mjs` so ignored local config files are scanned when present:
  - `viewer/config.js`
  - `apps/android/local.properties`
  - `apps/ios/Config.xcconfig`
- Added hardening tests to keep account/admin route limiter coverage and local secret-scan coverage from regressing.

## Launch Blockers

No committed secret or immediate code-level launch blocker was found in this pass.

Before public production launch, manually confirm:
- Production has `REDIS_URL` configured, or the intentional single-instance fallback flag is explicitly accepted. The app currently fails closed in production when Redis is missing unless fallback is allowed.
- `ADMIN_EMAILS`, admin MFA settings, and Supabase OAuth redirect URLs are correct for the production domain.
- `SOURCE_EVIDENCE_SIGNING_SECRET`, `POS_WEBHOOK_SIGNING_SECRET`, Stripe secrets, and provider keys are real production/staging secrets, not placeholders.
- Supabase migrations have been applied to the live project and Supabase Advisor has no remaining exposed-table/RLS warnings for browser-exposed schemas.
- No service-role key is present in browser config, hosting dashboard public variables, static files, or mobile client config.

## Unresolved Risks

- Live Supabase RLS state was reviewed from migrations/tests, not directly from the hosted Supabase project. Run Supabase Advisor and verify table grants/RLS in the dashboard before launch.
- CSP still allows `unsafe-inline` and external CDN scripts for the current static viewer pages. That is compatible with the existing app, but it increases XSS blast radius while session tokens live in `localStorage`.
- Browser session tokens are stored client-side. A future hardening pass should consider httpOnly secure cookies plus CSRF protection, or at least a nonce-based CSP migration.
- The Supabase browser library is loaded from a CDN with a major-version URL on some pages. Consider pinning an exact version and/or self-hosting with integrity controls.
- Account deletion support exists as a request flow; the operational deletion/SLA process still needs to be documented for launch privacy readiness.
- Database and RLS policies were not changed in this pass because no clearly necessary safe schema change was found.

## Security/Privacy Notes

- Public keys: Supabase anon/publishable keys and Google Maps browser keys are acceptable in client config, but they must rely on Supabase RLS/domain restrictions/provider settings.
- Private keys: Supabase service-role, OpenAI, Stripe secret, Stripe webhook, source-evidence signing, and POS webhook secrets must stay server-only.
- Supabase RLS: Supabase guidance requires both grants and RLS policies for exposed schemas. Existing migrations move deprecated direct contributor tables behind RLS/revoked browser writes, but the live project still needs dashboard verification.
- Auth/session: local email/password sessions use hashed server tokens. Supabase OAuth sessions are verified server-side with `auth.getUser`, then mapped into local accounts/sessions.
- Authorization: venue dashboard reads/writes require active venue assignment unless admin. Non-admin profile/inventory changes generally queue for review instead of publishing directly.
- File/storage: source evidence is private by default, validates image bytes, blocks active text payloads, and uses HMAC-signed expiring links.
- Error handling: central error/not-found paths avoid query-string leaks and redact sensitive fields/values.

## Recommended Implementation Order

1. Keep the route limiter and scanner changes from this pass.
2. Verify production environment variables and hosting dashboard variable visibility.
3. Apply/verify Supabase migrations in the live project, then run Supabase Advisor.
4. Confirm production Redis rate limiting is configured.
5. Run a deploy smoke test for `/config.js`, OAuth login, venue portal access, uploads, and admin actions.
6. Plan a later CSP/session hardening pass: exact script pinning, CSP nonces, and safer session storage.
7. Document the account deletion operational process.

## Files Changed

- `src/modules/business/business.routes.ts`
- `scripts/security-scan.mjs`
- `test/business-routes-hardening.test.ts`
- `test/security-scan.test.ts`
- `SECURITY_PRIVACY_AUDIT.md`

## Files Likely To Need Future Changes

- `src/app.ts` for future CSP/cookie/session hardening.
- `src/config/env.ts` and deployment docs for production secret/readiness checks.
- `viewer/business.js`, `viewer/account.html`, and auth-related pages for future session-storage changes.
- `supabase/migrations/*` if Supabase Advisor finds live RLS/grant gaps.
- `README.md` or an ops runbook for account deletion and production secret rotation steps.

## Commands Run

- `npx vitest run test/business-routes-hardening.test.ts test/security-scan.test.ts` - passed, 2 files / 5 tests.
- `npm run build` - passed.
- `npm test` - passed, 27 files / 266 tests.
- `npm run security:scan` - passed, 259 tracked/untracked/explicit local config files checked.
- `npm run security:audit` - passed, 0 high-severity vulnerabilities.

No lint command is defined in `package.json`.

## Mobile Folder Confirmation

Mobile app folders were not modified by this security pass. I only checked for local secret/config filenames such as Android `local.properties`, iOS `Config.xcconfig`, Google service config files, and signing files; none were found in the working tree search. The repository already had pre-existing dirty mobile-folder changes before this pass.
