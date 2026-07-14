-- Run this SQL only against Pint Path's independent backup Supabase project.
-- It must never be added to supabase/migrations/: that directory is deployed to
-- the production application project by `supabase db push`.
--
-- Backup payloads include SQLite databases plus private image/PDF evidence. A
-- bucket-level byte cap would eventually reject the monolithic SQLite snapshot
-- as the database grows, so the bucket delegates size enforcement to the
-- independent provider/project limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pintpath-backups',
  'pintpath-backups',
  false,
  null,
  array[
    'application/json',
    'application/octet-stream',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = null,
  allowed_mime_types = excluded.allowed_mime_types;

-- No anon/authenticated object policies are created. Only the independent
-- project's server-side service role may access backup objects.
