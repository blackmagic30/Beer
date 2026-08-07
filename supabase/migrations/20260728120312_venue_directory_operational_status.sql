-- The production venue directory predates this repository's migration
-- history, so keep this migration conditional for clean local resets while
-- applying a forward-only contract to the hosted relation.
do $$
begin
  if to_regclass('public.venues') is null then
    return;
  end if;

  execute 'alter table public.venues add column if not exists business_status text';
  execute 'alter table public.venues add column if not exists last_checked_at timestamptz';
  execute 'alter table public.venues add column if not exists directory_eligible boolean not null default false';

  -- Legacy rows have not yet been checked against the status-aware importer.
  -- Keep their status NULL so the operational-only public query fails closed
  -- until a bounded refresh supplies an authoritative Google status.

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.venues'::regclass
       and conname = 'venues_business_status_check'
  ) then
    execute $sql$
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
        ) not valid
    $sql$;
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.venues'::regclass
       and conname = 'venues_australian_postcode_check'
  ) then
    execute $sql$
      alter table public.venues
        add constraint venues_australian_postcode_check
        check (postcode is null or postcode ~ '^[0-9]{4}$') not valid
    $sql$;
  end if;

  execute $sql$
    create index if not exists venues_operational_directory_name_id_idx
      on public.venues (last_checked_at desc, name, id)
      where directory_eligible = true
        and business_status = 'OPERATIONAL'
  $sql$;

  execute $sql$
    comment on column public.venues.business_status is
      'Latest Google Places business status. Public directory reads expose OPERATIONAL rows only.'
  $sql$;
  execute $sql$
    comment on column public.venues.last_checked_at is
      'UTC time when the importer last checked the Google Places record.'
  $sql$;
  execute $sql$
    comment on column public.venues.directory_eligible is
      'True only after the current importer verifies that the Google Place remains an eligible bar, pub, or brewery.'
  $sql$;
end
$$;
