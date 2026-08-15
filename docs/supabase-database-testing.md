# Supabase database testing

Pint Path rebuilds and tests its repository-owned Supabase schema without
connecting CI to a hosted project. The local test scope is the 17 public tables,
private helper functions, dormant defense-in-depth RLS policies, final Data API
grant revocation, and the private
`beermap-source-evidence` bucket created by `supabase/migrations`.

The production `public.venues` relation and conditional legacy relations are
not created by this migration chain. Do not add guessed versions of those
objects to make a local test pass. Reconcile them from a reviewed production
schema-only dump and the external venue pipeline's canonical schema.

## Prerequisites

- Docker Engine or Docker Desktop is running.
- Supabase CLI `2.109.1` is installed.
- Ports configured in `supabase/config.toml` are available.

CI pins the official `supabase/setup-cli` v2.1.1 commit and requests CLI
`2.109.1`; local validation should use the same CLI release.

## Run the complete local database gate

From the repository root:

```sh
supabase db start
supabase db reset --local
supabase db lint --local --schema public,private,pintpath_app,pintpath_ops --level warning --fail-on warning
supabase db advisors --local --type security --level warn --fail-on warn
supabase db advisors --local --type performance --level warn --fail-on error
supabase test db --local supabase/tests
supabase stop --no-backup
```

`supabase db reset --local` applies the complete migration chain again after
startup. Repository seeding is disabled because there is no canonical Supabase
fixture; this avoids a reset depending on a missing `supabase/seed.sql`.

CI then seeds quoted, broad, and unrelated-bucket policies on both managed
Storage tables, applies
`20260815120455_revoke_all_direct_storage_policies.sql` twice, and runs the
standalone posture verifier. This proves the actual forward migration removes
unknown policy drift and remains idempotent; the source-level Vitest contract
is not the sole evidence for its dynamic cleanup loop. Supabase owns the
managed Storage tables, so user migrations cannot safely toggle their RLS
flags. The migration and readiness checks instead fail closed if either flag
is disabled; provider support must repair that managed-schema drift.

The performance advisor reports warnings for review but fails the gate only on
errors. Security advisor warnings fail the gate. Treat every reported
performance warning as review work before launch even when CI remains green.

## What pgTAP verifies

- Every repository-owned public table exists and has RLS enabled.
- The Auth profile trigger and private helper functions exist.
- `SECURITY DEFINER` helpers use a fixed `pg_catalog` search path.
- Private functions are not executable by `PUBLIC` or `anon`.
- `anon` has no repository-owned table privileges.
- `authenticated` has no direct public table/column grants and cannot execute
  public RPCs or private helpers; application data is Express-API only.
- Future postgres-owned public objects are not automatically granted to Data
  API roles.
- Update policies include both `USING` and `WITH CHECK`; insert policies include
  `WITH CHECK`.
- Server-only tables have no browser policies.
- The source-evidence bucket is private and constrained; every Storage bucket
  is private, and `storage.objects` and `storage.buckets` both have RLS enabled
  with exactly zero direct policies.
- The one-row `pintpath_storage_policy_posture` view exposes only the two policy
  counts, two RLS booleans, and aggregate public-bucket count, runs with invoker
  rights, is executable by `service_role`, and is inaccessible to browser JWT
  roles.

Application `/ready` and the mutation-authorized provider-readiness Storage
canary both use the server-only key and fail closed unless that exact posture is
present. The provider check runs before any privileged canary upload. Neither
aggregate check replaces the hosted ordinary-user denial tests below.

The SQL files live in `supabase/tests`. The Supabase CLI runs every file in its
own transaction and rolls it back after pgTAP finishes.

## Hosted verification still required

Local tests cannot prove hosted configuration or schema drift. Before a
production database change, also capture and review:

1. `supabase migration list --linked` and `supabase db push --linked --dry-run`
   against the explicitly confirmed target.
2. The live `pg_policies`, Storage table RLS flags, table/column/routine grants, object owners, default
   privileges, views, functions, indexes, extensions, and Realtime
   publications.
3. A real `anon`, user A, user B, admin, and service-role access matrix. Capture
   a user access JWT before deletion and require explicit permission denial for
   every table/RPC/Storage attempt immediately after deletion and before expiry.
4. Auth Site URL/redirects, the Google callback, proof that Apple OAuth is
   disabled, SMTP, password protection, MFA, rate limits, and session
   revocation behavior.
5. Storage denial tests for `anon` and authenticated users across object and
   bucket operations, plus the exact posture-view read and a controlled
   service-role upload/download/delete canary.
6. Managed backup/PITR status and a restore rehearsal that includes the
   production venue directory and Auth database, not only SQLite and Storage.

See the current Supabase guidance for
[database testing](https://supabase.com/docs/guides/database/testing),
[CLI testing and linting](https://supabase.com/docs/guides/local-development/cli/testing-and-linting),
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
and [Data API hardening](https://supabase.com/docs/guides/database/hardening-data-api).
