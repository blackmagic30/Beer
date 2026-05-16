# Security Policy

## Supported Beta Posture

Pint Path is a Melbourne beta running on a Node.js, TypeScript, Express, SQLite, Supabase, Google Maps, Twilio, ElevenLabs, OpenAI, Stripe, and Railway stack.

The beta security posture is designed to protect:

- exact beer-price access through server-side gating
- admin review and call/transcript routes
- venue-manager access to assigned venues only
- payment webhooks through Stripe signature verification
- source/photo evidence through upload validation, private evidence references, and short-lived signed URLs
- aggregate analytics privacy through bucket-size suppression

This is not yet a mature enterprise security program. Wider launch still needs provider-verified Supabase MFA/AAL2 setup, private Storage verification, Redis provisioning, restore drills, and a formal RLS/pentest review.

## Reporting Vulnerabilities

Report suspected security issues privately to the project owner/admin. Do not file public issues with secrets, exploitable payloads, phone numbers, transcripts, source photos, or personal data.

Include:

- affected route or page
- steps to reproduce
- impact
- whether any account, venue, payment, transcript, or upload data was exposed
- screenshots only if they do not include private data

## Secret And Key Rotation

Rotate a provider key immediately if it was committed, exposed through `/config.js`, posted in chat, shown in a screenshot, leaked in logs, or stored in an unsafe export.

Rotation checklist:

- Supabase service role: rotate in Supabase, update Railway/local env, restart the service, verify server sync only.
- Google Maps browser key: rotate in Google Cloud, restrict HTTP referrers to `https://pintpath.beer/*`, `http://localhost:3000/*`, and `http://127.0.0.1:3000/*`.
- Google Places server key: rotate and restrict by API/IP where possible.
- Stripe secret/webhook keys: rotate in Stripe, update Railway env, replay a signed test webhook.
- Twilio auth token: rotate in Twilio, update Railway env, confirm signed webhooks still pass.
- OpenAI and ElevenLabs keys: rotate with each provider, update Railway env, verify no raw payloads are logged.

Run `npm run security:scan` before every deploy.

## Incident Response Checklist

1. Disable risky env switches first: `OUTBOUND_CALLS_ENABLED=false`, `DEMO_BILLING_MODE=false`, and `ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false`.
2. If payments are involved, disable checkout price IDs and verify Stripe webhook signatures.
3. Rotate any potentially exposed keys.
4. Revoke impacted sessions with logout-all/admin database action.
5. Review `security_audit_log` for admin, payment, session, and venue-manager actions.
6. Preserve relevant Railway logs and database backups.
7. Patch, test with `npm run check` and `npm run security:scan`, then redeploy.
8. Notify affected testers/users if account, phone, transcript, payment, or source evidence data may have been exposed.

## Payment Security Notes

- `DEMO_BILLING_MODE=true` is blocked in production unless `ALLOW_DEMO_BILLING_IN_PRODUCTION=true` is explicitly set.
- Non-demo Stripe webhooks must include a valid Stripe signature and configured `STRIPE_WEBHOOK_SECRET`.
- Subscription entitlements should come from Stripe webhooks or explicit admin override only, never from client-submitted subscription status.
- Replayed Stripe events are ignored through webhook event idempotency.

## Privacy And Data Retention Notes

- Do not expose individual clickstream, exact user location, call transcripts, phone numbers, source photos, or account emails to venue managers.
- Venue analytics are aggregated and low-count buckets are suppressed by `ANALYTICS_MIN_BUCKET_SIZE`.
- Location is opt-in and one-time; the app must not store continuous movement trails.
- Upload/source evidence should use private object storage or the server-side private evidence fallback with signed review URLs. Do not expose raw source URLs or data URLs publicly.
- Production admin actions require verified email and Supabase AAL2/MFA claims when `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true`.
- Production uploads/verifications require verified account status when `REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION=true`.
- Production rate limiting should use Redis via `REDIS_URL`; the in-memory override is only for a time-boxed single-instance emergency.
- Keep database and export backups encrypted or access-controlled.

## Backup And Restore

- Back up the Railway SQLite volume before production deploys or schema changes.
- Schema changes should be additive. Avoid destructive migrations for the beta.
- Roll back by redeploying the previous commit and restoring the pre-deploy SQLite backup if a migration corrupts state.

## Admin MFA / Step-Up

Repo-side admin step-up checks are implemented and fail closed in production. Supabase/provider configuration is still required: enable MFA factors, require confirmed email, verify admin sessions reach Auth Assurance Level 2 (`aal2`), and keep `REQUIRE_ADMIN_MFA_IN_PRODUCTION=true`.
