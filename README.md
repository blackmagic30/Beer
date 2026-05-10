# melb-beer-bot

`melb-beer-bot` is a production-minded local Node.js + TypeScript service that places Twilio outbound calls, connects them to an ElevenLabs voice agent, stores one `call_run` per call, persists the full transcript when the call is finished, parses beer pricing outcomes, and exposes review APIs so you can inspect exactly what happened afterward.

## Current Capabilities

- Creates a `call_runs` row before every outbound dial attempt.
- Places a live Twilio outbound call from `POST /api/calls/outbound`.
- Handles Twilio voice webhooks and always returns valid TwiML.
- Falls back to a safe spoken TwiML response if ElevenLabs is missing or fails.
- Tracks Twilio status updates like `ringing`, `in-progress`, `completed`, `busy`, `no-answer`, `failed`, and `canceled`.
- Accepts ElevenLabs post-call transcript webhooks.
- Persists raw transcripts to `call_runs`.
- Parses the current target beer flow, configurable as Guinness, Carlton Draft, or Stone & Wood.
- Syncs completed venue-linked call results into Supabase `call_results`; the public viewer reads approved venue/price data through server-gated business APIs.
- Stores structured per-beer availability fields for map use:
  - `availability_status`
  - `available_on_tap`
  - `available_package_only`
  - `unavailable_reason`
- Syncs `cleaned.beers`, `cleaned.menu_items`, and `cleaned.menu_capture` into Supabase so the map and future crowdsourced menu tooling can build on the same shape.
- Parses happy hour fields:
  - `happy_hour`
  - `happy_hour_days`
  - `happy_hour_start`
  - `happy_hour_end`
  - `happy_hour_price`
- Stores parse confidence plus parse status:
  - `parsed`
  - `partial`
  - `needs_review`
  - `failed`
- Supports `testMode: true` so you can safely place a test call to your own number and clearly distinguish it from real venue calls.
- Provides review endpoints for recent calls and per-call inspection.
- Adds a Melbourne-only business-model demo with free preview access, paid premium access, contributor unlocks, public submissions, missions, admin review, and aggregate analytics.

## Main Routes

- `POST /api/calls/outbound`
- `GET /api/calls`
- `GET /api/calls/:callSid`
- `GET /api/results`
- `POST /webhooks/twilio/voice`
- `POST /webhooks/twilio/status`
- `POST /webhooks/elevenlabs/post-call`
- `GET /health`
- `GET /api/business/config`
- `POST /api/business/auth/signup`
- `POST /api/business/auth/login`
- `GET /api/business/account`
- `GET /api/business/access`
- `GET /api/business/missions`
- `POST /api/business/submissions`
- `POST /api/business/submissions/:id/review`
- `POST /api/business/account/preferences`
- `POST /api/business/account/saved-items`
- `DELETE /api/business/account/saved-items`
- `POST /api/business/feedback`
- `POST /api/business/wrong-price-reports`
- `POST /api/business/requests`
- `POST /api/business/venue-interest`
- `GET /api/business/venue-portal`
- `POST /api/business/venue-portal/:venueId/submissions`
- `GET /api/business/admin/kpis`
- `GET /api/business/admin/retention`
- `GET /api/business/admin/coverage`
- `GET /api/business/admin/partner-leads`
- `GET /api/business/admin/queues`
- `GET /api/business/admin/venue-partners`
- `POST /api/business/admin/venue-managers`
- `POST /api/business/admin/venue-managers/revoke`
- `POST /api/business/admin/venue-interest/:id/status`
- `POST /api/business/admin/venue-outreach`
- `POST /api/business/billing/checkout`
- `POST /api/business/billing/webhook`
- `GET /api/business/analytics/preview`

Field-test note: legacy call-control and call-result routes are admin-only. Use a bearer token from an account listed in `ADMIN_EMAILS` for `/api/calls/*`, `/api/results`, `/api/admin/*`, and `/api/business/admin/*`.

## Business Model Demo

The hosted viewer now includes a focused Melbourne/Victoria MVP business layer:

