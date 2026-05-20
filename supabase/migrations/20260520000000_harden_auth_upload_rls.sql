-- Harden Supabase browser-facing account/upload policies for pintpath.au auth.
-- Public venue/map reads stay server-mediated unless explicitly documented elsewhere.
-- Normal users may create and read their own pending uploads, but cannot mark uploads verified.

create schema if not exists private;

create or replace function private.beermap_is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = p_user_id
      and role = 'admin'
      and account_status = 'active'
  );
$$;

grant execute on function private.beermap_is_admin(uuid) to authenticated;

alter table if exists public.profiles enable row level security;
alter table if exists public.beermap_uploads enable row level security;
alter table if exists public.beermap_verifications enable row level security;
alter table if exists public.user_activity_events enable row level security;
alter table if exists public.age_verifications enable row level security;

drop policy if exists "uploads_update_own_pending" on public.beermap_uploads;
drop policy if exists "uploads_admin_select" on public.beermap_uploads;
drop policy if exists "uploads_admin_review_update" on public.beermap_uploads;
drop policy if exists "verifications_admin_select" on public.beermap_verifications;
drop policy if exists "activity_admin_select" on public.user_activity_events;
drop policy if exists "age_verifications_admin_select" on public.age_verifications;

create policy "uploads_admin_select"
  on public.beermap_uploads for select
  to authenticated
  using (private.beermap_is_admin(auth.uid()));

create policy "uploads_admin_review_update"
  on public.beermap_uploads for update
  to authenticated
  using (private.beermap_is_admin(auth.uid()))
  with check (private.beermap_is_admin(auth.uid()));

create policy "verifications_admin_select"
  on public.beermap_verifications for select
  to authenticated
  using (private.beermap_is_admin(auth.uid()));

create policy "activity_admin_select"
  on public.user_activity_events for select
  to authenticated
  using (private.beermap_is_admin(auth.uid()));

create policy "age_verifications_admin_select"
  on public.age_verifications for select
  to authenticated
  using (private.beermap_is_admin(auth.uid()));

revoke all on public.profiles from anon;
revoke all on public.beermap_uploads from anon;
revoke all on public.beermap_verifications from anon;
revoke all on public.user_activity_events from anon;
revoke all on public.age_verifications from anon;

revoke update on public.beermap_uploads from authenticated;
grant select, insert on public.beermap_uploads to authenticated;
grant update (status, updated_at) on public.beermap_uploads to authenticated;

grant select, insert on public.beermap_verifications to authenticated;
grant select, insert on public.user_activity_events to authenticated;
grant select on public.age_verifications to authenticated;

-- Only admins can pass the update RLS policy above, and column grants restrict the mutable fields.
-- Do not grant authenticated users update access to user_id, venue_id, beer_id, or metadata.
