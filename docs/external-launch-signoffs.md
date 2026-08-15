# External launch evidence checklist

This is the executable checklist for the 13 required items in `docs/release-evidence.json`. Repository tests prove code and synthetic contracts; these checks prove the deployed providers, physical devices, real venue operations, legal decisions, backups, the permanent-staging cost ceiling, and the signed iOS build.

Do not mark an item `pass` because its code exists or a local test passed. Mark it `pass` only after every step and pass criterion below is satisfied.

This is a Free-only web and iOS launch. Pricing, paid enrolment, venue Pro,
trials, report delivery, rewards, counter/POS tools, public happy-hour discovery,
and Android distribution are excluded. Any evidence that enables or advertises
one of those surfaces belongs to a different candidate and fails this release.

## Common setup for one release candidate

Record and mechanically compare three non-overlapping resource sets in the
private release register:

- **Permanent integrated staging:** stable Railway staging plus staging
  Postgres/Supabase, Auth, private Storage, Redis, provider credentials, domain,
  and callbacks. Use it for migration, two-replica concurrency, authentication,
  deletion, data repair, DAST, smoke, load, deploy, and rollback-build proof.
- **Ephemeral destructive restore staging:** newly created Railway,
  Postgres/Supabase, Storage, Redis namespace, credentials, domain, and callbacks
  used only for PITR/WORM restoration, RPO/RTO, and tombstone replay. Destroy it
  only after two-person evidence sign-off.
- **Production:** never receives restore-rehearsal writes and shares no secret,
  database path, service-role key, Redis namespace, or callback with either
  environment.

Cost scope follows the same separation. The permanent-staging receipt includes
only permanent-staging Railway, staging Supabase, and staging external-provider
resources/caps. The canonical-production operational copy uses a separate
production cost authority. Disposable restore resources use a separate
temporary-spend authority. Neither may be folded into the staging total or
used to hide an unknown, unpriced, shared, or unbounded staging resource.

Never restore production data into permanent integrated staging. Configure the
reviewed `RESTORE_REHEARSAL_EXPECTED_*` identity pins only after the disposable
restore resources have been created and recorded; the runtime identity must
match every pin and remain distinct from production and permanent staging.

- [ ] Name one release owner with authority to stop the launch.
- [ ] Complete the named private role/contact register and pass the tabletop gate in `docs/data-breach-response-runbook.md`; an untested template is not production evidence.
- [ ] Freeze the reviewed PR head, record it as `reviewedPrHeadSha`, and confirm
  ordinary CI, automated readiness, and the required Native Apps `ios` check are
  green for that exact commit. Android is informational and outside this launch scope.
- [ ] Follow Phase 16 of `docs/production-launch-runbook.md`: merge that exact
  head through protected `main`, authenticate the exact non-draft
  same-repository merged PR without treating a human review as release
  authority, require the GitHub merge commit and separately fetched
  reviewed-head trees to be identical, and record the current protected-main
  merge commit as both `candidateSha` and `deploymentSha`. A squash/rebase result
  need not descend from the PR head.
- [ ] Initialise one private working directory in every new operator shell:

  ```bash
  set -euo pipefail
  export RELEASE_ID="${PINTPATH_RELEASE_ID:?Set an immutable ID such as PP-LAUNCH-2026-001}"
  export RELEASE_PR_NUMBER="${PINTPATH_RELEASE_PR_NUMBER:?Load the associated merged PR number from the private release register}"
  export REVIEWED_PR_HEAD_SHA="${PINTPATH_REVIEWED_PR_HEAD_SHA:?Load the reviewed PR-head SHA from the private release register}"
  export CANDIDATE_SHA="${PINTPATH_CANDIDATE_SHA:?Load the protected-main candidate SHA from the private release register}"
  [[ "$RELEASE_PR_NUMBER" =~ ^[1-9][0-9]*$ ]]
  [[ "$REVIEWED_PR_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
  [[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
  export REVIEWED_PR_HEAD_REF="refs/pintpath/reviewed-pr-head/$CANDIDATE_SHA"
  git fetch --no-tags --no-recurse-submodules --force origin \
    +refs/heads/main:refs/remotes/origin/main \
    "+refs/pull/$RELEASE_PR_NUMBER/head:$REVIEWED_PR_HEAD_REF"
  test "$(gh pr view "$RELEASE_PR_NUMBER" --json state --jq .state)" = "MERGED"
  test "$(gh pr view "$RELEASE_PR_NUMBER" --json mergeCommit --jq .mergeCommit.oid)" = "$CANDIDATE_SHA"
  test "$(git rev-parse origin/main)" = "$CANDIDATE_SHA"
  test "$(git rev-parse "$REVIEWED_PR_HEAD_REF^{commit}")" = "$REVIEWED_PR_HEAD_SHA"
  git cat-file -e "$CANDIDATE_SHA^{commit}"
  export EVIDENCE_DIR="${PINTPATH_EVIDENCE_DIR:-$HOME/.pintpath/launch-evidence/$RELEASE_ID/$CANDIDATE_SHA}"
  umask 077
  mkdir -p "$EVIDENCE_DIR"
  chmod 700 "$EVIDENCE_DIR"
  test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
  test "$(git rev-parse "$REVIEWED_PR_HEAD_REF^{tree}")" = "$(git rev-parse "$CANDIDATE_SHA^{tree}")"
  test "$(git status --porcelain)" = ""
  npm ci --include=dev
  ```

