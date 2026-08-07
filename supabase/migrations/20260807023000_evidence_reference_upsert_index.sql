-- PostgREST expresses the capture upsert as ON CONFLICT
-- (evidence_reference) without an index predicate. PostgreSQL cannot infer the
-- earlier partial unique index for that conflict target, while a regular
-- unique index still permits multiple NULL values.
do $$
begin
  if to_regclass('public.venue_menu_captures') is null then
    return;
  end if;

  drop index if exists public.venue_menu_captures_evidence_reference_idx;

  create unique index venue_menu_captures_evidence_reference_idx
    on public.venue_menu_captures (evidence_reference);
end
$$;
