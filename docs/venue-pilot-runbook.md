# Free venue pilot runbook

Run this independently with three real venues that differ in size, menu format,
staff turnover, and network quality. A code-only simulation does not count.
This launch includes assigned venue-Free operations only. Pro, trial, billing,
reports, rewards, counter staff, redemption, POS, specials, and public
happy-hour discovery remain disabled.

## Before the pilot

1. Record the frozen candidate SHA and open the matching private
   `venue_pilot_*` gate manifest.
2. The owner submits a venue claim from `/venue-portal.html` using the email on
   their verified Pint Path account.
3. An admin verifies the claimant through an independently sourced venue phone,
   email, or existing partner contact, then approves the assignment.
4. Prove the manager sees only the assigned venue. A second manager must be
   denied that venue, and the pilot manager must be denied every other venue.
5. Confirm no Pro, trial, checkout, billing, report, reward, counter, redemption,
   POS, or special/deal control is visible or callable.

## Free venue operations

1. Update the venue profile and ordinary opening hours. Confirm the expected
   public fields publish and safeguard-triggered or restricted changes remain
   queued for admin review.
2. Add at least three beer/stock/price rows. Verify create, edit, out-of-stock,
   and removal behavior on the venue portal and public discovery response.
3. Submit one separate community contribution with approved private source
   evidence. Confirm review, evidence linkage, and publication without exposing
   the evidence object or its path publicly.
4. Use the retained venue-side happy-hour collection field. Confirm it remains
   available to the assigned venue and admin while producing no consumer
   happy-hour record, filter, card, badge, mission, contribution route, SEO
   claim, promotional copy, or iOS surface.
5. Interrupt the network during one safe profile or beer update, restore the
   connection, and retry. Prove the final state is correct and no duplicate row
   or event is created.
6. Open support and submit one wrong-price report. Confirm the correct private
   queue, priority, acknowledgement, and role isolation.
7. Revoke the manager assignment and prove venue-management access stops while
   the public venue data and audit history remain intact.

## Immediate stop conditions

Stop the pilot and keep its evidence item pending if:

- another venue or another user's private data is visible;
- a restricted change bypasses the required review path;
- private evidence, object paths, tokens, or personal data appear publicly;
- a retry creates duplicate state or loses an acknowledged update;
- public happy-hour discovery or contribution becomes reachable;
- Pro, trial, paid, report, reward, counter, redemption, POS, or special/deal
  behavior becomes reachable;
- revocation fails to remove venue-management access; or
- a critical/high security, privacy, data-integrity, or accessibility defect is
  unresolved.

## Evidence

For each venue, record the date, frozen SHA, venue, devices/browsers, owner and
admin roles, every step/result, defects/retests, network interruption result,
revocation result, and owner approval in its private gate manifest. Redact
personal data and do not retain private source material in Git.

The venue owner and a different independent verifier must sign the manifest.
Update the matching `venue_pilot_*` object in `docs/release-evidence.json` only
after every step and stop condition passes, using the opaque gate reference and
SHA-256 format in `docs/external-launch-signoffs.md`.