- Free users can view the map, venue pins, suburbs, data freshness, missions, and a limited number of exact price reveals per day.
- Premium users can unlock full map utility at A$1.99/month or A$19/year.
- Contributors can earn temporary premium access through approved venue data. Defaults are 5 points for a valid full venue update and 15 approved monthly points for 30 days of access.
- Public submissions are queued as `pending` and do not become trusted map data until reviewed.
- Approved submissions publish `venue_price_records`, which the map merges into existing venue data for existing venues.
- Mission points are weighted by usefulness, not by number of bars visited. Repeated same-venue submissions in the same month are capped.
- Admin review lives at `/admin.html` and is protected by account role checks via `ADMIN_EMAILS`.
- Legacy call/result APIs are admin-only so transcripts and call-derived exact price rows are not exposed to anonymous users.
- The public map no longer exposes legacy admin controls or direct browser reads of exact price records.
- Exact price records are redacted by default and only revealed through server-side access checks and daily free reveal limits.
- Analytics are captured as aggregate events only. No venue dashboard or individual clickstream export is live yet.
- The admin KPI dashboard tracks early validation metrics, retention cohorts, data coverage, and potential partner leads from aggregated demand.
- Users can save venues, beers, and suburbs, submit feedback, report wrong prices, and request missing venues or beers.
- The public map includes retention filter chips, active happy-hour previews, recently verified price previews, and wrong-price reporting.
- The public map supports optional one-time browser location for “near me” sorting, approximate venue distances, and active happy hours nearby. Location is only requested after the user taps “Use my location”; precise coordinates are kept in browser state and are not stored in analytics.

Business demo pages:

- `/pricing.html`: free, monthly, yearly, and contributor access copy.
- `/account.html`: signup/login, 18+ confirmation, access status, points, saved items, preferences, requests, feedback, and submission status.
- `/missions.html`: Needs Data mission board with sorting, quick-win guidance, and points.
- `/submit.html`: venue data submission with manual rows and photo/source queue.
- `/for-bars`: professional venue-owner page for register-interest and claim-listing requests.
- `/venue-portal`: admin-assigned venue manager portal with listing quality, update links, pending update submission, and privacy-safe aggregate insights.
- `/admin.html`: admin-only submission review, KPI dashboard, cohorts, coverage, partner leads, and review queues.

Venue partner demo layer:

- Bars can register interest from `/for-bars`; requests stay in the admin partner queue.
- Admin can assign or revoke venue managers from `/admin.html`.
- Venue managers can only access assigned venues on `/venue-portal`.
- Venue manager updates are submitted for review by default, rather than directly publishing.
- Venue insights are aggregate-only and do not expose user names, individual clickstream, or exact user location.
- The portal includes a listing quality score, wrong-price reports, user requests, current verified records, and a copyable update link for QR/signage use.

Responsible-alcohol guardrails:

- 18+ confirmation is required for account signup and full price/submission flows.
- The demo does not collect government ID documents.
- Copy is intentionally neutral: verified prices, data accuracy, and responsible use.
- Partner venue credit/rewards are marked as coming soon and are disabled.

Location/privacy guardrails:

- Location is opt-in only and uses one-time `getCurrentPosition`; the app does not use continuous tracking.
- Distances are approximate straight-line distances, not walking or driving routes.
- Analytics events for near-me actions store coarse context such as radius and status only, not exact latitude/longitude.
- If location permission is denied or unavailable, users can still search by venue, suburb, or beer.

## Small Public Beta Hardening

For the Melbourne beta, exact prices must flow through the Express API, not direct browser database reads.

- `/api/business/price-records` returns redacted price records unless the caller has admin, premium, contributor, or remaining free reveal access.
- Free exact-price reveal limits are counted server-side using the logged-in user where possible, or the anonymous session/IP fallback for anonymous users.
- The map gets venue pins and preview metadata by default, then requests an exact venue reveal only when a user opens a venue detail.
- Admin tools live on `/admin.html` and `/api/business/admin/*`; public map HTML should not include admin unlock forms or secret-entry UI.
- Demo photo/source uploads are validated for image MIME type and 6MB max size, then stored with pending submissions for review. For production, move these to private object storage and render review links through signed URLs.
- `DEMO_BILLING_MODE=true` is for local/demo only. Production blocks demo billing unless `ALLOW_DEMO_BILLING_IN_PRODUCTION=true` is explicitly set.
- State-changing business APIs check trusted origins and use lightweight in-memory rate limits for auth, submissions, feedback, requests, price reveals, and billing routes.
- Security headers are enabled with a Google Maps-compatible CSP, `nosniff`, same-origin frame protection, strict referrer policy, and limited browser permissions.
- `FIELD_TEST_MODE=true` adds an unobtrusive beta label, feedback entry point, and admin field-test summary without exposing debug details to public users.
- See `FIELD_TEST_CHECKLIST.md` before showing the app to real users.
- See `DEPLOYMENT_CHECKLIST.md` before merging to `main` or deploying the Railway beta; it includes backup, migration, smoke-test, and rollback steps.