- [ ] Before permanent-staging scale starts, require exactly two successful
  deployment runs for the same candidate: the initial deployment and the
  post-plan closeout redeploy. Require both complete and select the second run
  and artifact; zero, one, more than two, or ambiguous completion order fails.
- [ ] Start each guarded permanent-staging provider mutation, legacy cutover,
  and runtime-variable run through `github:reviewed-candidate-authority:verify`.
  Require complete authenticated history from the associated PR's `merged_at`
  through the authenticated current `run_started_at`, not its `created_at`,
  because retained queued runs can start out of creation order. That
  `run_started_at` must be no more than 168 hours after `merged_at`. Beyond seven
  days or with incomplete history, stop and create a newly reviewed and merged
  candidate. Provider/cutover redispatch is allowed only when every prior
  matching run's exact write step is authenticated with conclusion `skipped`. A general
  runtime-variable write is keyed by candidate+target+variable and permits no
  matching prior run, even one skipped before write.

- [ ] Create a private evidence register for the release. Do not commit tokens, customer identifiers, private menu files, POS secrets, signing keys, backup contents, or unredacted screenshots.
- [ ] Give the release an immutable ID such as `PP-LAUNCH-2026-001`. Before
  recording the first completed check, set `release.id`,
  `release.reviewedPrHeadSha`, and `release.candidateSha` in
  `docs/release-evidence.json`. Never change them to rescue stale evidence. The
  validator requires both commits to exist, their trees to match exactly, the
  protected-main candidate to remain an ancestor of `HEAD`, and only
  `docs/release-evidence.json` to differ in the evidence-closeout commit.
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
  jq -e --arg releaseId "$RELEASE_ID" --arg gateId "$GATE_ID" --arg sha "$CANDIDATE_SHA" --arg result "$GATE_RESULT" \
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

Change only `status`, `evidence`, `evidenceSha256`, `verifiedAt`, and `verifiedBy`; preserve the existing ID, label, owner, next action, and `required: true` value. The sole additional field that may change is `costReceipt` on `permanent_staging_cost`: it must remain `null` while that item is pending or failed and may become only the sanitized, validator-conforming object described in section 13 when that item passes. `evidence` must be exactly `<release.id>/<gate id>`, the digest must be the lowercase SHA-256 of the final private gate manifest, and `verifiedBy` must contain `Full name, role`. A pending item must keep all four ordinary proof fields—and the cost item's `costReceipt`—`null`; a completed failed check uses `status: "fail"` with the same durable proof fields but no cost receipt.

The stored `production_public_smoke` and `production_role_smoke` proofs expire
after 24 hours because live providers and access can change without a code
commit. Re-capture and independently verify both inside the final launch window.
The informational validator reports expired proof or code/dirty-worktree drift
as `evidenceCurrent: false`; the strict gate rejects it. Both modes reject future
timestamps, proof collected before the protected-main candidate commit,
unknown/non-ancestor protected-main candidates, reviewed-head tree mismatch,
unexpected schema fields, and required `not_applicable` gates. They deliberately
do not require `reviewedPrHeadSha` to be an ancestor of a squash/rebase candidate.

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
11. iOS external TestFlight/Beta App Review, full App Review approval, and
    manual-release readiness.
12. Fresh permanent-staging-only provider cost observation and independent
    verification for the frozen candidate.
13. Final evidence closeout and strict release gate.

The OCR corpus, accessibility review, legal review, and App Review approval work
can run in parallel after the production candidate is stable. Do not run venue
pilots before the role and provider checks pass.

## 1. `production_public_smoke`

**Owner:** Release engineer. **Verifier:** Operations owner.

- [ ] Confirm the common variables point at the intended release and a private directory:

  ```bash
  export DEPLOYED_MAIN_SHA="${PINTPATH_DEPLOYED_MAIN_SHA:?Load the exact serving protected-main SHA from the private release register}"
  [[ "$DEPLOYED_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
  test "$(git rev-parse origin/main)" = "$DEPLOYED_MAIN_SHA"
  git merge-base --is-ancestor "$CANDIDATE_SHA" "$DEPLOYED_MAIN_SHA"
  test "$(git rev-parse "$REVIEWED_PR_HEAD_SHA^{tree}")" = "$(git rev-parse "$CANDIDATE_SHA^{tree}")"
  test -z "$(git diff --name-only "$CANDIDATE_SHA..$DEPLOYED_MAIN_SHA" -- . ':(exclude)docs/release-evidence.json')"
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
    PINTPATH_EXPECTED_COMMIT_SHA="$DEPLOYED_MAIN_SHA" \
    npm run --silent smoke:production | tee "$EVIDENCE_DIR/production-public-smoke.json"
  jq -e . "$EVIDENCE_DIR/production-public-smoke.json"
  ```

