-- Register an opaque, server-generated evidence reference before a reviewed
-- capture can publish trusted price rows. The private capture remains
-- service-role-only; public APIs expose only linkage/presence booleans.
do $$
begin
  if to_regclass('public.venue_menu_captures') is null then
    return;
  end if;

  alter table public.venue_menu_captures
    add column if not exists evidence_reference text;

  create unique index if not exists venue_menu_captures_evidence_reference_idx
    on public.venue_menu_captures (evidence_reference)
    where evidence_reference is not null;

  comment on column public.venue_menu_captures.evidence_reference is
    'Opaque server-side linkage used to attest that private reviewed evidence was durably registered before public price publication.';
end
$$;

revoke all on table public.venue_menu_captures from anon, authenticated;
