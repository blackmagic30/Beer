# Pint Path Role and Permission Matrix

This matrix documents the Free baseline and explicitly enrolled bar-pilot rules enforced by the
Express business API, viewer pages, and canonical production runtime:
PostgreSQL application repositories with Supabase Auth and private Storage.
Backend checks are the source of truth; frontend hiding is only a usability
layer. SQLite development/legacy paths and dormant commercial code are not
execution authority for this pilot.

The current scope and evidence are in [bar-pilot-ready.md](docs/bar-pilot-ready.md).
Pilot access uses explicit venue allowlists and does not require a paid plan.

## Public / Anonymous

Can:
- Browse public map, venue markers, missions, pricing, account/auth, beta terms, and privacy pages.
- Search venues, suburbs, and beers using public preview data.
- Use map filters that do not require exact-price access.
- Create feedback, venue/beer requests, venue-interest requests, and wrong-price reports.
- See the fixed free preview through `/api/business/price-records`: eligible
  pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.
- See intended published beers, serving sizes, stock and prices for explicitly
  enrolled pilot venues, including beers outside that preview.

Cannot:
- Upload venue data submissions.
- Verify submissions.
- View account pages, saved items, private submissions, admin queues, venue portal data, analytics, or monthly reports.
- See public happy-hour or special rows, filters, badges, or promotional claims
  in this release.
- Fetch non-preview exact prices outside enrolled pilot venues without contributor-unlocked/admin access, or
  directly read private PostgreSQL, Supabase, or service-role data.

Private data never exposed:
- Account emails, user IDs tied to submissions, source-photo data URLs, session tokens, admin notes, security audit logs, private report internals, and exact user location.

## Free Member

Can:
- Sign up, log in/out, confirm 18+, manage account preferences, and save venues/beers/suburbs.
- Submit venue data after login and 18+ confirmation.
- Verify another user's submission.
- See their own submissions, verifications, saved items, contribution progress, age-verification status, and activity summary.
- Use the same fixed free preview as signed-out visitors, without a daily counter.
- Report wrong prices, send feedback, request venues/beers, and use contributor flows.
- In the enabled bar pilot, view their drink-point wallet, rotating customer
  identity, progress to 50 and one-use free-pint reward. Staff record purchases
  and redeem rewards; customers cannot set either points balance.

Cannot:
- Verify their own upload.
- Approve/reject/fraud-flag submissions.
- Self-award points or edit contribution totals.
- Access admin APIs, venue portal data, the full contributor-unlocked price
  catalogue, venue analytics, or another user's private account/submission data.

Approval / validation:
- Submissions stay `pending` until admin review.
- Points are awarded only after approval and are capped to one approved same-user/same-venue/month contribution.
- Fraud-flagged submissions can warn or suspend the user.

## Paid Member — Deferred / Dormant

Status for the Free bar pilot: **deferred and unavailable**. Paid enrolment,
Stripe checkout, paid map entitlements, and billing management must remain
disabled. The behavior below describes dormant implementation only; it grants
no current pilot access and is not an approved product claim.

Dormant behavior if separately approved and enabled in a future release:
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

## Venue Tier 1: Basic (Free Pilot)

Can:
- Access `/venue-portal` only when logged in, 18+ confirmed, active, role is `venue_manager`, and assigned to that venue by admin.
- Manage only the assigned venue's profile, ordinary opening hours, beer rows,
  on-tap/in-stock status, and prices.
- Capture happy-hour details for internal venue/admin operations only. These
  records do not publish to the public website or app in this release.
- See assigned venue listing quality, wrong-price report summaries, venue requests, current venue-supplied records, and update link.
- Submit community-style updates or restricted changes for admin/data-quality
  review through the portal submission flow.
- At an explicitly enrolled pilot venue, invite/revoke counter staff, operate
  Pint Points/redemption, inspect venue history and reverse erroneous awards
  with an auditable reason. Restricted demo preparation is separately gated.

Cannot:
- Access unassigned venues by URL/API manipulation.
- Access admin dashboard or admin APIs.
- Change their own venue membership tier through profile updates.
- Publish public happy-hour or special rows, or access dormant Pro specials,
  analytics, reports, billing or POS. Staff/reward tools require pilot enrolment.
