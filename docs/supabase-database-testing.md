# Supabase database testing

Pint Path rebuilds and tests its repository-owned Supabase schema without
connecting CI to a hosted project. The local test scope is the 17 public tables,
private helper functions, RLS policies, Data API grants, and the private
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
supabase db lint --local --schema public,private --level warning --fail-on warning
supabase db advisors --local --type security --level warn --fail-on warn
supabase db advisors --local --type performance --level warn --fail-on error
supabase test db --local supabase/tests
supabase stop --no-backup
```

`supabase db reset --local` applies the complete migration chain again after
startup. Repository seeding is disabled because there is no canonical Supabase
fixture; this avoids a reset depending on a missing `supabase/seed.sql`.

The performance advisor reports warnings for review but fails the gate only on
errors. Security advisor warnings fail the gate. Treat every reported
performance warning as review work before launch even when CI remains green.

## What pgTAP verifies

- Every repository-owned public table exists and has RLS enabled.
- The Auth profile trigger and private helper functions exist.
- `SECURITY DEFINER` helpers use a fixed `pg_catalog` search path.
- Private functions are not executable by `PUBLIC` or `anon`.
- `anon` has no repository-owned table privileges.
- `authenticated` receives only the intended table and profile-column grants.
- Future postgres-owned public objects are not automatically granted to Data
  API roles.
- Update policies include both `USING` and `WITH CHECK`; insert policies include
  `WITH CHECK`.
- Server-only tables have no browser policies.
- The source-evidence bucket is private, constrained, and has no direct browser
  object policy.

The SQL files live in `supabase/tests`. The Supabase CLI runs every file in its
own transaction and rolls it back after pgTAP finishes.

## Hosted verification still required

Local tests cannot prove hosted configuration or schema drift. Before a
production database change, also capture and review:

1. `supabase migration list --linked` and `supabase db push --linked --dry-run`
   against the explicitly confirmed target.
2. The live `pg_policies`, table/column/routine grants, object owners, default
   privileges, views, functions, indexes, extensions, and Realtime
   publications.
3. A real `anon`, user A, user B, admin, and service-role access matrix.
4. Auth Site URL/redirects, Google and Apple callbacks, SMTP, password
   protection, MFA, rate limits, and session revocation behavior.
5. Storage denial tests for `anon` and authenticated users plus a controlled
   service-role upload/download/delete canary.
6. Managed backup/PITR status and a restore rehearsal that includes the
   production venue directory and Auth database, not only SQLite and Storage.

See the current Supabase guidance for
[database testing](https://supabase.com/docs/guides/database/testing),
[CLI testing and linting](https://supabase.com/docs/guides/local-development/cli/testing-and-linting),
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
and [Data API hardening](https://supabase.com/docs/guides/database/hardening-data-api).
