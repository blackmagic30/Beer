-- Detailed Supabase submission table for contributor-uploaded beer prices.
-- This complements the local Express review queue and keeps raw evidence private.
-- `venue_id` is TEXT because existing deployments have imported venue identifiers as text.

create schema if not exists private;

create table if not exists public.user_price_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  venue_id text not null,
  beer_name text not null check (char_length(trim(beer_name)) > 0 and char_length(beer_name) <= 160),
  price_numeric numeric(8,2) check (price_numeric is null or (price_numeric >= 0 and price_numeric <= 250)),
  currency text not null default 'AUD' check (currency = 'AUD'),
  serving_size text not null default 'pint'
    check (serving_size in ('pint', 'pot', 'schooner', 'jug', 'bottle', 'can', 'other')),
  serving_ml integer check (serving_ml is null or (serving_ml > 0 and serving_ml <= 5000)),
  source_type text not null default 'manual'
    check (source_type in ('manual', 'photo', 'menu', 'receipt', 'other')),
  evidence_path text,
  notes text,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'rejected', 'needs_more_info')),
  verified_at timestamptz,
  rejected_at timestamptz,
  reviewer_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_price_submissions_review_state check (
    (status = 'verified' and verified_at is not null and rejected_at is null)
    or (status = 'rejected' and rejected_at is not null and verified_at is null)
    or (status in ('pending', 'needs_more_info') and verified_at is null and rejected_at is null)
  )
);

create index if not exists idx_user_price_submissions_user_created
  on public.user_price_submissions(user_id, created_at desc);

create index if not exists idx_user_price_submissions_venue_created
  on public.user_price_submissions(venue_id, created_at desc);

create index if not exists idx_user_price_submissions_status_created
  on public.user_price_submissions(status, created_at desc);

alter table public.user_price_submissions enable row level security;

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

create policy "user_price_submissions_owner_select"
  on public.user_price_submissions for select
  to authenticated
  using (auth.uid() = user_id);

create policy "user_price_submissions_admin_select"
  on public.user_price_submissions for select
  to authenticated
  using (private.beermap_is_admin(auth.uid()));

create policy "user_price_submissions_owner_insert_pending"
  on public.user_price_submissions for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and verified_at is null
    and rejected_at is null
    and reviewer_notes is null
    and (
      evidence_path is null
      or evidence_path like auth.uid()::text || '/%'
    )
  );

create policy "user_price_submissions_admin_review_update"
  on public.user_price_submissions for update
  to authenticated
  using (private.beermap_is_admin(auth.uid()))
  with check (private.beermap_is_admin(auth.uid()));

revoke all on public.user_price_submissions from anon;
grant select, insert on public.user_price_submissions to authenticated;
grant update (status, verified_at, rejected_at, reviewer_notes, updated_at) on public.user_price_submissions to authenticated;