Suggested production beta values:

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://beer.splitseconds.app
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
FREE_PRICE_REVEALS_PER_DAY=5
FIELD_TEST_MODE=true
ADMIN_EMAILS=you@example.com
STRIPE_SECRET_KEY=sk_test_or_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_MONTHLY=price_monthly_199_aud
STRIPE_PRICE_YEARLY=price_yearly_19_aud
```

Stripe test-mode webhook check:

1. Set `DEMO_BILLING_MODE=false` and Stripe test keys in `.env`.
2. Run `npm run dev`.
3. In another terminal, run:

```bash
stripe listen --forward-to localhost:3000/api/business/billing/webhook
```

4. Copy the printed `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.
5. Start checkout from `/pricing.html` or `/account.html` and complete it with a Stripe test card.
6. Confirm `/account.html` shows premium access after the webhook is delivered.

Local MVP flow checks:

- Free map: open `http://localhost:3000`, confirm pins appear and exact prices are limited.
- Signup/age gate: create an account, confirm 18+, then submit venue data at `/submit.html`.
- Admin approval: sign up with an email in `ADMIN_EMAILS`, open `/admin.html`, approve the pending submission, and confirm points are awarded.
- Contributor unlock: approve enough unique-venue points to reach `CONTRIBUTOR_UNLOCK_POINTS`, then confirm full access and map price visibility.
- KPI tracking: open `/admin.html` and confirm KPI, retention, coverage, partner lead, and queue sections load for admin only.

## Exact Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Set these values:

```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=3000
TARGET_BEER=guinness
PUBLIC_BASE_URL=https://your-ngrok-subdomain.ngrok-free.app
DATABASE_PATH=./data/melb-beer-bot.sqlite
TRUST_PROXY=true
OUTBOUND_CALLS_ENABLED=true
OUTBOUND_CALL_TIMEZONE=Australia/Melbourne
OUTBOUND_CALL_WINDOW_START=11:00
OUTBOUND_CALL_WINDOW_END=20:30
OUTBOUND_CALL_ALLOWED_DAYS=mon,tue,wed,thu,fri,sat,sun
OUTBOUND_REPEAT_GUARD_SECONDS=300
PARSE_CONFIDENCE_THRESHOLD=0.72
BATCH_CALL_CIRCUIT_BREAKER_THRESHOLD=5
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_browser_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
SUPABASE_RESULTS_TABLE=call_results
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
GOOGLE_MAPS_MAP_ID=optional_google_maps_map_id
GOOGLE_PLACES_API_KEY=your_server_side_google_places_api_key
TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+61300000000
TWILIO_CALL_TIME_LIMIT_SECONDS=30
TWILIO_VALIDATE_SIGNATURES=false
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_AGENT_ID=agent_XXXXXXXXXXXXXXXX
ELEVENLABS_WEBHOOK_SECRET=optional_shared_secret_from_elevenlabs
ADMIN_EMAILS=you@example.com
FREE_PRICE_REVEALS_PER_DAY=5
CONTRIBUTOR_UNLOCK_POINTS=15
CONTRIBUTOR_UNLOCK_DAYS=30
DEMO_BILLING_MODE=true
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
FIELD_TEST_MODE=true
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_MONTHLY=price_monthly_199_aud
STRIPE_PRICE_YEARLY=price_yearly_19_aud
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
```

What each one does:

- `PUBLIC_BASE_URL`: your public HTTPS base URL. Use your ngrok URL here.
- `TARGET_BEER`: active beer campaign for outbound calls and reparsing. Supported values: `guinness`, `carlton_draft`, `stone_and_wood`.
- `HOST`: interface the Node server should bind to. Use `0.0.0.0` for Railway and other hosted deployments.
- `DATABASE_PATH`: SQLite file path.
- `OUTBOUND_CALLS_ENABLED`: master pause switch for real venue dialing. Test-mode calls still work.
- `OUTBOUND_CALL_TIMEZONE`: timezone used for the venue call window.
- `OUTBOUND_CALL_WINDOW_START` / `OUTBOUND_CALL_WINDOW_END`: local start and stop time for venue calls.
- `OUTBOUND_CALL_ALLOWED_DAYS`: allowed local weekdays for venue calls.
- `OUTBOUND_REPEAT_GUARD_SECONDS`: blocks accidentally dialing the same number again within this window.
- `PARSE_CONFIDENCE_THRESHOLD`: threshold used for review decisions.
- `BATCH_CALL_CIRCUIT_BREAKER_THRESHOLD`: pauses the batch after this many consecutive bad outcomes.
- `SUPABASE_URL`: Supabase project URL used for venue imports and map-sync result writes.
- `SUPABASE_ANON_KEY`: optional for legacy standalone/static viewer experiments. The hosted beta viewer does not expose this key.
- `SUPABASE_SERVICE_ROLE_KEY`: required for inserting venues and syncing call results.
- `SUPABASE_RESULTS_TABLE`: Supabase table used for synced call results. Defaults to `call_results`.
- `GOOGLE_MAPS_API_KEY`: browser-safe Google Maps key used by the hosted viewer.
- `GOOGLE_MAPS_MAP_ID`: optional Google Maps map ID for branded vector map styling.
- `GOOGLE_PLACES_API_KEY`: server-side key used by the venue import scripts. If absent, the importer falls back to `GOOGLE_MAPS_API_KEY`.
- `TWILIO_*`: credentials and caller number used for real outbound calls.
- `TWILIO_CALL_TIME_LIMIT_SECONDS`: hard answered-call cap enforced by Twilio. Default `30` seconds so real staff can answer while still limiting credit bleed.
- `TWILIO_VALIDATE_SIGNATURES`: set to `true` once your ngrok/public URL is stable.
- `ELEVENLABS_API_KEY`: required for live ElevenLabs call connection.
- `ELEVENLABS_AGENT_ID`: required for live ElevenLabs agent routing.
- `ELEVENLABS_WEBHOOK_SECRET`: optional but recommended for verifying ElevenLabs post-call webhooks.
- `ADMIN_EMAILS`: comma-separated emails that become admin accounts on signup.
- `FREE_PRICE_REVEALS_PER_DAY`: configurable daily exact-price previews for free users.
- `CONTRIBUTOR_UNLOCK_POINTS`: approved monthly contribution points required for contributor access.
- `CONTRIBUTOR_UNLOCK_DAYS`: number of premium days granted for contributor unlocks.
- `DEMO_BILLING_MODE`: when `true`, checkout can simulate a premium subscription without live Stripe. Keep this `false` for production beta.
- `ALLOW_DEMO_BILLING_IN_PRODUCTION`: emergency override that allows demo billing in production. Leave `false` unless you are intentionally running a demo environment.
- `FIELD_TEST_MODE`: shows beta feedback affordances and an admin field-test summary. Keep enabled for private field tests; disable for a polished public launch.
- `STRIPE_SECRET_KEY`: Stripe test/live secret key for checkout sessions and webhook calls.
- `STRIPE_WEBHOOK_SECRET`: Stripe endpoint secret used to verify subscription webhooks.
- `STRIPE_PRICE_MONTHLY`: Stripe price ID for the A$1.99/month plan.
- `STRIPE_PRICE_YEARLY`: Stripe price ID for the A$19/year plan.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: browser publishable key placeholder for future embedded Stripe UI.

## Exact ngrok Workflow

1. Install dependencies.

```bash
npm install
```

2. Start the app.

```bash
npm run dev
```

3. Start ngrok in another terminal.

```bash
ngrok http 3000
```

4. Copy the HTTPS forwarding URL from ngrok.

Example:

```text
https://abc123.ngrok-free.app
```

5. Put that exact URL into `.env` as `PUBLIC_BASE_URL`.

```dotenv
PUBLIC_BASE_URL=https://abc123.ngrok-free.app
```

6. Restart the app after editing `.env`.

## Split Seconds Staging Domain

You do not need to buy a separate subdomain if you already own `splitseconds.app`.

Use:

```text
beer.splitseconds.app
```