- [ ] Confirm `health`, `ready`, `config`, `venues`, `prices`, the map, Account, Venue Portal, Admin page, and `deployed_commit` pass.
- [ ] Confirm the result has zero failures. The only permitted skips are `user_account`, `venue_manager_portal`, and `admin_queues`; those belong to item 2.
- [ ] Inside the deployed production service or a Railway one-shot deployment,
  use a mode-private temporary file rather than the operator host's
  `$EVIDENCE_DIR`, which is not available remotely. `railway run`, a local
  injected environment, and a generic container without Railway deployment and
  replica identity are not evidence:

  ```bash
  set -euo pipefail
  umask 077
  PROD_READINESS_RESULT="$(mktemp)"
  npm run --silent readiness:launch | tee "$PROD_READINESS_RESULT"
  jq -e '.readinessProfile == "production_free_launch"
    and .ok == true and .summary.failures == 0 and .summary.blockingWarnings == 0
    and any(.checks[]; .id == "RAILWAY_DEPLOYED_READINESS_CONTEXT" and .status == "pass")' \
    "$PROD_READINESS_RESULT"
  ```

  Securely transfer only that sanitized JSON to the operator host as `$EVIDENCE_DIR/provider-readiness.json`, validate it again, then delete the remote temporary file. Never copy a remote `.env` or provider credential.

- [ ] Before the manual release workflow, run
  `npm run --silent readiness:railway:mutation-boundary` with two distinct
  project tokens scoped to the exact production and staging environments.
  Require the token identity checks, both undecrypted staged-patch checks, and
  every production Postgres deployment/snapshot/source/digest check to be
  `true`. The current incident baseline is intentionally non-passing. Do not
  edit it to accept the 2026-08-10 redeploy, commit/discard a staged patch, or
  use this read-only receipt as mutation authority. Railway writes remain
  stopped until the tracked one-operation executor owns an immediate preflight
  and unconditional postflight.
- [ ] Before the manual release workflow, close permanent-staging sealing as a
  separate ordered gate. Preserve a passing deployed/one-shot pre-seal
  `readiness:launch` receipt with
  `readinessProfile=permanent_staging_complete`; seal only the 16 populated
  source/consumer rows in
  `ops/railway/permanent-staging-sealed-variable-policy.json`; then run
  `npm run --silent readiness:railway:sealed` externally with only the exact
  environment-scoped project token loaded as
  `PINTPATH_RAILWAY_METADATA_TOKEN`. Require the one metadata receipt to report
  `policy=permanent-staging-post-rotation`, `mode=post-seal`,
  `outcome=passed`, and `checks.forbiddenVariablesAbsent=true`. Its complete
  inventory must have no `OFFSITE_BACKUP_SUPABASE_URL`,
  `OFFSITE_BACKUP_SERVICE_ROLE_KEY`, or `OFFSITE_BACKUP_BUCKET` row, including a
  blank or sealed row. Finally, require the same strict permanent-staging
  profile from a fresh post-seal deployment or one-shot deployment. Never
  export a resolved row, use `railway run`, or unseal to repeat readiness.
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
- [ ] Confirm Redis is configured for normal production. In permanent integrated
  staging, set `REQUIRE_REDIS_RATE_LIMITING=true`, confirm `/ready` reports
  `rateLimiterRedis.required=true`, and use at least two app instances to prove
  the third request against a limit of two is rejected across replicas. Then
  interrupt only staging Redis and prove readiness plus protected traffic return
  `503` rather than switching to process memory. Restore the exact registered
  staging Redis reference and confirm recovery; never run the outage drill
  against production or restore staging. Permanent staging must not share the
  production backup writer, bucket, database, or Redis namespace.
- [ ] Confirm active OpenAI, Google, Supabase, backup, deletion-notice,
  webhook-signing, and recipient-encryption secrets remain server-side. Prove
  Stripe, POS, and report-email credentials are absent or inert while their
  features are disabled.
- [ ] Confirm TLS, HSTS/security headers, secure/HttpOnly/SameSite cookies, CSP, CORS, mixed-content blocking, and public cache headers on the deployed site. Run DAST only against staging/preview, never broad production traffic, and resolve all critical/high findings.
- [ ] Run Lighthouse or WebPageTest on `/`, `/pricing.html`, `/venue-portal.html`, and `/account.html` on mobile and desktop. Require 85+ performance on public landing/pricing, 95+ accessibility/SEO on public pages, 90+ accessibility on authenticated tools, no initial blocking console error, and no document overflow at 390px, 768px, or desktop.
- [ ] Define the expected launch peak from a documented acquisition/traffic
  model, then run permanent-staging peak, 2×-peak headroom, and at least
  60-minute soak tests across map venues/prices/missions and authenticated admin
  queues. Include sustained Postgres write contention for the approved
  submission/moderation/deletion-job mix, connection-pool saturation, lock-wait
  and deadlock monitoring, worker overlap, process restart, rolling deploy, and
  Postgres-compatible rollback. Require zero duplicate/lost work and
  authorization/data-isolation failures, less than 1% 5xx, public API p95 below
  2 seconds, admin p95 below 3 seconds, and no unbounded queue/lock growth.
- [ ] Confirm named alerts and escalation for `/health`, `/ready`, 5xx,
  deployment failure, Redis failure, deletion-notice manual review/retention
  breach, login/rate-limit spikes, database/volume size, backup age, and enabled
  scheduled-job failure. Trigger each safely in staging and preserve
  delivery/acknowledgement evidence. Stripe/report alerts become required only
  when those future features are enabled.

