do $verify$
declare
  observed integer;
  definition text;
  business_constraint_validated boolean;
  postcode_constraint_validated boolean;
  ledger_recorded boolean;
  ledger_name text;
  ledger_statements text[];
begin
  if to_regclass('public.venues') is null then
    raise exception 'public.venues is absent';
  end if;

  select count(*)
    into observed
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'venues'
     and (
       (
         column_name = 'business_status'
         and data_type = 'text'
         and is_nullable = 'YES'
         and column_default is null
       )
       or (
         column_name = 'last_checked_at'
         and data_type = 'timestamp with time zone'
         and is_nullable = 'YES'
         and column_default is null
       )
       or (
         column_name = 'directory_eligible'
         and data_type = 'boolean'
         and is_nullable = 'NO'
         and column_default = 'false'
       )
     );

  if observed <> 3 then
    raise exception 'venue directory status columns do not match the reviewed contract';
  end if;

  select pg_get_constraintdef(oid), convalidated
    into definition, business_constraint_validated
    from pg_constraint
   where conrelid = 'public.venues'::regclass
     and conname = 'venues_business_status_check'
     and contype = 'c';

  if definition is null
     or position('business_status IS NULL' in definition) = 0
     or position('OPERATIONAL' in definition) = 0
     or position('CLOSED_TEMPORARILY' in definition) = 0
     or position('CLOSED_PERMANENTLY' in definition) = 0
     or position('FUTURE_OPENING' in definition) = 0 then
    raise exception 'venues_business_status_check does not match the reviewed contract';
  end if;

  select count(*)
    into observed
    from public.venues
   where business_status is not null
     and business_status not in (
       'OPERATIONAL',
       'CLOSED_TEMPORARILY',
       'CLOSED_PERMANENTLY',
       'FUTURE_OPENING'
     );

  if observed <> 0 then
    raise exception 'public.venues contains rows that violate venues_business_status_check';
  end if;

  select pg_get_constraintdef(oid), convalidated
    into definition, postcode_constraint_validated
    from pg_constraint
   where conrelid = 'public.venues'::regclass
     and conname = 'venues_australian_postcode_check'
     and contype = 'c';

  if definition is null
     or position('^[0-9]{4}$' in definition) = 0 then
    raise exception 'venues_australian_postcode_check does not match the reviewed contract';
  end if;

  select count(*)
    into observed
    from public.venues
   where postcode is not null
     and postcode !~ '^[0-9]{4}$';

  if observed <> 0 then
    raise exception 'public.venues contains rows that violate venues_australian_postcode_check';
  end if;

  if not exists (
    select 1
      from pg_index i
      join pg_class index_relation on index_relation.oid = i.indexrelid
     where i.indrelid = 'public.venues'::regclass
       and index_relation.relname = 'venues_operational_directory_name_id_idx'
       and i.indisvalid
       and i.indisready
       and position('directory_eligible = true' in pg_get_expr(i.indpred, i.indrelid)) > 0
       and position('business_status' in pg_get_expr(i.indpred, i.indrelid)) > 0
       and position('OPERATIONAL' in pg_get_expr(i.indpred, i.indrelid)) > 0
  ) then
    raise exception 'venue directory operational index does not match the reviewed contract';
  end if;

  if not (
    select relrowsecurity
      from pg_class
     where oid = 'public.venues'::regclass
  ) then
    raise exception 'row level security is disabled on public.venues';
  end if;

  if has_table_privilege('anon', 'public.venues', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.venues', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'browser roles retain direct public.venues privileges';
  end if;

  if not has_table_privilege(
    'service_role',
    'public.venues',
    'SELECT,INSERT,UPDATE,DELETE'
  ) then
    raise exception 'service_role lacks the reviewed public.venues privileges';
  end if;

  if not exists (
    select 1
      from pg_trigger trigger_relation
      join pg_proc trigger_function on trigger_function.oid = trigger_relation.tgfoid
     where trigger_relation.tgrelid = 'public.venues'::regclass
       and trigger_relation.tgname = 'set_venues_updated_at'
       and not trigger_relation.tgisinternal
       and trigger_relation.tgenabled <> 'D'
       and not trigger_function.prosecdef
       and coalesce(trigger_function.proconfig, '{}'::text[])
         @> array['search_path=pg_catalog']
  ) then
    raise exception 'venue updated_at trigger is absent or not invoker-safe';
  end if;

  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise exception 'Supabase migration ledger is absent';
  end if;

  select exists (
    select 1
      from supabase_migrations.schema_migrations
     where version = '20260901032339'
  ) into ledger_recorded;

  if business_constraint_validated is distinct from postcode_constraint_validated
     or business_constraint_validated is distinct from ledger_recorded then
    raise exception 'venue constraint validation and migration ledger state are mixed';
  end if;

  if ledger_recorded then
    select name, statements
      into ledger_name, ledger_statements
      from supabase_migrations.schema_migrations
     where version = '20260901032339';

    if ledger_name is distinct from 'validate_external_venue_directory_constraints'
       or coalesce(array_length(ledger_statements, 1), 0) <> 2
       or regexp_replace(
         btrim(ledger_statements[1]),
         '[[:space:]]+',
         ' ',
         'g'
       ) <> 'alter table public.venues validate constraint venues_business_status_check'
       or regexp_replace(
         btrim(ledger_statements[2]),
         '[[:space:]]+',
         ' ',
         'g'
       ) <> 'alter table public.venues validate constraint venues_australian_postcode_check' then
      raise exception 'reviewed venue constraint migration ledger row is not exact';
    end if;
  end if;
end
$verify$;
