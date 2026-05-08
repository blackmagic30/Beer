# Melbourne Beer Map Field-Test Checklist

Use this before showing the app to real Melbourne users.

## 1. Local Or Staging Setup

- Run `npm install` if dependencies are not installed.
- Copy `.env.example` to `.env`.
- Set `PUBLIC_BASE_URL` to the preview URL users will open, for example `https://beer.splitseconds.app`.
- Set `DATABASE_PATH` to the field-test SQLite database path.
- Run `npm run check` before deploying.

## 2. Recommended Field-Test Env

```dotenv
FIELD_TEST_MODE=true
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
FREE_PRICE_REVEALS_PER_DAY=3
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
ADMIN_EMAILS=your-admin-email@example.com
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
- Log in as the admin email; pending submissions, KPI, retention, coverage, queues, and field-test summary should load.

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

## 9. KPI Dashboard

- Open `/admin.html`.
- Check the field-test summary for users, searches, reveals, blocked reveals, submissions, reports, feedback, top clicked venues, and top searched beers.
- Check the regular KPI, retention, coverage, and partner-lead sections.

## 10. Bug Reporting During The Test

- Use the floating feedback button when `FIELD_TEST_MODE=true`.
- Use “Report wrong price” inside venue cards for price issues.
- Use Account requests for missing venues or beers.

## 11. Known Limitations

- Photo/source uploads are demo storage unless private object storage is configured later.
- Admin source review is protected, but uploaded files should not contain private personal information.
- Exact-price access is server-gated, but keep Supabase service-role keys server-only.
- Demo billing is not a real payment.
- Partner rewards, free beer redemption, and venue dashboards are intentionally disabled.

## 12. Do Not Enable Yet

- Do not use live payments unless Stripe test checkout and webhooks have passed.
- Do not enable partner rewards or free beer redemption.
- Do not collect government ID documents.
- Do not expose individual user clickstream to venues.
