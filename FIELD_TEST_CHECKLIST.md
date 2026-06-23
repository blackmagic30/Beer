# Pint Path Field-Test Checklist

Use this before showing the app to real Melbourne users.

## 1. Local Or Staging Setup

- Run `npm install` if dependencies are not installed.
- Copy `.env.example` to `.env`.
- Set `PUBLIC_BASE_URL` to the preview URL users will open, for example `https://pintpath.au`.
- Set `DATABASE_PATH` to the field-test SQLite database path.
- Run `npm run check` before deploying.
- Run `npm run security:scan` before deploying.

## 2. Recommended Field-Test Env

```dotenv
FIELD_TEST_MODE=true
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
FREE_PRICE_REVEALS_PER_DAY=3
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
ADMIN_EMAILS=your-admin-email@example.com
SESSION_TTL_DAYS=60
ADMIN_SESSION_TTL_DAYS=7
ANALYTICS_MIN_BUCKET_SIZE=5
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
```

For a production-hosted private beta, keep `DEMO_BILLING_MODE=false` unless you intentionally set `ALLOW_DEMO_BILLING_IN_PRODUCTION=true` and clearly tell testers checkout is simulated. If Stripe test-mode checkout and webhooks have not passed end to end, use free limits, contributor unlocks, or explicit admin overrides instead of live payment claims.

## 3. Test Accounts

- Create one normal/free user.
- Create one admin user using an email listed in `ADMIN_EMAILS`.
- Optionally create a contributor test user for checking points and unlocks.

## 4. Demo Billing

- Open `/pricing.html`.
- Log in and confirm 18+ first.
- Click monthly or yearly.
- Confirm the account page shows premium access.
- Do not use live payments unless Stripe test mode has passed.
- Do not enable demo billing in production unless `ALLOW_DEMO_BILLING_IN_PRODUCTION=true` is intentionally set for this private beta.

## 5. Admin Access

- Log out and open `/admin.html`; admin content should stay hidden and API calls should fail.
- Log in as a normal user; admin content should still be blocked.
- Log in as the admin email; pending submissions, KPI, retention, coverage, queues, partner leads, venue partner interest, manager assignments, and field-test summary should load.

## 6. Free User Flow

- Open `/` while logged out.
- Confirm venue pins load.
- Open venue details and reveal exact prices until the free limit is reached.
- Confirm blocked reveals show a clear upgrade/contribute path instead of exposing exact prices.

## 7. Contributor Submission Flow

- Log in as a normal user and confirm 18+.
- Open `/submit.html`.
- Search for a venue using a partial name.
- Submit either a single beer price, full venue update, happy-hour update, or photo/source upload.
- Confirm the account page shows the submission as pending.

## 8. Approve Submissions

- Log in as admin.
- Open `/admin.html`.
- Approve the pending submission.
- Confirm points are awarded only after approval.
- Confirm approved prices publish to the map with confidence and last verified date.
- Confirm repeated same-user/same-venue submissions in the month do not stack points.
- Confirm the approval creates a redacted `security_audit_log` entry.

## 9. KPI Dashboard

- Open `/admin.html`.
- Check the field-test summary for users, searches, reveals, blocked reveals, submissions, reports, feedback, top clicked venues, and top searched beers.
- Check the regular KPI, retention, coverage, and partner-lead sections.
- Check venue partner interest, outreach status, and manager assignment sections if you are demoing to a venue manager.

## 10. Venue Partner Demo

- Open `/for-bars` and confirm it redirects to `/venue-portal` without exposing a public claim form.
- Confirm `/admin.html` is the only place to assign venue-manager access during beta.
- Create or pick a venue-manager test user.
- Assign the test user to one venue from `/admin.html`.
- Log in as the venue manager and open `/venue-portal`.
- Confirm only the assigned venue is visible.
- Confirm the Overview, Profile, Beers / stock, Happy hours, Deals & specials, Analytics, and Monthly report tabs load.
- As a Basic venue account, confirm profile, beers, and happy hours can be edited, while specials, analytics, and monthly reports show a Pro upgrade prompt.
- Ask admin to set the venue tier to Pro for a demo, then confirm aggregate suburb-level analytics and monthly report preview appear once the privacy threshold is met.
- Confirm Pro shows premium display metadata in the returned profile, without changing public ranking behaviour.
- As a verified user with no assigned venue, open `/venue-portal` and confirm it shows invite-only access rather than a claim form.
- Confirm listing quality, wrong-price reports, requests, and update link are visible.
- Add a beer row, mark it on tap/in stock, add a happy hour, and add a deal/special.
- Submit a venue manager update and confirm it appears as pending review, not automatically published.
- Revoke the assignment and confirm the venue manager portal is blocked.

## 11. Bug Reporting During The Test

- Use the floating feedback button when `FIELD_TEST_MODE=true`.
- Use “Report wrong price” inside venue cards for price issues.
- Use Account requests for missing venues or beers.

## 12. Known Limitations

- Photo/source uploads are demo storage unless private object storage is configured later.
- Production rejects inline demo image uploads unless `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=true` is intentionally enabled.
- Admin source review is protected, but uploaded files should not contain private personal information.
- Exact-price access is server-gated, but keep Supabase service-role keys server-only.
- Demo billing is not a real payment.
- Venue manager analytics are directional aggregate beta counts only.
- Paid venue billing, partner rewards, free beer redemption, and brewery dashboards are intentionally disabled.

## 13. Do Not Enable Yet

- Do not use live payments unless Stripe test checkout and webhooks have passed.
- Do not enable partner rewards or free beer redemption.
- Do not collect government ID documents.
- Do not expose individual user clickstream to venues.