**Pass:** The exact SHA is deployed; public smoke exits `0`; its JSON parses; provider readiness has no failures/blocking warnings; provider access, distributed limiting, private Storage, TLS/browser security, performance, load, secret exposure, monitoring, and staging DAST checks all pass with no unresolved critical/high finding.

**Evidence:** Public-smoke JSON, production provider-readiness JSON, permanent-
staging pre/post-seal deployed-readiness JSON, sealed-variable metadata JSON,
deployed SHA, sanitized provider screenshots, key-restriction screenshots,
Storage/RLS results, monitor test alert, timestamp, and verifier.

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
- [ ] Set the dedicated user and venue-manager credentials as protected `production` environment secrets for both hourly **Production Health** and **Pint Path Release Gate**. Use these exact names: `PINTPATH_SMOKE_USER_EMAIL`, `PINTPATH_SMOKE_USER_PASSWORD`, `PINTPATH_SMOKE_VENUE_EMAIL`, and `PINTPATH_SMOKE_VENUE_PASSWORD`. Keep protected `SUPABASE_URL=https://auth.pintpath.au` and the exact reviewed `sb_publishable_...` value in `SUPABASE_ANON_KEY` in that environment too: the smoke script rejects another origin and any legacy, secret, malformed, or whitespace-wrapped key, compares the live public auth config against those pins, and sends no password or protected role request on a mismatch. Do not configure user/venue bearer-token secrets; the workflow creates and revokes disposable sessions at runtime.
- [ ] Obtain one short-lived Supabase admin access token through a normal password plus MFA ceremony and confirm its JWT is AAL2. Store it temporarily in a mode-`600` file at `$EVIDENCE_DIR/supabase-admin.token`; never paste it into the checklist or shell history. Do not store the admin password or TOTP seed in GitHub Actions.
- [ ] Exchange the AAL2 Supabase admin token for a one-use Pint Path app-cookie
  credential without printing either credential or placing it in a process
  argument. The response body must not contain an app credential; validate the
  one exact host-only `Set-Cookie` field before retaining only its value in the
  protected mode-`600` file:

  ```bash
  (
    set -euo pipefail
    umask 077
    ROLE=admin
    TOKEN_FILE="$EVIDENCE_DIR/supabase-$ROLE.token"
    HEADER_FILE="$EVIDENCE_DIR/pintpath-$ROLE-exchange.headers"
    RESPONSE_FILE="$EVIDENCE_DIR/pintpath-$ROLE-exchange.json"
    STATUS_FILE="$EVIDENCE_DIR/pintpath-$ROLE-exchange.status"
    APP_TOKEN_FILE="$EVIDENCE_DIR/pintpath-$ROLE.token"
    EXPIRES_FILE="$EVIDENCE_DIR/pintpath-$ROLE.expires-at"
    trap 'rm -f "$HEADER_FILE" "$RESPONSE_FILE" "$STATUS_FILE" "$APP_TOKEN_FILE" "$EXPIRES_FILE"' EXIT INT TERM
    test ! -e "$HEADER_FILE" && test ! -e "$RESPONSE_FILE" && test ! -e "$STATUS_FILE"
    test ! -e "$APP_TOKEN_FILE" && test ! -e "$EXPIRES_FILE"
    jq -nc --rawfile accessToken "$TOKEN_FILE" \
      '{accessToken:($accessToken | gsub("[\\r\\n]+$"; ""))}' \
      | curl --fail-with-body --silent --show-error \
        --proto '=https' \
        --max-redirs 0 \
        --dump-header "$HEADER_FILE" \
        --output "$RESPONSE_FILE" \
        --write-out '%{http_code}\n' \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        -H 'Origin: https://pintpath.au' \
        --data-binary @- \
        https://pintpath.au/api/business/auth/supabase-session \
        > "$STATUS_FILE"
    test "$(<"$STATUS_FILE")" = 200
    jq -e '.ok == true and (.data | type == "object") and (.data | has("token") | not)' \
      "$RESPONSE_FILE" > /dev/null
    jq -er '.data.expiresAt' "$RESPONSE_FILE" > "$EXPIRES_FILE"
    node scripts/extract-production-app-session-cookie.mjs \
      "$HEADER_FILE" "$APP_TOKEN_FILE"
    chmod 600 "$EXPIRES_FILE"
    rm -f "$HEADER_FILE" "$RESPONSE_FILE" "$STATUS_FILE"
    trap - EXIT INT TERM
  )
  ```

