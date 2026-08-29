# Permanent-staging off-site key revocation — 29 August 2026

The custom Supabase secret key left in permanent-staging Railway variable
`OFFSITE_BACKUP_SERVICE_ROLE_KEY` was revoked before any Railway-row deletion.
The exact custom key ID was removed successfully through the authenticated
Supabase Management API, was absent from the post-revocation inventory, and
then returned HTTP 401 when used against the staging project. The project's
legacy service-role key was already disabled and independently returned HTTP
401.

A secret-safe consumer inventory found the custom key only in the exact
permanent-staging Beer variable row. The legacy service-role key had no Railway
consumer, and neither key occurred in the 944 tracked repository files examined.
No raw key, token, secret-derived hash, or credential-bearing response is stored
here.

This closes credential invalidation only. It does not delete the three forbidden
Railway rows, apply a staged Railway patch, recover permanent staging, freeze a
release candidate, or claim launch readiness. No Railway deletion workflow is
currently authorized. Any future reviewed operation must first prove no-deploy
deletion semantics on a disposable secret-free variable, pin this attestation,
and prove the full provider state machine under an external writer freeze.
