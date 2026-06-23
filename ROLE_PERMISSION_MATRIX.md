# Pint Path Role and Permission Matrix

This matrix documents the beta access rules enforced by the Express business API, viewer pages, and SQLite schema. Backend checks are the source of truth; frontend hiding is only a usability layer.

## Public / Anonymous

Can:
- Browse public map, venue markers, missions, pricing, account/auth, beta terms, and privacy pages.
- Search venues, suburbs, and beers using public preview data.
- Use map filters that do not require exact-price access.
- Create feedback, venue/beer requests, venue-interest requests, and wrong-price reports.
- Reveal exact prices only through `/api/business/price-records` within the server-side anonymous daily reveal limit.

Cannot:
- Upload venue data submissions.
- Verify submissions.
- View account pages, saved items, private submissions, admin queues, venue portal data, analytics, or monthly reports.
- Fetch unlimited exact prices or directly read private Supabase/service-role data.

Private data never exposed:
- Account emails, user IDs tied to submissions, source-photo data URLs, session tokens, admin notes, security audit logs, private report internals, and exact user location.

## Free Member

Can:
- Sign up, log in/out, confirm 18+, manage account preferences, and save venues/beers/suburbs.
- Submit venue data after login and 18+ confirmation.
- Verify another user's submission.
- See their own submissions, verifications, saved items, contribution progress, age-verification status, and activity summary.
- Use server-limited free exact-price reveals.
- Report wrong prices, send feedback, request venues/beers, and use contributor flows.

Cannot:
- Verify their own upload.
- Approve/reject/fraud-flag submissions.
- Self-award points or edit contribution totals.
- Access admin APIs, venue portal data, paid map access beyond reveal limits, venue analytics, or another user's private account/submission data.

Approval / validation:
- Submissions stay `pending` until admin review.
- Points are awarded only after approval and are capped to one approved same-user/same-venue/month contribution.
- Fraud-flagged submissions can warn or suspend the user.

## Paid Member

Can:
- Everything a Free Member can do.
- Access exact price records through the server-gated API when subscription status is `premium_monthly` or `premium_yearly` and age confirmation is present.
- Use paid map features such as full beer search, cheapest sort, verified-only, and full happy-hour detail according to current product rules.

Cannot:
- Access admin APIs, venue portal data unless separately assigned, another user's private account/submission data, or venue-private reports.
- Bypass Stripe/demo billing server-side entitlement checks.

Approval / validation:
- Paid status is updated by server-side demo grant, Stripe webhook, or explicit admin override only.
- Frontend-submitted subscription state is never trusted.

## Contributor-Unlocked Member

Can:
- Everything a Free Member can do.
- Access full exact-price map features while `subscription_status = contributor_unlocked` and `premium_until` is valid.

Cannot:
- Extend access without approved contribution points.
- Earn contributor access while suspended.

Approval / validation:
- Contributor unlock uses the contribution ledger, not mutable frontend totals.

## Venue Tier 1: Basic

Can:
- Access `/venue-portal` only when logged in, 18+ confirmed, active, role is `venue_manager`, and assigned to that venue by admin.
- Manage only assigned venue profile, stock/beer rows, on-tap/in-stock status, prices, happy hours, deals, and specials.
- See assigned venue listing quality, wrong-price report summaries, venue requests, current venue-supplied records, and update link.
- Submit venue updates for admin/data-quality review through the portal submission flow.

Cannot:
- Access unassigned venues by URL/API manipulation.
- Access admin dashboard or admin APIs.
- Change their own venue membership tier through profile updates.
- View Pro analytics or monthly report content.
- See individual user IDs, anonymous session IDs, exact user location, raw user clickstream, account emails, or raw source-photo evidence in portal insight payloads.

Publishing / validation:
- Portal inventory/happy-hour/special rows are venue-supplied and scoped to the assigned venue.
- High-trust public price records from community submissions still use the admin review flow.
- Admin should only assign verified venue managers during beta.

## Venue Tier 2: Pro

Can:
- Everything Basic can do.
- View privacy-safe suburb-level aggregate analytics and monthly report previews when the bucket threshold is met.
- See own venue profile/lookups/list views/specials metrics.
- Store premium public display metadata: highlighted name, `Pro` badge, promoted flag, and featured-special eligibility.

Cannot:
- Force spammy ranking, paid venue billing behaviour, or public featured placement beyond the current metadata flags.
- See competitor-level private data, another venue's reports, individual user clickstream, exact user location, or suppressed low-count suburb demand buckets.

Privacy threshold:
- Suburb demand buckets are suppressed below the configured threshold, with venue-manager views using at least 10 events for sensitive demand lists.

## Admin / Moderator / Approver

Can:
- Access protected admin dashboards, KPI/retention/coverage/partner-lead views, queues, and venue partner tools.
- Review submissions and approve/reject/needs-more-evidence/fraud-flag.
- Assign/revoke venue managers.
- Update venue-interest/outreach status.
- Override user status/trust fields.
- Create missions from user requests.
- View security audit logs through repository/admin tooling where implemented.

Cannot:
- Review their own submission.
- Use admin APIs without a valid non-expired, non-revoked, active admin session.
- Bypass audit logging for sensitive admin/payment actions.
- Expose service-role keys, Stripe secrets, OpenAI/private Google keys, raw evidence photos, or private user account data in public UI.

Approval / validation:
- Sensitive admin actions create security audit rows with redacted metadata.
- Admin sessions use a shorter TTL than normal sessions.

## Challenge / Points Participants

Current beta implementation treats data-quality missions/submissions as the challenge/points system.

Can:
- Complete data-quality missions by submitting venue data.
- Earn points only after admin approval.
- Track own points/submission history in account.

Cannot:
- Self-award points.
- Earn duplicate same-user/same-venue/month contribution points.
- Earn contributor access from rejected, fraud-flagged, or unreviewed submissions.
- Access or edit another user's points ledger.

Auditability:
- `contribution_ledger` records approved point awards with user, submission, venue, points, reason, month, and timestamp.

## Report Viewers

Can:
- Admins can view global reports/dashboards.
- Assigned Pro venue managers can view only their own venue metrics and aggregate suburb trends after privacy thresholds.

Cannot:
- Normal users or Basic venue managers cannot view paid analytics/monthly report payloads.
- Venue managers cannot view another venue's private report by changing IDs in URLs/API calls.
- Reports must not expose competitor-level private rows, raw user clickstream, exact user location, account emails, raw session IDs, or source-photo evidence.

## Inputs Requiring Validation

- Auth: email/password and Supabase session tokens.
- Submissions: venue, observed date/time, source image/URL, beer rows, prices, tap status, happy-hour details.
- Verification: target submission and result.
- Venue portal: profile URLs, phone/socials, venue tags, beer catalog fields, ABV, prices, serving sizes, happy-hour days/times, specials.
- Billing: plan/tier is validated server-side and entitlements come from Stripe webhook/demo/admin code paths only.
- Uploads: MIME, magic bytes, size, unsafe extensions/content, and production inline storage guard.

## Known Beta Limitations

- Local email/password accounts do not yet include a full email-verification workflow; Supabase OAuth/email verification should be preferred for public beta onboarding.
- Portal-managed stock/happy-hour rows can be displayed as venue-supplied data for assigned managers; broader trusted-public publishing and disputes still need operational policy.
- Provider-side Supabase MFA verification, storage access tests, Redis provisioning, and a formal Supabase RLS audit remain in `PROD_FOLLOWUPS.md`.
