# External launch evidence checklist

This is the executable checklist for the 12 required items in `docs/release-evidence.json`. Repository tests prove code and synthetic contracts; these checks prove the deployed providers, physical devices, real venue operations, legal decisions, backups, and the signed iOS build.

Do not mark an item `pass` because its code exists or a local test passed. Mark it `pass` only after every step and pass criterion below is satisfied.

## Common setup for one release candidate

- [ ] Name one release owner with authority to stop the launch.
- [ ] Complete the named private role/contact register and pass the tabletop gate in `docs/data-breach-response-runbook.md`; an untested template is not production evidence.
- [ ] Freeze the candidate commit, then initialise one private working directory in every new operator shell:

  ```bash
  set -euo pipefail
  git fetch origin main
  export RELEASE_ID="${PINTPATH_RELEASE_ID:?Set an immutable ID such as PP-LAUNCH-2026-001}"
  export RELEASE_SHA="$(git rev-parse origin/main)"
  export EVIDENCE_DIR="${PINTPATH_EVIDENCE_DIR:-$HOME/.pintpath/launch-evidence/$RELEASE_SHA}"
  umask 077
  mkdir -p "$EVIDENCE_DIR"
  chmod 700 "$EVIDENCE_DIR"
  test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
  test "$(git status --porcelain)" = ""
  npm ci --include=dev
  ```

- [ ] Confirm ordinary CI, automated readiness, and the required Native Apps `ios` check are green for that commit. Android is informational and outside this launch scope.
- [ ] Deploy that commit and confirm `/ready` reports the same SHA.
- [ ] Create a private evidence register for the release. Do not commit tokens, customer identifiers, private menu files, POS secrets, signing keys, backup contents, or unredacted screenshots.
- [ ] Give the release an immutable ID such as `PP-LAUNCH-2026-001`. Before recording the first completed check, set `release.id` and the full 40-character `release.candidateSha` in `docs/release-evidence.json`. Never change them to rescue stale evidence. The validator requires that SHA to exist, remain an ancestor of `HEAD`, and have no later code changes; only `docs/release-evidence.json` may differ in the evidence-closeout commit.
- [ ] For every gate, create a gate-specific private manifest under the release register. Record the release ID, gate ID, candidate SHA, production environment, date, executor, named verifier and role, every step/result, defects/retests, and private artifact links plus their hashes. The manifest is the durable proof; the public file stores only its opaque reference and SHA-256.
- [ ] Use dedicated synthetic smoke accounts and redact transaction references before storing evidence.
- [ ] Before sending any unpublished menu to OpenAI or collecting real-shift evidence, obtain written owner/legal approval for the data-processing purpose, venue/menu permission or lawful basis, privacy notice, retention, redaction, and participant handling. This is the preliminary part of `legal_billing`; keep that item pending until its final review is complete.
- [ ] Keep each item `pending` if a required step is blocked. Use `fail` when a completed check fails. Do not use `not_applicable` for a required launch item.
- [ ] Keep `set -euo pipefail` enabled for every operator-shell block below. The steps rely on immediate exit plus pipeline failure propagation so a later `jq`, hash, or SHA check cannot mask an earlier failure. Start a fresh initialized shell if those options are changed.
- [ ] Use `npm run --silent` for machine-readable output and run `jq -e . <file>` after capture. Ordinary `npm run` adds banner text and does not produce a valid JSON artifact. Hash the final gate manifest only after it is immutable:

  ```bash
  export GATE_ID="production_public_smoke" # change for each gate
  export GATE_RESULT="pass" # use fail when preserving a completed failed check
  export GATE_MANIFEST="$EVIDENCE_DIR/$GATE_ID/manifest.json"
  test -f "$GATE_MANIFEST"
  jq -e --arg releaseId "$RELEASE_ID" --arg gateId "$GATE_ID" --arg sha "$RELEASE_SHA" --arg result "$GATE_RESULT" \
    '.releaseId == $releaseId and .gateId == $gateId and .candidateSha == $sha
      and .environment == "production" and .result == $result' "$GATE_MANIFEST"
  export GATE_MANIFEST_SHA256="$(shasum -a 256 "$GATE_MANIFEST" | awk '{print $1}')"
  test "${#GATE_MANIFEST_SHA256}" -eq 64
  ```

  A digest detects later artifact changes; it does not replace the independent verifier's responsibility to inspect the real proof.

For a passed item, update only that matching object in `docs/release-evidence.json`:

```json
{
  "id": "production_public_smoke",
  "label": "Production public health, readiness, API, and page smoke",
  "owner": "Release engineer and operations owner",
  "nextAction": "Capture the complete public/provider, performance, load, security-header, and alert exercise against one frozen production SHA; keep paid/report delivery disabled and prove deletion delivery in its own gate.",
  "required": true,
  "status": "pass",
  "evidence": "PP-LAUNCH-2026-001/production_public_smoke",
  "evidenceSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "verifiedAt": "2026-07-14T10:00:00.000Z",
  "verifiedBy": "Full name, release engineer"
}
```

Change only `status`, `evidence`, `evidenceSha256`, `verifiedAt`, and `verifiedBy`; preserve the existing ID, label, owner, next action, and `required: true` value. `evidence` must be exactly `<release.id>/<gate id>`, the digest must be the lowercase SHA-256 of the final private gate manifest, and `verifiedBy` must contain `Full name, role`. A pending item must keep all four proof fields `null`; a completed failed check uses `status: "fail"` with the same durable proof fields.

The stored `production_public_smoke` and `production_role_smoke` proofs expire after 24 hours because live providers and access can change without a code commit. Re-capture and independently verify both inside the final launch window. The informational validator reports expired proof or code/dirty-worktree drift as `evidenceCurrent: false`; the strict gate rejects it. Both modes reject future timestamps, proof collected before the frozen candidate commit, unknown/non-ancestor candidate SHAs, unexpected schema fields, and required `not_applicable` gates.

After each update, run:

```bash
npm run release:evidence
```

Keep the final evidence update as one closeout commit that changes only `docs/release-evidence.json`. If signed mobile builds were created from its parent candidate, record both SHAs in the private register. The manual production gate must still run against the final deployed `main` SHA, and **Native Apps** must be manually dispatched so its protected production-configuration iOS job runs for that exact final SHA.

## Recommended order

1. Preliminary privacy/data-processing/content-rights approval.
2. Production public smoke and providers.
3. Production role and authentication smoke.
4. Account-deletion completion notice and old-token denial proof.
5. Labelled OCR corpus.
6. Venue pilots one, two, and three.
7. Moderation, takedown, appeal, and operator-handoff drill.
8. Backup restore rehearsal.
9. Accessibility and physical-device matrix.
10. Final legal and pricing-deferral approval.
11. iOS TestFlight/App Review preparation.
12. Final evidence closeout and strict release gate.

The OCR corpus, accessibility review, legal review, and store preparation can run in parallel after the production candidate is stable. Do not run venue pilots before the role and provider checks pass.

## 1. `production_public_smoke`

**Owner:** Release engineer. **Verifier:** Operations owner.

- [ ] Confirm the common variables point at the intended release and a private directory:

  ```bash
  test "$RELEASE_SHA" = "$(git rev-parse origin/main)"
  test -d "$EVIDENCE_DIR"
  ```

- [ ] From a clean shell with no smoke-role credentials or tokens set, run the public smoke:

  ```bash
  env -u PINTPATH_SMOKE_USER_TOKEN \
    -u PINTPATH_SMOKE_VENUE_TOKEN \
    -u PINTPATH_SMOKE_ADMIN_TOKEN \
    -u PINTPATH_SMOKE_USER_EMAIL \
    -u PINTPATH_SMOKE_USER_PASSWORD \
    -u PINTPATH_SMOKE_VENUE_EMAIL \
    -u PINTPATH_SMOKE_VENUE_PASSWORD \
    PINTPATH_SMOKE_BASE_URL=https://pintpath.au \
    PINTPATH_EXPECTED_COMMIT_SHA="$RELEASE_SHA" \
    npm run --silent smoke:production | tee "$EVIDENCE_DIR/production-public-smoke.json"
  jq -e . "$EVIDENCE_DIR/production-public-smoke.json"
  ```

- [ ] Confirm `health`, `ready`, `config`, `venues`, `prices`, the map, Account, Venue Portal, Admin page, and `deployed_commit` pass.
- [ ] Confirm the result has zero failures. The only permitted skips are `user_account`, `venue_manager_portal`, and `admin_queues`; those belong to item 2.
- [ ] Inside a protected production service/container session, use a mode-private temporary file rather than the operator host's `$EVIDENCE_DIR`, which is not available remotely:

  ```bash
  set -euo pipefail
  umask 077
  PROD_READINESS_RESULT="$(mktemp)"
  npm run --silent readiness:launch | tee "$PROD_READINESS_RESULT"
  jq -e '.ok == true and .summary.failures == 0 and .summary.blockingWarnings == 0' \
    "$PROD_READINESS_RESULT"
  ```

  Securely transfer only that sanitized JSON to the operator host as `$EVIDENCE_DIR/provider-readiness.json`, validate it again, then delete the remote temporary file. Never copy a remote `.env` or provider credential.
