# Melbourne Beer Map Deployment Checklist

Use this before merging `core-business-demo` into `main` or deploying a Railway production beta.

## 1. Confirm The Target

- Production branch: `main`.
- Current beta branch: `core-business-demo`.
- Hosting: Railway, using `railway.toml`.
- Build command: `npm run build`.
- Start command: `node dist/src/server.js`.
- Health check: `/health`.
- Database: SQLite at `DATABASE_PATH`, with additive schema creation from `src/db/schema.sql`.

## 2. Pre-Deploy Checks

- Run `git status --short --branch` and confirm only intended release files are changed.
- Run `git diff --check`.
- Run `npm run build`.
- Run `npm test`.
- Run `npm run check`.
- Confirm no `.env` file, API keys, Stripe secrets, Supabase service-role keys, Twilio auth tokens, OpenAI keys, or ElevenLabs keys are committed.
- Confirm public map source does not contain legacy admin/debug UI strings.

## 3. Required Production Beta Env

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PUBLIC_BASE_URL=https://beer.splitseconds.app
DATABASE_PATH=/app/data/melb-beer-bot.sqlite
TRUST_PROXY=true
FIELD_TEST_MODE=true
FREE_PRICE_REVEALS_PER_DAY=3
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
ADMIN_EMAILS=your-admin-email@example.com
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
OUTBOUND_CALLS_ENABLED=false
```

If you intentionally use simulated checkout for the private field test, set both:

```dotenv
DEMO_BILLING_MODE=true
ALLOW_DEMO_BILLING_IN_PRODUCTION=true
```

In that mode, the pricing UI must be treated as beta/demo billing, not real payment collection.

## 4. Stripe Modes

- Demo billing: works without Stripe keys, but production blocks it unless `ALLOW_DEMO_BILLING_IN_PRODUCTION=true`.
- Stripe test mode: set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
- No billing: keep `DEMO_BILLING_MODE=false` and leave Stripe keys empty; free limits, admin overrides, and contributor unlocks still work.
- Do not process live payments until Stripe Checkout and webhook forwarding have been tested with Stripe CLI.

## 5. Database Backup And Migration

- Before deploy, back up the production SQLite file or Railway volume.
- The schema is additive with `CREATE TABLE IF NOT EXISTS` and indexes; do not run destructive `DROP` or `DELETE` commands for this beta.
- Deploy will initialize missing tables from `src/db/schema.sql` through the app database setup.
- Verify `/health` after deploy, then confirm account signup and map load.
- If migration fails, stop the deployment, restore the DB backup, and redeploy the previous production commit.

## 6. Admin Account

- Set `ADMIN_EMAILS` to the owner/admin email before first admin signup.
- Sign up with that exact email.
- Open `/admin.html`.
- Confirm unauthenticated requests are blocked and the admin dashboard loads only for the admin account.

## 7. Live Smoke Test

- Open the live site logged out and confirm the map loads.
- Confirm no admin/debug UI is visible.
- Open a venue and confirm exact prices are limited/redacted for anonymous users.
- Directly request `/api/business/price-records` logged out and confirm prices are redacted unless a server-counted reveal is used.
- Create or log in as a test user and confirm 18+.
- Hit the free reveal limit.
- Submit venue data and confirm it appears as pending in account.
- Log in as admin and approve the submission.
- Confirm points are awarded only after approval.
- Confirm contributor unlock works after the configured threshold.
- Confirm approved price records appear on the map with confidence and last verified date.
- Confirm `/api/calls` and `/api/results` return `401` logged out and `403` for non-admin users.
- Submit a wrong-price report and feedback.
- Confirm KPI/field-test dashboard records activity.
- Open `/for-bars`, submit a venue interest request, and confirm it appears in admin.
- Assign a venue manager in admin, log in as that user, and confirm `/venue-portal` only shows the assigned venue.
- Submit a venue-manager update and confirm it remains pending review.
- Check the main pages on a phone-width screen.

## 8. Rollback Plan

- Identify the previous production commit with `git log --oneline main`.
- If the bad deploy came from a merge commit, revert it with `git revert -m 1 <merge_commit_sha>`.
- If it was a fast-forward push, create a revert commit for the problematic range or redeploy the previous SHA from Railway if available.
- Push the rollback commit to `main` and let Railway redeploy.
- If data migration caused issues, stop the app, restore the pre-deploy database backup, then redeploy the previous commit.
- Fast feature-disable env switches:
  - `FIELD_TEST_MODE=false`
  - `DEMO_BILLING_MODE=false`
  - `FREE_PRICE_REVEALS_PER_DAY=0`
  - `OUTBOUND_CALLS_ENABLED=false`
  - Remove Stripe price IDs to disable live checkout safely.

## 9. Merge Commands

Use these only after all checks pass:

```bash
git switch main
git pull origin main
git merge --ff-only core-business-demo
npm run check
git push origin main
```

If `--ff-only` fails, stop and inspect the merge before continuing.