- [ ] Set `PINTPATH_SMOKE_ADMIN_TOKEN` as a `production` environment secret
  immediately before dispatching the manual gate. Despite the compatibility
  name, this value is the raw one-use app-cookie value; the smoke script sends
  it only as `Cookie: pint_path_session=...`, never as a bearer. For an
  operator-run capture, load it and prompt for the lower-privilege credentials
  without writing them to shell history:

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
    PINTPATH_EXPECTED_COMMIT_SHA="$DEPLOYED_MAIN_SHA" \
    npm run --silent smoke:production:auth | tee "$EVIDENCE_DIR/production-role-smoke.json"
  jq -e . "$EVIDENCE_DIR/production-role-smoke.json"
  ```

- [ ] Confirm all public checks plus `user_account`, `venue_manager_portal`, and `admin_queues` pass with zero failures and zero skips.
- [ ] In real browsers, prove logged-out users receive only the fixed free price
  preview, contributors receive the intended earned set, a normal user cannot
  load admin/venue-private data, one manager cannot access an unauthorized
  venue, and the MFA admin can access queues. Prove counter/reward/POS and paid
  surfaces remain unavailable.
- [ ] As a contributor, submit a price and private photo; prove the second user
  cannot see raw submission/evidence; approve as admin; then prove the normalized
  price publishes while reward/points/redemption surfaces remain disabled.
- [ ] As the assigned manager, prove ordinary profile and beer edits follow the
  documented Free path while restricted fields and safeguard-triggered changes
  remain queued for admin review. Save one venue-side happy-hour record only as
  internal venue operations data and prove it creates no public record, filter,
  mission, contribution path, SEO claim, or web/iOS surface.
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

- [ ] Deploy the candidate Postgres schema and notification worker to permanent
  integrated staging. Import and reconcile the migration source, then use at
  least two app/worker replicas to prove concurrent claims and retries cannot
  lose or duplicate a notice. SQLite is read-only migration evidence only.
- [ ] In Resend, verify the sender domain and create a dedicated sending-only transactional key. Create one staging-only webhook at the exact staging Railway origin and a separate production webhook at `https://pintpath.au/api/business/account-deletion-notifications/resend-webhook`; give each its own `whsec_` secret and subscribe both to `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, and `email.complained`. Never send staging events to the production endpoint.
- [ ] Generate an independent 32-byte recipient-encryption key. Store the active key ID, keyring JSON, Resend key, sender, monitored reply-to, and `whsec_` webhook secret only in the protected Railway/GitHub secret stores. Never paste a secret, keyring, or recipient into evidence.
- [ ] Keep `SUPABASE_OAUTH_PROVIDERS=google`; prove production startup rejects Apple and an incomplete deletion-notice configuration.
- [ ] Set `ACCOUNT_DELETION_REHEARSAL_ENABLED=true` only after mechanically
  matching the privately registered permanent-staging Railway, Postgres,
  Supabase, Storage, Redis, origin, callback, and staging-only Resend identities;
  assert all differ from production and restore staging. Remove production WORM
  credentials and every `RESTORE_REHEARSAL_*` variable, require shared Redis and
  disallow the in-memory limiter. Load the reviewed permanent-staging
  `ACCOUNT_DELETION_REHEARSAL_EXPECTED_*` pins and verified replica count; the
  runtime must match and `DATABASE_PATH` must be absent. Hash the exact staging
  database and Redis URLs without printing them, require the matching protected
  `PINTPATH_EXPECTED_*_URL_SHA256` pins, and reject the registered production
  and restore digests through `PINTPATH_FORBIDDEN_*_URL_SHA256S`. The pinned
  live database/Redis provider resource IDs must also match their protected
  `PINTPATH_EXPECTED_*_RESOURCE_ID` values and reject both production and
  restore resources in `PINTPATH_FORBIDDEN_*_RESOURCE_IDS`; alternate
  credentials for the same resource are not separation. The pinned
  staging Supabase origin plus the fixed private `beermap-source-evidence`
  bucket identifies Storage. Run `npm run --silent
  readiness:launch` inside the deployed staging service or a Railway one-shot
  deployment, require a passing `RAILWAY_DEPLOYED_READINESS_CONTEXT`, require
  `readinessProfile=account_deletion_rehearsal`, and confirm `/ready` separately.
  Remove the rehearsal switch immediately afterward and prove it is false or
  absent in production.
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
- [ ] Confirm `/ready`, `job:account_deletion_notifications`, and the admin
  deletion queue report configured/healthy state with no manual-review or
  overdue-retention rows. Inspect Postgres using aggregate/length checks only
  and prove there is no plaintext recipient in outbox/admin/log output.

**Pass:** One and only one completion notice reaches the staging recipient, its delivery is cryptographically linked to a verified Resend event, recipient ciphertext is purged on verified delivery, audited terminal resolution, or its applicable hard limit, all abuse/retry/restore/retention cases pass, and production readiness is fail-closed.

**Evidence:** Candidate SHA, Postgres schema/import/reconciliation receipt,
sanitized Resend domain/webhook screenshots, provider message ID,
non-identifying webhook event ID/keyed receipt HMAC, two-replica worker matrix,
admin/job summaries, timestamp, and verifier. No email address or secret is
permitted.

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
- [ ] Before using the permanent-staging cost-bound mode, rerun the complete labelled corpus with both model values set to exact `gpt-4.1-mini-2025-04-14`; preserve the fail/pass report and independent review before separately authorizing any variable change.
- [ ] With `OPENAI_MENU_OCR_COST_BOUND_MODE=true`, prove the shared `system_state` reservation row advances by five cents before each provider attempt, never refunds failed or uncertain attempts, takes its rolling-window timestamp from the shared database clock, denies after US$1 in every rolling 31-day window, forbids PDFs and standalone discovery OCR, and remains consistent under two-replica concurrency and restart.
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

This gate is Postgres + private Storage + WORM. The existing SQLite volume
backup/rehearsal/attestation scripts are legacy migration-source tools and
cannot pass the full-scale production restore gate. Keep this item pending
until the Postgres-native backup, WORM download, restore, reconciliation, and
tombstone-replay implementation exists and is part of the frozen candidate.

