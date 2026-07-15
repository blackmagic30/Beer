-- Existing browser-facing grants are intentionally narrow. Make that posture durable by
-- removing automatic Data API privileges from the hosted platform's user-object owner.
-- Future migrations must explicitly grant only the operations each API role requires.
-- Hosted Supabase has created user objects as `postgres` since 2022; the legacy
-- `supabase_admin` role is platform-owned and cannot be altered by customer migrations.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;
