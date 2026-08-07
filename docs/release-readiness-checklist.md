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

The `test:release:pintpath` script runs the full build/test/security gate, validates production-provider configuration, requires every external release-evidence item to be complete, and runs `npm audit --audit-level=high`. Use the ordinary `npm run check` gate during local development; the strict release command is expected to fail until provider and human sign-off evidence is genuinely complete.

After production provider env is configured, also run:

```bash
npm run readiness:launch
```

This strict launch gate treats provider warnings as blockers. See `docs/launch-9-readiness-gates.md` for the manual evidence pack that local tests cannot prove.

GitHub keeps these two signals deliberately separate:

- **Pint Path Automated Readiness** runs on pushes and pull requests. It proves the build, local release suite, security scan, dependency audit, and reports external evidence without claiming that evidence is complete.
- **Pint Path Release Gate** is a manual production-environment workflow. It runs strict authenticated production smoke checks and `release:evidence:strict`, so it cannot pass with skipped roles or incomplete sign-offs.

The informational evidence command exits successfully when the evidence file is structurally valid, but its JSON keeps `launchReady: false` until every required sign-off passes. Its `incomplete` array names the accountable owner and exact next action for every open gate. Only the strict command is a launch gate.

Release-evidence schema v2 binds every completed gate to one immutable production release ID and frozen 40-character candidate SHA and requires the SHA-256 of a gate-specific private manifest. The informational command reports stale live proof and code/worktree drift with `evidenceCurrent: false`; the strict gate refuses it. Future timestamps and structurally unsupported proof are invalid in both modes. This does not make human evidence automatic; it prevents a note, old timestamp, or unrelated commit from being mistaken for durable launch proof.

Use the [external launch evidence checklist](external-launch-signoffs.md) for the ordered owner, command, pass/fail, stop-condition, and evidence checklist for all 12 required IDs.

Create a canonical, protected GitHub environment named `production`, then configure these environment secrets for both hourly user/venue monitoring and the manual gate:

```text
PINTPATH_SMOKE_USER_EMAIL
PINTPATH_SMOKE_USER_PASSWORD
PINTPATH_SMOKE_VENUE_EMAIL
PINTPATH_SMOKE_VENUE_PASSWORD
```

The scheduled workflow signs those dedicated verified accounts in through the public Supabase password flow, exchanges each provider session for a Pint Path session, checks the scoped endpoint, then revokes both the disposable Pint Path session and its current Supabase refresh session. Missing credentials are reported as a monitoring-configuration warning in a separate hourly job; they do not turn a passing public-health job into a false outage alert.