That is the recommended staging/live-testing host for this project because it keeps the beer map separate from the main Split Seconds app while still living under your existing domain.

When you deploy it, switch:

```dotenv
PUBLIC_BASE_URL=https://beer.splitseconds.app
```

Recommended rollout:

1. Keep local development on `localhost` and ngrok.
2. Deploy the app to Railway.
3. Point `beer.splitseconds.app` at that host with DNS.
4. Switch `PUBLIC_BASE_URL` to `https://beer.splitseconds.app`.
5. Update Twilio and ElevenLabs webhook URLs to the same domain.
6. Add the domain to your Google Maps browser key referrer rules.

Recommended Google Maps browser key referrers once hosted:

- `https://beer.splitseconds.app/*`
- `http://localhost:3000/*`
- `http://127.0.0.1:3000/*`

Recommended Google key split long-term:

- `.env` `GOOGLE_MAPS_API_KEY`: browser Google Maps key for web map rendering
- `.env` `GOOGLE_PLACES_API_KEY`: server-side key for venue import/search
- later: dedicated iOS key for the App Store app
- later: dedicated Android key for the Play Store app

Recommended hosted environment values:

```dotenv
PUBLIC_BASE_URL=https://beer.splitseconds.app
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
GOOGLE_MAPS_API_KEY=your_google_maps_browser_key
GOOGLE_MAPS_MAP_ID=optional_google_maps_map_id
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
```

## Railway Deployment

This repo includes [railway.toml](/Users/zac/Desktop/Beer/railway.toml) with:

- build command: `npm run build`
- start command: `npm run start`
- healthcheck path: `/health`

Recommended Railway service setup:

1. Deploy one web service from this repo.
2. Attach a persistent volume mounted at `/app/data`.
3. Set `DATABASE_PATH=./data/melb-beer-bot.sqlite`.
4. Set `PUBLIC_BASE_URL=https://beer.splitseconds.app`.
5. Add the custom domain `beer.splitseconds.app`.

Because the app uses SQLite for local `call_runs` state, the persistent volume matters.

## Viewer Google Maps Setup

The viewer supports two modes:

1. Hosted through the Express app
   This is the recommended production path on Railway.
2. Standalone static viewer
   This is useful for quick local-only tests with `npx serve viewer`.

When the viewer is hosted through the Express app, the browser config is served automatically from:

- `/config.js`

and uses these safe env vars:

- `GOOGLE_MAPS_API_KEY`
- `GOOGLE_MAPS_MAP_ID`

The hosted public viewer intentionally does not receive Supabase browser credentials. Venue and price data comes through `/api/business/venues` and `/api/business/price-records` so exact-price access can be enforced server-side.

For legacy standalone local use, the viewer can still use:

- `viewer/config.js`

Start from the example:

```bash
cp viewer/config.example.js viewer/config.js
```

Then set:

```js
window.MELB_BEER_BOT_VIEWER_CONFIG = {
  googleMapsApiKey: "your_google_maps_browser_key",
  googleMapsMapId: "",
  trackedBeers: [],
  business: {
    fieldTestMode: true,
    freePriceRevealsPerDay: 3,
  },
};
```

Notes:

- Do not use standalone static mode for public beta price data, because it cannot enforce server-side price gating.
- `googleMapsApiKey` should be a browser key restricted by HTTP referrers
- `googleMapsMapId` is optional for now, but it gives you a clean path to branded vector map styling later

For local browser testing, allow these referrers on the Google Maps browser key:

- `http://localhost:3000/*`
- `http://127.0.0.1:3000/*`
- `http://localhost:*/*`
- `http://127.0.0.1:*/*`

For hosted staging, also allow:

- `https://beer.splitseconds.app/*`

Make sure the same Google Cloud project has:

- `Maps JavaScript API` enabled
- billing enabled

Long-term recommended key split:

- browser web viewer: Google Maps browser key via `/config.js` or `viewer/config.js`
- server-side venue import: `GOOGLE_PLACES_API_KEY`
- iOS app: dedicated iOS Maps key
- Android app: dedicated Android Maps key

That keeps local testing, the web viewer, and the future mobile apps on the same Google Maps platform without sharing one over-broad key.

## Melbourne Venue Import

Import or refresh Melbourne bar and pub venues into Supabase `venues`:

```bash
npm run venues:import -- --dry-run
```

Then run the real import:

```bash
npm run venues:import
```

Notes:

- the importer scans a Melbourne metro grid with Google Places Nearby Search
- it keeps only venues Google classifies as a strict `bar` or `pub`
- it excludes obvious noisy results like airport lounges and sports/golf club false positives
- it updates existing rows by `google_place_id` when available
- it falls back to matching by normalized `name + address`
- it stores `name`, `address`, `suburb`, `state`, `postcode`, `phone`, `website`, `latitude`, and `longitude`
- it continues past single-cell Google API failures instead of killing the whole run

If you want to test on a smaller area first:

```bash
npm run venues:import -- --dry-run --max-cells=5
```

For a targeted Melbourne CBD backfill to catch bars the broad metro grid can miss:

```bash
npm run venues:import:city -- --dry-run
npm run venues:import:city
```

That city backfill:

- runs Google Places Text Search against Melbourne CBD bar/pub queries
- is useful for filling gaps where Nearby Search ranking misses inner-city venues
- still dedupes by `google_place_id` first, then normalized `name + address`

For an inner-ring Melbourne suburb backfill across:

- Fitzroy
- Collingwood
- Richmond
- Carlton
- South Yarra
- St Kilda
- Brunswick
- Prahran
- South Melbourne

run:

```bash
npm run venues:import:inner-ring -- --dry-run
npm run venues:import:inner-ring
```

That inner-ring backfill:

- runs Google Places Text Search suburb-by-suburb for bars and pubs
- is useful for catching major hospitality pockets just outside the CBD
- keeps the suburb list explicit instead of widening the whole metro filter

## Review Export Before Calling

Export a clean review list of call-ready venues before batch calling:

```bash
npm run venues:review
```

That writes:

- `data/venue-call-review.json`
- `data/venue-call-review.csv`

By default the review export:

- includes only venues that have a valid E.164-callable phone number
- includes only venues with coordinates
- excludes venues already present in Supabase `call_results`

Helpful options:

```bash
npm run venues:review -- --limit=50
npm run venues:review -- --suburb=fitzroy
npm run venues:review -- --include-called --include-not-ready
```

## Batch Call Imported Venues

Once the app is running locally and ngrok is live, queue calls for imported venues:

```bash
npm run venues:call -- --dry-run --limit=10
```

Then run the real batch:

```bash
npm run venues:call -- --limit=25 --delay-ms=45000
```

To run the same venue batch for a different beer target, set `TARGET_BEER` before the command:

```bash
TARGET_BEER=carlton_draft npm run venues:call -- --limit=25 --delay-ms=45000
TARGET_BEER=stone_and_wood npm run venues:call -- --limit=25 --delay-ms=45000
```

What the batch caller does:

- reads venues from Supabase `venues`
- normalizes Australian phone numbers to E.164
- skips venues already resolved locally or in Supabase
- auto-runs stale call recovery before dialing
- respects the configured Melbourne business-hours window
- posts sequentially to `POST /api/calls/outbound`
- writes resumable state to `data/runs/venue-call-batch-state.json`
- pauses automatically if the last queued call is still unresolved after the wait window
- pauses automatically after too many consecutive bad outcomes
- waits between calls so you do not hammer venues or your Twilio account

Helpful options:

```bash
npm run venues:call -- --suburb=fitzroy --limit=10
npm run venues:call -- --test-mode --limit=3
npm run venues:call -- --include-called --limit=5
npm run venues:call -- --fresh
npm run venues:call -- --state-file=./data/runs/my-batch.json
```

If a batch pauses, rerun the same command and it will resume from the saved state file. Use `--fresh` only when you intentionally want to discard the saved cursor and build a new queue.

## Viewer Data Source

The hosted `viewer/index.html` now reads venue pins and approved price previews through the local Express business API:

- `GET /api/business/venues`
- `GET /api/business/price-records`

`/api/business/price-records` returns redacted records by default. The viewer requests `reveal=true&venueId=...` only when a user opens a venue detail, and the server decides whether exact prices can be returned.

Call-derived data can still sync into Supabase `call_results` for the calling pipeline, but the public browser should not read that table directly for beta use.

The hosted Express app serves browser config from `/config.js`. For standalone static testing only, you can copy `viewer/config.example.js` to a local ignored `viewer/config.js`; do not commit real browser keys.

For quick local testing with a temporary browser key override, you can also open:

