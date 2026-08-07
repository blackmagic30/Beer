# Pint Path production launch runbook

Last audited: 3 August 2026
Scope: full public web launch plus an Australian iOS launch.

The current Railway-volume/SQLite architecture is not a highly available
“full-scale” architecture: Railway volumes cannot use replicas and require a
brief service interruption during deployment. It may support only a quantified,
single-region controlled public launch after capacity/soak and downtime risk are
accepted in writing. A launch marketed or operated as horizontally scalable,
multi-region, or highly available requires migration of the authoritative
SQLite data, deletion outbox, webhook correlation, and job leases to one shared
transactional datastore before candidate freeze.

The first iOS release has one architecture: free discovery, contribution, and
assigned venue-Free profile/beer-list management. It contains no consumer paid
entitlement, StoreKit product, venue Pro surface, venue trial activation,
billing management, upgrade prompt, or external purchase link. Venue Pro and
the dormant 60-day introductory Pro design are web-only.

Pricing and the venue offer are currently deferred. Both enrolment flags remain
false, and no price, checkout, or introductory Pro grant may be marketed or
started in this release. The existing 60-day design shares the commercial flag
and Stripe path, so it cannot supply the requested free venue access while paid
enrolment remains closed. Before offering it, the owner must either approve the
complete pricing/Stripe contract or ship and prove a separately flagged,
non-billing grant path that expires to Free without creating a subscription.

This is the controlling sequence. Complete it from top to bottom. A later phase never waives a failed earlier gate.

## Release identities and stop rule

Record these values in the private release register:

- `releaseId`: the immutable business release identifier.
- `candidateSha`: the 40-character PR-head commit containing all application, migration, workflow, iOS, test, and runbook implementation. It freezes only after integrated staging passes.
- `deploymentSha`: the protected `main` commit first deployed with commercial enrolment disabled.
- `deployedMainSha`: the exact protected `main` commit serving production at final enablement. It may differ from `candidateSha` only by merge metadata and the evidence-only closeout change allowed by the release-evidence validator.
- `rollbackBuildSha`: a separately recorded, deployable build proven against schema version 15 and the post-migration Supabase schema.

`candidateSha` and `rollbackBuildSha` never change for a release. If any application, schema, workflow, iOS, threshold, or test file changes after `candidateSha` is recorded, discard that candidate identity and return to integrated staging. Updating only `docs/release-evidence.json` with genuine post-deployment evidence is the sole closeout exception.

Do not record the older production commit `52622fad3330d2f1591425e34b465252831001eb` as `rollbackBuildSha`: that build supports local schema version 11 and refuses a database newer than it supports.

## Current verdict

**No-go for the requested full-scale web and iOS launch today.**

The production service is online on commit
`95b9f2da5e9a99692c8cfafba90d2c29e63ccbc8`. A fresh public smoke on 3 August
2026 passed nine public availability/page/API checks with zero failures; the
three authenticated role checks were skipped because protected smoke
credentials were not supplied. The deployed build predates the new launch-flag,
Google-only OAuth, schema-15 deletion-notice, and 3 August legal contracts.

Observed production data on 3 August 2026:

- 612 unique venues across 112 nonblank suburbs.
- Only 5 of 611 marketed venues (0.82%) have at least three qualifying current verified prices.
- Zero suburb buckets pass the required 70% coverage independently.
- Keeping all 112 suburbs in scope requires at least 478 covered venues because
  each suburb rounds its own 70% target up. At the observed row distribution,
  that is at least 473 additional covered venues and a theoretical minimum of
  1,415 additional qualifying price rows; reverification and rejected rows will
  increase the real workload.
- The public API returns 62 trusted price rows, but zero expose a source-submission link and private evidence existence cannot be inferred.
- Zero happy-hour records and zero specials are public.
- The newest qualifying price was verified on 5 July 2026, about 685 hours
  before the latest gate, against a 48-hour launch maximum.
- Three structured addresses are malformed.
- Business status is not exposed for the currently public directory, so the absence of closed venues cannot be proved.
- With the signed no-happy-hour launch scope applied, the gate has five failures and three unknowns: eight blocking issues. Without that signed scope, happy-hour coverage is a ninth blocker.

The local working candidate has passed Node 22 TypeScript and Vitest checks, the repository security and dependency scans, deployment guards, plist validation, an Xcode 26.5 Release simulator build, and an unsigned Release device archive. These are local results, not proof of the final frozen commit, a signed archive, production data, or App Review approval.

The workspace now contains local implementations for the commercial gates, no-card trial rules, evidence linkage, exact Place-ID status refresh, recurring refresh workflow, hidden no-happy-hour scope, web-and-iOS evidence scope, and production price-promotion controls. They remain unproved until the final tree is independently reviewed, committed, pushed, rerun in CI, and exercised in integrated staging.

The remaining launch blockers require live/external completion:

- deploy and verify the status/evidence schema, then reconcile every trusted public row;
- build qualifying current prices until every marketed suburb independently passes;
- correct all malformed structured addresses;
- enable PITR, prove a usable recovery point, and restrict production database network access;
- configure and dispatch the protected daily status workflow, then connect its failure threshold to the real on-call page;
- a schema-15-compatible rollback build;
- a clean candidate commit, current remote CI/CodeQL, independent approval, and required branch protections;
- either a shared transactional datastore that permits replicas or an explicitly
  limited single-region launch decision backed by quantified peak/soak,
  write-contention, disk-full, restart, and deployment-recovery evidence;
- an immutable backup copy in a separate failure domain, written with an
  application credential that cannot shorten retention or delete prior copies;
- proof that an access JWT captured before account deletion cannot use the Pint
  Path API, Supabase Data API/RPC, or Storage after deletion;
- staging proof that deletion removes raw submissions, item/free text,
  contribution ledger, evidence links, and submission-derived public rows;
- proof that an existing Google-only web account can establish email/password
  access in iOS without creating a second Supabase user or Pint Path account;
- the approved manual daily account-deletion and moderation operations;
- signed legal/GST/privacy/liquor/marketing decisions;
- active Apple account/agreements/compliance status, signed App Store archive
  validation, physical-device/TestFlight proof, defined crash monitoring, App
  Review approval, and release evidence.

## Phase 0 — approve and record the immutable launch contract

Do not begin paid outreach, candidate freeze, production mutation, or App Store submission until the owner records:

1. **Initial geography:** the exact ordered list of marketed suburbs. Recommended first scope is Victoria-only and limited to suburbs that pass the gate independently.
2. **Venue offer:** currently deferred and disabled. Before enabling it, approve the exact duration, eligibility, expiry, duplicate/fraud handling, support path, and whether it is a separately flagged non-billing grant or a Stripe trial. A free grant must expire to Free without creating a payment obligation.
3. **Paid transition:** currently deferred and disabled. If a future offer can transition to paid Pro, approve when billing starts, consent/payment-method requirements, cancellation/refund handling, and prove the exact behaviour in staging plus the smallest-value live canary.
4. **Venue price and GST:** currently deferred. Before paid enrolment, approve the amount, whether it includes GST, the operator's GST-registration decision, and all authoritative copy. Do not treat any dormant internal amount as an approved launch price.
5. **iOS architecture:** free discovery, contribution, and assigned venue-Free
   profile/beer-list management. No StoreKit, paid consumer entitlement, venue
   Pro capability, trial activation, upgrade prompt, billing portal, or external
   purchase link.
6. **Native authentication:** email-based account access only for the first release; Google and Apple social login are compile-disabled, not merely hidden by a remote provider list.
7. **Happy-hour launch choice:** launch without happy-hour discovery. All consumer web and iOS filters, cards, badges, empty states, claims, and promotional copy stay hidden until the 25% threshold is met in a future release.
8. **Deletion operation:** the named primary and backup operators, the fixed daily review time, the displayed seven-day cancellation window, the guaranteed completion deadline, and the escalation contact.
9. **Moderation operation:** the named owner, backup, response SLA, appeal path, and emergency takedown path.
10. **Legal entity:** the same approved entity for the app, Apple developer
    account, contracts, ABN, domains, and active provider accounts. Stripe
    entity alignment becomes mandatory only for a future commercial candidate.
11. **Data thresholds:** the exact values in Phase 8 and the exact marketed-suburb scope. These values are immutable for this release.
12. **Named release roles:** deployer, independent reviewer, evidence verifier, rollback operator, and first-72-hours on-call operator.
13. **Breach response:** named primary/backup incident and privacy decision owners, provider escalation contacts, and a passed tabletop using `docs/data-breach-response-runbook.md`.
14. **Availability architecture:** either migrate the authoritative SQLite/outbox/job state to shared transactional Postgres and prove replicas, or record that this is a controlled single-region launch with planned deployment downtime, quantified capacity, 2× peak headroom, maintenance communication, and a named migration trigger. Do not call the latter highly available or full-scale.
15. **Backup authority:** one immutable copy in a different provider or region,
    an application principal that can create but cannot delete/overwrite retained
    objects, a separately controlled retention/deletion principal, and tested
    object-lock/WORM retention. A second Supabase project controlled by the same
    production service-role key is an operational copy, not this proof.
16. **Deletion content contract:** delete raw submissions, submission items/free
    text, contribution ledger, evidence links, and every public price row derived
    from that submission. Any future publisher-curated retained fact needs a
    separate fully de-linked ingestion path and written privacy/legal plus App
    Review approval in a new candidate.
17. **iOS monitoring:** for a true broad/full-scale release, select a
    privacy-reviewed production crash source with dSYM symbolication and alert
    delivery (for example a separately approved crash processor or a first-party
    MetricKit pipeline), supplemented by TestFlight/App Store Connect and Xcode
    Organizer. For a controlled cohort only, Apple-native reports may be used
    while every report is manually reviewed. Name the owner/cadence; require zero
    reproducible critical crashes and at least 99.5% crash-free sessions over
    seven days and 500 sessions before broad expansion. With a smaller sample,
    remain controlled. Any new diagnostics processor requires privacy, retention,
    policy, and App Store declaration review before candidate freeze.

The following dormant copy is not approved for publication until items 2–4 are
resolved and the chosen grant/billing implementation passes staging:

> 60-day Introductory Pro access for verified venues. No card required. No automatic charge. Your access ends on the exact date and time shown in your venue dashboard. Unless your venue actively starts a paid Pro subscription on the web, it automatically moves to Free when the introductory period ends. Your venue profile and saved data remain. Pro analytics, reports, specials and premium placement switch off at expiry.

Use “60-day,” not “two-month.”

## Phase 1 — freeze unsafe public scope

- [ ] Keep `COMMERCIAL_LAUNCH_ENABLED=false`.
- [ ] Keep `PINT_POINTS_REWARDS_ENABLED=false`.
- [ ] Keep `ALCOHOL_GAMIFICATION_ENABLED=false`.
- [ ] Keep Pub Golf, alcohol-purchase points, free-pint rewards, and redemption routes out of public pages, screenshots, demos, and App Store metadata.
- [ ] Keep consumer paid enrolment outside this release.
- [ ] Keep venue trial and paid-Pro entry points closed for this release.
- [ ] Hide all consumer happy-hour UI and copy on both web and iOS.
- [ ] Do not market broad verified-price coverage while the strict data gate fails.
- [ ] Do not market suburbs outside the approved, independently passing list.
- [ ] Do not submit or release the current iOS build.

Production launch-safe values are:

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://pintpath.au
FIELD_TEST_MODE=false
DEMO_BILLING_MODE=false
ALLOW_DEMO_BILLING_IN_PRODUCTION=false
COMMERCIAL_LAUNCH_ENABLED=false
CONSUMER_PAID_ENROLLMENT_ENABLED=false
SUPABASE_OAUTH_PROVIDERS=google
ACCOUNT_DELETION_REHEARSAL_ENABLED=false
ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
PINT_POINTS_REWARDS_ENABLED=false
ALCOHOL_GAMIFICATION_ENABLED=false
ALCOHOL_PROMOTION_APPROVAL_REFERENCE=
VENUE_PRO_TRIAL_DAYS=0
VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD=false
REQUIRE_REDIS_RATE_LIMITING=true
ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false
REQUIRE_ADMIN_MFA_IN_PRODUCTION=true
REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true
```

Do not treat saved provider variables as proof. Before and after every production deployment, save `/config.js` privately and parse its public business object:

```bash
set -euo pipefail
curl -fsS https://pintpath.au/config.js \
  | sed -e '1s/^window\.MELB_BEER_BOT_VIEWER_CONFIG = //' -e '$s/;$//' \
  > "$PINTPATH_EVIDENCE_DIR/live-config.json"

