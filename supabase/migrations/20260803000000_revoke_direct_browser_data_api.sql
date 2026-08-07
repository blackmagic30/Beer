-- Pint Path clients use Supabase only for Auth. All application data access is
-- mediated by the Express API, which applies app-session revocation, role and
-- venue checks, rate limits, retention, and deletion suppression. Removing the
-- direct Data API surface also contains an access JWT that was issued before an
-- Auth user was deleted: the stateless JWT may remain cryptographically valid
-- until exp, but anon/authenticated have no table, sequence, RPC, or private
-- helper privilege with which to use it.

revoke all privileges on all tables in schema public from public, anon, authenticated;
revoke all privileges on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

revoke all on schema private from anon, authenticated;
revoke execute on all functions in schema private from anon, authenticated;

-- Storage is a separate schema and is governed by storage.objects policies.
-- The source-evidence hardening migration removes every anon/authenticated
-- policy; keep that provider-level denial in the live verification matrix.

comment on schema public is
  'Pint Path application data is server-mediated. anon/authenticated have no direct Data API or RPC privileges; Supabase Auth endpoints remain available.';
