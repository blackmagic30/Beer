insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'pintpath-backups',
  'pintpath-backups',
  false,
  104857600,
  array[
    'application/json',
    'application/octet-stream',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- No anon/authenticated object policies are created. Only the server-side
-- service role can write, list, verify, or remove production backups.