jq -e '
  .business.commercialLaunchEnabled == false
  and .business.consumerPaidEnrollmentEnabled == false
  and .business.pricing == null
  and .business.pintPointsRewardsEnabled == false
  and .business.alcoholGamificationEnabled == false
  and .business.venueProTrialDays == 0
  and .business.venueProTrialRequiresPaymentMethod == false
  and .business.demoBillingMode == false
  and .business.fieldTestMode == false
' "$PINTPATH_EVIDENCE_DIR/live-config.json"
```

Stop if the response differs. Phase 18 repeats this same disabled-state assertion;
there is no commercial-enable step in this release.

## Phase 2 — preserve complete current production evidence

Use a new encrypted absolute directory outside the repository. Do not reuse a prior directory and do not put credentials, private source material, or personal data in Git.

The public venue and mission APIs use offset pagination; the public price API uses cursor pagination. Capture every page, not a large first page. Reconcile the offset-page item count to the API total, require the last `hasMore=false`, reject repeated price cursors, and save raw response pages before hashing.

```bash
set -euo pipefail
umask 077

PINTPATH_EVIDENCE_DIR=/absolute/private/pintpath-launch-2026-07-28
test ! -e "$PINTPATH_EVIDENCE_DIR"
mkdir -p "$PINTPATH_EVIDENCE_DIR"

capture_offset_pages() {
  local capture_endpoint="$1"
  local capture_item_field="$2"
  local capture_stem="$3"
  local capture_limit="$4"
  local capture_offset=0
  local capture_seen=0
  local capture_total=-1
  local capture_page=0

  while :; do
    local capture_file
    capture_file="$PINTPATH_EVIDENCE_DIR/${capture_stem}-$(printf '%04d' "$capture_page").json"
    curl -fsS \
      "https://pintpath.au/api/business/${capture_endpoint}?limit=${capture_limit}&offset=${capture_offset}" \
      > "$capture_file"

    jq -e --arg item "$capture_item_field" --argjson expectedOffset "$capture_offset" '
      .ok == true
      and (.data[$item] | type == "array")
      and (.data.pagination.total | type == "number")
      and .data.pagination.offset == $expectedOffset
      and (.data.pagination.hasMore | type == "boolean")
    ' "$capture_file" >/dev/null

    local capture_page_total
    local capture_page_count
    local capture_has_more
    capture_page_total="$(jq -r '.data.pagination.total' "$capture_file")"
    capture_page_count="$(jq -r --arg item "$capture_item_field" '.data[$item] | length' "$capture_file")"
    capture_has_more="$(jq -r '.data.pagination.hasMore' "$capture_file")"

    if [ "$capture_total" -eq -1 ]; then
      capture_total="$capture_page_total"
    fi
    test "$capture_page_total" -eq "$capture_total"
    capture_seen=$((capture_seen + capture_page_count))

    if [ "$capture_has_more" = "false" ]; then
      test "$capture_seen" -eq "$capture_total"
      break
    fi

    test "$capture_page_count" -gt 0
    capture_offset=$((capture_offset + capture_page_count))
    capture_page=$((capture_page + 1))
  done
}

capture_offset_pages venues venues venues 250
capture_offset_pages missions missions missions 200

price_cursor=""
price_cursor_log="$PINTPATH_EVIDENCE_DIR/price-cursors.txt"
: > "$price_cursor_log"
price_page=0
while :; do
  price_url='https://pintpath.au/api/business/price-records?limit=500'
  if [ -n "$price_cursor" ]; then
    price_encoded_cursor="$(jq -nr --arg value "$price_cursor" '$value | @uri')"
    price_url="${price_url}&cursor=${price_encoded_cursor}"
  fi

  price_file="$PINTPATH_EVIDENCE_DIR/price-records-$(printf '%04d' "$price_page").json"
  curl -fsS "$price_url" > "$price_file"
  jq -e '
    .ok == true
    and (.data.records | type == "array")
    and ((.data.nextCursor == null) or (.data.nextCursor | type == "string"))
  ' "$price_file" >/dev/null

  price_next_cursor="$(jq -r '.data.nextCursor // empty' "$price_file")"
  if [ -z "$price_next_cursor" ]; then
    break
  fi
  if grep -Fqx -- "$price_next_cursor" "$price_cursor_log"; then
    echo "Repeated price cursor" >&2
    exit 1
  fi
  printf '%s\n' "$price_next_cursor" >> "$price_cursor_log"
  price_cursor="$price_next_cursor"
  price_page=$((price_page + 1))
done

jq -s '[.[].data.records | length] | add' \
  "$PINTPATH_EVIDENCE_DIR"/price-records-*.json \
  > "$PINTPATH_EVIDENCE_DIR/price-record-count.txt"

curl -fsS https://pintpath.au/health > "$PINTPATH_EVIDENCE_DIR/health.json"
curl -fsS https://pintpath.au/ready > "$PINTPATH_EVIDENCE_DIR/ready.json"
PINTPATH_DATA_BASE_URL=https://pintpath.au \
  npm run --silent readiness:data \
  > "$PINTPATH_EVIDENCE_DIR/data-readiness-observation.json"

