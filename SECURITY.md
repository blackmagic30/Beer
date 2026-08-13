# Security Policy

## Supported Beta Posture

Pint Path's reviewed launch architecture runs Node.js, TypeScript, Express,
PostgreSQL, Redis, Supabase Auth/private Storage, Google Maps, OpenAI, Resend,
and Railway. SQLite is permitted only in isolated development/tests and as the
sealed, read-only migration source; no production or permanent-staging runtime
may open it for authoritative writes. The old phone-call automation surface
has been removed from the repository and is not built or mounted.

The beta security posture is designed to protect:

- exact beer-price access through server-side gating
- admin review, source-evidence, and venue-manager routes
- venue-manager access to assigned venues only
- payment webhooks through Stripe signature verification
- source/photo evidence through upload validation, private evidence references, and short-lived signed URLs
- aggregate analytics privacy through bucket-size suppression

This is not yet a mature enterprise security program. Wider launch still needs provider-verified Supabase MFA/AAL2 setup, private Storage verification, Redis provisioning, restore drills, and a formal RLS/pentest review.

## Reporting Vulnerabilities

Report suspected security issues privately to the project owner/admin. Do not file public issues with secrets, exploitable payloads, phone numbers, source photos, or personal data.

Include:

- affected route or page
- steps to reproduce
- impact
- whether any account, venue, payment, source-evidence, or upload data was exposed
- screenshots only if they do not include private data

## Secret And Key Rotation

Rotate a provider key immediately if it was committed, exposed through `/config.js`, posted in chat, shown in a screenshot, leaked in logs, or stored in an unsafe export.

Rotation checklist:

Any Railway environment update, restart, route change, or redeploy below remains
blocked until `readiness:railway:mutation-boundary` passes and the tracked
one-operation executor owns both the immediate preflight and unconditional
postflight. Never use a dashboard **Deploy**, Git autodeploy, or an ad-hoc CLI
command to bridge that gap; never commit or discard unrelated staged changes.

- Supabase service role: rotate in Supabase, update local configuration, then use the guarded Railway executor for the remote update/restart and verify server sync only.
- Google Maps browser key: rotate in Google Cloud, restrict HTTP referrers to `https://pintpath.au/*`, `http://localhost:3000/*`, and `http://127.0.0.1:3000/*`.
- Google Places server key: rotate and restrict by API/IP where possible.
- Stripe secret/webhook keys: rotate in Stripe, use the guarded Railway executor for the remote update, and replay a signed test webhook.
- OpenAI keys: rotate with OpenAI, use the guarded Railway executor for the remote update, and verify no raw payloads are logged.
- Retired phone-call provider keys: remove them from Railway/local env. If phone automation ever returns, rebuild it behind a fresh security review and rotate any old provider credentials first.

Run `npm run security:scan` before every deploy.

## Incident Response Checklist

1. Disable risky env switches first: `DEMO_BILLING_MODE=false` and `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false`.
2. If payments are involved, disable checkout price IDs and verify Stripe webhook signatures.
3. Rotate any potentially exposed keys.
4. Revoke impacted sessions with logout-all/admin database action.
5. Review `security_audit_log` for admin, payment, session, and venue-manager actions.
6. Preserve relevant Railway logs and database backups.
7. Patch and test with `npm run check` and `npm run security:scan`; then use only the reviewed Railway executor to redeploy the exact immutable image.
8. Notify affected testers/users if account, phone, payment, or source evidence data may have been exposed.

## Payment Security Notes

- `DEMO_BILLING_MODE=true` is blocked in production unless `ALLOW_DEMO_BILLING_IN_PRODUCTION=true` is explicitly set.
- Non-demo Stripe webhooks must include a valid Stripe signature and configured `STRIPE_WEBHOOK_SECRET`.
- Subscription entitlements should come from Stripe webhooks or explicit admin override only, never from client-submitted subscription status.
- Replayed Stripe events are ignored through webhook event idempotency.

## Privacy And Data Retention Notes

- Do not expose individual clickstream, exact user location, phone numbers, source photos, or account emails to venue managers.
- Venue analytics are aggregated and low-count buckets are suppressed by `ANALYTICS_MIN_BUCKET_SIZE`.
- Location is opt-in and one-time; the app must not store continuous movement trails.
- Upload/source evidence should use private object storage or the server-side private evidence fallback with signed review URLs. Do not expose raw source URLs or data URLs publicly.
- Production admin actions require verified email and Supabase AAL2/MFA claims when `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true`.
- Production uploads/verifications require verified account status when `REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true`.
- Production rate limiting should use Redis via `REDIS_URL`; the in-memory override is only for a time-boxed single-instance emergency.
- Keep database and export backups encrypted or access-controlled.

## Backup And Restore

- Require managed PostgreSQL PITR plus a checksummed logical backup on the
  committed protected schedule; a successful job must update the readiness
  freshness receipt.
- Copy logical backups and every referenced private Storage object to a
  separately administered provider-enforced WORM/object-lock destination.
- Rehearse restoration into the pinned disposable target and reconcile schema,
  row counts, private objects, tombstones, and RPO/RTO before launch.
- Roll back only through the reviewed Railway executor to a recorded immutable
  Postgres-compatible image. Never resume writes to the sealed SQLite source.
- Follow the controlling sequence in
  [`docs/production-launch-runbook.md`](docs/production-launch-runbook.md); a
  backup artifact is not release evidence until it is candidate-bound there.

## Admin MFA / Step-Up

Repo-side admin step-up checks are implemented and fail closed in production. Supabase/provider configuration is still required: enable MFA factors, require confirmed email, verify admin sessions reach Auth Assurance Level 2 (`aal2`), and keep `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true`.
