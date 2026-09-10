# Staging Google signup timestamp correction

This follow-up fixes the first authenticated hosted acceptance failure after
the owner enabled Google for the bar pilot. It does not reopen launch work.

On 10 September 2026, the existing Google Web client successfully authenticated
the owner against staging. The application returned the expected 403 requesting
age and policy consent, followed by `400 Invalid account or session input` after
the owner submitted all three confirmations. The same sequence occurred twice,
at 10:17–10:18 UTC, on candidate
`2aa0a8a58170dadd32299108e4cbdbacd849c4a0` and staging deployment
`0bb33a28-ff0b-4d9a-8f7a-0108ab4889cd`.

An aggregate-only provider query confirmed one Google identity and one confirmed
email timestamp with nonzero sub-millisecond precision. This observes stored
precision, not a captured Auth HTTP response. No user identifiers, timestamp
values or credentials were exposed. A fresh anonymous browser also followed
the actual account button through Supabase to Google's real sign-in screen.

`getSupabaseEmailVerifiedAt` previously passed the provider confirmation value
unchanged into account persistence, which deliberately accepts only canonical
millisecond UTC timestamps. Valid microsecond, whole-second and offset values
therefore failed account creation after consent. The service now validates the
server-verified timestamp and normalizes it to canonical UTC before persistence.
Malformed or impossible dates remain unverified. Repository validation, provider
verification, consent binding, roles and session protections are unchanged.

## Focused verification

- Before the fix: 14 failures and one pass. All three real-PostgreSQL HTTP
  signup cases reproduced the hosted 403-consent then 400-input sequence.
- After the fix: all 15 focused cases pass, including microseconds, nanoseconds,
  whole seconds, timezone offsets and invalid calendar/timezone input.
- The PostgreSQL cases cover first consent, successful account creation,
  HttpOnly session cookies, returning-session rotation, and refusal of invalid
  confirmation data without damaging an existing account or session.
- All 458 related tests across six files pass, including the original 13
  PostgreSQL points contracts, account callback/PKCE, repository validation,
  browser Supabase keys and native form fallback.
- Repository lint, typecheck, formatting and diff checks pass. The task-owned
  PostgreSQL instance was stopped after verification.

Private local logs use `/tmp/pintpath-google-timestamp-{red,green,related,repository-lint}.log`.
Required PR/main gates and protected deployment must complete before the owner
retries hosted sign-in. These local results do not claim that a hosted PintPath
account has been created successfully.
