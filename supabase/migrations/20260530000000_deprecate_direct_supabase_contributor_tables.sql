-- Canonical Pint Path contributor submissions now go through the Express business API
-- (/api/business/submissions). That flow attaches the authenticated user server-side,
-- stores private evidence paths, applies location/points rules, and sends submissions
-- through review before public map publication.
--
-- These older direct-Supabase scaffolding tables are retained for history/backups, but
-- browser roles must not write to them or use them as an alternate submission path.

do $$
begin
  if to_regclass('public.beermap_uploads') is not null then
    execute 'alter table public.beermap_uploads enable row level security';
    execute 'revoke all on public.beermap_uploads from anon';
    execute 'revoke insert, update, delete on public.beermap_uploads from authenticated';
    execute 'comment on table public.beermap_uploads is ''Deprecated direct Supabase contributor upload scaffold. Use Express /api/business/submissions so uploads attach the authenticated user, private evidence, location eligibility, review workflow, and points ledger consistently.''';
  end if;

  if to_regclass('public.beermap_verifications') is not null then
    execute 'alter table public.beermap_verifications enable row level security';
    execute 'revoke all on public.beermap_verifications from anon';
    execute 'revoke insert, update, delete on public.beermap_verifications from authenticated';
    execute 'comment on table public.beermap_verifications is ''Deprecated direct Supabase verification scaffold. Verification/review must use protected server-side reviewer/admin flows so users cannot verify their own uploads or publish unreviewed data.''';
  end if;

  if to_regclass('public.user_price_submissions') is not null then
    execute 'alter table public.user_price_submissions enable row level security';
    execute 'revoke all on public.user_price_submissions from anon';
    execute 'revoke insert, update, delete on public.user_price_submissions from authenticated';
    execute 'comment on table public.user_price_submissions is ''Deprecated direct Supabase price submission scaffold. Canonical Pint Path submissions are stored through the Express API and local review workflow before normalized approved data reaches the public map.''';
  end if;
end $$;
