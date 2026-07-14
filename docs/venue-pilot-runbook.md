# Venue pilot runbook

Run this with three venues that differ in size, menu format, staff turnover, and network quality. A code-only simulation does not count as a venue pilot.

## Before the shift

1. The owner submits a venue claim from `/venue-portal.html` using the email on their verified Pint Path account.
2. Admin verifies the person through an independently sourced venue phone, email, or existing partner contact, then approves the claim.
3. The owner adds counter staff by public Pint Path account ID. Confirm staff can only open redemption tools.
4. Confirm the owner can edit profile, beers, prices, happy hours, and staff, while counter staff cannot.
5. Save manager and counter-staff screenshots or test notes outside the public site.

## During the shift

1. Test QR scan and six-character code entry.
2. Record at least five paid drinks across two staff accounts.
3. Repeat one transaction reference and prove no duplicate points are awarded.
4. Disable the network after member preview, submit a receipt, restore the network, and retry the queued receipt.
5. Enter one wrong drink and reverse it. Confirm staff can reverse only their own entry within 15 minutes; the manager can correct it later.
6. Revoke one counter account and prove portal access stops.
7. Confirm customer, counter, owner, and admin totals reconcile after reversals.

## Stop conditions

Stop the pilot if another venue is visible, a code is stored in the offline queue, a retry awards duplicate points, a reversal deletes history, counter staff see billing/POS credentials/analytics, or public map data changes without the intended review path.

## Evidence

For each venue record date, venue, devices, staff roles, transaction references with customer identifiers redacted, pass/fail, defects, and owner sign-off in its private gate manifest. Update the matching `venue_pilot_*` item in `docs/release-evidence.json` only after all stop conditions pass, using the manifest's opaque gate reference and SHA-256 as described in `docs/external-launch-signoffs.md`.
