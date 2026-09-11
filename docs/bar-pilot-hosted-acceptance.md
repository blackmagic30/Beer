# Hosted evidence for the protected bar-pilot promotion

The existing production workflow now selects the explicit `bar-pilot` release
scope. It still verifies the reviewed current candidate, base CI, protected
staging configuration/deployment artifacts, native migration, provider readiness,
worker fencing and the later production recovery chain. Local fixtures cannot
replace the required hosted customer/venue observations.

## Collect actual observations

1. Finish the four legitimate Google sign-ins, current consent and administrator
   MFA. Assign the authorised manager/staff and prepare the labelled staging
   venue using the existing restricted pilot setup. Do not create substitute
   provider sessions or mark personal consent on someone else's behalf.
2. Build the exact reviewed candidate and record the successful protected staging
   run. Run the normal browser walkthrough against that candidate. The existing
   `scripts/smoke-bar-pilot-browser.mjs` supports explicitly opted-in staging;
   its private fixture input must identify the exact `candidateSha`,
   `stagingRunId`, reserved `venueId`, and four distinct `accounts` entries
   (`admin`, `manager`, `staff`, `customer`) with actual application `id` and
   legitimate browser `storageState` paths. Capture those states only from
   authorised normal sign-ins; keep them private and remove them after use.
   Alternatively execute the same interfaces in authorised interactive browser
   sessions and preserve the observed results.
3. The browser harness verifies provider-backed account identity/consent and
   administrator MFA, rejects the wrong candidate before mutations, and reads
   all three protected runtime routes before and after the run. It writes
   `hosted-observations.json` with account hashes and deployment/source bindings.
   This supporting file is deliberately **not** a complete acceptance record:
   reusing a session does not prove the Google login ceremony, and a list used
   during the test does not prove a hosted map-provider failure.
4. Execute the remaining Google/session and desktop/mobile/map-failure checks.
   For every required case in `HOSTED_PILOT_CHECKS`, retain actual browser or
   HTTP observation evidence. A pending check, an API-only purchase substituted
   for the normal staff UI, or a loopback fixture is not a hosted pass. Do not
   retain credentials, active QR/reward codes or raw customer records in release
   evidence. Observe map failure only in the isolated test browser; do not break
   the provider configuration for other users.

## Complete the protected record only after all checks pass

`scripts/lib/hosted-bar-pilot-acceptance.mjs` validates the operator's record of
actual observations. It does not perform the Google ceremony or independently
authenticate the truth of a human observation. The protected deployment
environment and the independently installed digest are its authority boundary.
Only the authorised operator who inspected the retained evidence should install
that record. Do not manufacture it from this document or unit-test fixtures.

The record has schema `pintpath-hosted-bar-pilot-acceptance/v1`, runtime
`hosted-staging`, the exact staging origin/candidate/run, the runtime's
domain-separated deployment digest and source identity, ISO UTC start/end times,
four distinct role/account hashes, viewport390×844, and all26 required checks.
Each check names its stable ID, `PASS`, and the SHA256 of the retained evidence
supporting that observation. Use account hashes computed as SHA256 over
`pintpath/pilot-account/v1\0` followed by the actual application account ID.
Keep the source evidence available for review; a digest is a reference, not a
replacement for the evidence.
Serialize the record with `JSON.stringify(record, null, 2)` and one final newline;
duplicate JSON fields or alternate byte encodings are rejected.

Install the completed record as `PINTPATH_HOSTED_PILOT_ACCEPTANCE_BASE64` and
its independently checked file digest as `PINTPATH_HOSTED_PILOT_ACCEPTANCE_SHA256`
in the existing protected `production-deployment` environment. This is release
preparation, not a normal bar/customer screen. The workflow materializes the
private input, and the executor verifies it and re-reads it immediately before
upload. The exact staging run comes from authenticated GitHub candidate evidence;
the exact current deployment/source comes from the live three-route prerequisite.
The record must match both and be less than24hours old.

Local results, missing/duplicate cases, pending owner actions, reused role
identities, an old/replaced staging deployment, changed file bytes, public file
permissions and symlink/hardlink substitutions all fail closed. No passing
hosted record exists until the actual controlled-account walkthrough succeeds.