- See individual user IDs, anonymous session IDs, exact user location, raw user clickstream, account emails, or raw source-photo evidence in portal insight payloads.

Publishing / validation:
- Routine assigned-manager profile, ordinary-hours, and verified
  beer/stock/tap/price writes are venue-supplied, scoped to the assigned venue,
  and publish directly with the implemented version/conflict controls.
- Happy-hour records remain internal-only even when active in the portal.
- Community submissions and safeguard-triggered or restricted changes remain
  pending until admin review. Guarded deletion bursts do not publish directly.
- Admin should only assign verified venue managers during beta.

## Venue Tier 2: Pro — Deferred / Dormant

Status for the Free bar pilot: **deferred and unavailable**. Pro enrolment,
trials, specials, venue analytics/reports, premium display, POS and billing
remain absent and their direct routes fail closed. Pilot staff/points/rewards
are independent of Pro. The behavior below is retained only as a description
of dormant implementation for a separately approved future release.

Dormant behavior if separately approved and enabled in a future release:
- Everything Basic can do.
- View privacy-safe suburb-level aggregate analytics and monthly report previews when the bucket threshold is met.
- See own venue profile/lookups/list views/specials metrics.
- Store premium public display metadata: highlighted name, `Pro` badge, promoted flag, and featured-special eligibility.

Cannot:
- Force spammy ranking, paid venue billing behaviour, or public featured placement beyond the current metadata flags.
- See competitor-level private data, another venue's reports, individual user clickstream, exact user location, or suppressed low-count suburb demand buckets.

Privacy threshold:
- Suburb demand buckets are suppressed below the configured threshold, with venue-manager views using at least 10 events for sensitive demand lists.

## Enrolled Pilot Counter Staff

Can identify a customer through the current server-validated code, record an
eligible purchased drink, and validate/redeem the customer's available one-use
50-point reward at their assigned pilot venue. An identical purchase retry adds
no point; redemption earns no point. Staff see a minimal wallet summary and
public customer reference, not other venues' private transaction history.

Cannot edit venue data, assign managers or staff, enter arbitrary balances,
prepare demo credits, inspect protected manager history, or operate another
venue. Revocation removes counter authority at the server transaction boundary.

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

These are contribution points. They are separate from the pilot drink-earned
Pint Points and 50-point Free Pint Reward implementation.

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

## Report Viewers (Admin Included; Venue Pro Deferred)

Can:
- Admins can view global reports/dashboards.
- In dormant Pro behavior only, assigned Pro venue managers would view only
  their own venue metrics and aggregate suburb trends after privacy thresholds.

Cannot:
- Normal users or Basic venue managers cannot view paid analytics/monthly report payloads.
- Venue managers cannot view another venue's private report by changing IDs in URLs/API calls.
- Reports must not expose competitor-level private rows, raw user clickstream, exact user location, account emails, raw session IDs, or source-photo evidence.

## Inputs Requiring Validation

- Auth: email/password and Supabase session tokens.
- Submissions: venue, observed date/time, source image/URL, beer rows, prices,
  and tap status; internal venue happy-hour capture is separately validated and
  never made public in this release.
- Verification: target submission and result.
- Venue portal: profile URLs, phone/socials, venue tags, beer catalog fields,
  ABV, prices, serving sizes, and internal-only happy-hour days/times. Specials
  inputs are dormant and unavailable in the Free pilot.
- Billing (deferred/dormant): any future plan/tier must be validated server-side
  and entitlements must come only from approved Stripe webhook/admin paths.
- Uploads: MIME, magic bytes, size, unsafe extensions/content, and production inline storage guard.

## Known Beta Limitations

- Public production onboarding uses Supabase email/password and Google OAuth with provider-confirmed email state. Apple OAuth is deferred until authorization-token revocation is implemented and tested. Local Pint Path password signup/login is limited to localhost/development and is not a production onboarding path.
- Portal-managed verified beer/stock/tap/price rows can be displayed publicly as
  venue-supplied data for assigned managers. Happy-hour rows remain internal;
  broader trusted-public publishing and disputes still need operational policy.
- Provider-side Supabase MFA verification, storage access tests, Redis provisioning, and a formal Supabase RLS audit remain in `PROD_FOLLOWUPS.md`.
