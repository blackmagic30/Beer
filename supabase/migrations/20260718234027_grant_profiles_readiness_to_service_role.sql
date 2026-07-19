-- The readiness probe validates that the repository-owned migration chain is
-- queryable through the Data API. New Supabase secret keys resolve to the
-- service_role database role, which still needs an explicit table privilege
-- after the default browser/API grants are hardened.
grant select on table public.profiles to service_role;
