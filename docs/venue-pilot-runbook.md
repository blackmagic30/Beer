# Bar pilot runbook

The current pilot scope is defined in [the candidate acceptance record](bar-pilot-ready.md).
It supersedes the earlier Free-only runbook: authorised pilot venues can use
staff drink Pint Points and the 50-point free-pint reward without Pro or payment.
Contribution points remain separate. Other commercial features stay disabled.

## Real venue onboarding

1. The manager opens `/account.html`, uses **Continue with Google**, and confirms
   age/terms, then finds their venue at `/venue-portal.html` and submits a claim.
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
The connected loop passed 21 real-browser checks against isolated PostgreSQL,
including the 390×844 customer viewport. This is desktop browser emulation;
the owner's actual iPhone and hosted Google accounts are separate checks.

## Prepare the isolated staging demo before the meeting

The demo venue is **PintPath Pilot Hotel — DEMO**, in the staging application at
<https://beer-staging.up.railway.app>. It is deliberately labelled and must not
be seeded into real production search results.

1. Four distinct controlled accounts complete the hosted Google sign-in and
   age/policy flow: existing allowlisted administrator, manager, staff and
   customer. Staff and customer stay ordinary users. The administrator completes
   the existing privileged-account requirements; do not bypass Google or MFA.
2. A deployment operator supplies the existing emails privately as
   `PINTPATH_PILOT_OPERATOR_EMAIL`, `PINTPATH_PILOT_MANAGER_EMAIL`,
   `PINTPATH_PILOT_STAFF_EMAIL` and `PINTPATH_PILOT_CUSTOMER_EMAIL`. The runtime
   demo allowlist must contain that customer's actual account ID and the venue
   allowlist must contain `pintpath-pilot-demo:venue:v1`.
3. In the pinned staging application runtime, use the compiled preparation tool:

   ```sh
   node dist/scripts/pilot-demo.js preflight
   node dist/scripts/pilot-demo.js setup
   ```

   It verifies the exact staging origin/environment/database digest and TLS,
   the existing provider-backed identities, distinct roles and fixture
   ownership. It creates the labelled profile/hours, three beer/price/stock
   rows, manager/staff access and 49 test points. A repeat `setup` is a no-op.
   A successful result reports `ready: true` and the fixed demo venue; no
   credentials or private account identifiers are printed.
4. Sign in to the manager/staff browsers and customer iPhone before the meeting.
   The manager's **Pint Points / redemption** screen identifies the customer's
   current code. Its restricted demo controls can prepare 49 or 50 points.
   These adjustments are labelled as demo preparation, never as purchases.
5. To restore the initial fixture between rehearsals, run
   `node dist/scripts/pilot-demo.js reset` in the same staging runtime using the
   same account set. It restores the known profile, three rows, roles and 49
   points while preserving original ledger entries, corrections and added rows.

Only preparation uses operator tooling. During the meeting all steps use the
ordinary manager/staff browser and customer phone. Never store account passwords,
OAuth session files, raw QR codes or provider secrets in Git or demo notes.

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