```text
http://localhost:3000/?googleMapsKey=YOUR_BROWSER_KEY
```

The synced `cleaned` payload is now more map-friendly:

- `cleaned.beers.<beer_key>` contains the structured beer outcome for each known beer
- `cleaned.menu_items` exposes the same data as a simple list for future menu aggregation
- `cleaned.menu_capture` records that the current source is a targeted phone probe rather than a full venue menu scrape
- each beer entry includes explicit availability fields so the viewer can show `On tap`, `Cans only`, `Bottles only`, or `Unavailable` without guessing from transcript text

That means the end-to-end loop is:

1. import venues into Supabase
2. export and review the call-ready venue list
3. batch call venues through the local app
4. let ElevenLabs post-call processing sync results into Supabase `call_results`
5. review or publish trusted rows into `venue_price_records`
6. refresh the hosted viewer and see the server-gated map update

## Future Menu Roadmap

The current phone workflow is intentionally a narrow probe, not a full menu capture. The synced payload now leaves a clean runway for future crowdsourcing:

- keep `call_results` focused on call-derived beer intel
- treat `cleaned.menu_items` as the first small slice of venue menu knowledge
- later add crowdsourced venue menu submissions on top, keyed by `venue_id`
- merge crowdsourced menu items with call-derived beer availability rather than replacing it

## Exact Twilio Webhook URLs

Use these URLs with your ngrok domain:

- Voice webhook:

```text
https://YOUR-NGROK-URL/webhooks/twilio/voice
```

- Status webhook:

```text
https://YOUR-NGROK-URL/webhooks/twilio/status
```

For outbound calls started by this app, those webhook URLs are passed programmatically to Twilio on each call. If you want to mirror them in the Twilio Console while testing, paste those same URLs into your Twilio number’s voice webhook settings and use `POST`.

## Exact ElevenLabs Webhook URL

Set your ElevenLabs post-call webhook URL to:

```text
https://YOUR-NGROK-URL/webhooks/elevenlabs/post-call
```

If webhook signing is enabled in ElevenLabs, copy the shared secret into:

```dotenv
ELEVENLABS_WEBHOOK_SECRET=...
```

## How One Real Call Works

1. You call `POST /api/calls/outbound`.
2. The app creates a `call_runs` row immediately.
3. The app asks Twilio to place the outbound call.
4. Twilio hits `/webhooks/twilio/voice`.
5. The app registers the live call with ElevenLabs and returns TwiML.
6. The ElevenLabs agent asks:

```text
Hey mate, quick one, how much is a pint of Guinness there?
```

7. If the response is unclear, it can ask once:

```text
Sorry, what was that mate?
```

8. Twilio status webhooks update the `call_runs` row while the call progresses.
9. ElevenLabs sends the post-call transcript webhook after the call is processed.
10. The app stores the full raw transcript, parses the Guinness price data, and updates `parse_confidence` and `parse_status`.
11. You inspect the finished run via `GET /api/calls` or `GET /api/calls/:callSid`.

## Exact Test Call Command

Use this to place a clearly marked test call to your own mobile number:

```bash
curl -X POST http://localhost:3000/api/calls/outbound \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_SESSION_TOKEN" \
  -d '{
    "venueId": "27b97227-2735-4a9c-ad7c-d1047f3f225e",
    "venueName": "Personal Test Call",
    "phoneNumber": "+61400000000",
    "suburb": "Test",
    "testMode": true
  }'
```

Use a real `venues.id` value here so the outbound call, ElevenLabs webhook payload, and downstream beer-price rows all stay attached to the correct venue.

What happens in test mode:

- the `call_runs.is_test` flag is set to `true`
- the API responses include `isTest`
- the run is easy to filter from real venue calls
- the agent still asks the normal beer and happy-hour questions so the full flow is testable

## Review APIs

List recent calls:

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_SESSION_TOKEN" \
  "http://localhost:3000/api/calls"
```

List only review-needed calls:

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_SESSION_TOKEN" \
  "http://localhost:3000/api/calls?needsReview=true"
```

List only review-needed parsed results:

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_SESSION_TOKEN" \
  "http://localhost:3000/api/results?needsReview=true"
