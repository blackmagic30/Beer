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
- Parses the current target beer flow, currently Guinness.
- Syncs completed venue-linked call results into Supabase `call_results` so the viewer can render them on the map.
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

## Main Routes

- `POST /api/calls/outbound`
- `GET /api/calls`
- `GET /api/calls/:callSid`
- `GET /api/results`
- `POST /webhooks/twilio/voice`
- `POST /webhooks/twilio/status`
- `POST /webhooks/elevenlabs/post-call`
- `GET /health`

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
```

What each one does:

- `PUBLIC_BASE_URL`: your public HTTPS base URL. Use your ngrok URL here.
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
- `SUPABASE_ANON_KEY`: browser-safe Supabase anon key used by the viewer.
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
SUPABASE_ANON_KEY=your_supabase_anon_browser_key
GOOGLE_MAPS_API_KEY=your_google_maps_browser_key
GOOGLE_MAPS_MAP_ID=optional_google_maps_map_id
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

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `GOOGLE_MAPS_API_KEY`
- `GOOGLE_MAPS_MAP_ID`

For standalone local use, the viewer can still use:

- `viewer/config.js`

Start from the example:

```bash
cp viewer/config.example.js viewer/config.js
```

Then set:

```js
window.MELB_BEER_BOT_VIEWER_CONFIG = {
  supabaseUrl: "https://your-project.supabase.co",
  supabaseAnonKey: "your_supabase_anon_browser_key",
  googleMapsApiKey: "your_google_maps_browser_key",
  googleMapsMapId: "",
};
```

Notes:

- `supabaseAnonKey` should be your public browser anon key, not the service role key
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

`viewer/index.html` now reads the latest rows from Supabase `call_results`, joins them to `venues`, and renders one marker per venue using the newest synced call result.

The viewer expects its browser config in:

- `viewer/config.js`

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
5. refresh `viewer/index.html` and see the map update

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
curl "http://localhost:3000/api/calls"
```

List only review-needed calls:

```bash
curl "http://localhost:3000/api/calls?needsReview=true"
```

List only review-needed parsed results:

```bash
curl "http://localhost:3000/api/results?needsReview=true"
```

Inspect one call by Twilio Call SID:

```bash
curl "http://localhost:3000/api/calls/CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
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