The authenticated job also receives protected `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment values. Before sending a password, it requires the live public config to match that pinned provider origin and browser-safe key; a mismatch fails closed without making a credential request.

Immediately before manually dispatching **Pint Path Release Gate**, also set this `production` environment secret:

```text
PINTPATH_SMOKE_ADMIN_TOKEN
```

The admin token must be a fresh Pint Path session created from a currently MFA-verified Supabase AAL2 admin session. Do not store an admin password or TOTP seed in Actions. The release gate revokes this one-use admin session after the check. Never commit credentials or print them in logs/evidence notes.

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
- The authenticated owner portal route path covers the current Free launch paths: login, assigned venue access, profile, beer/stock, support, cross-owner blocking, and pending-review state.
- Happy-hour collection and Pro-special branches remain covered as dormant/future regression paths. That coverage is not evidence that either feature is public in this release.
- Assigned venue managers publish profile and beer edits directly for their venue. Retained venue-side happy-hour collection follows the same internal workflow but remains absent from public web and iOS surfaces. Tier, code acceptance, and listing activation remain admin-controlled.
- A venue-wide fourth beer deletion within an hour is held for admin approval, even when multiple managers perform the earlier deletes.
- Pending venue changes are visible to the owning venue manager and admins, but not another venue manager.
- Rejected venue-manager changes do not publish.
- Basic venue tier remains analytics-locked after approved public data changes.
- Admin analytics buckets below `ANALYTICS_MIN_BUCKET_SIZE` are suppressed.
- Venue analytics hide suburb trends until the privacy floor is met.
- Analytics metadata redacts email, tokens, and precise location keys.
- Dormant/future monthly-report generation uses aggregate events and the Melbourne reporting timezone.
- Dormant/future report exports remain restricted to verified assigned Pro venue managers or admins.
- Report-delivery mocks test the future adapter without sending real email. They do not make reports part of the current launch.
- Supabase migrations keep source-evidence storage private and do not introduce `public.bars`.
- Public HTML smoke checks cover key pages and retired Twilio/ElevenLabs leakage.

## Release Blockers Not Fully Automated Locally

These are launch-critical but require provider/staging verification:

- **Supabase OAuth:** Google provider credentials, web redirect URLs, the provider callback, and email-confirmation behavior must be verified. Supabase should allow `https://pintpath.au/auth/callback`; the Google console should allow the callback derived from `SUPABASE_URL`, for example `https://auth.pintpath.au/auth/v1/callback`. Set `SUPABASE_OAUTH_PROVIDERS=google` and prove Apple is disabled. The first-release iOS app is email/password only, declares no custom URL scheme, and uses the HTTPS callback for email confirmation/password recovery.
- **Supabase Auth security:** Enable leaked-password protection before public launch.
- **Supabase live access audit:** Apply the final Data API retirement migration, then prove live that `anon` and `authenticated` have zero privileges on public tables, sequences, RPCs, and private helpers. RLS remains defence in depth; only the Express service, using its server-only service role, may access application data. Local SQL parsing is not a substitute for live privilege and denial proof.
- **Supabase database version:** Confirm the live project is not on deprecated Postgres 14 before launch.
- **Supabase Data API retirement:** Prove direct PostgREST/Data API reads, writes, RPCs, and storage-object access are denied to ordinary clients while the documented Express API paths still work. Future migrations must not add public grants unless a separately reviewed access contract explicitly reintroduces them.
- **Storage bucket live audit:** Verify `beermap-source-evidence` is private, has the intended file-size/MIME limits, and has no direct `anon` or `authenticated` object policies. Prove ordinary clients are denied and only the server-authorized API/admin signed-URL paths work.
- **Google Maps Map ID:** Create a JavaScript/vector Map ID in Google Maps Platform, set `GOOGLE_MAPS_MAP_ID`, and verify AdvancedMarkerElement markers render on staging.
- **Stripe/pricing:** Keep `COMMERCIAL_LAUNCH_ENABLED=false` and
  `CONSUMER_PAID_ENROLLMENT_ENABLED=false` for this release. Stripe values may
  remain absent; prove no current amount, checkout, trial, upgrade, or enrolment
  action is public. Test-mode lifecycle proof and the smallest-value live canary
  belong to a future commercial candidate after pricing is approved; do not
  enable a flag or make a charge for this free launch.
- **Report email:** Keep `REPORT_EMAIL_MODE=disabled` and `REPORT_DELIVERY_SCHEDULE_ENABLED=false` for this Free venue launch, and prove no report is sent or advertised. Provider-delivery proof belongs to a future Pro/commercial release candidate. This does not replace the separate current-launch account-deletion completion-notice evidence below.
- **Account-deletion completion notice:** Configure a dedicated Resend sending-only key, verified sender/reply-to, 32-byte recipient-encryption keyring, and signed webhook for `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`. Set `ACCOUNT_DELETION_REHEARSAL_ENABLED=true` only for the sacrificial proof in isolated Railway staging and prove it is `false` or absent in production. Verify delivery and audited terminal-resolution purges, the 30-day post-completion limit, the 60-day pre-completion held cap, invalid/replayed and out-of-order events, failure handling, restart/worker overlap, the pre-24-hour uncertain-send cutoff, and restored-tombstone suppression.
- **Redis rate limiting:** Full-scale production should use `REDIS_URL`; in-memory fallback is acceptable only for controlled beta/preview. Set `REQUIRE_REDIS_RATE_LIMITING=true` for the isolated two-replica staging outage drill so protected traffic and readiness fail closed when staging Redis is unavailable.
- **DAST/mobile E2E:** Do not run dynamic scanners against production. Run any ZAP/Lighthouse/Playwright mobile pass only against local, preview, or staging.
- **Backups/restore:** Run and document a provider-level restore drill before full-scale launch.

## Manual Staging Smoke

- Open the public map logged out and confirm no admin/debug/provider legacy content is visible.
- Confirm free users see only the fixed pint previews for Guinness, Carlton
  Draught, and Stone & Wood Pacific Ale; no public happy-hour filter, card,
  badge, promotional claim, submission mode, or special-price detail appears.
- Log in, submit a beer price and source photo, and confirm it is pending.
- Confirm another user cannot see that raw submission/evidence.
- Approve the submission as admin and confirm the normalized price appears on the map.
- Assign a venue manager and confirm ordinary profile and beer edits publish directly for that assigned venue. Exercise the retained venue-side happy-hour collection field, but prove it creates no public happy-hour record, filter, mission, contribution path, SEO claim, or iOS surface. Then trigger a documented safeguard/restricted change, confirm it stays pending, approve it as admin, and confirm only the approved guarded change publishes.
- Prove Pro, report, special, checkout, counter, reward, and POS surfaces are unavailable in the current web and iOS release, and that scheduled report delivery remains disabled.
