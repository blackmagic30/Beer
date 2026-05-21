-- Product-correct replacement for the old call_results scratch table.
-- This table stores admin-reviewed menu/photo/manual captures by venue so
-- approved price publishing can keep using normalized, venue-keyed data.
-- It is not a public browser data source.

create table if not exists public.venue_menu_captures (
  id uuid primary key default gen_random_uuid(),
  venue_id text not null,
  venue_name text not null,
  suburb text,
  saved_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb,
  cleaned jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_venue_menu_captures_venue_saved
  on public.venue_menu_captures(venue_id, saved_at desc);

alter table public.venue_menu_captures enable row level security;

revoke all on public.venue_menu_captures from anon;
revoke all on public.venue_menu_captures from authenticated;

-- Service-role/server-side admin tools write this table. Do not add browser
-- RLS policies unless a future reviewed, role-checked admin client requires it.

do $$
begin
  if to_regclass('public.call_results') is not null then
    execute $copy$
      insert into public.venue_menu_captures (venue_id, venue_name, suburb, saved_at, raw, cleaned)
      select
        cr.venue_id::text,
        coalesce(cr.venue_name::text, ''),
        nullif(cr.suburb::text, ''),
        coalesce(cr.saved_at::timestamptz, now()),
        coalesce(cr.raw::jsonb, '{}'::jsonb),
        coalesce(cr.cleaned::jsonb, '{}'::jsonb)
      from public.call_results cr
      where cr.venue_id is not null
        and not exists (
          select 1
          from public.venue_menu_captures existing
          where existing.venue_id = cr.venue_id::text
            and existing.saved_at = coalesce(cr.saved_at::timestamptz, now())
        )
    $copy$;
  end if;
end $$;