- [ ] Confirm managed Postgres PITR is enabled, the latest recovery point is
  within the signed RPO, retention is correct, alerts are active, and a direct
  migration/logical-backup connection can be used without exposing a password.
- [ ] Create a checksummed logical Postgres export, private source-evidence/
  Storage snapshot, manifest, and deletion ledger/tombstones. Record the exact
  database schema, candidate SHA, source identities, UTC time, counts, and
  hashes without customer data or secrets.
- [ ] Write the complete recovery set to provider-enforced object-lock/WORM
  storage in a separate failure domain. The application writer must be unable
  to delete, overwrite, shorten retention, change object lock, or administer
  the bucket. Prove those denials and give retention/deletion authority to a
  separate two-person operations principal.
- [ ] Treat `OFFSITE_BACKUP_SUPABASE_URL` and `pintpath-backups` only as a
  **private operational restore copy**. It is mutable and same-provider, so it
  is neither independent nor immutable. Provision its schema only with
  `ops/supabase/independent-backup-project-storage.sql`; the legacy filename
  does not change the copy's weaker authority.
- [ ] Optionally verify the operational copy with the repository SDK helper.
  Use a temporary mode-`600` key file, never secret bytes in shell history, and
  preserve only aggregate output. The key file is an exact-byte input with no
  leading/trailing whitespace, CR/LF, or NUL. With tracing disabled, transfer
  it using a no-line-ending writer equivalent to
  `printf '%s' "$VALUE" > "$OFFSITE_BACKUP_SECRET_KEY_FILE"`; never use
  `echo` or print the value during verification:

  ```bash
  OFFSITE_BACKUP_SUPABASE_URL="${OFFSITE_BACKUP_SUPABASE_URL:?}" \
  OFFSITE_BACKUP_BUCKET="${OFFSITE_BACKUP_BUCKET:-pintpath-backups}" \
    npm run --silent data:backup:download-offsite -- \
      --backup-id="$BACKUP_ID" \
      --expected-manifest-sha256="$EXPECTED_MANIFEST_SHA256" \
      --output="$BACKUP_PATH" \
      --service-role-key-file="$OFFSITE_BACKUP_SECRET_KEY_FILE" \
    | tee "$EVIDENCE_DIR/offsite-backup-download.json"
  jq -e --arg manifestSha256 "$EXPECTED_MANIFEST_SHA256" \
    '.ok == true and .manifestSha256 == $manifestSha256' \
    "$EVIDENCE_DIR/offsite-backup-download.json"
  test -f "$BACKUP_PATH/manifest.json"
  shasum -a 256 "$BACKUP_PATH/manifest.json" \
    | awk '{print $1}' \
    | tee "$EVIDENCE_DIR/offsite-backup-manifest.sha256"
  ```

  This helper verifies the operational copy only. The actual disaster-recovery
  rehearsal must retrieve and verify the WORM authority through the separately
  administered reader.

- [ ] Create a fresh ephemeral destructive restore environment. Record its
  Railway project/environment/service, Postgres database, Supabase project,
  private Storage, Redis namespace, temporary credentials, domain, and
  callbacks. Assert each differs from production and permanent integrated
  staging before any restored byte is uploaded.
- [ ] Implement and independently review candidate-bound signed/sealed authority
  for the newly created restore-only Supabase origin. The current build
  deliberately strips restore Supabase credentials before client construction
  and keeps `/ready` failed; same-environment `SUPABASE_URL` and
  `RESTORE_REHEARSAL_EXPECTED_SUPABASE_URL` values are not an authority. Do not
  reuse a hard-coded/example ref or read a restore service key until the new
  mechanism binds the real project and proves it differs from production,
  permanent staging, and the operational copy.
- [ ] Restore the WORM-sourced Postgres export/PITR target, private Storage,
  and tombstones using the reviewed Postgres-native tooling. Require schema,
  constraints, row counts/hashes, MIME/object references, deletion-ledger
  chain, tombstoned-data absence, and application invariants to pass.
- [ ] Start only the candidate in restore mode. Prove public reads, role
  isolation, `/startup`, `/ready`, Postgres connectivity, Redis namespace
  identity, disabled external writes/jobs, and deletion-tombstone replay.
  Never test restored customer credentials or send provider notifications.
- [ ] Measure actual RPO/RTO against the signed targets. Independently verify
  the restore manifest, database/Storage hashes, candidate SHA, and WORM
  retention evidence.
- [ ] Remove public networking and stop the disposable services. Revoke every
  temporary key/token, remove every restore-only secret variable and provider
  callback/webhook, delete the recorded Postgres database, Supabase project and
  Storage, Redis namespace/service, Railway service/environment/project/volume,
  and disposable domain, then verify the domain is unreachable and each ID can
  no longer be selected. Delete nothing by display name or wildcard. Two people
  must prove production and permanent staging identities, data, keys, callbacks,
  domains, and deployments are unchanged.

**Pass:** Current Postgres PITR plus logical/private-Storage/WORM recovery
artifacts restore from the WORM authority into a new disposable environment;
integrity, application, tombstone, RPO/RTO, isolation, and teardown checks all
pass; the operational Supabase copy is not cited as immutable authority.