```

Inspect one call by Twilio Call SID:

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_SESSION_TOKEN" \
  "http://localhost:3000/api/calls/CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

The call review responses include:

- call metadata from `call_runs`
- `rawTranscript`
- `parseConfidence`
- `parseStatus`
- `needsReview`
- parsed beer result rows
- parsed happy hour summary

`needsReview=true` returns calls where at least one of these is true:

- `parse_status` is `partial`
- `parse_status` is `needs_review`
- `parse_status` is `failed`
- `parse_confidence` is below the configured threshold

## Outbound Request Validation

`POST /api/calls/outbound` validates:

- `venueId` as a UUID from your `venues.id` table
- `venueName`
- `phoneNumber` in E.164 format
- `suburb`
- optional `testMode`

Invalid numbers are rejected cleanly with a JSON validation error.

There is also a repeat-dial safeguard:

- if the same number was dialed recently, the API returns a `429`
- controlled by `OUTBOUND_REPEAT_GUARD_SECONDS`

## Data Model

### call_runs

One row per call attempt, including:

- `id`
- `call_sid`
- `venue_name`
- `phone_number`
- `suburb`
- `started_at`
- `ended_at`
- `duration_seconds`
- `call_status`
- `raw_transcript`
- `parse_confidence`
- `parse_status`
- `error_message`
- `created_at`
- `updated_at`

Additional operational fields:

- `conversation_id`
- `is_test`

### beer_price_results

One row per beer per call, plus the shared happy-hour block:

- `beer_name`
- `price_text`
- `price_numeric`
- `confidence`
- `needs_review`
- `happy_hour`
- `happy_hour_days`
- `happy_hour_start`
- `happy_hour_end`
- `happy_hour_price`
- `happy_hour_confidence`

## Sample SQL Schema

The full schema lives at [`src/db/schema.sql`](/Users/zac/Desktop/beer/src/db/schema.sql).

## Logging and Observability

The app emits structured JSON logs for:

- outbound call creation failures
- Twilio voice webhook hits
- Twilio status webhook hits
- ElevenLabs post-call webhook hits
- transcript parse completion
- parse failures

This is the main visibility layer when you place a real call.

## Verification

Run the full local check suite:

```bash
npm run check
```

## Troubleshooting

### Webhook not hit

- Confirm `PUBLIC_BASE_URL` matches the current ngrok URL exactly.
- Confirm ngrok is still running.
- Confirm the app is listening on the same port ngrok is forwarding to.
- If `TWILIO_VALIDATE_SIGNATURES=true`, make sure Twilio is calling the exact same URL, including HTTPS and host.
- Watch the app logs while placing the call. You should see a log entry for `/webhooks/twilio/voice` and `/webhooks/twilio/status`.

### TwiML invalid

- `POST /webhooks/twilio/voice` always returns XML, even on failure.
- If the call immediately reads the fallback message, the voice webhook was reached but ElevenLabs setup failed.
- Check:
  - `ELEVENLABS_API_KEY`
  - `ELEVENLABS_AGENT_ID`
  - ngrok URL
  - Twilio request signature validation setting
- Inspect the matching call via `GET /api/calls/:callSid` and look at `errorMessage`.

### Call completes but no transcript

- Confirm ElevenLabs post-call webhook is configured to:

```text
https://YOUR-NGROK-URL/webhooks/elevenlabs/post-call
```

- Confirm `ELEVENLABS_WEBHOOK_SECRET` matches the webhook configuration if signing is enabled.
- Check app logs for `/webhooks/elevenlabs/post-call`.
- Inspect the call via `GET /api/calls/:callSid`.
- If `parseStatus` is still `pending`, the post-call webhook probably never arrived.
- If `parseStatus` is `failed` and `rawTranscript` is empty, the webhook arrived but there was no usable transcript body.

### Transcript saved but parser empty

- Inspect `rawTranscript` from `GET /api/calls/:callSid`.
- Check whether the transcript actually contains the beer names or happy-hour answer.
- If the agent reached the fallback message instead of ElevenLabs, the transcript may be missing the expected conversation.
- `parseStatus=partial` means some fields were extracted but not all.
- `parseStatus=needs_review` means data was found but confidence was too low.
- `parseStatus=failed` means no useful structured data could be derived.

## Notes

- This pass focuses on reliability and observability, not UI.
- There is no full auth layer yet.
- The Twilio voice route is intentionally defensive so one malformed webhook does not crash the call flow.
