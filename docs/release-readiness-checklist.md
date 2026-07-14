# Pint Path Release-Readiness Test Checklist

This checklist adapts the external Pint Path test-pack assumptions to this repository. The automated suite is repo-native Vitest/Express/SQLite and must run only against local, test, preview, or staging data.

## Automated Local Gates

Run before any release candidate:

```bash
npm run build
npm test
npm run readiness:providers
npm run test:release:pintpath
git diff --check
```

The `test:release:pintpath` script currently runs the Pint Path release-readiness Vitest suite, the local secret scanner, and `npm audit --audit-level=high`.

After production provider env is configured, also run:

```bash
npm run readiness:launch
```

This strict launch gate treats provider warnings as blockers. See `docs/launch-9-readiness-gates.md` for the manual evidence pack that local tests cannot prove.

GitHub keeps these two signals deliberately separate:

- **Pint Path Automated Readiness** runs on pushes and pull requests. It proves the build, local release suite, security scan, dependency audit, and reports external evidence without claiming that evidence is complete.
- **Pint Path Release Gate** is a manual production-environment workflow. It runs strict authenticated production smoke checks and `release:evidence:strict`, so it cannot pass with skipped roles or incomplete sign-offs.

The informational evidence command exits successfully when the evidence file is structurally valid, but its JSON keeps `launchReady: false` until every required sign-off passes. Only the strict command is a launch gate.

Configure fresh production-environment secrets before running the manual gate:

```text
PINTPATH_SMOKE_USER_TOKEN
PINTPATH_SMOKE_VENUE_TOKEN
PINTPATH_SMOKE_ADMIN_TOKEN
```

These are short-lived Pint Path bearer sessions for dedicated smoke accounts. Never commit them or print them in evidence notes. The admin token must represent a currently MFA-verified admin session.

## Synthetic Data

Use only clearly marked synthetic data:

```bash
npm run test:seed:pintpath
npm run test:reset:pintpath
```

Both scripts refuse to run when `NODE_ENV=production` or when `PUBLIC_BASE_URL` points at `https://pintpath.au`.

## Covered By The Release Suite

- Anonymous users cannot upload beer-price data.
- Authenticated uploads are attached to the server-side authenticated user, not a client-supplied user id.
- Users cannot verify their own uploads.
- Users cannot list another user’s private submissions.
- Admin and analytics preview routes reject anonymous and normal users.
- Source evidence stays behind private references and signed URLs.
- Obvious localhost/private/metadata source-photo URLs are rejected before storage.
- The authenticated owner portal route path covers login, assigned venue access, profile, beer/stock, happy-hour, Pro special, support, cross-owner blocking, and pending-review state.
- Assigned venue managers publish profile, beer, and happy-hour edits directly for their venue. Tier, code acceptance, and listing activation remain admin-controlled.
- A venue-wide fourth beer deletion within an hour is held for admin approval, even when multiple managers perform the earlier deletes.
- Pending venue changes are visible to the owning venue manager and admins, but not another venue manager.
- Rejected venue-manager changes do not publish.
- Basic venue tier remains analytics-locked after approved public data changes.
- Admin analytics buckets below `ANALYTICS_MIN_BUCKET_SIZE` are suppressed.
- Venue analytics hide suburb trends until the privacy floor is met.
- Analytics metadata redacts email, tokens, and precise location keys.
- Monthly venue reports generate from aggregate events using the Melbourne reporting timezone.
- Monthly report exports are restricted to verified assigned Pro venue managers or admins.
- Report delivery can be mocked for tests without sending real email.
- Supabase migrations keep source-evidence storage private and do not introduce `public.bars`.
- Public HTML smoke checks cover key pages and retired Twilio/ElevenLabs leakage.

## Release Blockers Not Fully Automated Locally

These are launch-critical but require provider/staging verification:

- **Supabase OAuth:** Google and Apple provider credentials, Supabase app redirect URLs, provider callback URLs, and email-confirmation behavior must be verified. Supabase should allow `https://pintpath.au/auth/callback`; Google/Apple should allow the Supabase provider callback derived from `SUPABASE_URL`, for example `https://auth.pintpath.au/auth/v1/callback`.
- **Supabase Auth security:** Enable leaked-password protection before public launch.
- **Supabase RLS live audit:** Apply migrations, then test anonymous/authenticated access in the Supabase dashboard or staging client. Local SQL parsing is not a substitute for live policy verification.
- **Supabase database version:** Confirm the live project is not on deprecated Postgres 14 before launch.
- **Supabase Data API exposure:** Confirm any new public-schema tables have intentional grants/exposure plus RLS; do not assume new tables are auto-exposed.
- **Storage bucket live audit:** Verify `beermap-source-evidence` is private, has the intended file-size limit, and owner-only policies work in Supabase Storage.
- **Google Maps Map ID:** Create a JavaScript/vector Map ID in Google Maps Platform, set `GOOGLE_MAPS_MAP_ID`, and verify AdvancedMarkerElement markers render on staging.
- **Stripe:** Do not enable live payments until Stripe CLI or dashboard test webhooks prove signed webhook verification, duplicate-event idempotency, subscription updates, cancellations, and failed invoices.
- **Report email:** The Resend adapter and monthly scheduler are implemented but opt-in. Do not announce live delivery until the sending domain/key/from address are configured, a targeted staging email proves manager-only recipient scoping, and Railway records a successful `job:monthly_report_delivery` state.
- **Redis rate limiting:** Full-scale production should use `REDIS_URL`; in-memory fallback is acceptable only for controlled beta/preview.
- **DAST/mobile E2E:** Do not run dynamic scanners against production. Run any ZAP/Lighthouse/Playwright mobile pass only against local, preview, or staging.
- **Backups/restore:** Run and document a provider-level restore drill before full-scale launch.

## Manual Staging Smoke

- Open the public map logged out and confirm no admin/debug/provider legacy content is visible.
- Confirm free users only see happy hours plus pint previews for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.
- Log in, submit a beer price and source photo, and confirm it is pending.
- Confirm another user cannot see that raw submission/evidence.
- Approve the submission as admin and confirm the normalized price appears on the map.
- Assign a venue manager, submit a venue edit, confirm it stays pending, approve it, then confirm it publishes.
- Verify Pro venue analytics remain aggregate-only and hide low-count buckets.
