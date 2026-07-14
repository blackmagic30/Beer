-- Browser clients must never bypass Pint Path's authenticated API validation,
-- rate limits, file-signature checks, or retention bookkeeping. Service role
-- bypasses Storage RLS and remains the only source-evidence object principal.
drop policy if exists "source_evidence_owner_insert" on storage.objects;
drop policy if exists "source_evidence_owner_select" on storage.objects;
drop policy if exists "source_evidence_owner_update" on storage.objects;
drop policy if exists "source_evidence_owner_delete" on storage.objects;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'beermap-source-evidence',
  'beermap-source-evidence',
  false,
  8388608,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on table storage.objects is
  'Storage objects are bucket-private. Pint Path source evidence is accessed only by server-side service role after application authorization.';