shasum -a 256 "$PINTPATH_EVIDENCE_DIR"/* \
  > "$PINTPATH_EVIDENCE_DIR/SHA256SUMS"
```

Record the operator, UTC start/end, production commit, page counts, reconciled totals, price-record count, commands, aggregate results, and `SHA256SUMS` hash in the private release register.

## Phase 3 — implement every launch requirement before candidate freeze

All implementation and staging work occurs before `candidateSha` exists. This includes code, migration, CI, tests, policies, copy, native compile-time scope, operational scripts, and this runbook.

The candidate must contain and test:

- separate enforcement proving that opening web venue Pro cannot expose any native venue, billing, external-purchase, or consumer-paid surface;
- compile-time exclusion of venue Pro, trial, billing, admin, and other
  commercial screens from the Australian iOS Release archive while keeping only
  assigned venue-Free profile/beer-list management;
- compile-time exclusion of Google and Apple native social login for the first release;
- hidden consumer happy-hour UI on web and iOS while the no-happy-hour release waiver is active;
- public evidence-presence metadata that proves linkage without exposing private evidence;
- fail-closed source capture before a trusted price becomes public;
- a complete, target-pinned venue refresh that checks every existing Google Place ID;
- a reviewed production price-promotion tool satisfying Phase 7;
- fail-closed deferred-pricing configuration that exposes no current amount,
  trial, checkout, or upgrade path while both enrolment flags are false;
- fixed, scope-bound data thresholds satisfying Phase 8;
- an approved manual daily deletion operation satisfying Phase 10;
- a scope-aware release-evidence validator and workflows satisfying Phase 14;
- protected GitHub-environment production smoke workflows satisfying Phase 17;
- a schema-version-15-compatible rollback build and rehearsal satisfying Phase 12.

Any missing item is a blocker. Do not freeze a candidate and promise to add it later.

## Phase 4 — inspect production Supabase without changing it

Production project ref: `jxpubqlmqnnqwadmjgyk`.
Independent backup project ref: `gjjffexmflwtnewtkkiy`.

Already observed:

- both projects were healthy in `ap-southeast-2`;
- production used Postgres 17;
- SSL enforcement was enabled;
- seven completed daily physical backups were visible;
- PITR was disabled;
- database network restrictions allowed `0.0.0.0/0` and `::/0`.

Obtain the database password through the provider's secure channel and let `supabase link` prompt. Do not place it in shell history.

```bash
set -euo pipefail
PINTPATH_PRODUCTION_PROJECT_REF=jxpubqlmqnnqwadmjgyk

supabase link --project-ref "$PINTPATH_PRODUCTION_PROJECT_REF"
test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$PINTPATH_PRODUCTION_PROJECT_REF"
supabase migration list --linked
supabase db push --linked --dry-run
supabase db lint --linked --schema public,private --level warning --fail-on warning
supabase db advisors --linked --type security --level warn --fail-on warn
supabase db advisors --linked --type performance --level warn --fail-on error

supabase db dump --linked --schema public,private \
  --file "$PINTPATH_EVIDENCE_DIR/supabase-production-schema.sql"
shasum -a 256 "$PINTPATH_EVIDENCE_DIR/supabase-production-schema.sql" \
  > "$PINTPATH_EVIDENCE_DIR/supabase-production-schema.sha256"
```

Do not run `supabase db push` without `--dry-run` in this phase. Do not call remote pgTAP read-only: extension setup can write transactionally. Run the reviewed remote pgTAP suite only after the migration in Phase 16, when required extensions and grants are deliberately provisioned.

Stop if the linked ref differs, migration history differs unexpectedly, RLS is off, `anon` or `authenticated` has unintended grants, the source-evidence bucket is public, or an unreviewed migration appears.

Review the latest Supabase changelog before the candidate gate. Node 20 support has been dropped by current Supabase JavaScript clients, so Node 22 or later is mandatory. Also verify explicit Data API grants and RLS for every new exposed table; new tables are not guaranteed to be auto-exposed.

## Phase 5 — prove recovery and reconcile current trusted data

### Supabase recovery

- [ ] Enable PITR on production.
- [ ] Wait until the provider shows a usable restorable window; merely toggling PITR on is not evidence.
- [ ] Record retention, target RPO/RTO, earliest restore point, and latest restorable time.
- [ ] Keep daily physical backups and independent object backups.
- [ ] Restore into isolated staging, never over production.
- [ ] Verify schema, RLS, Storage denial, counts, hashes, and deletion tombstones.
- [ ] Measure RPO and RTO.
- [ ] Destroy restored resources only after evidence is signed.
- [ ] Replace open database CIDRs only after exact Railway and emergency-operator egress addresses are proven. If stable egress is unavailable, record compensating controls instead of inventing an allowlist.
- [ ] Recheck SSL after network changes.

Use [the external restore checklist](./external-launch-signoffs.md) for its fail-closed staging identities, volume isolation, Redis namespace, and cleanup procedure.

### Railway production volume, read-only

Run in the Railway production service shell, not through a local `railway run`, because the SQLite volume is remote:

```bash
sqlite3 -readonly "$DATABASE_PATH"
```

Then:

```sql
PRAGMA query_only=ON;

SELECT confidence, source_type, count(*), count(DISTINCT venue_id),
       min(last_verified_at), max(last_verified_at)
FROM venue_price_records
GROUP BY confidence, source_type;

SELECT count(*), count(DISTINCT venue_id)
FROM venue_happy_hours
WHERE active = 1;

SELECT count(*), sum(price_verified_at IS NOT NULL), count(DISTINCT venue_id)
FROM venue_beers
WHERE on_tap = 1 AND in_stock = 1;

SELECT source_type, status, count(*), count(DISTINCT venue_id)
FROM admin_ingestion_queue
GROUP BY source_type, status;
```

Save aggregate output only.

Reconcile every public row in the complete trusted set:

- `admin_verified`;
- `venue_confirmed`;
- `photo_verified`;
- `community_confirmed`.

Each must map to a durable reviewed submission or a successfully captured source-ingestion item before publication. The public API must expose a non-sensitive evidence-presence/link identifier so the strict gate can prove the mapping. Quarantine every unlinkable row for reverification while preserving its audit history. A public row with `source_submission_id=NULL` and no independently provable captured source is not launch-ready.

## Phase 6 — repair and prove the full venue directory in existing staging

Reuse the separate staging environment already created. Do not create another staging environment and do not use restore-rehearsal staging for these writes.

The candidate directory implementation must:

- expose stored phone and website fields;
- persist `business_status`, `last_checked_at`, and directory eligibility;
- include only freshly checked `OPERATIONAL` rows in active public results;
- exclude temporarily closed, permanently closed, unknown, malformed, and expired-status rows;
- validate Australian postcodes as exactly four digits;
- preserve inactive rows for audit and possible reopening;
- enumerate every existing row with a Google Place ID and request current Place Details even if discovery does not rediscover it;
- fail before writes if any discovery cell, text query, or existing Place-ID check fails;
- exit nonzero if any insert, update, exclusion, or status write fails;
- emit a transition manifest for dry-run, success, and partial-failure outcomes.

Manually verify and correct:

- Bridge Road Brewers airport;
- Pizza Al Taglio;
- Captain Melville;
- Red Rock Airport Services;
- Sahara Lounge.

After all malformed rows are corrected, add and prove a reviewed follow-up migration that runs:

```sql
ALTER TABLE public.venues
  VALIDATE CONSTRAINT venues_business_status_check;

ALTER TABLE public.venues
  VALIDATE CONSTRAINT venues_australian_postcode_check;
```

Do not mark unknown rows operational to make validation pass.

Link and mechanically pin the existing staging project:

```bash
set -euo pipefail
PINTPATH_STAGING_PROJECT_REF='replace-with-approved-existing-staging-project-ref'
test -n "$PINTPATH_STAGING_PROJECT_REF"
test "$PINTPATH_STAGING_PROJECT_REF" != "replace-with-approved-existing-staging-project-ref"
test "$PINTPATH_STAGING_PROJECT_REF" != "jxpubqlmqnnqwadmjgyk"

supabase link --project-ref "$PINTPATH_STAGING_PROJECT_REF"
test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$PINTPATH_STAGING_PROJECT_REF"
supabase migration list --linked
supabase db push --linked --dry-run
supabase db push --linked
supabase migration list --linked
supabase test db --linked supabase/tests
```

Run the complete discovery and all-existing-Place-ID refresh with staging credentials only. Pin every invocation:

```bash
set -euo pipefail

PINTPATH_EXPECTED_SUPABASE_PROJECT_REF="$PINTPATH_STAGING_PROJECT_REF" \
  npm run venues:import -- \
  --dry-run \
  --city-backfill \
  --inner-ring-backfill \
  --expected-project-ref="$PINTPATH_STAGING_PROJECT_REF" \
  | tee "$PINTPATH_EVIDENCE_DIR/staging-venue-refresh-dry-run.log"

PINTPATH_EXPECTED_SUPABASE_PROJECT_REF="$PINTPATH_STAGING_PROJECT_REF" \
  npm run venues:import -- \
  --city-backfill \
  --inner-ring-backfill \
  --expected-project-ref="$PINTPATH_STAGING_PROJECT_REF" \
  | tee "$PINTPATH_EVIDENCE_DIR/staging-venue-refresh-write.log"
```

Both commands must exit zero. Review and sign the manifest hash, input existing-row count/hash, attempted and successful Place-ID counts, failed fetch/write counts, insert/update/exclusion counts, every status/eligibility transition, quarantined counts, start/end timestamps, project ref, and `candidateSha` placeholder that will later be bound at freeze. A partial failure must still leave a recoverable failure manifest; absence of that behavior is a blocker.

Run:

```sql
SELECT
  count(*) FILTER (WHERE google_place_id IS NULL) AS without_google_place_id,
  count(*) FILTER (
    WHERE directory_eligible = true
      AND business_status IS DISTINCT FROM 'OPERATIONAL'
  )
    AS eligible_non_operational,
  count(*) FILTER (
    WHERE directory_eligible = true
      AND (
        last_checked_at IS NULL
        OR last_checked_at < now() - interval '24 hours'
      )
  )
    AS eligible_status_older_than_24h,
  count(*) FILTER (WHERE postcode IS NOT NULL AND postcode !~ '^[0-9]{4}$')
    AS invalid_postcode
FROM public.venues;

SELECT business_status, directory_eligible, count(*),
       min(last_checked_at), max(last_checked_at)
FROM public.venues
GROUP BY business_status, directory_eligible
ORDER BY business_status NULLS FIRST, directory_eligible;

SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = 'public.venues'::regclass
  AND conname IN (
    'venues_business_status_check',
    'venues_australian_postcode_check'
  )
ORDER BY conname;
```

Every marketed venue must be `OPERATIONAL`, directory-eligible, and checked within 24 hours of the final strict gate. Both named constraints must report `convalidated=true`. Unresolved rows remain quarantined and outside the marketed scope.

Public status expires after seven days. Before candidate freeze, implement and
test the recurring job definition; before commercial enablement, configure and
prove its protected production run. It must:

- runs the same target-pinned complete refresh daily;
- may never go more than six days without a successful complete run;
- warns when the latest complete run is five days old;
- pages the on-call owner before six days and before any row reaches the seven-day public expiry;
- records the target ref and signed transition manifest;
- exits and alerts on any provider or database failure.

The recurring operation and alert proof are launch blockers, not post-launch follow-up.

The candidate contains `.github/workflows/venue-directory-refresh.yml`. After
that workflow reaches protected `main` in Phase 16, but before commercial
enablement:

1. Configure the protected `production` environment secrets `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, and `GOOGLE_PLACES_API_KEY`.
2. Require a production-environment reviewer who is not the workflow
   dispatcher.
3. Connect workflow failure to the real on-call paging integration. A GitHub
   warning or failed check without a page is not sufficient.
4. Dispatch the workflow from the exact protected `main` SHA and require both
   its dry run and write run to check every existing Place ID successfully.
5. Preserve the Actions log containing the target-pinned transition manifest
   and its SHA-256 in the private release register.
6. Verify the workflow warns when the oldest eligible status reaches 120 hours
   and fails at 138 hours, leaving 30 hours before the seven-day public expiry.

The scheduled run is daily at `23 14 * * *` UTC. After merge, the schedule runs
from the default branch; confirm that its checked-out SHA contains the reviewed
workflow before relying on it.

## Phase 7 — build trustworthy price coverage and a safe production promotion path

Run fresh discovery in bounded staging batches:

```bash
set -euo pipefail
PINTPATH_APPROVED_SUBURB='replace-with-one-approved-suburb'
PINTPATH_DISCOVERY_LIMIT='replace-with-reviewed-positive-integer'
test "$PINTPATH_APPROVED_SUBURB" != "replace-with-one-approved-suburb"
[[ "$PINTPATH_DISCOVERY_LIMIT" =~ ^[1-9][0-9]*$ ]]
test "${SUPABASE_URL%/}" = "https://${PINTPATH_STAGING_PROJECT_REF}.supabase.co"
test "$PUBLIC_BASE_URL" = "$PINTPATH_STAGING_BASE_URL"
test "$DATABASE_PATH" = "$PINTPATH_STAGING_DATABASE_PATH"
npm run menus:discover -- \
  --venue-query="$PINTPATH_APPROVED_SUBURB" \
  --limit="$PINTPATH_DISCOVERY_LIMIT"
```

Run this only in the existing staging service environment with its staging admin bearer, SQLite volume, source-evidence directory, Supabase, and provider credentials. Repeat only for approved marketed suburbs. Never use a broad unreviewed publish.

`scripts/queue-menu-crawler-results.ts` can mutate schema even with `--dry-run`; use only a copied or staging SQLite database:

```bash
DATABASE_PATH=/absolute/staging-copy/pint-path.sqlite \
  npm run menus:queue-review -- \
  --file=/absolute/private/report.json \
  --dry-run
```

Before any public publish, make evidence capture fail closed:

1. Create or confirm the durable private source submission/capture.
2. Verify its object exists and its hash/signature matches.
3. Link the proposed public row to that durable identity.
4. Publish only after steps 1–3 commit successfully.
5. If capture or linking fails, retain a non-public `evidence_pending` item and exit nonzero.

Do not publish to SQLite first and merely warn if Supabase capture fails. Do not use `--skip-source-check` for a launch publication.

### Mandatory production-promotion tool

The candidate contains `scripts/promote-reviewed-price-data.ts`, exposed only as
`npm run menus:promote-reviewed -- <mode>`. Its mutation modes hard-refuse every
Supabase project except production `jxpubqlmqnnqwadmjgyk`; refuse restore
identities; require the four launch flags explicitly false; and bind the exact
candidate SHA, production SQLite path, Supabase origin/ref, canonical manifest,
manifest hash, approved source-ingestion UUIDs, backup attestation, operator,
independent reviewer, and approval reference.

It must continue to:

- require an explicit production target and refuse staging/restore identities;
- require the approved input manifest and SHA-256;
- provide a production-data no-write plan mode that writes only a new
  permission-`0600` private review manifest;
- allow only explicitly reviewed row IDs;
- require source checks and durable evidence linkage;
- be idempotent;
- make publication fail closed across SQLite and Supabase capture, with a defined compensation/reconciliation state where one datastore cannot be committed atomically with the other;
- exit nonzero on any read, evidence, validation, or write failure;
- produce canonical, tamper-evident, operator/reviewer-attributed manifests and
  receipts with target identities, counts, source authority hashes, before/after
  state hashes, `candidateSha`, backup authority, and exact rollback authority;
- support a reviewed rollback/quarantine operation for only the promoted batch;
- pass staging success, retry, duplicate, partial-failure, and rollback tests.

Operational limits are deliberate:

- the tool verifies and records a fresh backup attestation but does not create
  or restore-test that backup;
- Supabase evidence registration precedes each local publication, so a
  multi-item apply is not globally atomic; a partial result is enumerated in
  the immutable receipt and the exact receipt-authorised quarantine handles
  finalized partial or reserved `in_progress` crash state;
- quarantine marks only authorised rows `disputed` and
  `source_ingestion_quarantined`; it preserves evidence and queue history and
  does not delete or rewind them;
- the operator must supply the actual mounted authoritative production SQLite
  file and approved `candidateSha`; the tool binds but does not infer them;
- source reachability is point-in-time at plan and apply.

The exact plan, apply, and quarantine invocations are in Phase 16.5. Do not
substitute `menus:publish-map-base`, a staging script, direct SQLite statements,
or ad hoc SQL.

Run a human or authorised-venue verification sprint, clear high-severity wrong-price reports, and retain the reviewed private source evidence. Production publication occurs only in Phase 16 after fresh recovery points.

## Phase 8 — lock and pass the commercial data contract in staging

These are required release values, not recommendations:

```dotenv
PINTPATH_DATA_MIN_MARKETED_VENUE_COVERAGE_PERCENT=70
PINTPATH_DATA_MIN_CURRENT_PRICES_PER_VENUE=3
PINTPATH_DATA_MAX_CORE_FRESHNESS_HOURS=48
PINTPATH_DATA_MAX_VENUE_STATUS_AGE_HOURS=24
PINTPATH_DATA_MAX_TRUSTED_ROW_AGE_DAYS=30
PINTPATH_DATA_MIN_HAPPY_HOUR_COVERAGE_PERCENT=25
PINTPATH_DATA_NO_HAPPY_HOUR_LAUNCH_SCOPE=true
PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE=replace-with-signed-release-decision-reference
```

Required outcomes:

- at least 70% of venues in every marketed suburb have at least three current verified pint prices;
- 100% of public rows in every trusted confidence state have durable reviewed evidence;
- newest core marketed data is under 48 hours old;
- no trusted row older than 30 days is represented as current;
- zero malformed structured addresses;
- zero closed, unknown, or status-expired venues are active;
- zero unresolved high-severity wrong-price reports;
- every marketed venue status is under 24 hours old at the final gate;
- because the release has zero happy-hour coverage, every consumer happy-hour UI and claim is absent and the signed waiver reference is present.

Set the exact approved comma-separated marketed scope. Run against the exact staged candidate deployment, not `https://pintpath.au`:

```bash
PINTPATH_DATA_BASE_URL="$PINTPATH_STAGING_BASE_URL" \
PINTPATH_DATA_MARKETED_SUBURBS="$PINTPATH_DATA_MARKETED_SUBURBS" \
PINTPATH_DATA_MIN_MARKETED_VENUE_COVERAGE_PERCENT=70 \
PINTPATH_DATA_MIN_CURRENT_PRICES_PER_VENUE=3 \
PINTPATH_DATA_MAX_CORE_FRESHNESS_HOURS=48 \
PINTPATH_DATA_MAX_VENUE_STATUS_AGE_HOURS=24 \
PINTPATH_DATA_MAX_TRUSTED_ROW_AGE_DAYS=30 \
PINTPATH_DATA_MIN_HAPPY_HOUR_COVERAGE_PERCENT=25 \
PINTPATH_DATA_NO_HAPPY_HOUR_LAUNCH_SCOPE=true \
PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE="$PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE" \
PINTPATH_DATA_STRICT=true \
  npm run readiness:data
```

Every configured suburb must exist and pass independently. A global average is not sufficient. The public UI, campaign targeting, and directory labels must use the same scope.

Store the scope, threshold values, UI-waiver reference, and deterministic scope hash in the signed release contract. Before candidate freeze, make the production workflow hard-code or assert these exact values. A protected-environment variable must not be able to silently weaken them. A threshold change creates a new release decision and restarts staging.

The candidate workflow hard-codes the numeric and waiver values
`70/3/48/24/30/25/true`. The exact marketed-suburb list is still an owner
decision. Once Phase 0 fixes that list, bind its deterministic hash in reviewed
code or an immutable signed release contract and make the workflow compare its
reported scope hash to that value. Until that comparison exists for the chosen
list, candidate freeze is blocked.

## Phase 9 — finish providers, billing, legal, privacy, and operations

### Google

- [ ] Browser Maps key restricted to required live and local referrers.
- [ ] Server Places key restricted to Places and Geocoding and absent from `/config.js`.
- [ ] Production Map ID configured.
- [ ] Exact web redirects verified.
- [ ] Manual-location fallback works when location is denied.
- [ ] Daily status-refresh quota, error alerts, and the six-day hard maximum are monitored.

### Supabase Auth and data access

- [ ] Site URL and exact HTTPS web callback for OAuth, email confirmation, and password recovery verified. The first-release iOS app has no custom URL callback; after completing an email link in the browser, the user returns to the app and signs in.
- [ ] Email confirmation and custom SMTP tested.
- [ ] Native Google and Apple providers absent from the first-release archive.
- [ ] Starting with an existing Google-only web account, use the approved email
  recovery/set-password path, then sign in on iOS and prove the same Supabase
  user ID and Pint Path account/public ID are retained. Reject any duplicate
  identity/account result and test an email-collision attempt explicitly.
- [ ] Leaked-password protection enabled.
- [ ] Admin MFA/AAL2 enforced.
- [ ] Every exposed table has explicit grants and RLS.
- [ ] Storage policies deny source evidence to public clients.
- [ ] Capture a short-lived Supabase access JWT before deleting a sacrificial
  account. After deletion, prove the old JWT cannot exchange for a Pint Path
  session and cannot read or mutate any Data API table, RPC, or Storage object.
  Record the configured JWT expiry and keep it at the shortest operationally
  acceptable value; deleting the Auth user or refresh session alone is not
  evidence that an already-issued access JWT stopped working.

### Redis

- [ ] Production `REDIS_URL` points to the intended authenticated private service.
- [ ] `REQUIRE_REDIS_RATE_LIMITING=true`.
- [ ] `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=false`.
- [ ] Isolated staging proves protected traffic and readiness fail closed during outage.

### Stripe web venue billing

This section is a future commercial-release checklist, not a gate for the
current pricing-deferred release. For this release, prove both enrolment flags
are false, all Stripe secrets/price IDs may be absent, no checkout/trial/upgrade
action is reachable, no dormant price is advertised as current, and existing
lifecycle endpoints reveal no customer data to an unauthorised user. Do not run
a live charge or enable the flag merely to complete evidence. Before any future
commercial release, complete every item below against a new candidate:

- [ ] GST treatment and legal entity approved.
- [ ] Live venue price belongs to that entity.
- [ ] Automatic tax and tax-ID collection match the finance decision.
- [ ] Venue Checkout asks for no payment method during the 60-day offer.
- [ ] Missing-payment-method end behaviour is `cancel`.
- [ ] Exact authoritative trial end is stored and displayed.
- [ ] The venue cannot receive a second offer through another user account.
- [ ] Let a trial Checkout reservation age past 35 minutes with its webhook delayed. A completed Stripe session must reconcile to the existing trial; a confirmed expired session may be replaced; missing, mismatched, or unavailable Stripe authority must block and enter support review without creating another trial.
- [ ] Expired access returns to Free automatically.
- [ ] Deliberate paid conversion has no second `trial_period_days`.
- [ ] Portal, cancellation, invoices, refunds, duplicate/out-of-order webhooks, and test clocks pass.
- [ ] With commercial enrolment disabled, new enrolment rejects while existing lifecycle management remains available.
- [ ] No Stripe purchase, portal, venue-upgrade, or billing call-to-action exists in the iOS archive.

The future smallest-value live checkout/portal/cancel/refund/webhook proof must
occur as a controlled canary after a commercial-disabled production deploy and
before public enrolment. It is intentionally not run for this release. If no
safe allowlisted canary exists in that future release, do not expose enrolment.

### Resend and email

- [ ] SPF, DKIM, and DMARC verified.
- [ ] Monitored reply-to configured.
- [ ] Transactional and marketing templates separated.
- [ ] Research and marketing consent separate and default-off.
- [ ] Unsubscribe works without login and is honoured within five working days.
- [ ] Staging proves only active verified managers receive venue messages.
- [ ] Scheduled marketing remains disabled until proof succeeds.

### OpenAI and menu extraction

- [ ] Key is server-side only.
- [ ] Model and fallback identifiers reviewed.
- [ ] OCR benchmark and independent label review meet the signed threshold.
- [ ] Unknown names remain quarantined.
- [ ] Raw private evidence never enters public analytics or logs.

### Legal and finance sign-off

Australian technology/privacy, liquor-promotion, and finance/accounting reviewers must approve:

- legal entity, contracting party, venue price, and GST;
- offer eligibility, expiry, downgrade, cancellation, and refund copy;
- Australian Consumer Law and small-business unfair-contract protections;
- provider inventory, countries, recipients, purposes, security, and retention;
- Privacy Act and Victorian Health Records Act analysis;
- contextual notices, policy, and App Store privacy answers;
- account access, correction, export, deletion, complaint, incident, and breach handling;
- marketing/research consent and Spam Act compliance;
- UGC reporting, blocking, takedown, appeal, and moderation SLA;
- proof that account deletion removes shared submission content and every
  submission-derived public row, reconciled to the executable retention policy;
- liquor-promotion design for every marketed jurisdiction;
- participating venue/licensee and RSA responsibilities.

Keep alcohol-linked rewards and Pub Golf disabled after general launch. They require a separate written approval and release.

## Phase 10 — operationalise the approved manual daily deletion contract

The first release uses an approved manual daily operation. Automation is desirable later but is not the first-release contract.

Before staging sign-off:

- [ ] Native control says “Delete account” or “Schedule account deletion.”
- [ ] Reauthentication and explicit confirmation work.
- [ ] The exact scheduled time and seven-day cancellation window are displayed.
- [ ] Primary and backup operators have least-privilege access.
- [ ] The due-request list is checked at the fixed recorded time every day, including weekends and holidays.
- [ ] A missed primary check pages the backup immediately.
- [ ] Every due request is processed by the displayed deadline.
- [ ] Processing removes or anonymises documented data, public/cache/search references, the Stripe customer, and the Supabase identity in an idempotent order.
- [ ] Lawful-retention exceptions are recorded without retaining unrelated data.
- [ ] Every failure is logged, retried, escalated, and alerted before becoming overdue.
- [ ] Every completion sends confirmation and receives a signed operator record.
- [ ] Daily evidence records zero unhandled due or overdue requests.
- [ ] Provider failure, restart, duplicate execution, partial completion, cancellation, and retention paths pass.

Configure the completion-notice path in this exact order:

The production Beer service must remain exactly one application replica in one Railway region while SQLite on its attached volume is authoritative. Redis shares rate-limit state only; it does not share the deletion outbox or webhook correlation state. Do not enable horizontal replicas or multi-region routing until the account-deletion request, outbox, recipient-secret, and webhook-event tables move together to one shared transactional datastore.

1. Deploy schema 15 and the notification worker to staging. Confirm the migration backup was created before the schema change.
2. In Resend, verify the Pint Path sending domain and create a sending-only API key dedicated to deletion notices. Do not reuse the monthly-report key.
3. Add a staging-only Resend webhook for `https://<staging RAILWAY_PUBLIC_DOMAIN>/api/business/account-deletion-notifications/resend-webhook`. Subscribe to `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`, then copy that webhook's staging-only `whsec_` signing secret directly into the staging secret manager. Never point the staging proof at the production webhook URL.
4. Generate the recipient-encryption key without printing it (`openssl rand -base64 32 | pbcopy` on macOS). Choose a key ID such as `2026-08`; store the active ID and a JSON keyring containing that key in Railway. Retain an old key only while the admin queue or database shows a live recipient-secret row using it.
5. On the isolated staging Beer service, first confirm Railway project `48d8c6cd-1c66-4148-874b-20877f48e1a5`, environment `a4e0f507-d6d3-4df9-a818-ad92c0071a35`, service `6816c4a2-e392-4ee5-826f-2584cb599ec0`, volume `/app/data`, `PUBLIC_BASE_URL=https://$RAILWAY_PUBLIC_DOMAIN`, `DATABASE_PATH=/app/data/pint-path.sqlite`, `SOURCE_EVIDENCE_STORAGE_DIR=/app/data/source-evidence`, and staging Supabase project `ibveugyfyzjptyvautlr`. Stripe must be test mode (`sk_test_`/`rk_test_`) or absent. Remove `OFFSITE_BACKUP_SUPABASE_URL`, `OFFSITE_BACKUP_SERVICE_ROLE_KEY`, `REDIS_URL`, `REDIS_KEY_NAMESPACE`, and every `RESTORE_REHEARSAL_REDIS_*` variable; keep `REQUIRE_REDIS_RATE_LIMITING=false` and set `ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION=true` only for this single-instance isolated proof. Then set `ACCOUNT_DELETION_NOTICE_MODE=resend`, the staging-only `RESEND_TRANSACTIONAL_API_KEY`, `ACCOUNT_DELETION_NOTICE_FROM`, `ACCOUNT_DELETION_NOTICE_REPLY_TO`, staging-only `RESEND_WEBHOOK_SIGNING_SECRET`, `ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID`, `ACCOUNT_DELETION_NOTICE_KEYRING_JSON`, `ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES=5`, and `ACCOUNT_DELETION_REHEARSAL_ENABLED=true`. Startup rejects any identity, origin, data path, Supabase project, backup credential, Redis reference, or Stripe mode outside this allowlist. Remove the rehearsal switch and in-memory limiter override immediately after the proof.
6. Set `SUPABASE_OAUTH_PROVIDERS=google`. Keep Apple OAuth disabled until Apple authorization-token revocation is implemented and tested. This is separate from the proof that native social login is absent from the iOS archive.
7. After the staging migration, run the exact notification-scoped gate below from the deployed staging Beer service. It must report `readinessProfile=account_deletion_rehearsal`; this profile never invokes the off-site backup Storage write canary. The `/ready` assertion separately proves local database/evidence-path and staging Supabase health. Then run the notification suites. Delete a sacrificial verified account only after its safety window is test-adjusted in staging; prove `held -> pending -> accepted -> delivered`, signed-webhook receipt storage, recipient-secret deletion, and audited terminal resolution of an independently verified undeliverable notice.

   ```bash
   set -o pipefail
   test "${ACCOUNT_DELETION_REHEARSAL_ENABLED:?}" = "true"
   test -z "${OFFSITE_BACKUP_SUPABASE_URL:-}${OFFSITE_BACKUP_SERVICE_ROLE_KEY:-}"
   test -z "${REDIS_URL:-}${REDIS_KEY_NAMESPACE:-}"
   npm run --silent readiness:providers \
     | tee /tmp/account-deletion-rehearsal-readiness.json \
     | jq -e '.readinessProfile == "account_deletion_rehearsal" and .ok == true'
   curl --fail --silent --show-error "${PUBLIC_BASE_URL%/}/ready" \
     | jq -e '.ok == true and .data.status == "ready"'
   ./node_modules/.bin/vitest run \
     test/account-deletion-notification.test.ts \
     test/account-deletion-notification-worker.test.ts
   ```
8. Test Resend timeout, 429, bounce, invalid signature, replay, out-of-order webhook, worker overlap, process restart, 23-hour uncertain cutoff, the 60-day held-recipient cap, purge on audited terminal resolution, the 30-day post-completion hard limit, and restored-tombstone suppression.
9. Separately create the production Resend webhook at `https://pintpath.au/api/business/account-deletion-notifications/resend-webhook` with its own production `whsec_` secret and the same six event subscriptions. Then set the production notice variables with independently generated credentials and key material. Never copy the staging signing secret or encryption keyring into production. `ACCOUNT_DELETION_REHEARSAL_ENABLED` must be `false` or absent in production. Deploy once all required values are present; canonical production intentionally fails closed if the notice path is incomplete.
10. Confirm `/ready`, the admin deletion queue, `job:account_deletion_notifications`, Resend delivery evidence, and the zero-plaintext database check. Record the exact provider message ID and non-identifying receipt for the release evidence packet.

Never paste the API key, webhook signing secret, encryption key, keyring JSON, or a recipient address into release evidence or terminal output. A provider acceptance is not a delivery confirmation. A signed delivery webhook marks the notice delivered; failure, suppression, or a missing webhook remains an operator-visible non-delivery state until it is independently resolved. Purge recipient ciphertext on verified delivery, an audited terminal resolution, or no later than 30 days after deletion completion; ciphertext still held before completion has a 60-day maximum.

Sign in with Apple token revocation is marked not applicable only while Apple OAuth is absent from the production web provider list, native social login is compile-disabled, and the signed Release archive proves no native Apple authorization path can create a token. If Apple login is enabled on either surface, the candidate is invalid and Apple token revocation plus retry/idempotency tests become mandatory before submission.

Policy copy must describe the manual operation and deadline honestly. Copy is not operational proof.

## Phase 11 — finish and internally prove the free iOS app

Required sequence:

1. Compile the Australian Release target as free discovery, contribution, and
   assigned venue-Free profile/beer-list management only.
2. Compile out admin, venue Pro, trials, upgrades, billing management, consumer
   paid entitlements, external purchase links, and related deep links. A
   venue-manager account may edit only the same free public profile and
   beer/stock data available to every assigned venue.
3. Keep `AppConfig.externalBillingLinksEnabled=false`.
4. Compile out native Google and Apple social login and remove unused Sign in with Apple entitlement from the archive; email authentication remains.
5. Do not add StoreKit products, Restore Purchases, Manage Subscription, or App Store Server entitlement code because this release sells no native digital entitlement.
6. Hide all consumer happy-hour UI and copy while the signed no-happy-hour scope is active.
7. Keep Pub Golf, alcohol-purchase points, and free-pint rewards absent.
8. Keep wrong-price reporting, support, account export, and the approved deletion flow working.
9. If public identities or UGC are visible, include report/block/filter controls and prove moderation operations; otherwise keep those surfaces hidden.
10. Reconcile `PrivacyInfo.xcprivacy`, the generated archive privacy report, App Store Privacy answers, public policy, and every third-party SDK.
11. Verify team `K5KNW7B34T`, bundle ID `au.pintpath.app`, production API origin, version, and monotonically increasing build. Prove the Release archive declares no custom URL scheme for this first release.
12. Confirm the Apple Developer Program membership is active; the Account Holder
    has working 2FA; the legal seller/entity matches the release contract; all
    current Developer Program/free-app agreement is accepted; paid-app, tax, and
    banking agreements are required only if a paid app or IAP is introduced; the
    app record belongs to the correct team; no compliance review or agreement
    state blocks submission; and the Account Holder plus one backup App Manager
    can access certificates, TestFlight, review, and release controls.
13. Archive with Xcode 26 or later and the iOS 26 SDK.
14. Run **Validate App** and resolve every signing, icon, privacy, export, entitlement, and API warning.
15. Upload this pre-candidate archive to an internal TestFlight group for staging rehearsal only.
16. Test the processed rehearsal build on a physical device running minimum iOS 17 and another on the current production iOS.
17. Cover IPv6-only networking, denied/revoked permissions, offline/interruption, email/password auth, the HTTPS browser round trip for email confirmation and password recovery, account export/deletion, support, wrong-price reporting, and contribution.
18. Configure the Phase 0 crash source, dSYM symbolication, environment/build/SHA
    tags, personal-data scrubbing, primary/backup alert delivery, and privacy
    declarations. Supplement it with TestFlight/App Store Connect diagnostics
    and Xcode Organizer. Pass the crash threshold and stop on any critical crash,
    auth lockout, data loss, or privacy fault.

The earlier untracked `apps/ios/BeerMap/BeerMap.entitlements` file is absent from
the current workspace. Keep the clean-tree and signed-archive scans: if that file
or any Sign in with Apple entitlement reappears, stop and remove it from this
candidate unless native social authentication is deliberately redesigned.

Archive inspection must prove the excluded native surfaces are absent from the signed product, not just disabled by a production response. This pre-candidate archive is rehearsal evidence only. It must not be submitted to App Review; Phase 13 rebuilds and uploads the final archive from the exact frozen `candidateSha`.

Do not begin external TestFlight or App Review until the commercial-disabled backend is deployed and proven in Phase 16.

## Phase 12 — run integrated staging and prove the rollback build

Deploy all implementation to the existing staging environment and execute, in order:

1. the reviewed migration dry run;
2. the migration;
3. local and linked pgTAP, RLS, grant, and Storage checks;
4. the complete target-pinned venue dry run and write;
5. transition review and 24-hour status-freshness query;
6. isolated success, retry, duplicate, partial-failure, crash-reconciliation,
   and quarantine tests for the production-promotion engine, plus an
   evidence-first staging publication through the same reviewed
   `AdminService` path; the production-locked CLI mutation modes must not be
   weakened to target staging;
7. trusted-set evidence reconciliation;
8. the exact strict data gate from Phase 8;
9. public and authenticated user/venue/admin smoke;
10. Redis outage proof;
11. commercial-disabled proof: both flags false, Stripe values absent or inert,
    no advertised current price, and no reachable checkout/trial/upgrade path;
12. deletion daily-operation rehearsal;
13. web happy-hour-absence and native compile-scope tests;
14. physical iOS/TestFlight internal tests.

Build `rollbackBuildSha` before production:

- it must be a committed, immutable, deployable artifact;
- it must open and operate on local schema version 15;
- it must preserve the schema-15 checkout-reservation and account-deletion-notice state and must not create duplicate venue Checkout sessions or deletion notices;
- it must tolerate the post-migration Supabase schema;
- it must keep all commercial and alcohol flags closed;
- it must pass health, readiness, public reads, auth, and data access against a schema-15 staging copy;
- its artifact digest and deployment instructions must be recorded;
- deploying it must not require a database downgrade.

Rehearse:

1. deploy the staged candidate;
2. exercise representative reads and writes;
3. deploy `rollbackBuildSha` without restoring the database;
4. rerun health, auth, RLS, public data, and deletion checks;
5. redeploy the candidate;
6. restore the separate backup only in isolated staging and replay deletion tombstones.

If the rollback build cannot run safely after schema 15, stop. The old production SHA is not a substitute.

Any code, migration, workflow, native, threshold, or runbook change resulting from this phase returns to step 1 of this phase.

## Phase 13 — create and prove the one frozen candidate

Only after Phases 0–12 pass:

```bash
set -euo pipefail

git status --short --branch
git diff --check
git diff --stat
git diff -- apps/ios
```

Preserve and review user-owned work. Never use a destructive reset or a broad
stash to make the tree appear clean. Use `git add --patch` or exact reviewed
paths, split commits by concern, and leave unrelated owner changes untouched.
Only after the intended candidate is committed and the working tree is clean:

```bash
set -euo pipefail
test -z "$(git status --porcelain)"
git fetch origin
git rebase origin/main
test -z "$(git status --porcelain)"
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Obtain review before rebasing or rewriting shared history. If the tree cannot be
made clean without deciding ownership of an untracked or modified file, stop and
resolve that ownership first.

Enforce Node 22, the exact CLI version, and cleanup:

```bash
set -euo pipefail

case "$(node --version)" in
  v22.*) ;;
  *) echo "Node 22 is required for the release candidate" >&2; exit 1 ;;
esac

test "$(supabase --version)" = "2.109.1"
npm ci
npm run check
npm run security:audit
git diff --check

trap 'supabase stop --no-backup >/dev/null 2>&1 || true' EXIT
supabase start
supabase db reset --local
supabase db lint --local --schema public,private --level warning --fail-on warning
supabase db advisors --local --type security --level warn --fail-on warn
supabase db advisors --local --type performance --level warn --fail-on error
supabase test db --local supabase/tests
supabase stop --no-backup
trap - EXIT
```

Required result:

- TypeScript build and all tests pass without retry.
- Security scan and deployment guard pass.
- Dependency audit has no unresolved advisory, or a dated owner-approved exception.
- Local Supabase rebuild, lint, advisors, and pgTAP pass.
- iOS Release CI/archive checks pass.
- Production cannot activate fake data, restore identities, demo billing, or in-memory rate limiting.

Before pushing the candidate, configure **GitHub Settings → Branches → `main` protection** to:

- require a pull request;
- require at least one approval from someone other than the author;
- dismiss stale approvals after new commits;
- require every review conversation to be resolved;
- require status checks and an up-to-date branch;
- require `build-test-scan`, `supabase-database`, `release-readiness`, CodeQL, and iOS;
- enforce the rule for administrators;
- block force pushes and branch deletion.

Read-only inspection on 28 July 2026 found only `build-test-scan`,
`release-readiness`, and `CodeQL JavaScript and TypeScript` required. Pull-request
reviews were not required, administrator enforcement was off, and no repository
ruleset supplied the missing controls. PR 12 was still a draft and behind
`main`; its latest recorded CodeQL gate failed. The default-branch code-scanning
API reported 26 open alerts: 21 high and five medium. The local candidate
contains fixes for the reviewed findings, but only a fresh remote scan of the
exact pushed SHA can close them. Treat every remote alert as unresolved until
that scan is green and the protection API confirms the settings above.

Configure **GitHub Settings → Environments → `production`** to:

- allow protected branches only;
- require a reviewer who is not the deployer;
- prevent self-review where the plan supports it;
- store production smoke credentials only in that environment;
- use a review wait timer if required by the launch owner.

Required checks must report for every protected PR. The candidate native
workflow is now unfiltered so its `ios` job reports on evidence-only PRs as
well as implementation PRs. Verify that behavior on GitHub before requiring the
status, and never bypass branch protection because a required workflow did not
start.

Stop until the protections are visible and tested with a non-production dry dispatch.

Push, then wait for all PR checks:

```bash
git push origin codex/fix-codeql-alerts
gh pr checks 12 --watch
```

If the reviewed branch was deliberately rebased, first verify no other person
advanced the remote branch; only then replace the first command with
`git push --force-with-lease origin codex/fix-codeql-alerts`. Never use a plain
force push.

Required launch checks:

- `build-test-scan`;
- `supabase-database`;
- `release-readiness`;
- `CodeQL JavaScript and TypeScript`;
- `ios`;
- no unresolved review thread;
- branch current with `main`;
- independent approval from someone other than the author.

Android is not a release-evidence item or full-launch gate for this web+iOS release. It may remain an informational repository-health job, but neither `android_release` nor an Android store build belongs in the launch evidence.

After checks and approval:

```bash
candidateSha="$(git rev-parse HEAD)"
[[ "$candidateSha" =~ ^[0-9a-f]{40}$ ]]
printf '%s\n' "$candidateSha"
```

Record `candidateSha`, `releaseId`, the threshold/scope hash, staging evidence hashes, and `rollbackBuildSha`. From this point, any implementation change invalidates `candidateSha`.

With a clean checkout at exactly `candidateSha`, repeat the Xcode Release archive, **Validate App**, privacy-report generation, archive inspection, App Store Connect upload, and internal TestFlight physical-device tests from Phase 11. Record the final archive hash, processed build number, and candidate source SHA. This is the only archive that may proceed to external TestFlight and App Review.

## Phase 14 — verify the candidate's web-and-iOS evidence scope

Verify that `candidateSha` already contains and tests a release-evidence validator and workflows whose required scope is web plus iOS, not Android. If it does not, the candidate is invalid: return to Phase 3, implement the change, repeat staging, and freeze a new `candidateSha`.

Required evidence IDs are:

- `production_public_smoke`;
- `production_role_smoke`;
- `account_deletion_completion_notice`;
- `ocr_labelled_corpus`;
- `venue_pilot_one`;
- `venue_pilot_two`;
- `venue_pilot_three`;
- `moderation_operations`;
- `backup_restore`;
- `accessibility_devices`;
- `legal_billing`;
- `ios_release`;

The candidate's required ID set, schema tests, checklists, and strict validator must omit `android_release`. Do not mark a required Android item falsely passed or not applicable.

Bind evidence to `releaseId` and `candidateSha`. `deployedMainSha` belongs in the private release register and the final workflow artifact rather than self-referencing the commit that contains `docs/release-evidence.json`.

Before production deployment:

```bash
npm run release:evidence
```

This non-strict command must validate schema and report genuinely pending live items. Do **not** run or require `npm run release:evidence:strict` before the candidate is deployed: production public smoke, production role smoke, and final iOS/App Review evidence cannot honestly exist yet.

Every passed item must have its opaque evidence reference, SHA-256, ISO timestamp, and named verifier/role. A code change after evidence begins invalidates `candidateSha` and all code-dependent evidence.

## Phase 15 — create the immediate pre-change recovery point and production pin

No candidate release schema, production data, or application-deployment mutation is allowed until all earlier phases pass. Pre-approved provider hardening and isolated restore work from Phases 5 and 9 must already be complete.

### Mechanical target pin

```bash
set -euo pipefail
PINTPATH_PRODUCTION_PROJECT_REF=jxpubqlmqnnqwadmjgyk
PINTPATH_EXPECTED_SUPABASE_PROJECT_REF="$PINTPATH_PRODUCTION_PROJECT_REF"

supabase link --project-ref "$PINTPATH_PRODUCTION_PROJECT_REF"
test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$PINTPATH_PRODUCTION_PROJECT_REF"
test "${SUPABASE_URL%/}" = "https://${PINTPATH_PRODUCTION_PROJECT_REF}.supabase.co"
supabase migration list --linked
supabase db push --linked --dry-run
```

Stop if CLI link, `SUPABASE_URL`, importer expected ref, or reviewed migration set does not resolve to `jxpubqlmqnnqwadmjgyk`. Production and backup-project refs must never be interchangeable.

In the ordinary production service environment, verify provider configuration without printing secrets:

```bash
npm run readiness:launch
```

This probe must run while all Phase 1 flags are false. Stop on any provider, Storage, Redis, billing, email, or restore-identity failure. Run it before capturing the fresh recovery point because provider readiness can perform a bounded write-and-cleanup probe.

### Fresh Supabase restore point

Immediately before the first production database write:

1. Open Supabase Dashboard → production project → **Database → Backups**.
2. Confirm PITR is enabled and the restorable window is healthy.
3. Record the database server UTC pre-change timestamp.
4. Confirm the provider's latest restorable time covers that timestamp.
5. Record the exact PITR timestamp selected for rollback, retention, operator, and dashboard evidence hash.
6. If PITR is unavailable, request and wait for a provider-confirmed on-demand physical backup; a logical dump alone is insufficient.
7. Stop if neither a current PITR point nor a completed provider physical backup exists.

Also create and hash a fresh schema dump after the pin.

### Fresh Railway SQLite and evidence backup

Run in the ordinary production service environment, never restore staging:

```bash
set -euo pipefail
PINTPATH_RELEASE_ID='replace-with-immutable-release-id'
test "$PINTPATH_RELEASE_ID" != "replace-with-immutable-release-id"
PINTPATH_BACKUP_DIR="/app/data/release-backups/$PINTPATH_RELEASE_ID"
test ! -e "$PINTPATH_BACKUP_DIR"

npm run data:backup -- --output "$PINTPATH_BACKUP_DIR"
npm run data:backup:verify -- --backup "$PINTPATH_BACKUP_DIR"
npm run data:backup:offsite
```

Record the backup ID, manifest hash, off-site result, PITR timestamp/backup ID, `candidateSha`, `rollbackBuildSha`, current production SHA, database targets, and two-person approval. Stop on any failure.

If more than 30 minutes elapse before the reviewed migration begins, or any unplanned production data mutation occurs between capture and that migration, repeat all of Phase 15 and record the newer recovery point.

## Phase 16 — merge, mutate production, deploy commercial-disabled, and prove live data

### 16.1 Merge the reviewed candidate

```bash
set -euo pipefail
if [ "$(gh pr view 12 --json isDraft --jq .isDraft)" = "true" ]; then
  gh pr ready 12
fi
gh pr checks 12 --watch
test "$(gh pr view 12 --json headRefOid --jq .headRefOid)" = "$candidateSha"
gh pr merge 12 --merge --match-head-commit "$candidateSha"
```

Wait until GitHub reports the protected merge complete, then:

```bash
set -euo pipefail
test "$(gh pr view 12 --json state --jq .state)" = "MERGED"
git fetch origin main
deploymentSha="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$candidateSha" "$deploymentSha"
test -z "$(git diff --name-only "$candidateSha..$deploymentSha")"
```

Require protected-branch merge and independent approval. Record `deploymentSha`. If `main` advanced with unrelated content, stop and restage; do not deploy an unproved tree.

### 16.2 Apply the reviewed Supabase migration while the old web build remains live

```bash
set -euo pipefail
supabase link --project-ref "$PINTPATH_PRODUCTION_PROJECT_REF"
test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$PINTPATH_PRODUCTION_PROJECT_REF"
test "${SUPABASE_URL%/}" = "https://${PINTPATH_PRODUCTION_PROJECT_REF}.supabase.co"
supabase migration list --linked
supabase db push --linked --dry-run
supabase db push --linked
supabase migration list --linked
supabase test db --linked supabase/tests
```

Stop if the dry run differs from staging, migration history differs, or pgTAP/RLS/Storage proof fails.

### 16.3 Refresh every production Place ID before the new directory read path deploys

Use the ordinary production operator environment with production Supabase and Google credentials and no restore-rehearsal markers:

```bash
set -euo pipefail

PINTPATH_EXPECTED_SUPABASE_PROJECT_REF="$PINTPATH_PRODUCTION_PROJECT_REF" \
  npm run venues:import -- \
  --dry-run \
  --city-backfill \
  --inner-ring-backfill \
  --expected-project-ref="$PINTPATH_PRODUCTION_PROJECT_REF" \
  | tee "$PINTPATH_EVIDENCE_DIR/production-venue-refresh-dry-run.log"

PINTPATH_EXPECTED_SUPABASE_PROJECT_REF="$PINTPATH_PRODUCTION_PROJECT_REF" \
  npm run venues:import -- \
  --city-backfill \
  --inner-ring-backfill \
  --expected-project-ref="$PINTPATH_PRODUCTION_PROJECT_REF" \
  | tee "$PINTPATH_EVIDENCE_DIR/production-venue-refresh-write.log"
```

Both runs must exit zero. Review and countersign every transition, failed count, count delta, quarantined row, and manifest hash. Run the Phase 6 SQL. Every marketed row must be `OPERATIONAL`, eligible, and under 24 hours old. Unknown and closed rows remain quarantined.

Confirm the monitored daily recurring job targets the same ref, has a successful test run, warns at five days, pages before six days, and cannot allow a seven-day-expired status to remain public.

### 16.4 Deploy the exact protected `main` build with enrolment disabled

Railway must deploy `deploymentSha` with the Phase 1 environment values. Wait for deployment completion, then:

```bash
PINTPATH_ENFORCE_LAUNCH_FLAGS=true \
PINTPATH_EXPECTED_COMMERCIAL_LAUNCH_ENABLED=false \
PINTPATH_EXPECTED_COMMIT_SHA="$deploymentSha" \
  npm run smoke:production
```

Require `/health` and `/ready` to return `200`, and require the reported SHA to equal `deploymentSha`. Re-run the Phase 1 live-config assertion. Commercial enrolment, rewards, and gamification must still be false.

Keep `COMMERCIAL_LAUNCH_ENABLED=false` throughout the first deployment and every production proof in Phases 16 and 17. Existing billing management and Stripe lifecycle processing remain available while new enrolment is closed.

If application health fails, deploy `rollbackBuildSha`. Do not redeploy the schema-11 production commit over a schema-15 volume.

### 16.5 Promote only the reviewed production price batch

Run the reviewed production-promotion tool from Phase 7 in the Railway
production service shell against the pinned production Supabase target and
authoritative mounted volume.

First create the private, data-no-write review manifest. Replace the ID
placeholder with only the independently reviewed source-ingestion UUIDs; do not
include whitespace:

```bash
set -euo pipefail
umask 077

test "$NODE_ENV" = "production"
test "${SUPABASE_URL%/}" = "https://jxpubqlmqnnqwadmjgyk.supabase.co"
[[ "$candidateSha" =~ ^[0-9a-f]{40}$ ]]

PINTPATH_PROMOTION_DATABASE="$(realpath "$DATABASE_PATH")"
PINTPATH_PROMOTION_IDS='replace-with-reviewed-uuid1,uuid2'
PINTPATH_PROMOTION_MANIFEST="$PINTPATH_EVIDENCE_DIR/${PINTPATH_RELEASE_ID}-reviewed-price-manifest.json"
PINTPATH_PROMOTION_PLAN_LOG="$PINTPATH_EVIDENCE_DIR/${PINTPATH_RELEASE_ID}-reviewed-price-plan.json"

test -f "$PINTPATH_PROMOTION_DATABASE"
test "$PINTPATH_PROMOTION_IDS" != "replace-with-reviewed-uuid1,uuid2"
test ! -e "$PINTPATH_PROMOTION_MANIFEST"
test ! -e "$PINTPATH_PROMOTION_PLAN_LOG"

promotion_plan_output="$(
  npm run --silent menus:promote-reviewed -- plan \
    --candidate-sha="$candidateSha" \
    --database="$PINTPATH_PROMOTION_DATABASE" \
    --expected-project-ref=jxpubqlmqnnqwadmjgyk \
    --ids="$PINTPATH_PROMOTION_IDS" \
    --manifest="$PINTPATH_PROMOTION_MANIFEST"
)"
printf '%s\n' "$promotion_plan_output" | tee "$PINTPATH_PROMOTION_PLAN_LOG"

PINTPATH_PROMOTION_MANIFEST_SHA256="$(
  printf '%s\n' "$promotion_plan_output" | jq -er '.manifestSha256'
)"
test "$(
  shasum -a 256 "$PINTPATH_PROMOTION_MANIFEST" | awk '{print $1}'
)" = "$PINTPATH_PROMOTION_MANIFEST_SHA256"
```

Stop for independent review. The reviewer must read the canonical manifest,
recheck every ID, venue, source URL, selected beer/price row, policy threshold,
source snapshot hash, production database path, Supabase origin/ref, and
`candidateSha`, then record approval without editing the manifest.

Immediately before apply, create and verify a new SQLite/source-evidence backup
if the Phase 15 backup is more than 30 minutes old or any intervening production
write occurred. Fill the exact completed backup authority and two distinct
human identities below. The backup timestamp must be canonical UTC with
milliseconds and at most 30 minutes old:

```bash
set -euo pipefail
umask 077

test "$NODE_ENV" = "production"
test "${COMMERCIAL_LAUNCH_ENABLED,,}" = "false"
test "${CONSUMER_PAID_ENROLLMENT_ENABLED,,}" = "false"
test "${PINT_POINTS_REWARDS_ENABLED,,}" = "false"
test "${ALCOHOL_GAMIFICATION_ENABLED,,}" = "false"
test "${SUPABASE_URL%/}" = "https://jxpubqlmqnnqwadmjgyk.supabase.co"
test -n "${SUPABASE_SERVICE_ROLE_KEY:-}"

PINTPATH_PROMOTION_OPERATOR='replace-with-named-operator'
PINTPATH_PROMOTION_REVIEWER='replace-with-different-named-reviewer'
PINTPATH_PROMOTION_APPROVAL_REFERENCE='replace-with-signed-change-reference'
PINTPATH_PROMOTION_BACKUP_ID='replace-with-pint-path-backup-id'
PINTPATH_PROMOTION_BACKUP_MANIFEST_SHA256='replace-with-64-lower-hex'
PINTPATH_PROMOTION_BACKUP_VERIFIED_AT='replace-with-UTC-ISO-milliseconds'
PINTPATH_PROMOTION_RECEIPT="$PINTPATH_EVIDENCE_DIR/${PINTPATH_RELEASE_ID}-reviewed-price-receipt.json"
PINTPATH_PROMOTION_APPLY_LOG="$PINTPATH_EVIDENCE_DIR/${PINTPATH_RELEASE_ID}-reviewed-price-apply.json"

test "$PINTPATH_PROMOTION_OPERATOR" != "replace-with-named-operator"
test "$PINTPATH_PROMOTION_REVIEWER" != "replace-with-different-named-reviewer"
test "$PINTPATH_PROMOTION_OPERATOR" != "$PINTPATH_PROMOTION_REVIEWER"
test "$PINTPATH_PROMOTION_APPROVAL_REFERENCE" != "replace-with-signed-change-reference"
test "$PINTPATH_PROMOTION_BACKUP_ID" != "replace-with-pint-path-backup-id"
[[ "$PINTPATH_PROMOTION_BACKUP_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]
test "$PINTPATH_PROMOTION_BACKUP_VERIFIED_AT" != "replace-with-UTC-ISO-milliseconds"
test ! -e "$PINTPATH_PROMOTION_RECEIPT"
test ! -e "$PINTPATH_PROMOTION_APPLY_LOG"

promotion_apply_output="$(
  SUPABASE_MENU_CAPTURE_TABLE=venue_menu_captures \
    npm run --silent menus:promote-reviewed -- apply \
      --candidate-sha="$candidateSha" \
      --database="$PINTPATH_PROMOTION_DATABASE" \
      --expected-project-ref=jxpubqlmqnnqwadmjgyk \
      --manifest="$PINTPATH_PROMOTION_MANIFEST" \
      --manifest-sha256="$PINTPATH_PROMOTION_MANIFEST_SHA256" \
      --receipt="$PINTPATH_PROMOTION_RECEIPT" \
      --operator="$PINTPATH_PROMOTION_OPERATOR" \
      --reviewer="$PINTPATH_PROMOTION_REVIEWER" \
      --approval-reference="$PINTPATH_PROMOTION_APPROVAL_REFERENCE" \
      --backup-id="$PINTPATH_PROMOTION_BACKUP_ID" \
      --backup-manifest-sha256="$PINTPATH_PROMOTION_BACKUP_MANIFEST_SHA256" \
      --backup-verified-at="$PINTPATH_PROMOTION_BACKUP_VERIFIED_AT"
)"
printf '%s\n' "$promotion_apply_output" | tee "$PINTPATH_PROMOTION_APPLY_LOG"
printf '%s\n' "$promotion_apply_output" | jq -e '.ok == true'

PINTPATH_PROMOTION_RECEIPT_SHA256="$(
  printf '%s\n' "$promotion_apply_output" | jq -er '.receiptSha256'
)"
test "$(
  shasum -a 256 "$PINTPATH_PROMOTION_RECEIPT" | awk '{print $1}'
)" = "$PINTPATH_PROMOTION_RECEIPT_SHA256"
```

If the apply command exits nonzero, do not rerun it blindly. Preserve the known
receipt path. A receipt may contain a finalized partial result or the reserved
`in_progress` crash authority; inspect and hash that exact file, close public
paths, and use the pre-reviewed quarantine command under **Rollback triggers
and exact order**.

After promotion:

- verify every promoted trusted row has durable evidence;
- verify no `evidence_pending` row is public;
- verify and countersign the canonical promotion manifest, receipt hashes, and
  rollback/quarantine authority;
- rerun aggregate Railway queries;
- resolve every high-severity wrong-price report.

### 16.6 Run strict production data and protected user/venue smoke

Use the immutable values:

```bash
PINTPATH_DATA_BASE_URL=https://pintpath.au \
PINTPATH_DATA_MARKETED_SUBURBS="$PINTPATH_DATA_MARKETED_SUBURBS" \
PINTPATH_DATA_MIN_MARKETED_VENUE_COVERAGE_PERCENT=70 \
PINTPATH_DATA_MIN_CURRENT_PRICES_PER_VENUE=3 \
PINTPATH_DATA_MAX_CORE_FRESHNESS_HOURS=48 \
PINTPATH_DATA_MAX_VENUE_STATUS_AGE_HOURS=24 \
PINTPATH_DATA_MAX_TRUSTED_ROW_AGE_DAYS=30 \
PINTPATH_DATA_MIN_HAPPY_HOUR_COVERAGE_PERCENT=25 \
PINTPATH_DATA_NO_HAPPY_HOUR_LAUNCH_SCOPE=true \
PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE="$PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE" \
PINTPATH_DATA_STRICT=true \
  npm run readiness:data
```

Dispatch **Production Health** at `deploymentSha` through the protected `production` GitHub environment. Do not run protected credentials in a local shell:

```bash
git fetch origin main
test "$(git rev-parse origin/main)" = "$deploymentSha"
gh workflow run production-health.yml --ref main
```

Use the Actions run created by that dispatch, obtain its exact run ID, then:

```bash
PINTPATH_PRODUCTION_HEALTH_RUN_ID='replace-with-numeric-run-id'
[[ "$PINTPATH_PRODUCTION_HEALTH_RUN_ID" =~ ^[1-9][0-9]*$ ]]
test "$(
  gh run view "$PINTPATH_PRODUCTION_HEALTH_RUN_ID" --json headSha --jq .headSha
)" = "$deploymentSha"
gh run watch "$PINTPATH_PRODUCTION_HEALTH_RUN_ID" --exit-status
```

Require public health plus configured verified user and venue-manager role smoke. The environment must require a reviewer who is not the deployer. Missing credentials or a skipped authenticated job is not a pass.

Do not run a live Stripe charge for this pricing-deferred release. Prove both
commercial flags remain false, checkout/trial/upgrade paths remain unavailable,
and no current price is advertised. Stripe canary evidence belongs to a future
commercial candidate.

At this point production data and backend behavior can be proven, but strict release evidence remains pending until App Review.

## Phase 17 — pass external TestFlight, App Review, evidence closeout, and the strict live gate

### 17.1 External TestFlight and App Review

Use the exact iOS archive bound to `candidateSha`:

1. Add an external TestFlight group and complete Beta App Review information.
2. Supply controlled consumer, contributor, and assigned venue-Free manager
   accounts. The iOS app has no admin or venue Pro role.
3. Pass external beta review.
4. Complete final screenshots, description, keywords, support URL, privacy URL, copyright, version notes, and processed build.
5. Do not show happy-hour discovery, rewards, Pub Golf, venue Pro, trial, billing, StoreKit, or external purchase prompts.
6. Under App Privacy, reconcile every data type with the archive privacy report and policy.
7. Answer alcohol, UGC, location, and unrestricted-web-access questions honestly.
8. In review notes, explain that assigned venues can edit only their free public
   profile and beer list in iOS; venue Pro, the dormant 60-day design, checkout,
   billing, and every upgrade prompt are disabled on the web and absent from the
   iOS binary for this release.
9. Explain the manual seven-day deletion operation and provide the consumer/contributor path.
10. Set Australia availability and manual release with phased release.
11. Select **Add for Review** and answer follow-up without changing binary or backend behavior.
12. Obtain approval but hold manual release.

A material app, backend, policy, data-collection, auth, or scope change invalidates the candidate and repeats staging.

### 17.2 Close evidence without changing implementation

Complete all 12 web-and-iOS evidence items from Phase 14. Update only `docs/release-evidence.json` in an evidence-closeout PR. The `candidateSha` remains the frozen PR-head SHA.

After protected merge:

```bash
git fetch origin main
deployedMainSha="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$candidateSha" "$deployedMainSha"

unexpected_paths="$(
  git diff --name-only "$candidateSha..$deployedMainSha" \
    | grep -Ev '^docs/release-evidence\.json$' \
    || true
)"
test -z "$unexpected_paths"
```

Record `deployedMainSha` in the private release register. Railway must deploy that exact commit with commercial enrolment still disabled. Require the reported production SHA to equal `deployedMainSha` and repeat the Phase 1 live-config assertion.

### 17.3 Run strict authenticated evidence through the protected environment

Create a fresh, one-use MFA/AAL2 admin smoke token only after the production-environment reviewer is ready. Enter it interactively into the protected environment; never print or pass it on a command line:

```bash
gh secret set PINTPATH_SMOKE_ADMIN_TOKEN --env production
git fetch origin main
test "$(git rev-parse origin/main)" = "$deployedMainSha"
gh workflow run pintpath-release-gate.yml --ref main \
  -f expected_commercial_launch_enabled=false
```

Obtain the exact dispatched run ID and watch it:

```bash
PINTPATH_RELEASE_GATE_RUN_ID='replace-with-numeric-run-id'
[[ "$PINTPATH_RELEASE_GATE_RUN_ID" =~ ^[1-9][0-9]*$ ]]
test "$(
  gh run view "$PINTPATH_RELEASE_GATE_RUN_ID" --json headSha --jq .headSha
)" = "$deployedMainSha"
gh run watch "$PINTPATH_RELEASE_GATE_RUN_ID" --exit-status
```

The **Pint Path Release Gate** must:

- check out `deployedMainSha`;
- run the public production smoke and require `/health` and `/ready`;
- match the live deployment SHA and exact launch-flag state;
- run public and authenticated user, venue, and admin smoke;
- revoke temporary direct smoke sessions;
- enforce the immutable strict data values;
- enforce provider readiness;
- execute `npm run release:evidence:strict` and enforce the web-and-iOS release evidence;
- upload provider, data, role-smoke, evidence, and tested-SHA artifacts.

Immediately after the run:

```bash
gh secret delete PINTPATH_SMOKE_ADMIN_TOKEN --env production
```

Also revoke the admin session at the provider, rotate/revoke any temporary smoke credentials, and verify the workflow's direct-session revocation result. Download the artifact and compare its tested SHA, release ID, scope hash, data result, and evidence hashes to the private register.

Do not call a local `npm run smoke:production:auth` invocation a protected-environment proof.

## Phase 18 — final go/no-go, keep commercial enrolment closed, then release iOS

The owner and independent reviewer must sign the final checklist before release.

No paid or trial surface is authorised by this release. Pricing and the bar offer
will return as a separate product decision and a new frozen candidate. This
release must prove that the disabled commercial state cannot expose web or
native checkout, trial, upgrade, external-purchase, StoreKit, or consumer-paid
surfaces.

After all earlier phases and the final independent go/no-go pass, confirm the
same `deployedMainSha` still has the closed state below. Do not change code,
thresholds, scope, or either flag.

```dotenv
COMMERCIAL_LAUNCH_ENABLED=false
CONSUMER_PAID_ENROLLMENT_ENABLED=false
```

Save and parse `/config.js`:

```bash
curl -fsS https://pintpath.au/config.js \
  | sed -e '1s/^window\.MELB_BEER_BOT_VIEWER_CONFIG = //' -e '$s/;$//' \
  > "$PINTPATH_EVIDENCE_DIR/live-config-closed.json"

jq -e '
  .business.commercialLaunchEnabled == false
  and .business.consumerPaidEnrollmentEnabled == false
  and .business.pricing == null
  and .business.pintPointsRewardsEnabled == false
  and .business.alcoholGamificationEnabled == false
  and .business.venueProTrialDays == 0
  and .business.venueProTrialRequiresPaymentMethod == false
  and .business.demoBillingMode == false
  and .business.fieldTestMode == false
' "$PINTPATH_EVIDENCE_DIR/live-config-closed.json"
```

Repeat:

- public production smoke with `PINTPATH_ENFORCE_LAUNCH_FLAGS=true`,
  `PINTPATH_EXPECTED_COMMERCIAL_LAUNCH_ENABLED=false`, and
  `PINTPATH_EXPECTED_COMMIT_SHA="$deployedMainSha"`;
- the strict data command from Phase 16;
- a fresh protected Production Health dispatch;
- the one-use admin-token ceremony and **Pint Path Release Gate** dispatch with
  `-f expected_commercial_launch_enabled=false`;
- web checks proving no current price is advertised and every checkout, trial,
  upgrade, and enrolment action is absent or inert;
- native archive/runtime checks proving no commercial surface appeared.

If any check fails or an unintended surface appears, keep or restore both flags
to `false`, stop release, and repeat the disabled-state assertion after repair.

Only after the disabled state passes may the owner:

1. open free web discovery and free venue-tool outreach only for passing marketed suburbs;
2. manually release the approved Australian iOS build;
3. start Apple's phased release;
4. announce the combined web and iOS launch.

## Phase 19 — progressive release and 72-hour watch

Release web traffic progressively and monitor:

- crash-free iOS sessions and server errors;
- p50/p95/p99 latency from Melbourne;
- email auth failures;
- Redis readiness and protected-route failures;
- any unexpected venue checkout, trial, billing webhook, paid entitlement, or
  dormant-price exposure while both flags are false;
- manual deletion due/overdue count, retries, escalations, and notices;
- privacy/export/correction request age;
- moderation queue age and SLA;
- wrong-price reports;
- price coverage, freshness, and evidence linkage;
- status-refresh last success, five-day warning, six-day page, and seven-day expiry exclusions;
- ingestion parse failures and review backlog;
- backup age and next restore rehearsal;
- unsubscribe failures, complaint rate, and support volume.

Run public health continuously and strict data daily. Run the complete target-pinned venue status refresh daily; never allow more than six days between successful complete runs. Keep the named operator on call for the first 72 hours.

## Rollback triggers and exact order

Rollback immediately for:

- auth or RLS cross-account access;
- leaked private evidence, token, or personal data;
- wrong Supabase, Railway, Redis, Stripe, or Storage target;
- failed or destructive migration;
- Redis bypass when required;
- incorrect charge, offer, entitlement, expiry, or downgrade;
- unsupported or corrupted public price;
- missing trusted evidence;
- closed, unknown, or seven-day-expired venue shown active;
- deletion work lost, duplicated, or overdue;
- sustained readiness, error, or latency breach;
- App Store compliance issue requiring feature removal.

Order:

1. Set `COMMERCIAL_LAUNCH_ENABLED=false`.
2. Disable the affected public path or place the service in the approved maintenance state.
3. Deploy `rollbackBuildSha`, which is proven against schema version 15.
4. Verify `/health`, `/ready`, reported SHA, auth, RLS, public data, and deletion access.
5. Quarantine only the affected promoted price batch using its reviewed manifest if data is unsupported.
6. Restore data only if data or schema is damaged; never restore merely to roll back code.
7. If restoring, use the recorded pre-change PITR timestamp or verified backup in isolation first, preserve newer legal/deletion records, and replay deletion tombstones before reopening.
8. Re-run public, authenticated, strict data, and flag checks.
9. Record incident timeline, scope, customer impact, evidence, and corrective action.

For step 5, first create and verify another fresh backup and fill its authority.
Then run this only after the affected batch and exact manifest/receipt authority
have been independently confirmed. It performs no deletes:

```bash
set -euo pipefail
umask 077

test "$NODE_ENV" = "production"
test "${COMMERCIAL_LAUNCH_ENABLED,,}" = "false"
test "${CONSUMER_PAID_ENROLLMENT_ENABLED,,}" = "false"
test "${PINT_POINTS_REWARDS_ENABLED,,}" = "false"
test "${ALCOHOL_GAMIFICATION_ENABLED,,}" = "false"
test "${SUPABASE_URL%/}" = "https://jxpubqlmqnnqwadmjgyk.supabase.co"
[[ "$candidateSha" =~ ^[0-9a-f]{40}$ ]]

PINTPATH_PROMOTION_DATABASE="$(realpath "$DATABASE_PATH")"
PINTPATH_PROMOTION_RECEIPT_SHA256="$(
  shasum -a 256 "$PINTPATH_PROMOTION_RECEIPT" | awk '{print $1}'
)"
PINTPATH_QUARANTINE_OPERATOR='replace-with-named-rollback-operator'
PINTPATH_QUARANTINE_REVIEWER='replace-with-different-named-reviewer'
PINTPATH_QUARANTINE_APPROVAL_REFERENCE='replace-with-rollback-change-reference'
PINTPATH_QUARANTINE_BACKUP_ID='replace-with-fresh-pint-path-backup-id'
PINTPATH_QUARANTINE_BACKUP_MANIFEST_SHA256='replace-with-64-lower-hex'
PINTPATH_QUARANTINE_BACKUP_VERIFIED_AT='replace-with-UTC-ISO-milliseconds'
PINTPATH_QUARANTINE_RECEIPT="$PINTPATH_EVIDENCE_DIR/${PINTPATH_RELEASE_ID}-reviewed-price-quarantine.json"
PINTPATH_QUARANTINE_LOG="$PINTPATH_EVIDENCE_DIR/${PINTPATH_RELEASE_ID}-reviewed-price-quarantine-output.json"

test "$PINTPATH_QUARANTINE_OPERATOR" != "replace-with-named-rollback-operator"
test "$PINTPATH_QUARANTINE_REVIEWER" != "replace-with-different-named-reviewer"
test "$PINTPATH_QUARANTINE_OPERATOR" != "$PINTPATH_QUARANTINE_REVIEWER"
test "$PINTPATH_QUARANTINE_APPROVAL_REFERENCE" != "replace-with-rollback-change-reference"
test "$PINTPATH_QUARANTINE_BACKUP_ID" != "replace-with-fresh-pint-path-backup-id"
[[ "$PINTPATH_QUARANTINE_BACKUP_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]
test "$PINTPATH_QUARANTINE_BACKUP_VERIFIED_AT" != "replace-with-UTC-ISO-milliseconds"
test ! -e "$PINTPATH_QUARANTINE_RECEIPT"
test ! -e "$PINTPATH_QUARANTINE_LOG"

quarantine_output="$(
  npm run --silent menus:promote-reviewed -- quarantine \
    --candidate-sha="$candidateSha" \
    --database="$PINTPATH_PROMOTION_DATABASE" \
    --expected-project-ref=jxpubqlmqnnqwadmjgyk \
    --manifest="$PINTPATH_PROMOTION_MANIFEST" \
    --manifest-sha256="$PINTPATH_PROMOTION_MANIFEST_SHA256" \
    --promotion-receipt="$PINTPATH_PROMOTION_RECEIPT" \
    --promotion-receipt-sha256="$PINTPATH_PROMOTION_RECEIPT_SHA256" \
    --quarantine-receipt="$PINTPATH_QUARANTINE_RECEIPT" \
    --operator="$PINTPATH_QUARANTINE_OPERATOR" \
    --reviewer="$PINTPATH_QUARANTINE_REVIEWER" \
    --approval-reference="$PINTPATH_QUARANTINE_APPROVAL_REFERENCE" \
    --backup-id="$PINTPATH_QUARANTINE_BACKUP_ID" \
    --backup-manifest-sha256="$PINTPATH_QUARANTINE_BACKUP_MANIFEST_SHA256" \
    --backup-verified-at="$PINTPATH_QUARANTINE_BACKUP_VERIFIED_AT"
)"
printf '%s\n' "$quarantine_output" | tee "$PINTPATH_QUARANTINE_LOG"
printf '%s\n' "$quarantine_output" | jq -e '.ok == true'

PINTPATH_QUARANTINE_RECEIPT_SHA256="$(
  printf '%s\n' "$quarantine_output" | jq -er '.quarantineReceiptSha256'
)"
test "$(
  shasum -a 256 "$PINTPATH_QUARANTINE_RECEIPT" | awk '{print $1}'
)" = "$PINTPATH_QUARANTINE_RECEIPT_SHA256"
```

Verify the receipt's `quarantinedIds`, `alreadyQuarantinedIds`, and
`absentIds`; confirm only the authorised rows disappeared from every public
price and inventory path; and confirm source evidence and ingestion history
remain intact.

Never redeploy the schema-11 production build over schema 15. Never delete the current production volume or overwrite it with an unverified backup.

## Final go/no-go sign-off

The release is **go** only when every item is true for the same `releaseId`, `candidateSha`, `deployedMainSha`, and `rollbackBuildSha`:

- [ ] launch contract and marketed scope signed;
- [ ] candidate contains all implementation and its tree matches `deployedMainSha` except the permitted evidence-only closeout;
- [ ] required web/iOS CI, CodeQL, review, and branch protections pass;
- [ ] Android is absent from required release evidence;
- [ ] local, staging, and live Supabase schema/RLS/Storage checks pass;
- [ ] fresh PITR/physical backup, SQLite backup, off-site backup, and restore rehearsal pass;
- [ ] schema-15-compatible rollback build and rehearsal pass;
- [ ] complete Place-ID refresh, target pin, transitions, and 24-hour launch freshness pass;
- [ ] daily monitored status refresh and five-/six-/seven-day alerts pass;
- [ ] reviewed production price-promotion tool, dry run, publication, evidence, and rollback manifest pass;
- [ ] every trusted public row has durable evidence;
- [ ] strict data gate passes independently for every marketed suburb;
- [ ] all consumer happy-hour UI and claims are hidden under the signed waiver;
- [ ] Google, email Auth, Redis, Resend, and OpenAI proofs pass;
- [ ] commercial and consumer-paid flags remain false; no current price,
  checkout, trial, or upgrade path is public;
- [ ] the pre-deletion Supabase JWT denial matrix and Google-web-to-iOS account
  bridge pass without duplicate identities;
- [ ] immutable independent backup authority and object-lock/WORM retention pass;
- [ ] staging deletion proves no raw submission, item/free text, contribution
  ledger, evidence link, or submission-derived public row remains;
- [ ] GST, legal, privacy, liquor, marketing, moderation, and finance approvals are recorded;
- [ ] approved manual daily deletion operation passes;
- [ ] native social login is compile-disabled and the Sign in with Apple revocation not-applicable proof is recorded;
- [ ] free discovery/contributor/venue-Free iOS archive, privacy report,
  physical devices, external TestFlight, and App Review pass;
- [ ] Apple membership, Account Holder/backup access, agreements, compliance
  review, app ownership, and crash-threshold evidence pass;
- [ ] strict release evidence and protected authenticated smoke pass;
- [ ] live flags match the approved state before and after enablement;
- [ ] named 72-hour operator is available.

Any unchecked box is a no-go. Narrowing scope requires new approved claims, a new scope hash, repeated staging, and a new candidate if implementation changes.

## Authoritative external references

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple account deletion requirements](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [Apple upcoming SDK requirements](https://developer.apple.com/news/upcoming-requirements/)
- [Victorian responsible alcohol advertising and promotions](https://www.vic.gov.au/responsible-alcohol-advertising-and-promotions)
- [OAIC small-business privacy guidance](https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business)
- [OAIC data-breach response guide](https://www.oaic.gov.au/privacy/notifiable-data-breaches/quick-reference-guide-for-responding-to-data-breaches)
- [ACMA spam guidance](https://www.acma.gov.au/avoid-sending-spam)
- [ACCC contracts and unfair terms](https://www.accc.gov.au/business/selling-products-and-services/contracts)
- [Supabase database testing](https://supabase.com/docs/guides/database/testing)
- [Supabase CLI testing and linting](https://supabase.com/docs/guides/local-development/cli/testing-and-linting)
- [Stripe free trials](https://docs.stripe.com/payments/checkout/free-trials?locale=en-GB)