**Evidence:** Recovery IDs and UTC times, logical/Storage/WORM manifest hashes,
object-lock and writer-denial proof, sanitized Postgres-native restore result,
RPO/RTO, deletion replay result, resource-identity comparison, purge record,
rollback target, and two-person sign-off. Do not retain object paths, customer
data, credentials, or raw debug output.

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
- [ ] Prove this is the exact frozen-SHA signed build. The archive, exported IPA,
  App Store Connect processed build, version/build number, and private release
  register must all map to the same frozen candidate; unsigned CI or a rebuilt
  binary cannot substitute.
- [ ] Scan the signed archive/exported IPA for private keys, service-role secrets, signing passwords, live bearer tokens, unexpected endpoints, and debug configuration before upload; store only a sanitized result.
- [ ] Capture every required screenshot class using synthetic or approved data.
- [ ] Provide sanitized reviewer credentials and instructions for member, contributor, and assigned venue-Free manager paths. Do not describe counter/admin, Pro, trial, billing, or reward tooling as iOS features.
- [ ] Install the processed TestFlight build and run email-authentication, role, permission, photo/location, accessibility, offline/interruption, export/deletion, and device checks on the minimum supported iOS 17 release and the current production iOS release.
- [ ] Complete external TestFlight/Beta App Review for that exact processed
  build and close every critical/high beta defect without changing the binary,
  backend contract, privacy answers, or scope.
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
- [ ] Select the Australia storefront, choose manual release, configure phased
  release, submit that exact build for full App Review approval, answer review
  follow-up without changing scope, and obtain approval (normally **Pending
  Developer Release**). Keep the approved build held until the coordinated
  web+iOS launch decision.

**Pass:** The exact frozen-SHA signed build passes validation, external
TestFlight/Beta App Review, device/accessibility/privacy checks, and full App
Review approval; the Australia storefront is selected, manual release and
phased release are configured, and the approved build held for coordinated
launch with no critical/high issue.

**Evidence:** App Store Connect build/review link, frozen-SHA/version mapping,
archive and IPA hashes, non-secret signing summary, validation result,
privacy-answer export, screenshot inventory, external beta report, device
matrix, full App Review approval status, Australia storefront selection,
manual/phased release configuration, held-state proof, and go/no-go approval.

This item passes only after App Review approval and the manual/phased hold. The
sequence is: approved and held build → strict pre-launch evidence → coordinated
manual/phased release → verify Australian storefront availability and install.

## 13. `permanent_staging_cost`

- [ ] Keep the checked-in
      `ops/railway/permanent-staging-cost-policy.json` at its reviewed v2 hash. Its
      credential-free external-export validator and receipt binder are active; its
      provider collector intentionally remains absent. Never treat that absence as
      permission to invent provider facts or collect with deployment credentials.
- [ ] After the candidate is frozen, capture fresh complete pre-deployment and
      post-deployment inventory and price-or-cap snapshots for each exact
  provider category: `railway`, `staging-supabase`, and
  `staging-external-providers`. Bind every snapshot and catalog/cap document by
  SHA-256 to the candidate and private gate manifest.
- [ ] For every provider, prove inventory and recurring-upper-bound coverage is
  complete and each count is zero: unknown resources, unpriced resources,
  resources shared with another environment, and resources with no enforceable
  recurring upper bound. Do not subtract promotional credits or negative
  amounts. Ceiling-round every line to integer USD cents before summing.
- [ ] Require each phase to total at most `4700` cents, leaving at least `300`
      cents below the `5000`-cent ceiling. Enforce the separate Railway `2000`,
      staging Supabase `2500`, and staging-external-provider `200` caps. Record the
      canonical production operational-copy and disposable-restore scopes as
      excluded, each with a distinct `separateAuthorityArtifactSha256`.
  They are not permanent-staging costs and cannot be used to dilute its total.
- [ ] Independently verify the exact frozen candidate, checked-in policy hash,
  inventory completeness, prices/caps, arithmetic, scope separation, and final
      manifest hash. Run the exact binder in
      `docs/permanent-staging-cost-evidence.md`; preserve its `preObservedAt` and
      `postObservedAt` values and verify both inside the final 24-hour window.

**Pass:** A provider-bound receipt for the frozen candidate is less than 24
hours old, covers exactly the three required provider categories, has complete
inventory and upper-bound evidence, reports zero unknown/unpriced/shared/
unbounded resources, ceiling-sums each phase to at most `4700` integer USD
cents with at least `300` cents headroom below the `5000` ceiling, excludes
both non-staging scopes under their exact separate authorities, and is accepted
by the deliberately activated reviewed policy and strict validator.

**Evidence:** Gate-specific private manifest; checked-in cost-policy hash;
provider inventory and price/cap hashes; per-provider integer-cent upper bounds;
separate production-copy and disposable-restore cost-authority hashes;
observation timestamp; candidate SHA; arithmetic review; and named independent
verifier. The public release file contains the matching manifest digest and the
sanitized `costReceipt`, never credentials, account data, or secret price terms.

Historical combined estimates are non-gating, not provider-observed, and
cannot satisfy this item. The active binder resolves the repository-code
blocker but does not create live evidence. Until protected pre/post exports and
independent approval exist for the candidate, this item remains pending.

