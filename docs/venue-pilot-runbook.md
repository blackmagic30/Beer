# Bar pilot runbook

The current pilot scope is defined in [the candidate acceptance record](bar-pilot-ready.md).
It supersedes the earlier Free-only runbook: authorised pilot venues can use
staff drink Pint Points and the 50-point free-pint reward without Pro or payment.
Contribution points remain separate. Other commercial features stay disabled.

## Real venue onboarding

1. The manager signs up, verifies their email and confirms age/terms, then finds
   their venue at `/venue-portal.html` and submits a claim.
2. An admin verifies the claimant independently through the venue's existing
   contact, then approves the manager assignment. A pending claim never grants
   access. Enrol only the agreed pilot venue in the runtime pilot allowlist.
3. The manager signs in and follows the dashboard setup list: venue details,
   ordinary hours, at least three beers, serving sizes, prices, and stock/tap state.
4. Check the public venue. Routine venue-supplied fields publish automatically;
   safeguarded edits retain the existing admin review boundary.
5. In Staff, invite the staff member's verified account. The staff member accepts
   in their account. Staff can operate the counter; they cannot edit the venue or
   grant manager privileges. Test revocation before relying on the account.

## Browser and iPhone demonstration

Use the isolated labelled demo venue/customer to demonstrate test point credits;
do not mix test credits into real customer balances.

1. On the iPhone, find the venue and show its beers/prices. In the bar browser,
   change a price/stock field, then refresh the public venue to show publication.
2. Sign in as the customer, open Pint Points and show the rotating customer code.
3. Staff identifies that code, selects the eligible purchased beer and confirms
   one purchase. Show the customer's balance increasing by exactly one.
4. Use the counter's retry of the same purchase to show it cannot add a second
   point. For the labelled test customer, the authorised demo manager can prepare
   49 points or reach 50 using the restricted demo control.
5. The customer opens the available free-pint reward. Staff checks its code and
   confirms redemption. Show the unmistakable redeemed result and customer
   balance reduced by 50, with no point earned for redemption.
6. Show History, then retry the same reward: it must fail. Reverse an erroneous
   paid purchase with a reason, and show both the original record and correction.

These are the meeting steps; preparation/deployment is completed beforehand.
Exact tested labels and fixture commands will be recorded in the candidate
acceptance record when browser verification completes.

## Pass and stop conditions

The public data, point balance, reward state and history must agree. Stop the
pilot if a code/reward can be reused incorrectly, a balance goes negative,
a duplicate purchase earns again, another venue's protected data is accessible,
a stale edit overwrites newer data, or access persists after revocation.
Record the candidate SHA, devices, venue, roles, date and observed results.
Never record credentials, raw codes or private customer data in Git.

Owner approval of alcohol promotions and participating venue practice is a
separate prerequisite for real reward use. This software runbook does not claim
legal approval.
