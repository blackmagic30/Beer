-- Permanent staging was created after the legacy production venue directory,
-- so the earlier conditional status migration was recorded without a table to
-- alter. Bootstrap the reviewed external relation forward-only. On production,
-- where public.venues already exists, CREATE TABLE IF NOT EXISTS is a no-op and
-- the remaining statements only converge the security/status contract.

create table if not exists public.venues (
  id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  google_place_id text,
  name text not null,
  address text,
  suburb text,
  state text default 'VIC'::text,
  postcode text,
  phone text,
  website text,
  latitude double precision,
  longitude double precision,
  source text default 'google_places'::text,
  description text,
  instagram text,
  contact_email text,
  opening_hours jsonb not null default '{}'::jsonb,
  venue_type text,
  tags text[] not null default '{}'::text[],
  membership_tier text not null default 'basic'::text,
  highlighted_name boolean not null default false,
  premium_badge text,
  promoted boolean not null default false,
  featured_special_eligible boolean not null default false,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint venues_pkey primary key (id),
  constraint venues_google_place_id_key unique (google_place_id),
  constraint venues_membership_tier_check
    check (membership_tier in ('basic', 'plus', 'pro'))
);

create index if not exists idx_venues_active
  on public.venues (active);
create index if not exists idx_venues_membership_tier
  on public.venues (membership_tier);
create index if not exists idx_venues_suburb
  on public.venues (suburb);

alter table public.venues enable row level security;
revoke all privileges on table public.venues from public, anon, authenticated;
grant select, insert, update, delete on table public.venues to service_role;

do $$
begin
  if to_regprocedure('public.set_updated_at()') is null then
    execute $function$
      create function public.set_updated_at()
      returns trigger
      language plpgsql
      set search_path = pg_catalog
      as $body$
      begin
        new.updated_at := pg_catalog.now();
        return new;
      end
      $body$
    $function$;
  end if;

  execute 'revoke all on function public.set_updated_at() from public, anon, authenticated';

  if not exists (
    select 1
      from pg_trigger
     where tgrelid = 'public.venues'::regclass
       and tgname = 'set_venues_updated_at'
       and not tgisinternal
  ) then
    execute $trigger$
      create trigger set_venues_updated_at
      before update on public.venues
      for each row execute function public.set_updated_at()
    $trigger$;
  end if;
end
$$;

alter table public.venues
  add column if not exists business_status text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists directory_eligible boolean not null default false;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.venues'::regclass
       and conname = 'venues_business_status_check'
  ) then
    alter table public.venues
      add constraint venues_business_status_check
      check (
        business_status is null
        or business_status in (
          'OPERATIONAL',
          'CLOSED_TEMPORARILY',
          'CLOSED_PERMANENTLY',
          'FUTURE_OPENING'
        )
      ) not valid;
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.venues'::regclass
       and conname = 'venues_australian_postcode_check'
  ) then
    alter table public.venues
      add constraint venues_australian_postcode_check
      check (postcode is null or postcode ~ '^[0-9]{4}$') not valid;
  end if;
end
$$;

create index if not exists venues_operational_directory_name_id_idx
  on public.venues (last_checked_at desc, name, id)
  where directory_eligible = true
    and business_status = 'OPERATIONAL';

comment on table public.venues is
  'Canonical Supabase venue directory. Public reads are mediated by the protected Express API.';
comment on column public.venues.business_status is
  'Latest Google Places business status. Public directory reads expose OPERATIONAL rows only.';
comment on column public.venues.last_checked_at is
  'UTC time when the importer last checked the Google Places record.';
comment on column public.venues.directory_eligible is
  'True only after the current importer verifies that the Google Place remains an eligible bar, pub, or brewery.';
