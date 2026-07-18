# External launch evidence checklist

This is the executable checklist for the 12 required items in `docs/release-evidence.json`. Repository tests prove code and synthetic contracts; these checks prove the deployed providers, physical devices, real venue operations, legal decisions, backups, and store builds.

Do not mark an item `pass` because its code exists or a local test passed. Mark it `pass` only after every step and pass criterion below is satisfied.

## Common setup for one release candidate

- [ ] Name one release owner with authority to stop the launch.
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

- [ ] Confirm CI, automated readiness, and Native Apps are green for that commit.
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
  "nextAction": "Enable and prove report email delivery and scheduling, then capture the complete public/provider, performance, load, security-header, and alert exercise against one frozen production SHA.",
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

Keep the final evidence update as one closeout commit that changes only `docs/release-evidence.json`. If signed mobile builds were created from its parent candidate, record both SHAs in the private register. The manual production gate must still run against the final deployed `main` SHA, and **Native Apps** must be manually dispatched for that final SHA because documentation-only pushes do not match its path filters.

## Recommended order

1. Preliminary privacy/data-processing/content-rights approval.
2. Production public smoke and providers.
3. Production role and authentication smoke.
4. Labelled OCR corpus.
5. Venue pilots one, two, and three.
6. POS vendor adapter or manual fallback pilot.
7. Backup restore rehearsal.
8. Accessibility and physical-device matrix.
9. Final legal and billing approval.
10. iOS TestFlight approval.
11. Android internal-track approval.
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
- [ ] In Supabase, verify the production Site URL and exact web/mobile redirect allow list, Google and Apple provider callbacks, email confirmation, leaked-password protection, admin MFA/AAL2, a supported Postgres version, intentional Data API grants, and RLS on every exposed table. Use the current [redirect URL](https://supabase.com/docs/guides/auth/redirect-urls), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), and [Data API security](https://supabase.com/docs/guides/api/securing-your-api) guidance.
- [ ] Confirm `beermap-source-evidence` is private and both `anon` and ordinary `authenticated` clients are denied list, download, upload, update, and delete. Prove only the authorized server API/admin signed-URL paths work. The service key must not appear in `/config.js`, browser requests, logs, or evidence.
- [ ] Confirm the independent backup Supabase URL is a different origin, and both `anon` and `authenticated` clients are denied every operation on `pintpath-backups`. The actual restore proof is item 8.
- [ ] Confirm browser Maps and server Places keys have API-level restrictions, approved origin/service restrictions, quotas, and budget alerts; the production vector Map ID must render live markers. Apply equivalent least-privilege quotas/alerts to OpenAI where the provider supports them.
- [ ] Confirm Redis is configured for normal production. In isolated staging, set `REQUIRE_REDIS_RATE_LIMITING=true`, confirm `/ready` reports `rateLimiterRedis.required=true`, and use two app instances to prove the third request against a limit of two is rejected across replicas. Then interrupt only staging Redis and prove readiness plus protected traffic return `503` rather than silently switching to process memory. Restore the exact staging Redis reference and confirm recovery; never run the outage drill against production.
- [ ] Confirm OpenAI, Google, Stripe, Supabase, POS, backup, and report-email secrets remain server-side.
- [ ] Confirm TLS, HSTS/security headers, secure/HttpOnly/SameSite cookies, CSP, CORS, mixed-content blocking, and public cache headers on the deployed site. Run DAST only against staging/preview, never broad production traffic, and resolve all critical/high findings.
- [ ] Run Lighthouse or WebPageTest on `/`, `/pricing.html`, `/venue-portal.html`, and `/account.html` on mobile and desktop. Require 85+ performance on public landing/pricing, 95+ accessibility/SEO on public pages, 90+ accessibility on authenticated tools, no initial blocking console error, and no document overflow at 390px, 768px, or desktop.
- [ ] Run a read-only staging load test across map venues/prices/missions and authenticated admin queues. Record tool/version/workload and require zero authorization/data-isolation failures, less than 1% 5xx, public API p95 below 2 seconds, and admin p95 below 3 seconds at the agreed beta concurrency.
- [ ] Confirm named alerts and escalation for `/health`, `/ready`, 5xx, deployment failure, Redis failure, Stripe webhook failure, login/rate-limit spikes, database/volume size, backup age, and scheduled job failure. Trigger each safely in staging and preserve delivery/acknowledgement evidence.

**Pass:** The exact SHA is deployed; public smoke exits `0`; its JSON parses; provider readiness has no failures/blocking warnings; provider access, distributed limiting, private Storage, TLS/browser security, performance, load, secret exposure, monitoring, and staging DAST checks all pass with no unresolved critical/high finding.

**Evidence:** Public-smoke JSON, provider-readiness JSON, deployed SHA, sanitized provider screenshots, key-restriction screenshots, Storage/RLS results, monitor test alert, timestamp, and verifier.

## 2. `production_role_smoke`

**Owner:** Release engineer and identity owner. **Verifier:** Security or admin owner.

- [ ] Create dedicated verified ordinary-user, second ordinary-user, venue-manager, counter-staff, and admin smoke accounts. Assign the manager only to intended test venues, accept the counter invitation, and require a current MFA/AAL2 admin session.
- [ ] Configure production [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), SPF/DKIM/DMARC, sender domain, bounce/delivery monitoring, and safe Auth email rate limits. Prove confirmation and password-reset delivery to non-team addresses; the default Supabase SMTP is not production evidence.
- [ ] Test email/password signup, email confirmation, password reset, Google sign-in, and Apple sign-in through their normal production redirects. For every provider test success, cancellation, provider error, stale/replayed callback, and interrupted return.
- [ ] Assign an owner and recurring six-month rotation date for the Apple OAuth secret as required by the current [Supabase Apple OAuth guidance](https://supabase.com/docs/guides/auth/social-login/auth-apple). Rotate once in staging and retest web, iOS, and Android sign-in before production rotation.
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
- [ ] In real browsers, prove logged-out users receive only the fixed free price preview, entitled users receive the intended full set, a normal user cannot load admin/venue-private data, one manager cannot access an unauthorized venue, counter staff see redemption tools only, and the MFA admin can access queues.
- [ ] As a contributor, submit a price and private photo; prove the second user cannot see raw submission/evidence; approve as admin; then prove the normalized price publishes and points are awarded only after approval.
- [ ] As the assigned manager, prove ordinary profile, beer, and happy-hour edits follow the documented direct-publish path, while restricted fields and safeguard-triggered changes remain queued for admin review.
- [ ] Prove privacy-thresholded analytics suppress low-count buckets and never expose another venue or individual activity.
- [ ] Accept and revoke a counter invitation; prove access begins only after acceptance and stops after revocation.
- [ ] Across two devices, prove password reset, current-device logout, logout-all, session listing/revocation, export, deletion request/status/cancel, and recent-auth requirements behave as documented. Export must include retained exact location fields but no raw evidence bytes/URLs, tokens, or passwords.
- [ ] Require zero unexpected browser console errors or failed network requests in the completed role journeys.
- [ ] Configure the Resend domain, sending-only key, sender, and monitored reply path. Use an active Pro venue, completed report month, enabled delivery, and current email-verified/age-confirmed manager. Require `deliveredCount=1`, zero rejected/uncertain/in-progress sends, a Resend delivered event, and no delivery to counter staff, revoked managers, or other venues. Confirm `job:monthly_report_delivery` succeeds.
- [ ] Confirm the hourly authenticated job creates and revokes disposable user/venue sessions and that its JSON has both `*_session_cleanup` and `*_provider_session_cleanup` checks passing. Rotate the dedicated account passwords under the credential policy, not on the old bearer-token expiry schedule. Create a fresh MFA/AAL2 admin token for each manual gate; the gate sets `PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS=true` and must show `admin_queues_session_cleanup` passing.
- [ ] Unset local credential/token variables and securely delete temporary token files when the capture is complete:

  ```bash
  unset PINTPATH_SMOKE_USER_EMAIL PINTPATH_SMOKE_USER_PASSWORD
  unset PINTPATH_SMOKE_VENUE_EMAIL PINTPATH_SMOKE_VENUE_PASSWORD
  unset PINTPATH_SMOKE_ADMIN_TOKEN PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS
  find "$EVIDENCE_DIR" -maxdepth 1 -type f \
    \( -name 'supabase-*.token' -o -name 'pintpath-*.token' \) -delete
  ```

**Pass:** Custom Auth email delivery and every provider/callback work; strict role-smoke JSON passes; the deployed user/contributor/manager/counter/admin journeys, isolation, entitlements, MFA, analytics privacy, session/privacy flows, token rotation, and targeted report delivery all pass with no unexpected console/network error.

**Evidence:** Role-smoke JSON or `pintpath-production-release-gate` artifact, provider-flow matrix, redacted isolation screenshots, report delivery ID/job state, SHA, timestamp, and verifier.

## 3. `ocr_labelled_corpus`

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

## 4–6. `venue_pilot_one`, `venue_pilot_two`, `venue_pilot_three`

**Owner:** Pilot lead. **Verifier:** The owner/manager of each participating venue.

Select three genuinely different venues by size, menu format, staff turnover, device mix, and network quality. A simulation does not count. Repeat every step below independently for each evidence ID.

### Before the shift

- [ ] The owner submits a claim through `/venue-portal.html` with a verified account.
- [ ] Admin independently verifies the owner through a trusted venue phone, email, or partner contact and approves the claim.
- [ ] Owner adds at least two counter staff by public Pint Path account ID.
- [ ] Prove the owner can manage profile, beers, prices, happy hours, and staff, while counter staff can access only redemption tools.
- [ ] Record devices, browsers/app versions, roles, network conditions, start time, and redacted test references.

### During a real shift

- [ ] Test QR scan and six-character member-code entry.
- [ ] Record at least five paid drinks across two staff accounts.
- [ ] Replay one transaction reference and prove no duplicate points are awarded.
- [ ] Disable the network after member preview, submit a receipt, restore connectivity, and retry the queued receipt.
- [ ] Enter one wrong drink and reverse it. Prove staff can reverse only their own entry within 15 minutes and the manager can correct it later.
- [ ] Revoke one counter account and prove access stops.
- [ ] Reconcile customer, counter, owner, and admin totals after reversals.

### Immediate stop conditions

Stop and mark the item `fail` if an unauthorized venue is visible, a member code is stored offline, a retry awards duplicate points, a reversal deletes history, counter staff see billing/POS credentials/analytics, or public data changes outside the intended publish/review path. A legitimately assigned multi-venue owner may see each authorized venue.

**Pass:** Every step passes during a real shift, totals reconcile, no stop condition occurs, defects are closed and retested, and the venue owner signs.

**Evidence:** One pack per venue with date/duration, venue characteristics, devices, roles, redacted references, step results, defects/retests, reconciliation, and venue-owner sign-off.

## 7. `pos_vendor_pilot`

**Owner:** Integration lead. **Verifier:** Venue owner and, for an adapter, vendor representative.

- [ ] Record one explicit launch choice: a named POS vendor adapter or the supported manual manager-portal fallback.

### Vendor adapter path

- [ ] Rotate the venue-scoped POS token and place it only in the vendor's protected secret store.
- [ ] Send the documented payload to `POST /api/business/pos/discount-redemptions` with `X-Pint-Path-POS-Token`.
- [ ] Keep `posReference` stable across retries.
- [ ] Prove first submission succeeds and returns `pointsEarned: 0`; exact replay returns success without a second discount redemption or duplicated savings. This endpoint does not award Pint Points—the separate verified-purchase flow does.
- [ ] Prove 4xx waits for staff correction. Test 5xx/network backoff through staging fault injection or adapter-side network loss, never by deliberately breaking production, and retry the same `posReference`.
- [ ] Prove a rotated token works immediately, the previous token works only until the returned `previousTokenValidUntil` (10-minute handover), then returns `401`; neither token may access another venue.
- [ ] Confirm the payload contains no name, email, phone, payment-card data, or full receipt.
- [ ] Reconcile POS references, Pint Path activity, and reversals at shift close.

### Manual fallback path

- [ ] During a real shift, run the QR/code, two-staff, five-drink, duplicate-reference, offline retry, reversal, revocation, role-scope, and reconciliation steps from a venue pilot.
- [ ] State explicitly that manual counter entry is the selected launch mode; do not describe a vendor adapter as complete.

**Pass:** One selected path works at a real venue with no secret/PII leak, duplicate discount redemption/savings, role breach, or reconciliation mismatch, and the venue owner signs. Pint Points are claimed only when the separate verified-purchase flow is also completed.

**Evidence:** Selected-mode decision, redacted request/response or manual-flow records, retry/idempotency proof, token-rotation proof if applicable, reconciliation, venue/vendor sign-off, and timestamp.

## 8. `backup_restore`

**Owner:** Operations/SRE lead. **Verifier:** Second operator and named incident owner.

- [ ] Confirm `OFFSITE_BACKUP_SUPABASE_URL` is a genuinely independent origin and `pintpath-backups` is private with no anonymous/authenticated object policies.
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
      --output="$REHEARSAL_ROOT" \
    | tee "$EVIDENCE_DIR/offsite-restore-rehearsal.json"
  jq -e '.ok == true' "$EVIDENCE_DIR/offsite-restore-rehearsal.json"
  ```

- [ ] Confirm SQLite integrity and foreign keys, database/evidence checksums, MIME/reference reconciliation, current independent deletion-ledger authority, and tombstoned PII/evidence purge all pass.
- [ ] Create a separate access-restricted staging Supabase project, apply the full current migration chain, and confirm its empty `beermap-source-evidence` bucket is private with no direct `anon`/`authenticated` policies. Stage the restored object tree with the repository helper; it requires an empty bucket, preserves the original object paths and manifest MIME types, and redownloads every object for checksum/MIME verification:

  ```bash
  export STAGING_SUPABASE_SECRET_KEY_FILE="${STAGING_SUPABASE_SECRET_KEY_FILE:?}"
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
  ```

- [ ] Configure an access-restricted staging app with `DATABASE_PATH=$REHEARSAL_ROOT/pint-path.sqlite` and that separate staging project's Supabase URL/keys. Keep email, billing, report delivery, and other external writes disabled. Verify `/ready`, login, map prices, private image and PDF evidence review, the orphan report, deletion-tombstone counts, and the staging Admin `job:restore_rehearsal` success state. Never point staging at the live volume or production Storage project.
- [ ] Redownload the staged bucket to a second new directory or use the helper's verified manifest, compare relative-path SHA-256 values, then purge the restored staging project/bucket and local backup material under the approved retention/incident procedure. Delete the rehearsal-only temporary independent-project secret key and its local key file; confirm the long-lived Railway production backup key remains active and unchanged.
- [ ] Record actual backup age/RPO, restore duration/RTO, rollback target, incident owner, escalation path, and two-person approval.

**Pass:** Backup verification and restore rehearsal exit `0`; functional checks pass; deletion safety passes; production data is untouched; actual RPO/RTO are accepted by the incident owner and second verifier.

**Evidence:** Backup ID; sanitized backup-creation, SDK-download, verification, and staging JSON; manifest SHA-256; restore result; staging functional sheet and job-state screenshot; purge record; measured RPO/RTO; rollback target; and two-person sign-off. Do not retain object-path listings or raw object-level debug output.

## 9. `accessibility_devices`

**Owner:** Accessibility QA lead. **Verifier:** Release owner.

- [ ] Record release SHA/URL, tester, physical devices, OS/browser versions, VoiceOver/TalkBack versions, text size, and zoom.
- [ ] Prepare logged-out, member/contributor, counter-staff, venue-manager, and admin accounts using synthetic data.
- [ ] Keyboard-test `/`, `/pricing.html`, `/account.html`, `/submit.html`, `/venue-portal.html`, and `/admin.html` at 100% and 200% zoom.
- [ ] Verify skip links, logical Tab/Shift-Tab order, visible focus, Enter/Space activation, Escape behavior, dialog focus containment/return, no keyboard trap, and no pointer-only required action.
- [ ] With VoiceOver or NVDA, test account creation/login, validation errors, password controls, OAuth cancellation, settings tabs, destructive confirmations, map/list details, submissions, portal forms, counter actions, and admin review states.
- [ ] On a physical iPhone, test Safari at default and large text with VoiceOver, including location allow/approximate/deny/no-fix, source-photo/camera input, auth returns, and venue tools.
- [ ] On a physical Android phone, test Chrome at default and large font/display size with TalkBack across the same flows.
- [ ] Run a formal axe scan on every public route and representative authenticated state above. Preserve the tool/version and results; require zero critical or serious violation and manually review anything the engine cannot decide.
- [ ] Test QR/camera permission allowed, denied, and unsupported states; manual code entry must remain usable.
- [ ] Confirm no lost content, horizontal document overflow, clipped controls, unreadable contrast, or unresolved control-size exception.
- [ ] Log every matrix row and defect, retest fixes on the same candidate, and obtain sign-off.

**Pass:** Every required role/route/device row passes, critical flows work without a mouse, errors/state changes are announced, and no critical/high accessibility defect remains.

**Evidence:** Completed matrix, device/version inventory, keyboard/zoom screenshots, short screen-reader recordings, permission results, defect disposition, SHA, and signed approval.

## 10. `legal_billing`

**Owners:** Company/product owner, Australian legal/privacy reviewer, and finance/accounting owner.

- [ ] Freeze the deployed Privacy, Terms, Pricing, Support, export/deletion flows, rewards wording, and store metadata for review.
- [ ] Finalize legal entity/trading name, ABN/ACN if applicable, address requirements, privacy/support contacts, response windows, governing law, escalation, and dispute contacts.
- [ ] Reconcile the privacy policy with actual account data, evidence photos/PDFs, exact upload location, optional analytics, reports, support records, security logs, billing state, processors/regions, retention, export, deletion, and backups.
- [ ] Review 18+ eligibility, responsible-service/RSA language, changing price/availability disclaimers, community submissions, Pint Points/rewards, venue obligations, suspension, liability, and content ownership/licensing.
- [ ] Confirm every consumer and venue price, billing period, entitlement, automatic renewal statement, cancellation path, paid-period end, failed-payment behavior, refund path, GST/tax invoice, and record-retention rule.
- [ ] In Stripe test mode, prove checkout, signed webhooks, duplicate/replayed events, subscription update/cancel, portal, failed payment, suspended-account recovery, refund/support, and account-deletion/billing race behavior. Verify invalid and stale signatures are rejected.
- [ ] Before opening paid production entry points, use the controlled live account to complete the smallest permitted real checkout, receive the live signed webhook, open the billing portal, cancel, refund immediately, and reconcile Stripe, Pint Path entitlement, receipt/tax records, and the refund. Use a company-controlled customer and venue, redact all identifiers, and obtain finance approval. Test-mode results do not prove live key, endpoint, tax, email, or bank configuration.
- [ ] Explicitly review Apple/Google payment-policy implications of web subscriptions and billing-portal access from native apps.
- [ ] Reconcile App Store privacy and Play Data Safety answers with the final public policy and actual production processors.
- [ ] Remove or formally resolve every placeholder/TBD, publish versioned final policies, and verify all website/store links.
- [ ] Obtain dated approval from the accountable owner, legal/privacy reviewer, and finance/accounting reviewer.

**Pass:** Published wording matches production behavior; entity/contact and billing decisions are final; provider flows pass; mobile declarations reconcile; all three responsible owners sign.

**Evidence:** Signed legal/privacy memo, finance decision log, policy versions/hashes, live links/screenshots, sanitized Stripe results, processor/retention inventory, and dated approvals.

## 11. `ios_release`

**Owners:** Apple Account Holder/App Manager, iOS release engineer, QA lead, and release owner.

- [ ] Record the native source SHA and confirm Native Apps CI is green for it.
- [ ] Confirm App Store Connect bundle ID `au.pintpath.beermap`, version/build uniqueness, Apple team, distribution certificate, and provisioning profile.
- [ ] Supply production Supabase public configuration without embedding a private key. Add `pintpath://auth-callback` to Supabase and complete Google/Apple provider-console configuration.
- [ ] Complete name, subtitle, description, category, keywords, age/alcohol rating, support/marketing/privacy/terms/deletion URLs, review contact, export compliance, and content-rights answers.
- [ ] Reconcile `PrivacyInfo.xcprivacy` and App Store privacy answers with actual production behavior.
- [ ] Confirm Sign in with Apple and external subscription access comply with the current App Review rules.
- [ ] Validate icon and launch appearance on supported small and large physical iPhones.
- [ ] Create a signed Release archive from the recorded SHA and run Organizer validation. Export a signed IPA with Organizer or `xcodebuild -exportArchive` using a private `ExportOptions.plist`, scan/hash that exact export, resolve all errors/material warnings, then upload the validated build. Record the archive and IPA SHA-256 values without committing signing material.
- [ ] Scan the signed archive/exported IPA for private keys, service-role secrets, signing passwords, live bearer tokens, unexpected endpoints, and debug configuration before upload; store only a sanitized result.
- [ ] Capture every required screenshot class using synthetic or approved data.
- [ ] Provide sanitized reviewer credentials and instructions for member, contributor, counter-staff, and venue-manager paths.
- [ ] Install the processed TestFlight build and run provider, role, permission, photo/location, accessibility, offline/interruption, export/deletion, and device checks on the minimum supported iOS 17 release and the current production iOS release.
- [ ] On both iOS versions, uninstall/reinstall and perform an encrypted device backup/restore or device-transfer rehearsal. Prove protected sessions/tokens are not restored into an unauthorized usable session and normal reauthentication works.
- [ ] Review crashes and sign-in failures, then assign support, rollback, phased-release, and first-72-hour owners.

**Pass:** The signed TestFlight build maps to the approved source SHA/version, validation is clear, metadata/privacy answers and screenshots are approved, the signed-device matrix passes, and no critical/high issue remains.

**Evidence:** App Store Connect build link, SHA/version mapping, artifact hashes, non-secret signing summary, validation result, privacy-answer export, screenshot inventory, TestFlight report, device matrix, and go/no-go approval.

This evidence item approves a signed TestFlight candidate. It does **not** prove public App Store approval. If iOS is part of the public launch, App Review approval, release availability, storefront checks, and the selected phased/manual release state are an additional final no-go condition.

## 12. `android_release`

**Owners:** Play Console owner, Android release engineer, QA lead, and release owner.

- [ ] Record the native source SHA and confirm Native Apps CI is green for it.
- [ ] Confirm Play package `au.pintpath.beermap` and a unique version code/name.
- [ ] Enrol in Play App Signing; generate, back up, and securely escrow the upload key. Record certificate fingerprints without committing key material.
- [ ] Supply production Supabase public configuration securely and verify `pintpath://auth-callback` plus provider-console settings.
- [ ] Run the unsigned source/CI gate from `apps/android`: `./gradlew --no-daemon lintDebug lintRelease testDebugUnitTest assembleDebug assembleRelease`.
- [ ] Follow the private zsh procedure in `apps/android/README.md`: provide the keystore path and alias through interactive prompts and both passwords through non-echoing prompts, keep the keystore outside the checkout, and run `./gradlew --no-daemon clean bundleRelease`. The task must fail when signing is absent or partial; never submit the unsigned CI APK.
- [ ] Verify `app/build/outputs/bundle/release/app-release.aab` with non-strict `jarsigner -verify -verbose -certs` and require `jar verified.`. Review every warning explicitly—a self-signed upload certificate can make `-strict` exit nonzero even when integrity is valid. Inspect the upload certificate with `keytool -printcert -jarfile`, match its validity/algorithms and SHA-256 fingerprint to Play, record `shasum -a 256`, verify package/version/configuration, and scan for embedded private secrets/debug values.
- [ ] Complete listing name/descriptions, category, icon/feature graphic, required device screenshots, 18+/alcohol framing, target audience, content rating, ads declaration, support/privacy/terms/deletion URLs, notes, and app-access instructions.
- [ ] Reconcile Play Data Safety with actual account, photo, location, optional analytics, billing, retention/deletion, encryption, sharing, and processor behavior.
- [ ] Confirm current target-SDK and device-policy compliance in Play Console.
- [ ] Upload to the internal track and install from Play rather than by sideloading.
- [ ] Run the complete role/provider/permission/photo/location/accessibility/offline matrix on physical devices, including minimum-supported and current Android versions.
- [ ] Run the Play pre-launch report and resolve all security, crash, ANR, accessibility, compatibility, and policy blockers.
- [ ] Verify device backup/transfer does not restore protected session preferences.
- [ ] Assign staged-rollout, rollback, support, crash/ANR monitoring, and first-72-hour owners.

**Pass:** The Play-delivered signed AAB maps to the approved source SHA/version, internal testing and the physical-device matrix pass, Data Safety/listing answers are approved, the pre-launch report has no blocker, and no critical/high issue remains.

**Evidence:** Play internal-release link, AAB SHA-256, SHA/version mapping, signing-certificate fingerprints, Data Safety export, listing/screenshot inventory, pre-launch report, tester/device matrix, and go/no-go approval.

This evidence item approves the Play internal-track candidate. It does **not** prove production-track approval. If Android is part of the public launch, Play review/production access, country/device availability, and the selected staged rollout state are an additional final no-go condition.

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

- [ ] Wait for CI and automated readiness, then manually dispatch **Native Apps** from the final `main` SHA; the workflow's path filters do not run it automatically for a documentation-only closeout:

  ```bash
  gh workflow run native-apps.yml --ref main
  sleep 5
  NATIVE_RUN_ID="$(gh run list --workflow native-apps.yml --branch main \
    --event workflow_dispatch --limit 20 --json databaseId,headSha \
    | jq -er --arg sha "$RELEASE_SHA" 'map(select(.headSha == $sha)) | first | .databaseId')"
  gh run watch "$NATIVE_RUN_ID" --exit-status
  test "$(gh run view "$NATIVE_RUN_ID" --json headSha --jq .headSha)" = "$RELEASE_SHA"
  ```

  Record the run ID/URL and require both Android and iOS jobs to pass. If the run has not appeared after five seconds, retry the `gh run list` lookup; never substitute a run for another SHA.
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

Broad launch remains **no-go** if any required item is pending/failed, the strict command fails, the final-SHA Native Apps dispatch or manual release gate fails, a critical/high defect is open, or the release owner cannot provide the evidence pack. Public native launch additionally remains no-go until the applicable App Store review and/or Play production-track approval is live; TestFlight and internal-track evidence alone authorizes only controlled beta distribution.