## Final closeout

- [ ] Confirm all 13 objects in `docs/release-evidence.json` are `pass`, bound to
  the one frozen release ID, reviewed PR-head SHA, and protected-main candidate
  SHA, and contain the exact gate reference, private-manifest SHA-256, ISO-8601
  timestamp, and named verifier/role. Confirm the public, role, and
  permanent-staging cost proofs are less than 24 hours old.
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
  export FINAL_MAIN_SHA="$(git rev-parse origin/main)"
  [[ "$FINAL_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]]
  git merge-base --is-ancestor "$CANDIDATE_SHA" "$FINAL_MAIN_SHA"
  test -z "$(git diff --name-only "$CANDIDATE_SHA..$FINAL_MAIN_SHA" -- . ':(exclude)docs/release-evidence.json')"
  export EVIDENCE_DIR="${PINTPATH_EVIDENCE_DIR:-$HOME/.pintpath/launch-evidence/$RELEASE_ID/$CANDIDATE_SHA}"
  umask 077
  mkdir -p "$EVIDENCE_DIR"
  chmod 700 "$EVIDENCE_DIR"
  test "$FINAL_MAIN_SHA" = "$(git rev-parse HEAD)"
  test "$(git status --porcelain)" = ""
  ```

- [ ] Wait for CI and automated readiness, then manually dispatch **Native Apps** from the final `main` SHA so the protected production-configuration iOS archive runs. Leave Android maintenance CI disabled because Android is outside this launch:

  ```bash
  gh workflow run native-apps.yml --ref main -f run_android=false
  sleep 5
  NATIVE_RUN_ID="$(gh run list --workflow native-apps.yml --branch main \
    --event workflow_dispatch --limit 20 --json databaseId,headSha \
    | jq -er --arg sha "$FINAL_MAIN_SHA" 'map(select(.headSha == $sha)) | first | .databaseId')"
  gh run watch "$NATIVE_RUN_ID" --exit-status
  test "$(gh run view "$NATIVE_RUN_ID" --json headSha --jq .headSha)" = "$FINAL_MAIN_SHA"
  ```

  Record the run ID/URL and require the `iOS dispatch prerequisite` check (job
  id `ios`) and protected `ios-production-configuration` job to pass; the
  Android job must be skipped for this dispatch. The automatic exact-SHA `ios`
  check remains a separate push run and must also be green. If the manual run
  has not appeared after five seconds, retry the `gh run list` lookup; never
  substitute a run for another SHA.

- [ ] Confirm the final `main` SHA is deployed and `/ready` reports it.
- [ ] Re-run public and strict role smoke against that final deployed SHA.
- [ ] Manually dispatch **Pint Path Release Gate** against the production GitHub environment and bind its result to the same SHA:

  ```bash
  gh workflow run pintpath-release-gate.yml --ref main \
    -f candidate_sha="$FINAL_MAIN_SHA"
  sleep 5
  RELEASE_GATE_RUN_ID="$(gh run list --workflow pintpath-release-gate.yml --branch main \
    --event workflow_dispatch --limit 20 --json databaseId,headSha \
    | jq -er --arg sha "$FINAL_MAIN_SHA" 'map(select(.headSha == $sha)) | first | .databaseId')"
  gh run watch "$RELEASE_GATE_RUN_ID" --exit-status
  test "$(gh run view "$RELEASE_GATE_RUN_ID" --json headSha --jq .headSha)" = "$FINAL_MAIN_SHA"
  ```

  Record the run ID/URL. Retry only the lookup if Actions has not indexed the new run yet.

- [ ] Download the `pintpath-production-release-gate-$FINAL_MAIN_SHA` artifact and confirm its
  permanent-staging sealed-variable metadata JSON, authenticated-smoke JSON,
  strict release-evidence JSON, and tested-SHA file all match the final commit.
  Validate the separately captured production and permanent-staging
  deployed/one-shot provider-readiness receipts from the private evidence pack;
  the GitHub runner must not regenerate them from duplicated application
  secrets.
- [ ] In the release-gate job itself, separately confirm the security-scan and dependency-audit steps passed. Those results are step logs/statuses and are not files in the artifact.
- [ ] Record the final go/no-go decision, launch owner, rollback target, support escalation, and first-72-hour coverage in the private evidence register.
- [ ] Only after the strict gate and two-person go/no-go pass, use App Store
  Connect to manually release the already-approved held build with the configured
  phased release. Do not upload or select a different binary.
- [ ] Verify the Australian storefront shows the approved version, complete a
  clean Australian install/open/sign-in smoke, and record the live storefront
  URL/time. If propagation is pending, keep the launch announcement on hold;
  this post-release check does not replace the pre-release App Review evidence.

Broad launch remains **no-go** if any required item is pending/failed, the strict
command fails, the final-SHA Native Apps dispatch or manual release gate fails,
the WORM-backup/JWT/submission-deletion/account-bridge/Apple-account/crash gates are not
proved, a critical/high defect is open, either commercial flag is true, or the
release owner cannot provide the evidence pack. Before release, full App Review
approval and the configured manual/phased hold are mandatory; after the
coordinated release action, the Australia storefront/install verification must
pass before the public launch is announced. TestFlight evidence alone authorizes
only controlled beta distribution.
