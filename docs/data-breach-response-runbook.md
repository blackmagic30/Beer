# Pint Path data-breach response runbook

Last audited: 3 August 2026

This is the operational response plan for any suspected or confirmed loss,
unauthorised access, disclosure, alteration, or destruction of Pint Path data.
It supplements, and does not replace, advice from the appointed Australian
privacy/legal adviser. Complete the named-role and contact fields in the private
operations register before launch; do not commit personal phone numbers,
credentials, customer data, or unredacted incident evidence.

The response follows the OAIC sequence: **contain, assess, notify, review**.
Treat 30 calendar days as the legal maximum for completing an assessment of a
suspected eligible breach, not a target. Act and escalate immediately.

Authoritative guidance:

- [OAIC quick reference for responding to data breaches](https://www.oaic.gov.au/privacy/notifiable-data-breaches/quick-reference-guide-for-responding-to-data-breaches)
- [OAIC four response steps](https://www.oaic.gov.au/privacy/notifiable-data-breaches/preventing-preparing-for-and-responding-to-data-breaches/data-breach-preparation-and-response/part-3-responding-to-data-breaches-four-key-steps)
- [OAIC preparation guidance](https://www.oaic.gov.au/privacy/notifiable-data-breaches/preventing-preparing-for-and-responding-to-data-breaches/data-breach-preparation-and-response/part-2-preparing-a-data-breach-response-plan)

## Required private role register

Record and keep current:

- incident commander and backup;
- privacy lead/NDB decision owner and backup;
- technical containment lead;
- evidence and timeline scribe;
- customer communications owner;
- external privacy/legal adviser;
- provider escalation contacts for Railway, Supabase, backup storage, Redis,
  Resend, Stripe, Google, OpenAI, GitHub, and Apple;
- authorised credential-rotation and production rollback operators;
- after-hours phone tree and acknowledgement target.

No role may be listed as only “founder,” “admin,” or a shared inbox. Record a
named person, role, private contact method, timezone, and backup.

## Activate this plan

Activate for any credible suspicion, including:

- a secret, token, signing key, backup key, session, or private URL is exposed;
- private Supabase/backup Storage, SQLite data, source evidence, exports, or
  deletion-recipient ciphertext is accessible outside its intended role;
- an account or provider is compromised or behaves unexpectedly;
- data is sent to the wrong person or provider;
- logs, alerts, users, a provider, researcher, or regulator report unauthorised
  access, disclosure, loss, alteration, or deletion;
- a stale/deleted-user token can still reach an app, Data API, RPC, or Storage
  path that should be denied;
- backup, deletion-ledger, webhook, or audit evidence is missing or altered.

Any team member may activate. Only the incident commander and privacy lead may
close the incident, and only after the completion checks below.

## First 15 minutes — identify, preserve, and contain

1. Start a private incident record with an immutable incident ID, UTC and
   Melbourne timestamps, reporter, detection source, affected system, and every
   action/decision. Do not paste secrets or unnecessary personal data.
2. Page the incident commander, privacy lead, technical lead, and scribe. Record
   acknowledgement times and any missing role.
3. Stop unrelated deployments, migrations, key rotations, retention deletion,
   evidence cleanup, and marketing. Preserve the exact serving SHA and provider
   configuration identifiers.
4. Preserve relevant read-only logs, audit rows, provider event IDs, hashes,
   headers, access history, deployment history, and backup manifests in the
   private incident register. Record chain of custody. Never download broader
   customer datasets merely “for evidence.”
5. Contain the smallest safe boundary: disable the affected route or account,
   revoke the exposed credential/session, block an abusive principal, make a
   bucket private, or roll back to a proven build. Do not wipe a volume, delete
   provider events, rotate unrelated keys, or destroy forensic evidence.
6. If active exploitation continues, prefer fail-closed maintenance/route
   isolation over continued availability. Keep `/health` and a public status
   message only when that does not expose data or impede containment.
7. Verify containment with an independent operator. Record what remains exposed,
   which tokens can stay valid until expiry, and the next check time.

## Provider-specific containment checklist

- **Railway/application:** identify the exact project/environment/service/
  deployment plus Postgres, private Storage, and Redis identities; disable the
  narrow route or deploy the Postgres-compatible rollback and preserve logs.
  Do not delete the production database/Storage, detach the sealed migration-
  source volume, or destroy forensic evidence.
- **Supabase Auth/Database/Storage:** revoke affected refresh sessions, rotate an
  exposed key using a staged replacement, tighten grants/RLS/bucket policies,
  preserve audit evidence, and test old access JWTs until their expiry. Deleting
  a user or signing out does not by itself invalidate an already-issued access
  JWT.
- **Off-site backups/deletion ledger:** remove compromised read/delete authority,
  preserve immutable copies and manifests, verify no object was changed or
  removed, and engage the separately controlled retention owner.
- **Redis:** rotate credentials/namespace only after preserving the incident
  identity evidence; expect protected traffic to fail closed during outage.
- **Resend/email:** revoke the affected API or webhook secret, pause only the
  affected sender/path, preserve message/event IDs, and assess recipient and
  email-address exposure.
- **Stripe:** restrict/revoke the affected key, preserve signed event IDs and
  payment references, contact Stripe, and do not store full payment details.
- **Google/OpenAI:** restrict or revoke the affected key, inspect usage/quota
  anomalies, preserve request identifiers, and assess submitted location/menu
  content.
- **GitHub/Apple:** revoke compromised sessions/tokens/certificates, protect the
  release branch/build, preserve audit logs, and pause store release if binary
  or signing integrity is uncertain.

## Assess facts and likely harm

Maintain a decision log answering:

- what happened, cause, start/end time, and how it was detected;
- systems, providers, environments, data stores, backups, and regions involved;
- exact data types, sensitivity, protection, retention state, and approximate
  affected-person count;
- whether data was merely exposed, accessed, copied, changed, destroyed, or
  used, and the evidence/confidence for each conclusion;
- affected users/venues and whether children, location history, identity,
  credentials, private evidence, support/deletion requests, or financial
  references are involved;
- who could access it, their capability/intent, and whether access continues;
- likely physical, financial, identity, discrimination, reputation, phishing,
  account-takeover, privacy, or safety harm;
- remedial action already taken and whether it prevents likely serious harm;
- joint-holder/provider notification obligations and who leads them;
- other contractual, Apple, payment, law-enforcement, insurer, or jurisdictional
  obligations identified by counsel.

The privacy lead records the suspected-eligible-breach decision, legal basis,
assessment start date, statutory deadline, reviewer, and next review time. If an
eligible breach becomes clear, proceed to notification promptly rather than
waiting for the assessment deadline.

## Notify when required

The privacy/legal decision owner approves notification content and recipients.
When required, notify the OAIC and affected people as soon as practicable. The
notice must be accurate, plain-language, and consistent across channels; it
must describe the incident and affected information, provide protective steps,
identify a monitored contact, and avoid exposing another person or active
investigation. Record submission receipts, delivery evidence, bounced notices,
public statements, support scripts, and updates.

Do not promise that no access occurred unless evidence proves it. Do not delay a
protective warning merely to finish marketing, blame a provider, or perfect the
wording.

## Recover and review

1. Restore service only from a known build/config/data point after containment,
   integrity, access, deletion, backup, and monitoring checks pass.
2. Rotate exposed credentials with overlap-safe order and verify old credentials
   fail. Check logs and client bundles for accidental disclosure.
3. Re-run authenticated isolation, stale-token, Storage/RLS, deletion, backup,
   public smoke, and provider readiness tests appropriate to the incident.
4. Monitor for recurrence and user harm with named thresholds and an end date.
5. Within five business days of containment, hold a blameless review covering
   root cause, detection/response timeline, control gaps, decisions, provider
   performance, and customer impact.
6. Assign each corrective action an owner, severity, due date, verifier, and
   durable proof. Update policies, training, threat models, tests, and this plan.
7. Close only after the incident commander and privacy lead sign the containment,
   notification, recovery, and corrective-action record. Retain it under the
   approved legal/incident retention schedule.

## Pre-launch tabletop gate

Before candidate freeze and at least every six months, tabletop all of:

- leaked Supabase service-role key;
- publicly readable source-evidence or backup bucket;
- stale access JWT after account deletion;
- compromised Railway/GitHub deploy credential;
- misdirected deletion or report email;
- tampered/missing backup or deletion ledger;
- malicious venue/user upload plus support escalation.

Require paging and backup-role acknowledgement, a timed contain/assess/notify/
review walkthrough, provider escalation, an OAIC decision exercise, an evidence
chain, recovery proof, and corrective actions. Store only an opaque tabletop
reference and SHA-256 in release evidence. A template with placeholders or an
unacknowledged phone tree is not a pass.