- [ ] In Supabase, verify the production Site URL and exact web redirect allow
  list, Google provider callback, `SUPABASE_OAUTH_PROVIDERS=google`, proof Apple
  OAuth is disabled, email confirmation, leaked-password protection, admin
  MFA/AAL2, and a supported Postgres version. Apply the final Data API retirement
  migration and prove `anon`/`authenticated` have zero public table, sequence,
  RPC, or private-helper privilege; RLS remains defense in depth and only the
  server service-role/Express path accesses application data. Use the current
  [redirect URL](https://supabase.com/docs/guides/auth/redirect-urls),
  [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
  and [Data API security](https://supabase.com/docs/guides/api/securing-your-api)
  guidance.
- [ ] Confirm `beermap-source-evidence` is private and both `anon` and ordinary `authenticated` clients are denied list, download, upload, update, and delete. Prove only the authorized server API/admin signed-URL paths work. The service key must not appear in `/config.js`, browser requests, logs, or evidence.
- [ ] Confirm the operational backup Supabase URL is a different origin, and
  both `anon` and `authenticated` clients are denied every operation on
  `pintpath-backups`. This same-provider project is not the immutable-copy
  proof: item 9 must also prove an object-locked/WORM copy in a separate failure
  domain whose application writer cannot delete or shorten retention.
- [ ] Confirm browser Maps and server Places keys have API-level restrictions, approved origin/service restrictions, quotas, and budget alerts; the production vector Map ID must render live markers. Apply equivalent least-privilege quotas/alerts to OpenAI where the provider supports them.
- [ ] Confirm Redis is configured for normal production. In isolated staging, set `REQUIRE_REDIS_RATE_LIMITING=true`, confirm `/ready` reports `rateLimiterRedis.required=true`, and use two app instances to prove the third request against a limit of two is rejected across replicas. Then interrupt only staging Redis and prove readiness plus protected traffic return `503` rather than silently switching to process memory. Restore the exact staging Redis reference and confirm recovery; never run the outage drill against production. The Railway environment must remain named `staging`, which disables production backup/report schedulers and deletion-ledger writes; staging must not share the production backup service key or bucket.
- [ ] Confirm active OpenAI, Google, Supabase, backup, deletion-notice,
  webhook-signing, and recipient-encryption secrets remain server-side. Prove
  Stripe, POS, and report-email credentials are absent or inert while their
  features are disabled.
- [ ] Confirm TLS, HSTS/security headers, secure/HttpOnly/SameSite cookies, CSP, CORS, mixed-content blocking, and public cache headers on the deployed site. Run DAST only against staging/preview, never broad production traffic, and resolve all critical/high findings.
- [ ] Run Lighthouse or WebPageTest on `/`, `/pricing.html`, `/venue-portal.html`, and `/account.html` on mobile and desktop. Require 85+ performance on public landing/pricing, 95+ accessibility/SEO on public pages, 90+ accessibility on authenticated tools, no initial blocking console error, and no document overflow at 390px, 768px, or desktop.
- [ ] Define the expected launch peak from a documented acquisition/traffic model, then run read-only staging peak, 2×-peak headroom, and at least 60-minute soak tests across map venues/prices/missions and authenticated admin queues. Include sustained write contention for the approved submission/moderation/deletion-job mix, near-capacity and disk-full containment, process restart, and a volume-backed deploy/recovery timing drill. Record tool/version/workload and require zero authorization/data-isolation failures, less than 1% 5xx, public API p95 below 2 seconds, admin p95 below 3 seconds, no unbounded queue/lock growth, and measured downtime inside the signed launch budget.
- [ ] Confirm named alerts and escalation for `/health`, `/ready`, 5xx,
  deployment failure, Redis failure, deletion-notice manual review/retention
  breach, login/rate-limit spikes, database/volume size, backup age, and enabled
  scheduled-job failure. Trigger each safely in staging and preserve
  delivery/acknowledgement evidence. Stripe/report alerts become required only
  when those future features are enabled.

**Pass:** The exact SHA is deployed; public smoke exits `0`; its JSON parses; provider readiness has no failures/blocking warnings; provider access, distributed limiting, private Storage, TLS/browser security, performance, load, secret exposure, monitoring, and staging DAST checks all pass with no unresolved critical/high finding.

**Evidence:** Public-smoke JSON, provider-readiness JSON, deployed SHA, sanitized provider screenshots, key-restriction screenshots, Storage/RLS results, monitor test alert, timestamp, and verifier.

## 2. `production_role_smoke`

**Owner:** Release engineer and identity owner. **Verifier:** Security or admin owner.

- [ ] Create dedicated verified ordinary-user, second ordinary-user,
  venue-Free-manager, and admin smoke accounts. Assign the manager only to
  intended test venues and require a current MFA/AAL2 admin session.
- [ ] Configure production [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), SPF/DKIM/DMARC, sender domain, bounce/delivery monitoring, and safe Auth email rate limits. Prove confirmation and password-reset delivery to non-team addresses; the default Supabase SMTP is not production evidence.
- [ ] Test Google web sign-in through the normal production redirect, including success, cancellation, provider error, stale/replayed callback, and interrupted return. Prove public web email/password signup/login and Apple are absent. Separately prove the first-release iOS email/password signup, confirmation, login, and recovery flow plus its HTTPS browser round trip.
- [ ] Begin with a Google-only web user that has never set a password. Complete
  the approved recovery/set-password flow, sign in on iOS, and prove both
  surfaces resolve to the same Supabase user ID and Pint Path account/public ID.
  Attempt the collision/duplicate path and require it to fail or link to that
  same identity; a second account is a release blocker.
- [ ] Confirm there is no production Apple OAuth secret or enabled provider. If Apple login is proposed later, assign rotation ownership and implement, test, and evidence authorization-token revocation before enabling it.
- [ ] Set the dedicated user and venue-manager credentials as protected `production` environment secrets for both hourly **Production Health** and **Pint Path Release Gate**. Use these exact names: `PINTPATH_SMOKE_USER_EMAIL`, `PINTPATH_SMOKE_USER_PASSWORD`, `PINTPATH_SMOKE_VENUE_EMAIL`, and `PINTPATH_SMOKE_VENUE_PASSWORD`. Keep the protected `SUPABASE_URL` and `SUPABASE_ANON_KEY` values in that environment too: the smoke script compares the live public auth config against those pins and sends no password on a mismatch. Do not configure user/venue bearer-token secrets; the workflow creates and revokes disposable sessions at runtime.
- [ ] Obtain one short-lived Supabase admin access token through a normal password plus MFA ceremony and confirm its JWT is AAL2. Store it temporarily in a mode-`600` file at `$EVIDENCE_DIR/supabase-admin.token`; never paste it into the checklist or shell history. Do not store the admin password or TOTP seed in GitHub Actions.
- [ ] Exchange the AAL2 Supabase admin token for a one-use Pint Path app token without printing either token or placing it in a process argument:

  ```bash
  (
    set -euo pipefail
    ROLE=admin
    TOKEN_FILE="$EVIDENCE_DIR/supabase-$ROLE.token"
    RESPONSE_FILE="$EVIDENCE_DIR/pintpath-$ROLE-exchange.json"
    APP_TOKEN_FILE="$EVIDENCE_DIR/pintpath-$ROLE.token"
    EXPIRES_FILE="$EVIDENCE_DIR/pintpath-$ROLE.expires-at"
    trap 'rm -f "$RESPONSE_FILE" "$APP_TOKEN_FILE" "$EXPIRES_FILE"' EXIT INT TERM
    jq -nc --rawfile accessToken "$TOKEN_FILE" \
      '{accessToken:($accessToken | gsub("[\\r\\n]+$"; ""))}' \
      | curl --fail-with-body --silent --show-error \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        https://pintpath.au/api/business/auth/supabase-session \
        > "$RESPONSE_FILE"
    jq -er '.data.token' "$RESPONSE_FILE" > "$APP_TOKEN_FILE"
    jq -er '.data.expiresAt' "$RESPONSE_FILE" > "$EXPIRES_FILE"
    chmod 600 "$APP_TOKEN_FILE" "$EXPIRES_FILE"
    rm -f "$RESPONSE_FILE"
    trap - EXIT INT TERM
  )
  ```

- [ ] Set `PINTPATH_SMOKE_ADMIN_TOKEN` as a `production` environment secret immediately before dispatching the manual gate. For an operator-run capture, load the one-use token and prompt for the lower-privilege credentials without writing them to shell history:

  ```bash
  export PINTPATH_SMOKE_ADMIN_TOKEN="$(<"$EVIDENCE_DIR/pintpath-admin.token")"
  export PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS=true
  read -r -p 'Smoke user email: ' PINTPATH_SMOKE_USER_EMAIL
  read -r -s -p 'Smoke user password: ' PINTPATH_SMOKE_USER_PASSWORD; echo
  read -r -p 'Smoke venue email: ' PINTPATH_SMOKE_VENUE_EMAIL
  read -r -s -p 'Smoke venue password: ' PINTPATH_SMOKE_VENUE_PASSWORD; echo
  export PINTPATH_SMOKE_USER_EMAIL PINTPATH_SMOKE_USER_PASSWORD
  export PINTPATH_SMOKE_VENUE_EMAIL PINTPATH_SMOKE_VENUE_PASSWORD
  ```

- [ ] Run:

  ```bash
  PINTPATH_SMOKE_BASE_URL=https://pintpath.au \
    PINTPATH_EXPECTED_COMMIT_SHA="$RELEASE_SHA" \
    npm run --silent smoke:production:auth | tee "$EVIDENCE_DIR/production-role-smoke.json"
  jq -e . "$EVIDENCE_DIR/production-role-smoke.json"
  ```

- [ ] Confirm all public checks plus `user_account`, `venue_manager_portal`, and `admin_queues` pass with zero failures and zero skips.
- [ ] In real browsers, prove logged-out users receive only the fixed free price
  preview, contributors receive the intended earned set, a normal user cannot
  load admin/venue-private data, one manager cannot access an unauthorized
  venue, and the MFA admin can access queues. Prove counter/reward/POS and paid
  surfaces remain unavailable.
- [ ] As a contributor, submit a price and private photo; prove the second user cannot see raw submission/evidence; approve as admin; then prove the normalized price publishes and points are awarded only after approval.
- [ ] As the assigned manager, prove ordinary profile, beer, and happy-hour edits follow the documented direct-publish path, while restricted fields and safeguard-triggered changes remain queued for admin review.
- [ ] Prove privacy-thresholded analytics suppress low-count buckets and never expose another venue or individual activity.
- [ ] Across two devices, prove password reset, current-device logout, logout-all, session listing/revocation, export, deletion request/status/cancel, and recent-auth requirements behave as documented. Export must include retained exact location fields but no raw evidence bytes/URLs, tokens, or passwords.
- [ ] Require zero unexpected browser console errors or failed network requests in the completed role journeys.
- [ ] Prove `REPORT_EMAIL_MODE=disabled` and
  `REPORT_DELIVERY_SCHEDULE_ENABLED=false`; no monthly venue report is sent or
  advertised for this venue-Free release. The dedicated account-deletion
  Resend path is configured and proved separately in item 3.
- [ ] Confirm the hourly authenticated job creates and revokes disposable user/venue sessions and that its JSON has both `*_session_cleanup` and `*_provider_session_cleanup` checks passing. Rotate the dedicated account passwords under the credential policy, not on the old bearer-token expiry schedule. Create a fresh MFA/AAL2 admin token for each manual gate; the gate sets `PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS=true` and must show `admin_queues_session_cleanup` passing.
- [ ] Unset local credential/token variables and securely delete temporary token files when the capture is complete:

  ```bash
  unset PINTPATH_SMOKE_USER_EMAIL PINTPATH_SMOKE_USER_PASSWORD
  unset PINTPATH_SMOKE_VENUE_EMAIL PINTPATH_SMOKE_VENUE_PASSWORD
  unset PINTPATH_SMOKE_ADMIN_TOKEN PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS
  find "$EVIDENCE_DIR" -maxdepth 1 -type f \
    \( -name 'supabase-*.token' -o -name 'pintpath-*.token' \) -delete
  ```

**Pass:** Custom Auth email delivery and every enabled provider/callback work;
strict role-smoke JSON passes; the deployed user/contributor/venue-Free
manager/admin journeys, isolation, MFA, analytics privacy, session/privacy
flows, token rotation, and disabled commercial/report/reward scope all pass with
no unexpected console/network error.

**Evidence:** Role-smoke JSON or `pintpath-production-release-gate` artifact,
provider-flow matrix, redacted isolation screenshots, disabled report/commercial
state, SHA, timestamp, and verifier.

## 3. `account_deletion_completion_notice`

**Owner:** Privacy operations owner and release engineer. **Verifier:** Independent security or privacy reviewer.

- [ ] Deploy schema 15 and the notification worker to isolated staging; preserve the automatic pre-migration SQLite backup.
- [ ] Pin the production Beer service to exactly one app replica and one region. Prove no autoscaling or second SQLite writer is enabled; Railway volumes do not permit replicas and introduce brief deployment downtime. Horizontal/multi-region or highly available launch claims are a no-go until the authoritative SQLite state, deletion outbox, webhook correlation, and job leases move together to a shared transactional datastore. Otherwise preserve the signed controlled-launch capacity/downtime acceptance and migration trigger.
- [ ] In Resend, verify the sender domain and create a dedicated sending-only transactional key. Create one staging-only webhook at the exact staging Railway origin and a separate production webhook at `https://pintpath.au/api/business/account-deletion-notifications/resend-webhook`; give each its own `whsec_` secret and subscribe both to `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`. Never send staging events to the production endpoint.
- [ ] Generate an independent 32-byte recipient-encryption key. Store the active key ID, keyring JSON, Resend key, sender, monitored reply-to, and `whsec_` webhook secret only in the protected Railway/GitHub secret stores. Never paste a secret, keyring, or recipient into evidence.
- [ ] Keep `SUPABASE_OAUTH_PROVIDERS=google`; prove production startup rejects Apple and an incomplete deletion-notice configuration.
- [ ] Set `ACCOUNT_DELETION_REHEARSAL_ENABLED=true` only after proving the immutable staging Railway project/environment/service IDs, exact `$RAILWAY_PUBLIC_DOMAIN` origin, `/app/data` volume and data paths, staging Supabase project `ibveugyfyzjptyvautlr`, Stripe test mode or absence, and staging-only Resend webhook/key material. Remove both off-site backup credentials and every Redis reference first; use the explicit in-memory limiter override only for this single-instance proof. Run `npm run --silent readiness:providers`, require `readinessProfile=account_deletion_rehearsal`, and confirm `/ready` separately. Remove the rehearsal switch and override immediately afterward and prove both are false or absent in production.
- [ ] Use a sacrificial verified staging account. After test-adjusting only its staging safety window, execute deletion and prove `held -> pending -> accepted -> delivered`, a verified webhook receipt, one provider message, and deletion of the encrypted recipient row.
- [ ] Prove invalid signatures return an error, duplicate `svix-id` deliveries are idempotent, older out-of-order events cannot reverse a newer outcome, worker overlap sends once, restart resumes work, and restored tombstones never send a notice.
- [ ] Prove timeout/429 retry backoff, bounce/failure operator attention, the 23-hour uncertain-send cutoff, recipient-ciphertext purge on verified delivery or audited terminal resolution, the 30-day post-completion hard limit, the 60-day pre-completion held cap, 400-day non-identifying webhook-receipt retention, and key rotation without removing a still-referenced key.
- [ ] Before deleting the sacrificial account, retain one short-lived Supabase
  access JWT in the protected evidence session. After Auth identity deletion and
  local completion, prove that exact old JWT cannot exchange for a Pint Path
  session and cannot read or mutate any exposed Data API table, RPC, or Storage
  object. Record only the JWT expiry and denial matrix, then destroy the token.
  A failed refresh or deleted Auth user alone does not prove an issued JWT is
  contained.
- [ ] Confirm `/ready`, `job:account_deletion_notifications`, and the admin deletion queue report configured/healthy state with no manual-review or overdue-retention rows. Inspect SQLite using aggregate/length checks only and prove there is no plaintext recipient in outbox/admin/log output.

**Pass:** One and only one completion notice reaches the staging recipient, its delivery is cryptographically linked to a verified Resend event, recipient ciphertext is purged on verified delivery, audited terminal resolution, or its applicable hard limit, all abuse/retry/restore/retention cases pass, and production readiness is fail-closed.

**Evidence:** Candidate SHA, schema version and migration-backup receipt, sanitized Resend domain/webhook screenshots, provider message ID, non-identifying webhook event ID/keyed receipt HMAC, admin/job summaries, staging test matrix, timestamp, and verifier. No email address or secret is permitted.

## 4. `ocr_labelled_corpus`

**Owner:** OCR/data QA lead. **Verifier:** Independent human label reviewer.

- [ ] Collect at least 30 menus not used to write prompts, tests, or patches.
- [ ] Cover mobile photos, multi-column PDFs, low contrast, wrapped names, pot/schooner/pint tables, tap and package rows, rows without prices, and strong non-beer distractors such as food, wine, spirits, cocktails, and headings.
- [ ] Keep sources outside Git. Record venue/menu permission or another approved lawful basis before sending any private/unpublished source to OpenAI, plus retention/deletion terms and a SHA-256 for every source before inference.
- [ ] Use at least 30 distinct unseen cases across the source categories above; repeated crops/pages from one menu do not count as distinct menus.
- [ ] Create a `mode: "labelled_corpus"` manifest with the fixed thresholds `overall: 0.90`, `rowRecall: 0.95`, `rowPrecision: 0.98`, `canonicalNames: 0.95`, `prices: 0.95`, `availability: 0.95`, and `nonBeerRejection: 1.00`. Human-label names, aliases, pint prices, availability, ABV, brewery, and forbidden non-beer names from the visible source; never use OCR output as the label.
- [ ] Run the deterministic scorer check:

  ```bash
  npm run ocr:benchmark
  ```

- [ ] Treat that command only as proof that the bundled scorer fixture works; it is not live-model or corpus accuracy evidence.

- [ ] Run the real model and preserve the enriched result:

  ```bash
  npm run --silent ocr:benchmark:live -- \
    --manifest "$EVIDENCE_DIR/labelled-corpus.json" \
    --write-results "$EVIDENCE_DIR/ocr-results.json" \
    | tee "$EVIDENCE_DIR/ocr-report.json"
  jq -e . "$EVIDENCE_DIR/ocr-results.json" >/dev/null
  jq -e . "$EVIDENCE_DIR/ocr-report.json" >/dev/null
  ```

- [ ] Confirm at least 90% overall, 95% row recall, 98% row precision, 95% canonical names, 95% prices, 95% availability, and 100% rejection of labelled non-beer candidates.
- [ ] Record `OPENAI_MENU_OCR_MODEL` and `OPENAI_MENU_OCR_FALLBACK_MODEL` values separately without recording the API key; the benchmark report does not embed them.
- [ ] Do not lower thresholds to pass. Keep any failed source layout behind admin/manual review until fixed and rerun.

**Pass:** The live report says `passed: true`, contains at least 30 unseen cases, meets every fixed threshold, and has independent label sign-off.

**Evidence:** Input manifest and source hashes, enriched result, report JSON, model identifiers without keys, per-layout score summary, reviewer, and timestamp.

## 5–7. `venue_pilot_one`, `venue_pilot_two`, `venue_pilot_three`

**Owner:** Pilot lead. **Verifier:** The owner/manager of each participating venue.

Select three genuinely different venues by size, menu format, device mix, and
network quality. A simulation does not count. Repeat every step independently
for each evidence ID without enabling Pro, trial, paid, reward, counter, or POS
features.

### Claim and assignment

- [ ] The owner submits a claim through `/venue-portal.html` with a verified account.
- [ ] Admin independently verifies the owner through a trusted venue phone,
  email, or partner contact and approves only the correct venue assignment.
- [ ] Prove the manager can see only assigned venues and a different verified
  user cannot access the venue workspace.
- [ ] Record devices, browsers/app version, network conditions, start time, and
  redacted test references.

### Free venue operations

- [ ] Update profile/hours and at least three beer/stock/price rows; verify the
  intended venue-managed fields publish and a safeguard-triggered destructive
  change is held for admin review.
- [ ] Submit a separate community beer-price/photo contribution, prove its raw
  evidence stays private, approve it as admin, and verify only the normalized
  public price publishes with the expected audit record.
- [ ] Exercise the retained venue-side happy-hour collection field and prove no
  public happy-hour record, filter, mission, contribution path, SEO claim, or
  iOS surface appears.
- [ ] Interrupt the network before one safe form submission, recover without a
  duplicate or partial update, and compare venue, manager, and admin views.
- [ ] File and resolve one wrong-price/support issue; verify priority, owner,
  response note, and public correction behavior.
- [ ] Revoke the venue-manager assignment and prove access stops on the existing
  session and after sign-in on a second device.
- [ ] Prove both commercial flags, rewards, gamification, reports, specials,
  counter/POS, trial, checkout, and upgrade actions remain unavailable.

### Immediate stop conditions

Stop and mark the item `fail` if an unauthorized venue or private evidence is
visible, an unreviewed community price publishes, a retry duplicates/partially
applies data, revoked access survives, public happy-hour content appears, or a
disabled commercial/reward surface becomes reachable.

**Pass:** Every Free venue step passes at the real venue, no stop condition
occurs, defects are closed and retested, and the venue owner plus independent
verifier sign.

**Evidence:** One pack per venue with date/duration, venue characteristics,
devices, roles, redacted references, before/after public and manager results,
network/revocation results, defects/retests, and venue-owner sign-off.

## 8. `moderation_operations`

**Owners:** Primary and backup moderation operators, privacy owner, and release owner.

- [ ] Record named primary/backup operators, normal/emergency response SLAs,
  escalation contact, appeal path, and the fixed daily queue-review time.
- [ ] Seed only synthetic test cases for a wrong price, abusive/free-text
  submission, private-evidence concern, account/privacy request, and venue claim.
- [ ] Prove normal users and unrelated venue managers cannot load admin queues,
  raw evidence, internal notes, assignment controls, or audit metadata.
- [ ] Triage, assign, reject/redact/take down, and resolve the synthetic cases;
  verify the public result changes only through the authorized review path and
  every action creates a redacted security-audit entry.
- [ ] Exercise one emergency public-data takedown and one appeal/re-review;
  preserve history without restoring unsafe free text or evidence publicly.
- [ ] Hand the queue to the backup operator and prove they can continue from the
  recorded state without shared credentials or private data in chat/email.
- [ ] Trigger an SLA breach/alert in staging and verify acknowledgement plus
  escalation. Keep marketing/report delivery, rewards, counter/POS, and paid
  enrolment disabled throughout.

**Pass:** Queue isolation, takedown, appeal, audit, SLA escalation, and backup
handoff all pass with no private-data exposure or unauthorized publication.

**Evidence:** Sanitized queue/takedown/appeal matrix, timestamps, audit-event
references, alert acknowledgement, handoff record, defects/retests, and signed
primary/backup/privacy-owner approval.

## 9. `backup_restore`

**Owner:** Operations/SRE lead. **Verifier:** Second operator and named incident owner.

- [ ] Treat `OFFSITE_BACKUP_SUPABASE_URL` as a private operational restore copy,
  not by itself as immutable disaster-recovery proof. Confirm it is a different
  origin and that `pintpath-backups` has no anonymous/authenticated object
  policies.
- [ ] Provision a second retained copy in a different provider or region with
  object lock/WORM retention for at least the signed backup window. The
  production application principal may create new uniquely named objects but
  must be unable to overwrite, delete, shorten retention, change object lock,
  or administer the bucket. Give deletion/retention control to a separate
  two-person operations principal. Prove those denials with harmless staging
  objects and preserve the provider policy/versioning/retention evidence.
- [ ] Replicate each completed schema-15 database, source-evidence set, manifest,
  and deletion ledger/tombstones into that immutable copy; verify hashes from a
  separately authorised reader. A service-role key that can both upload and
  run retention deletion, or two projects in the same failure domain, fails
  this gate.
- [ ] Confirm Railway reports `RAILWAY_ENVIRONMENT_NAME=production` in the protected production console. Confirm every staging/preview environment has a different name and neither shares nor writes to the production backup bucket; automatic backup and deletion-ledger writes fail closed outside the canonical production runtime.
- [ ] Provision the destination only with `ops/supabase/independent-backup-project-storage.sql`, never through the production migration chain.
- [ ] In a protected production service/container session, prove `DATABASE_PATH` resolves inside the mounted `/app/data` volume and is the running service's readable live SQLite file. Run the backup there—not from an operator laptop or checkout—and capture its JSON without printing provider secrets:

  ```bash
  set -euo pipefail
  umask 077
  test -r "${DATABASE_PATH:?}"
  case "$(realpath "$DATABASE_PATH")" in /app/data/*) ;; *) exit 1 ;; esac
  PROD_BACKUP_RESULT="$(mktemp)"
  npm run --silent data:backup:offsite | tee "$PROD_BACKUP_RESULT"
  jq -e '.ok == true
    and (.backupId | type == "string" and length > 0)
    and (.manifestSha256 | type == "string" and test("^[a-f0-9]{64}$"))' \
    "$PROD_BACKUP_RESULT"
  ```

- [ ] Securely transfer only that sanitized JSON result to `$EVIDENCE_DIR/offsite-backup.json`, delete the production temporary file, and record its backup ID, trusted manifest SHA-256, database/object/evidence counts, bytes, tombstones, and pruning result. Never transfer the live database through this step.
- [ ] In the independent backup project, create a separate temporary secret key for this rehearsal only. Never reuse or revoke the long-lived Railway production backup key. Place the temporary key in a mode-`600` regular, non-symlink file on the protected operator host; never paste it into chat, screenshots, shell history, or evidence.
- [ ] On the protected operator host, use the repository-installed SDK downloader from the earlier secret-free `npm ci` and download exactly the new immutable prefix. The downloader accepts the temporary key file path rather than secret bytes, rejects an existing destination or unsafe object path, verifies the downloaded manifest before publishing the directory, cleans a partial download on failure, and emits aggregate JSON without object paths:

  ```bash
  export BACKUP_ID="$(jq -er '.backupId' "$EVIDENCE_DIR/offsite-backup.json")"
  export EXPECTED_MANIFEST_SHA256="$(jq -er \
    '.manifestSha256 | select(test("^[a-f0-9]{64}$"))' \
    "$EVIDENCE_DIR/offsite-backup.json")"
  export RESTORE_BASE="$EVIDENCE_DIR/backup-restore/$BACKUP_ID"
  export BACKUP_PATH="$RESTORE_BASE/snapshot"
  export OFFSITE_BACKUP_SECRET_KEY_FILE="${OFFSITE_BACKUP_SECRET_KEY_FILE:?}"
  test ! -e "$BACKUP_PATH"
  install -d -m 700 "$RESTORE_BASE"
  test -f "$OFFSITE_BACKUP_SECRET_KEY_FILE"
  test ! -L "$OFFSITE_BACKUP_SECRET_KEY_FILE"
  chmod 600 "$OFFSITE_BACKUP_SECRET_KEY_FILE"

  OFFSITE_BACKUP_SUPABASE_URL="${OFFSITE_BACKUP_SUPABASE_URL:?}" \
  OFFSITE_BACKUP_BUCKET="${OFFSITE_BACKUP_BUCKET:-pintpath-backups}" \
    npm run --silent data:backup:download-offsite -- \
      --backup-id="$BACKUP_ID" \
      --expected-manifest-sha256="$EXPECTED_MANIFEST_SHA256" \
      --output="$BACKUP_PATH" \
      --service-role-key-file="$OFFSITE_BACKUP_SECRET_KEY_FILE" \
    | tee "$EVIDENCE_DIR/offsite-backup-download.json"

  jq -e --arg backupId "$BACKUP_ID" \
    --arg manifestSha256 "$EXPECTED_MANIFEST_SHA256" \
    --arg outputPath "$BACKUP_PATH" \
    '.ok == true
     and .backupId == $backupId
     and .manifestSha256 == $manifestSha256
     and .outputPath == $outputPath
     and (.objectCount | type == "number" and . > 0)
     and (.bytes | type == "number" and . > 0)' \
    "$EVIDENCE_DIR/offsite-backup-download.json"
  test -f "$BACKUP_PATH/manifest.json"
  ```

- [ ] The downloader uses the repository-installed Supabase SDK and emits only aggregate JSON—never Storage object paths or secret values. The downloaded `manifest.json`, followed by the independent verification command, remains the integrity authority for path sets, bytes, checksums, MIME metadata, database references, and orphan reporting. Do not retain raw object-level troubleshooting output. Hash and verify the downloaded snapshot:

  ```bash
  shasum -a 256 "$BACKUP_PATH/manifest.json" \
    | awk '{print $1}' \
    | tee "$EVIDENCE_DIR/offsite-backup-manifest.sha256"
  test "$(<"$EVIDENCE_DIR/offsite-backup-manifest.sha256")" = \
    "$EXPECTED_MANIFEST_SHA256"
  npm run --silent data:backup:verify -- --backup="$BACKUP_PATH" \
    | tee "$EVIDENCE_DIR/offsite-backup-verify.json"
  jq -e '.ok == true' "$EVIDENCE_DIR/offsite-backup-verify.json"
  ```

- [ ] With production and independent-destination URLs plus the independent service key available only to the operator, rehearse into a new empty directory. Point `DATABASE_PATH` at the database that the command is about to create inside that isolated directory; this records `job:restore_rehearsal` in the restored copy, never in production:

  ```bash
  export REHEARSAL_ROOT="$RESTORE_BASE/rehearsal"
  test ! -e "$REHEARSAL_ROOT"
  SUPABASE_URL="${SUPABASE_URL:?}" \
  OFFSITE_BACKUP_SUPABASE_URL="${OFFSITE_BACKUP_SUPABASE_URL:?}" \
  OFFSITE_BACKUP_SERVICE_ROLE_KEY="$(<"$OFFSITE_BACKUP_SECRET_KEY_FILE")" \
  DATABASE_PATH="$REHEARSAL_ROOT/pint-path.sqlite" \
    npm run --silent data:backup:rehearse -- \
      --backup="$BACKUP_PATH" \
      --backup-id="$BACKUP_ID" \
      --source-manifest-sha256="$EXPECTED_MANIFEST_SHA256" \
      --output="$REHEARSAL_ROOT" \
    | tee "$EVIDENCE_DIR/offsite-restore-rehearsal.json"
  jq -e '.ok == true' "$EVIDENCE_DIR/offsite-restore-rehearsal.json"
  export DELETION_LEDGER_SHA256="$(jq -er '.deletionLedgerSha256' \
    "$EVIDENCE_DIR/offsite-restore-rehearsal.json")"
  export DELETION_LEDGER_GENESIS_SHA256="$(jq -er '.deletionLedgerGenesisSha256' \
    "$EVIDENCE_DIR/offsite-restore-rehearsal.json")"
  export DELETION_LEDGER_CHECKPOINT_SHA256="$(jq -er '.deletionLedgerCheckpointSha256' \
    "$EVIDENCE_DIR/offsite-restore-rehearsal.json")"
  ```

- [ ] Confirm SQLite integrity and foreign keys, database/evidence checksums, MIME/reference reconciliation, current independent deletion-ledger authority, and tombstoned PII/evidence purge all pass.
- [ ] Seal the exact post-rehearsal runtime directory before it leaves the operator host. The command refuses an existing attestation, symlinks, hard links, special files, unexpected sidecars, a changed SQLite file, a mismatched source manifest, failed integrity/foreign-key checks, or an incomplete `job:restore_rehearsal` state:

  ```bash
  npm run --silent data:backup:attest-restore -- \
    --restore-root="$REHEARSAL_ROOT" \
    --backup-id="$BACKUP_ID" \
    --source-manifest="$BACKUP_PATH/manifest.json" \
    --source-manifest-sha256="$EXPECTED_MANIFEST_SHA256" \
    --deletion-ledger-sha256="$DELETION_LEDGER_SHA256" \
    --deletion-ledger-genesis-sha256="$DELETION_LEDGER_GENESIS_SHA256" \
    --deletion-ledger-checkpoint-sha256="$DELETION_LEDGER_CHECKPOINT_SHA256" \
    | tee "$EVIDENCE_DIR/restore-runtime-attestation.json"
  export RESTORE_ATTESTATION_SHA256="$(
    jq -er '.attestationSha256' "$EVIDENCE_DIR/restore-runtime-attestation.json"
  )"
  ```

- [ ] Create a **new, one-shot** access-restricted restore-staging Supabase project in the `Pint Path Backups` organization. Record its exact project ref and the exact ID of the temporary secret key; do not select a project by display name. The restore guard pins the permitted project refs in `src/config/env.ts`, so a new one-shot ref requires a separately reviewed code change and deployment before any restored bytes are uploaded. Unlink any previously selected project, bind the CLI to the exact new ref, verify the link file before and after both migration commands, dry-run the full migration chain, and only then apply it:

  ```bash
  export RESTORE_STAGING_PROJECT_REF='ibveugyfyzjptyvautlr'
  test "$RESTORE_STAGING_PROJECT_REF" = 'ibveugyfyzjptyvautlr'
  supabase unlink
  test ! -f supabase/.temp/project-ref
  supabase link --project-ref "$RESTORE_STAGING_PROJECT_REF"
  test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$RESTORE_STAGING_PROJECT_REF"
  supabase db push --linked --dry-run
  test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$RESTORE_STAGING_PROJECT_REF"
  supabase db push --linked
  test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$RESTORE_STAGING_PROJECT_REF"
  ```

  This literal is the reviewed one-shot ref pinned by the current build. Because that project is deleted during teardown, the runbook literal and `src/config/env.ts` pin must be changed together in a reviewed commit before another rehearsal. Confirm the exact project's empty `beermap-source-evidence` bucket is private, has no direct `anon`/`authenticated` policies, and has no pre-existing objects. Keep the exact link and canonical URL verification immediately before staging. The repository helper refuses a non-empty bucket, preserves original object paths and manifest MIME types, and redownloads every object for checksum/MIME verification:

  ```bash
  export STAGING_SUPABASE_SECRET_KEY_FILE="${STAGING_SUPABASE_SECRET_KEY_FILE:?}"
  export STAGING_SUPABASE_URL="https://${RESTORE_STAGING_PROJECT_REF}.supabase.co"
  test "$STAGING_SUPABASE_URL" = 'https://ibveugyfyzjptyvautlr.supabase.co'
  test -f "$STAGING_SUPABASE_SECRET_KEY_FILE"
  test ! -L "$STAGING_SUPABASE_SECRET_KEY_FILE"
  chmod 600 "$STAGING_SUPABASE_SECRET_KEY_FILE"
  SUPABASE_URL="${SUPABASE_URL:?}" \
  OFFSITE_BACKUP_SUPABASE_URL="${OFFSITE_BACKUP_SUPABASE_URL:?}" \
  STAGING_SUPABASE_URL="${STAGING_SUPABASE_URL:?}" \
  STAGING_SUPABASE_SERVICE_ROLE_KEY="$(<"${STAGING_SUPABASE_SECRET_KEY_FILE:?}")" \
    npm run --silent data:backup:stage-evidence -- \
      --backup="$BACKUP_PATH" \
      --restore="$REHEARSAL_ROOT" \
    | tee "$EVIDENCE_DIR/staged-restore-evidence.json"
  jq -e '.ok == true' "$EVIDENCE_DIR/staged-restore-evidence.json"
  test "$(tr -d '\r\n' < supabase/.temp/project-ref)" = "$RESTORE_STAGING_PROJECT_REF"
  ```

- [ ] If the source manifest reports zero Supabase Storage evidence objects, do not manufacture or upload any: preserve the empty private bucket and record the zero count. The filesystem evidence directory and its attestation are still required.
- [ ] Keep the Railway Beer service stopped while preparing restore staging. Select and record these immutable resources before changing anything; abort if any ID differs:

  ```bash
  export RAILWAY_PROJECT_ID='48d8c6cd-1c66-4148-874b-20877f48e1a5'
  export STAGING_ENVIRONMENT_ID='a4e0f507-d6d3-4df9-a818-ad92c0071a35'
  export STAGING_BEER_SERVICE_ID='6816c4a2-e392-4ee5-826f-2584cb599ec0'
  export STAGING_REDIS_SERVICE_ID='d6351cec-fe04-4a6f-8e05-1cc164ea1e73'
  ```

  In Railway, select the exact project ID, staging environment ID, and Beer service ID—not their display names. Reduce Beer to one replica. Create a **new** staging-only Beer volume, attach it at `/app/data`, and record its exact volume ID. Never reuse, move, clone, or attach the production Beer volume. The operator-host path under `$REHEARSAL_ROOT` does not exist in Railway and must never be used as Railway's `DATABASE_PATH`.

- [ ] Before starting bootstrap, deploy only a reviewed build containing the fail-closed restore guard and configure the complete staging contract below. The one-shot `SUPABASE_URL` ref must match the reviewed ref pinned in `src/config/env.ts`. Railway system identity and service references must be selected from the exact resources above, never typed imitations:

  ```dotenv
  NODE_ENV=production
  RESTORE_REHEARSAL_MODE=true
  RESTORE_REHEARSAL_PHASE=bootstrap
  RESTORE_REHEARSAL_BACKUP_ID=<selected-backup-id>
  RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256=<trusted-source-manifest-sha256>
  RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256=<trusted-runtime-attestation-sha256>
  PUBLIC_BASE_URL=https://<RAILWAY_PUBLIC_DOMAIN>
  RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL=https://<production-project>.supabase.co
  RESTORE_REHEARSAL_BACKUP_SUPABASE_URL=https://<independent-backup-project>.supabase.co
  RESTORE_REHEARSAL_ACCESS_USERNAME=<staging-operator-name>
  RESTORE_REHEARSAL_ACCESS_PASSWORD=<unique-32-plus-byte-secret>
  SUPABASE_URL=https://<third-restore-staging-project>.supabase.co
  SUPABASE_ANON_KEY=<restore-staging-publishable-key>
  SUPABASE_SERVICE_ROLE_KEY=<restore-staging-secret-key>
  SUPABASE_OAUTH_PROVIDERS=
  REDIS_URL=${{Redis.REDIS_URL}}
  RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID=${{Redis.RAILWAY_ENVIRONMENT_ID}}
  RESTORE_REHEARSAL_REDIS_SERVICE_ID=${{Redis.RAILWAY_SERVICE_ID}}
  RESTORE_REHEARSAL_REDIS_SENTINEL=${{Redis.RESTORE_REHEARSAL_IDENTITY_SENTINEL}}
  REDIS_KEY_NAMESPACE=pint-path:restore:<staging-environment-id>:<backup-id>
  REQUIRE_REDIS_RATE_LIMITING=true
  GOOGLE_MAPS_API_KEY=<staging-origin-restricted-browser-key>
  GOOGLE_MAPS_MAP_ID=<map-id>
  SOURCE_EVIDENCE_SIGNING_SECRET=<unique-staging-32-plus-byte-secret>
  REPORT_EMAIL_MODE=disabled
  REPORT_DELIVERY_SCHEDULE_ENABLED=false
  DEMO_BILLING_MODE=false
  ALLOW_DEMO_BILLING_IN_PRODUCTION=false
  ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false
  DATABASE_PATH=/app/data/bootstrap/pint-path.sqlite
  SOURCE_EVIDENCE_STORAGE_DIR=/app/data/bootstrap/source-evidence
  ```

  Completely remove all `STRIPE_*`, Resend/report sender, Google Places, OpenAI, POS webhook, production smoke/admin bearer, shared-admin-secret, public Stripe, and offsite-backup URL/key variables. The restore guard must reject startup if any are present; if the Railway project, environment, Beer service, Redis service, or Supabase refs differ; if the authenticated Redis URL is not `redis.railway.internal:6379`; if the public origin is not the exact staging Railway domain; or if either restored path is not exact for the selected phase.

- [ ] Seed a unique 32+ byte sentinel in the exact staging Redis service at `pint-path:restore:<staging-environment-id>:<backup-id>:identity`; configure `RESTORE_REHEARSAL_IDENTITY_SENTINEL` on that Redis service. In its console, bind the operation to the immutable service identity, require the private host and authenticated connection, create the identity only when absent with `SET ... NX`, and compare the stored value server-side without printing the key or secret:

  ```bash
  set -euo pipefail
  umask 077
  test "$RAILWAY_ENVIRONMENT_ID" = 'a4e0f507-d6d3-4df9-a818-ad92c0071a35'
  test "$RAILWAY_SERVICE_ID" = 'd6351cec-fe04-4a6f-8e05-1cc164ea1e73'
  test "${RAILWAY_PRIVATE_DOMAIN:?}" = 'redis.railway.internal'
  test "${REDISHOST:?}" = 'redis.railway.internal'
  test "${REDISPORT:?}" = '6379'
  export BACKUP_ID='<recorded-selected-backup-id>'
  test "$(printf '%s' "$BACKUP_ID" | wc -c | tr -d ' ')" -ge 10
  export REDIS_KEY_NAMESPACE="pint-path:restore:${RAILWAY_ENVIRONMENT_ID}:${BACKUP_ID}"
  export IDENTITY_KEY="${REDIS_KEY_NAMESPACE}:identity"
  export SENTINEL="${RESTORE_REHEARSAL_IDENTITY_SENTINEL:?}"
  test "$(printf '%s' "$SENTINEL" | wc -c | tr -d ' ')" -ge 32
  export REDISCLI_AUTH="${REDISPASSWORD:?}"
  test "$(redis-cli --no-auth-warning -h "$REDISHOST" -p "$REDISPORT" \
    --user "${REDISUSER:-default}" SET "$IDENTITY_KEY" "$SENTINEL" NX)" = 'OK'
  test "$(redis-cli --no-auth-warning -h "$REDISHOST" -p "$REDISPORT" \
    --user "${REDISUSER:-default}" EVAL \
    'return redis.call("GET", KEYS[1]) == ARGV[1] and 1 or 0' \
    1 "$IDENTITY_KEY" "$SENTINEL")" = '1'
  unset REDISCLI_AUTH SENTINEL IDENTITY_KEY
  ```

  A failed `NX`, identity mismatch, wrong service ID, or wrong host is a hard stop: never overwrite an existing identity. Configure Beer with Railway references only after this proof. The app performs the sentinel comparison and rate-limit mutation atomically on every protected Redis write. Never copy a production Redis URL or sentinel.

- [ ] Start bootstrap only after the full contract above is deployed. In the Beer console, prove the container and new empty volume are the selected resources, and prove neither upload destination exists:

  ```bash
  set -euo pipefail
  umask 077
  export BACKUP_ID="${RESTORE_REHEARSAL_BACKUP_ID:?}"
  export RESTORE_ATTESTATION_SHA256="${RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256:?}"
  export EXPECTED_MANIFEST_SHA256="${RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256:?}"
  test "$RAILWAY_PROJECT_ID" = '48d8c6cd-1c66-4148-874b-20877f48e1a5'
  test "$RAILWAY_ENVIRONMENT_ID" = 'a4e0f507-d6d3-4df9-a818-ad92c0071a35'
  test "$RAILWAY_SERVICE_ID" = '6816c4a2-e392-4ee5-826f-2584cb599ec0'
  test "$RAILWAY_VOLUME_MOUNT_PATH" = '/app/data'
  test "$RESTORE_REHEARSAL_REDIS_SERVICE_ID" = 'd6351cec-fe04-4a6f-8e05-1cc164ea1e73'
  test ! -e "/app/data/incoming-$BACKUP_ID"
  test ! -e "/app/data/restore-$BACKUP_ID"
  ```

  Bootstrap must return `200` from `/health` and `/ready`, report `backendServicesInitialized=false` and `databaseOpened=false`, and return `503` for every other route. Compare the volume ID visible in the Railway file browser with the recorded fresh volume ID before uploading. Upload the complete attested directory into exactly `/app/data/incoming-$BACKUP_ID`; never upload over an existing path and never use `--overwrite`.

- [ ] Inside that exact staging Beer container, activate the uploaded directory. The command verifies the incoming directory against the trusted backup ID and both hashes, requires an unused final path on the same volume, holds an exclusive lock, atomically renames, fsyncs, and verifies the activated bytes again. Capture aggregate output and require both successful activation and clean lock removal:

  ```bash
  set -euo pipefail
  umask 077
  export BACKUP_ID="${RESTORE_REHEARSAL_BACKUP_ID:?}"
  export RESTORE_ATTESTATION_SHA256="${RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256:?}"
  export EXPECTED_MANIFEST_SHA256="${RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256:?}"
  export ACTIVATION_RESULT="$(mktemp /tmp/pint-path-restore-activation.XXXXXX)"
  trap 'rm -f "$ACTIVATION_RESULT"' EXIT HUP INT TERM
  npm run --silent data:backup:activate-restore -- \
    --incoming-root="/app/data/incoming-$BACKUP_ID" \
    --final-root="/app/data/restore-$BACKUP_ID" \
    --backup-id="$BACKUP_ID" \
    --attestation-sha256="$RESTORE_ATTESTATION_SHA256" \
    --source-manifest-sha256="$EXPECTED_MANIFEST_SHA256" \
    > "$ACTIVATION_RESULT"
  jq -e '.activated == true and .activationLockCleanupRequired == false' \
    "$ACTIVATION_RESULT"
  ```

  Securely transfer only that aggregate JSON into the operator-host `$EVIDENCE_DIR` through the approved evidence channel, then run `rm -f "$ACTIVATION_RESULT"` before leaving the shell. The output file is opened successfully before activation starts; no `tee` or operator-host path is used inside Railway.

  If the command exits nonzero, its output is lost, or `activationLockCleanupRequired` is true, stop Beer and do not rerun activation or manually remove/rename the lock. Run the read-only verifier separately against each root that exists:

  ```bash
  set -euo pipefail
  umask 077
  export BACKUP_ID="${RESTORE_REHEARSAL_BACKUP_ID:?}"
  export RESTORE_ATTESTATION_SHA256="${RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256:?}"
  export EXPECTED_MANIFEST_SHA256="${RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256:?}"
  npm run --silent data:backup:verify-runtime -- \
    --restore-root='<exact-existing-incoming-or-final-root>' \
    --backup-id="$BACKUP_ID" \
    --attestation-sha256="$RESTORE_ATTESTATION_SHA256" \
    --source-manifest-sha256="$EXPECTED_MANIFEST_SHA256"
  ```

  Apply this decision tree with a second verifier: final exists + verifies and incoming is absent means the rename committed (retain the cleanup warning as evidence, do not rerun activation, and continue only after sign-off); incoming exists + verifies and final is absent means it did not commit (leave the lock untouched and repeat on a fresh volume); both, neither, or any failed verification means quarantine the volume, preserve aggregate evidence, delete that staging volume, and repeat on a fresh volume. Never start active mode from an ambiguous state.

- [ ] Change the phase and both runtime paths together, then redeploy. Active startup must re-run attestation, SQLite integrity/foreign keys, evidence reconciliation, and successful rehearsal-state checks before opening the database:

  ```dotenv
  RESTORE_REHEARSAL_PHASE=active
  DATABASE_PATH=/app/data/restore-<backup-id>/pint-path.sqlite
  SOURCE_EVIDENCE_STORAGE_DIR=/app/data/restore-<backup-id>/source-evidence
  ```
- [ ] Confirm anonymous access to every restored page is denied while `/health` and `/ready` remain available to Railway. After the first valid Basic-authentication request, confirm the short-lived Secure/HttpOnly/SameSite=Strict access cookie works in Safari without repeatedly sending a Basic header. Confirm all responses carry `X-Robots-Tag: noindex, nofollow, noarchive` and `Cache-Control: no-store`.
- [ ] Exercise only the four allowlisted read endpoints: `/api/business/config`, `/api/business/access`, `/api/business/venues`, and `/api/business/price-records`. Confirm map/list prices render from the local restored SQLite copy. Prove every other `/api` path, every mixed-case API prefix, every API `HEAD`, and every mutation returns `503`; browser Supabase configuration is blank; background retention/mission/report jobs do not start; external provider writes are disabled; and public `/ready` exposes only boolean verification state (never backup IDs, hashes, counts, object paths, or credentials) while confirming the restore-staging Supabase read probe and matching staging Redis identity. Keep the detailed backup/attestation/database hashes only in the access-restricted operator evidence. Do not test restored user credentials, admin actions, claims, reports, or private-account flows in this rehearsal.
- [ ] Confirm Railway still shows exactly one Beer replica and capture sanitized evidence plus actual RPO/RTO. Remove staging public networking, prove the rehearsal URL is no longer reachable, and stop Beer. Keep the exact staging Redis service online only for namespace cleanup in item 1; perform all cleanup from its own console, never from an absent stopped-Beer console. Operate only against recorded IDs, in this order:

  1. In the exact staging Redis service console, require `RAILWAY_ENVIRONMENT_ID=a4e0f507-d6d3-4df9-a818-ad92c0071a35`, `RAILWAY_SERVICE_ID=d6351cec-fe04-4a6f-8e05-1cc164ea1e73`, `REDISHOST=redis.railway.internal`, `REDISPORT=6379`, and authenticated `REDISPASSWORD`. Re-enter the recorded backup ID and construct only `pint-path:restore:$RAILWAY_ENVIRONMENT_ID:$BACKUP_ID`. Use `REDISCLI_AUTH="$REDISPASSWORD" redis-cli` with bounded `SCAN`; store matched names only in a mode-`600` temporary file, reject every returned name that is outside the exact prefix, issue one `UNLINK` per validated name, rescan, require aggregate zero, and delete the temporary file. Do not print names. `FLUSHALL`, `FLUSHDB`, `KEYS *`, and wildcard deletion outside this exact namespace are forbidden. If any ID, namespace, host, authentication, or prefix check differs, abort without deleting.
  2. Remove only this reviewed staging variable/reference allowlist: `RESTORE_REHEARSAL_ACCESS_PASSWORD`, `RESTORE_REHEARSAL_ACCESS_USERNAME`, `RESTORE_REHEARSAL_PHASE`, `RESTORE_REHEARSAL_BACKUP_ID`, `RESTORE_REHEARSAL_SOURCE_MANIFEST_SHA256`, `RESTORE_REHEARSAL_RUNTIME_ATTESTATION_SHA256`, `RESTORE_REHEARSAL_PRODUCTION_SUPABASE_URL`, `RESTORE_REHEARSAL_BACKUP_SUPABASE_URL`, `RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID`, `RESTORE_REHEARSAL_REDIS_SERVICE_ID`, `RESTORE_REHEARSAL_REDIS_SENTINEL`, `RESTORE_REHEARSAL_MODE`, `REDIS_KEY_NAMESPACE`, `DATABASE_PATH`, `SOURCE_EVIDENCE_STORAGE_DIR`, `SOURCE_EVIDENCE_SIGNING_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_OAUTH_PROVIDERS`. Remove `RESTORE_REHEARSAL_IDENTITY_SENTINEL` from the exact staging Redis service. Do not bulk-clear either service's environment.
  3. Revoke the exact temporary Supabase secret-key ID recorded at creation, delete its exact local key file, and delete the exact one-shot restore project ref. Project deletion is the purge boundary for its private bucket and database; verify that exact ref is no longer listed and cannot be linked. Do not delete or rotate anything in production or the independent backup project. If a project is ever retained instead, first enumerate the exact attested object set, delete only that set, verify the bucket has zero objects, revoke every restore key, and prove the project is credential-free. Regardless of deletion or retention, run `supabase unlink` and require `supabase/.temp/project-ref` to be absent before continuing.
  4. Delete the exact recorded staging Beer volume ID, record the deletion request timestamp and Railway's scheduled-destruction timestamp, and verify the service has no volume attached. Railway may retain a recoverable deleted volume for up to 48 hours; after that window, complete a follow-up proving the exact volume can no longer be restored.
  5. Compare the post-teardown production baseline with the pre-rehearsal evidence: exact production deployment, volume, domains, Supabase ref, independent-backup ref/key identity, and Redis service must be unchanged. These checks are read-only. Remove local restored material only under the approved retention/incident procedure.

  A second verifier must review every exact ID and aggregate zero-count before signing teardown.
- [ ] Record actual backup age/RPO, restore duration/RTO, rollback target, incident owner, escalation path, and two-person approval.

**Pass:** Backup verification and restore rehearsal exit `0`; functional checks pass; deletion safety passes; production data is untouched; actual RPO/RTO are accepted by the incident owner and second verifier.

**Evidence:** Backup ID; sanitized backup-creation, SDK-download, verification, and staging JSON; manifest SHA-256; restore result; staging functional sheet and job-state screenshot; purge record; measured RPO/RTO; rollback target; and two-person sign-off. Do not retain object-path listings or raw object-level debug output.

## 10. `accessibility_devices`

**Owner:** Accessibility QA lead. **Verifier:** Release owner.

- [ ] Record release SHA/URL, tester, physical devices, OS/browser versions, VoiceOver/TalkBack versions, text size, and zoom.
- [ ] Prepare logged-out, member/contributor, venue-Free-manager, and admin accounts using synthetic data.
- [ ] Keyboard-test `/`, `/pricing.html`, `/account.html`, `/submit.html`, `/venue-portal.html`, and `/admin.html` at 100% and 200% zoom.
- [ ] Verify skip links, logical Tab/Shift-Tab order, visible focus, Enter/Space activation, Escape behavior, dialog focus containment/return, no keyboard trap, and no pointer-only required action.
- [ ] With VoiceOver or NVDA, test account creation/login, validation errors,
  password controls, OAuth cancellation, settings tabs, destructive
  confirmations, map/list details, submissions, Free venue portal forms, and
  admin review states.
- [ ] On a physical iPhone, test Safari at default and large text with VoiceOver, including location allow/approximate/deny/no-fix, source-photo/camera input, auth returns, and venue tools.
- [ ] On a physical Android phone, test Chrome at default and large font/display size with TalkBack across the same flows.
- [ ] Run a formal axe scan on every public route and representative authenticated state above. Preserve the tool/version and results; require zero critical or serious violation and manually review anything the engine cannot decide.
- [ ] Test source-photo selection and location permission allowed, denied, and
  unsupported states. Prove no QR/member-code/counter control appears.
- [ ] Confirm no lost content, horizontal document overflow, clipped controls, unreadable contrast, or unresolved control-size exception.
- [ ] Log every matrix row and defect, retest fixes on the same candidate, and obtain sign-off.

**Pass:** Every required role/route/device row passes, critical flows work without a mouse, errors/state changes are announced, and no critical/high accessibility defect remains.

**Evidence:** Completed matrix, device/version inventory, keyboard/zoom screenshots, short screen-reader recordings, permission results, defect disposition, SHA, and signed approval.

## 11. `legal_billing`

**Owners:** Company/product owner, Australian legal/privacy reviewer, and finance/accounting owner.

- [ ] Freeze the deployed Privacy, Terms, Pricing, Support, export/deletion flows, rewards wording, and store metadata for review.
- [ ] Finalize legal entity/trading name, ABN/ACN if applicable, address requirements, privacy/support contacts, response windows, governing law, escalation, and dispute contacts.
- [ ] Reconcile the privacy policy with actual account data, evidence photos/PDFs, exact upload location, optional analytics, reports, support records, security logs, billing state, processors/regions, retention, export, deletion, and backups.
- [ ] Review 18+ eligibility, responsible-service/RSA language, changing price/availability disclaimers, community submissions, Pint Points/rewards, venue obligations, suspension, liability, and content ownership/licensing.
- [ ] Prove a sacrificial deletion removes its raw submission rows, item/free
  text, contribution ledger, evidence links, and every public price record whose
  source is that submission. Search the live database/export/cache by the old
  account ID, submission IDs, email, and unique test text. A future retained
  publisher-curated fact requires a separate fully de-linked ingestion path and
  written privacy/legal plus App Review approval in a new candidate.
- [ ] For this pricing-deferred release, prove
  `COMMERCIAL_LAUNCH_ENABLED=false` and
  `CONSUMER_PAID_ENROLLMENT_ENABLED=false`, no Stripe secret or price ID is
  required, no checkout/trial/upgrade action is reachable, and no dormant amount
  is advertised as a current offer. Record the owner/finance decision that no
  charge, trial, renewal, tax invoice, refund, or paid entitlement starts in
  this release. Do not enable a flag or make a live charge to complete evidence.
- [ ] Keep the future billing contract pending outside this release. Before a
  later commercial candidate, confirm every price/GST/renewal/cancellation/
  refund rule, run signed Stripe test-mode lifecycle and delayed-webhook tests,
  then perform the separately approved smallest-value live canary. Those future
  checks do not block this free launch while both flags remain false.
- [ ] Record that the submitted iOS binary has no subscription, billing-portal,
  upgrade, or external-purchase surface. Review Apple/Google payment-policy
  implications before a future commercial/native candidate.
- [ ] Reconcile App Store privacy answers with the final public policy and actual production processors. Play Data Safety belongs to a future Android release.
- [ ] Remove or formally resolve every placeholder/TBD, publish versioned final policies, and verify all website/store links.
- [ ] Obtain dated approval from the accountable owner, legal/privacy reviewer, and finance/accounting reviewer.

**Pass:** Published wording matches production behavior; entity/contact and
retained-content decisions are final; the documented free/deferred-billing state
matches both flags and every public surface; mobile declarations reconcile; all
three responsible owners sign.

**Evidence:** Signed legal/privacy memo, retained-content decision, finance
deferral record, disabled-flag/public-surface proof, policy versions/hashes, live
links/screenshots, processor/retention inventory, and dated approvals. No live
Stripe charge is evidence for this release.

## 12. `ios_release`

**Owners:** Apple Account Holder/App Manager, iOS release engineer, QA lead, and release owner.

- [ ] Record the native source SHA and confirm the required Native Apps `ios` job is green for it. Android is informational and outside this launch scope.
- [ ] Confirm App Store Connect bundle ID `au.pintpath.app`, version/build uniqueness, Apple team, distribution certificate, and provisioning profile.
- [ ] Confirm active Apple Developer Program membership, working Account Holder
  2FA, a backup App Manager, correct app-record/team ownership, matching legal
  seller/entity, the current Developer Program/free-app agreement, and no
  unresolved compliance-review state that blocks upload, TestFlight, review, or
  release. Paid-app, tax, and banking agreements are required only if a paid app
  or IAP is introduced. Capture sanitized account-status evidence.
- [ ] Supply production Supabase public configuration without embedding a private key. The first-release iOS app is email/password only: prove its archive contains no custom URL scheme or native Google/Apple login, then test the exact HTTPS web callback used for email confirmation/password recovery and the return-to-app sign-in flow.
- [ ] Complete name, subtitle, description, category, keywords, age/alcohol rating, support/marketing/privacy/terms/deletion URLs, review contact, export compliance, and content-rights answers.
- [ ] Reconcile `PrivacyInfo.xcprivacy` and App Store privacy answers with actual production behavior.
- [ ] Confirm the archive contains no Sign in with Apple entitlement, native social-login path, StoreKit code, subscription management, upgrade call-to-action, or external purchase link.
- [ ] Validate icon and launch appearance on supported small and large physical iPhones.
- [ ] Create a signed Release archive from the recorded SHA and run Organizer validation. Export a signed IPA with Organizer or `xcodebuild -exportArchive` using a private `ExportOptions.plist`, scan/hash that exact export, resolve all errors/material warnings, then upload the validated build. Record the archive and IPA SHA-256 values without committing signing material.
- [ ] Scan the signed archive/exported IPA for private keys, service-role secrets, signing passwords, live bearer tokens, unexpected endpoints, and debug configuration before upload; store only a sanitized result.
- [ ] Capture every required screenshot class using synthetic or approved data.
- [ ] Provide sanitized reviewer credentials and instructions for member, contributor, and assigned venue-Free manager paths. Do not describe counter/admin, Pro, trial, billing, or reward tooling as iOS features.
- [ ] Install the processed TestFlight build and run email-authentication, role, permission, photo/location, accessibility, offline/interruption, export/deletion, and device checks on the minimum supported iOS 17 release and the current production iOS release.
- [ ] On both iOS versions, uninstall/reinstall and perform an encrypted device backup/restore or device-transfer rehearsal. Prove protected sessions/tokens are not restored into an unauthorized usable session and normal reauthentication works.
- [ ] Before a broad/full-scale release, select a privacy-reviewed production
  crash source with dSYM symbolication and primary/backup alert delivery; tag
  environment, version, build, and candidate SHA and scrub email, token,
  location, and submission content. Supplement it with TestFlight/App Store
  Connect diagnostics and Xcode Organizer. For a controlled cohort only,
  Apple-native reports may be manually reviewed while the sample grows. Require
  zero reproducible critical crashes and at least 99.5% crash-free sessions
  across seven days and 500 sessions before broad expansion; with a smaller
  sample, remain controlled. Reconcile any processor/SDK with the privacy
  manifest, App Privacy answers, public policy, retention, and provider list.

**Pass:** The signed TestFlight build maps to the approved source SHA/version, validation is clear, metadata/privacy answers and screenshots are approved, the signed-device matrix passes, and no critical/high issue remains.

**Evidence:** App Store Connect build link, SHA/version mapping, artifact hashes, non-secret signing summary, validation result, privacy-answer export, screenshot inventory, TestFlight report, device matrix, and go/no-go approval.

This evidence item approves a signed TestFlight candidate. It does **not** prove public App Store approval. If iOS is part of the public launch, App Review approval, release availability, storefront checks, and the selected phased/manual release state are an additional final no-go condition.

## Final closeout

- [ ] Confirm all 12 objects in `docs/release-evidence.json` are `pass`, bound to the one frozen release ID/candidate SHA, and contain the exact gate reference, private-manifest SHA-256, ISO-8601 timestamp, and named verifier/role. Confirm the public and role proofs are less than 24 hours old.
- [ ] Run:

  ```bash
  npm run --silent release:evidence | tee "$EVIDENCE_DIR/release-evidence.json"
  jq -e . "$EVIDENCE_DIR/release-evidence.json"
  npm run --silent release:evidence:strict | tee "$EVIDENCE_DIR/release-evidence-strict.json"
  jq -e . "$EVIDENCE_DIR/release-evidence-strict.json"
  ```

- [ ] Commit the evidence-only closeout and push it. Refresh and bind the shell to the immutable final commit:

  ```bash
  git fetch origin main
  export RELEASE_SHA="$(git rev-parse origin/main)"
  export EVIDENCE_DIR="${PINTPATH_EVIDENCE_DIR:-$HOME/.pintpath/launch-evidence/$RELEASE_SHA}"
  umask 077
  mkdir -p "$EVIDENCE_DIR"
  chmod 700 "$EVIDENCE_DIR"
  test "$RELEASE_SHA" = "$(git rev-parse HEAD)"
  test "$(git status --porcelain)" = ""
  ```

- [ ] Wait for CI and automated readiness, then manually dispatch **Native Apps** from the final `main` SHA so the protected production-configuration iOS archive runs. Leave Android maintenance CI disabled because Android is outside this launch:

  ```bash
  gh workflow run native-apps.yml --ref main -f run_android=false
  sleep 5
  NATIVE_RUN_ID="$(gh run list --workflow native-apps.yml --branch main \
    --event workflow_dispatch --limit 20 --json databaseId,headSha \
    | jq -er --arg sha "$RELEASE_SHA" 'map(select(.headSha == $sha)) | first | .databaseId')"
  gh run watch "$NATIVE_RUN_ID" --exit-status
  test "$(gh run view "$NATIVE_RUN_ID" --json headSha --jq .headSha)" = "$RELEASE_SHA"
  ```

  Record the run ID/URL and require the `ios` and protected
  `ios-production-configuration` jobs to pass; the Android job must be skipped
  for this dispatch. If the run has not appeared after five seconds, retry the
  `gh run list` lookup; never substitute a run for another SHA.
- [ ] Confirm the final `main` SHA is deployed and `/ready` reports it.
- [ ] Re-run public and strict role smoke against that final deployed SHA.
- [ ] Manually dispatch **Pint Path Release Gate** against the production GitHub environment and bind its result to the same SHA:

  ```bash
  gh workflow run pintpath-release-gate.yml --ref main
  sleep 5
  RELEASE_GATE_RUN_ID="$(gh run list --workflow pintpath-release-gate.yml --branch main \
    --event workflow_dispatch --limit 20 --json databaseId,headSha \
    | jq -er --arg sha "$RELEASE_SHA" 'map(select(.headSha == $sha)) | first | .databaseId')"
  gh run watch "$RELEASE_GATE_RUN_ID" --exit-status
  test "$(gh run view "$RELEASE_GATE_RUN_ID" --json headSha --jq .headSha)" = "$RELEASE_SHA"
  ```

  Record the run ID/URL. Retry only the lookup if Actions has not indexed the new run yet.
- [ ] Download the `pintpath-production-release-gate` artifact and confirm its provider-readiness JSON, authenticated-smoke JSON, strict release-evidence JSON, and tested-SHA file all match the final commit.
- [ ] In the release-gate job itself, separately confirm the security-scan and dependency-audit steps passed. Those results are step logs/statuses and are not files in the artifact.
- [ ] Record the final go/no-go decision, launch owner, rollback target, support escalation, and first-72-hour coverage in the private evidence register.

Broad launch remains **no-go** if any required item is pending/failed, the strict
command fails, the final-SHA Native Apps dispatch or manual release gate fails,
the immutable-backup/JWT/submission-deletion/account-bridge/Apple-account/crash gates are not
proved, a critical/high defect is open, either commercial flag is true, or the
release owner cannot provide the evidence pack. Public native launch additionally
remains no-go until App Store review and the intended storefront release are
live; TestFlight evidence alone authorizes only controlled beta distribution.
