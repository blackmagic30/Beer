# Pint Path 9/10 Launch Readiness Gates

This is the evidence pack needed to move Pint Path from a strong beta to a true public-launch posture. Keep these checks against local, staging, or production-preview data unless a step explicitly says it must be verified in the live provider dashboard.

## Automated Gates

Run before every release candidate:

```bash
npm run check
npm run test:release:pintpath
npm run ocr:benchmark
npm run smoke:production
npm run release:evidence
git diff --check
```

Run after real production provider env is configured:

```bash
npm run readiness:launch
npm run smoke:production:auth
npm run release:evidence:strict
```

`readiness:launch` runs the provider check with production semantics and treats warnings as launch-blocking. It should return zero failures and zero blocking warnings before broad public traffic.

## Manual Provider Proof

- Supabase Auth redirects include `https://pintpath.au/auth/callback` and local callback URLs.
- Supabase Google/Apple provider callback URL derived from `SUPABASE_URL` is present in the provider consoles.
- Supabase leaked-password protection is enabled for public signup.
- Supabase admin MFA/AAL2 is configured and an admin staging login proves `aal2` before admin actions.
- Supabase live project is not on deprecated Postgres 14. Supabase support for Postgres 14 ends on 2026-07-01.
- Supabase RLS and table grants are checked in the dashboard or RLS Tester after migrations are applied. Do not rely only on SQL text tests.
- Supabase Storage bucket `beermap-source-evidence` is private, not public, and owner/admin access is verified.
- Google Maps browser key is restricted to approved referrers and `GOOGLE_MAPS_MAP_ID` renders AdvancedMarkerElement markers on staging.
- Stripe test-mode Checkout and signed webhooks prove subscription create/update/cancel, failed invoice handling, and replay idempotency before live payments.
- Redis is provisioned through `REDIS_URL`; production does not rely on the in-memory rate-limit override for broad traffic.
- OpenAI and Google Places keys are server-side, restricted where possible, and absent from `/config.js`.

## Authenticated Owner Journey

Use a fresh staging owner account and record pass/fail evidence:

1. Create account or OAuth login.
2. Confirm email/verified account state.
3. Admin assigns venue-manager access.
4. Owner opens `/venue-portal`.
5. Owner submits profile update.
6. Owner adds beer/stock row.
7. Owner adds happy-hour row.
8. Pro owner adds special/deal.
9. Owner opens support from the portal.
10. Owner views report/analytics gate appropriate to Free/Pro tier.
11. Another owner is blocked from that venue.
12. Admin approves pending changes and public map shows only approved data.

The local release suite now covers this path synthetically, but staging still needs real browser/auth/provider confirmation.

## Monitoring And Operations

- External uptime checks hit both `/health` and `/ready`.
- 5xx, deploy failure, Redis failure, Stripe webhook failure, and login/rate-limit spikes alert a named owner.
- Railway volume/database backup is automated and backup age is monitored.
- One staging restore drill is completed and dated.
- Incident owner, escalation path, RPO, RTO, and rollback target are recorded before public launch.
- `/status.html`, `/security.html`, and `/.well-known/security.txt` point users to private support/security reporting paths.

## Performance Budget

Run Lighthouse or WebPageTest against staging on mobile and desktop for:

- `/`
- `/pricing.html`
- `/venue-portal`
- `/account.html`

Target before a 9/10 launch:

- Performance: 85+ on public landing/pricing pages.
- Accessibility: 95+ on public pages and 90+ on authenticated tool pages.
- SEO: 95+ on public pages.
- No document-level horizontal overflow at 390px, 768px, and desktop widths.
- No blocking console errors on initial page load.

Do not chase risky bundle rewrites before launch. Prefer measured fixes: defer non-critical scripts, lazy-load map extras, compress/cache static assets, and keep authenticated pages from doing unnecessary signed-out work.

## Accessibility And Device Proof

- Keyboard-only pass: landing, pricing, account auth, submit, venue portal tabs/forms, modals/dialogs.
- Screen reader smoke: headings, form labels, error announcements, dashboard empty states, and destructive confirmations.
- Real mobile pass: iPhone Safari and Android Chrome at large text/default zoom.
- Touch targets: primary controls should be at least 44px where practical; dense nav/footer links should not drop below 40px.
- Focus indicators remain visible on dark backgrounds.

## Legal And Trust Proof

- Owner/legal review of Privacy, Terms, account deletion/export wording, analytics/cookie consent, and alcohol/responsible-service language.
- Final owner contact/support details are published.
- Billing/refund/cancellation process is approved before paid launch.
- Any screenshots, sample reports, or case-study copy use synthetic or owner-approved data only.

## Go / No-Go

Go only when:

- Automated gates pass.
- `npm run readiness:launch` passes with zero blocking warnings.
- Provider proof is complete or explicitly accepted by the owner for a limited beta.
- Owner journey passes in staging with real auth.
- Monitoring, backup, and rollback evidence exists.
- Legal/support placeholders have been reviewed and replaced or accepted for beta.

No-go if any normal user can access admin data, any owner can access another venue, any source evidence is public, Stripe accepts unsigned webhooks, production runs broad traffic without Redis, or the app has no monitored backup/incident path.
