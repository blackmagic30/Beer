-- Keep public contributor display names unique and within community rules.
-- Emails remain private; leaderboards use display_name/public_account_id only.

create schema if not exists private;

alter table if exists public.profiles
  add column if not exists display_name_key text;

create or replace function private.normalize_public_display_name_key(value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', ' ', 'g'),
        '\s+',
        ' ',
        'g'
      )
    ),
    ''
  );
$$;

create or replace function private.public_display_name_is_blocked(value text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(value, '') ~* '(https?://|www\.|@|\b(admin|moderator|staff|support|pint\s*path|pintpath)\b|\b(n[i1!]+g+(e|a|3)?r?|c[o0]on|g[o0]{2}k|ch[i1!]+nk|p[a4]k[i1!]|r[a4]ghead|sp[i1!]c|k[i1!]ke)\b|\b(f[a4]g+(ot)?|tr[a4]nny|dyke|h[o0]m[o0])\b|\b(ret[a4]rd|sp[a4]stic|mongoloid)\b|\b(wh[o0]re|sl[uü]t|c[uü]nt|b[i1!]tch)\b)';
$$;

with normalized as (
  select
    id,
    nullif(regexp_replace(btrim(coalesce(display_name, '')), '\s+', ' ', 'g'), '') as display_name,
    private.normalize_public_display_name_key(display_name) as display_name_key,
    updated_at
  from public.profiles
),
ranked as (
  select
    *,
    row_number() over (partition by display_name_key order by updated_at desc nulls last, id) as key_rank
  from normalized
)
update public.profiles p
set
  display_name = case
    when ranked.display_name_key is null then null
    when length(ranked.display_name) < 2 or length(ranked.display_name) > 28 then null
    when private.public_display_name_is_blocked(ranked.display_name) then null
    when ranked.key_rank > 1 then null
    else ranked.display_name
  end,
  display_name_key = case
    when ranked.display_name_key is null then null
    when length(ranked.display_name) < 2 or length(ranked.display_name) > 28 then null
    when private.public_display_name_is_blocked(ranked.display_name) then null
    when ranked.key_rank > 1 then null
    else ranked.display_name_key
  end,
  updated_at = now()
from ranked
where p.id = ranked.id;

create unique index if not exists profiles_display_name_key_key
  on public.profiles(display_name_key)
  where display_name_key is not null;

create or replace function private.guard_public_display_name()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, private
as $$
declare
  next_key text;
begin
  new.display_name := nullif(regexp_replace(btrim(coalesce(new.display_name, '')), '\s+', ' ', 'g'), '');
  next_key := private.normalize_public_display_name_key(new.display_name);

  if next_key is null then
    new.display_name_key := null;
    return new;
  end if;

  if length(new.display_name) < 2 or length(new.display_name) > 28 then
    raise exception 'Display name must be 2-28 characters.';
  end if;

  if new.display_name !~ '^[A-Za-z0-9][A-Za-z0-9 ._''’\-]*[A-Za-z0-9]$' then
    raise exception 'Display name can use letters, numbers, spaces, dots, apostrophes, underscores, and hyphens.';
  end if;

  if private.public_display_name_is_blocked(new.display_name) then
    raise exception 'Choose a display name that follows the community rules.';
  end if;

  if exists (
    select 1
    from public.profiles p
    where p.display_name_key = next_key
      and p.id <> new.id
  ) then
    if tg_op = 'INSERT' then
      new.display_name := null;
      new.display_name_key := null;
      return new;
    end if;

    raise exception 'That display name is already taken.';
  end if;

  new.display_name_key := next_key;
  return new;
end;
$$;

drop trigger if exists profiles_public_display_name_guard on public.profiles;
create trigger profiles_public_display_name_guard
  before insert or update of display_name on public.profiles
  for each row
  execute function private.guard_public_display_name();

revoke all on function private.normalize_public_display_name_key(text) from public;
revoke all on function private.public_display_name_is_blocked(text) from public;
revoke all on function private.guard_public_display_name() from public;
