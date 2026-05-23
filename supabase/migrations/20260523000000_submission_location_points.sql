-- Store intentional upload-location proof privately for contributor point eligibility.
-- Public map/API views must not expose these coordinates.

alter table public.user_price_submissions
  add column if not exists upload_latitude numeric(9,6),
  add column if not exists upload_longitude numeric(9,6),
  add column if not exists upload_accuracy_meters numeric(10,2),
  add column if not exists upload_location_captured_at timestamptz,
  add column if not exists distance_to_venue_meters numeric(10,2),
  add column if not exists points_eligible_by_location boolean not null default false,
  add column if not exists points_eligibility_reason text,
  add column if not exists points_awarded numeric(6,2) not null default 0;

comment on column public.user_price_submissions.upload_latitude is
  'Private intentional upload-location evidence for contributor points. Do not expose publicly.';
comment on column public.user_price_submissions.upload_longitude is
  'Private intentional upload-location evidence for contributor points. Do not expose publicly.';
comment on column public.user_price_submissions.distance_to_venue_meters is
  'Server-calculated distance to venue when trusted venue coordinates are available.';

create index if not exists idx_user_price_submissions_points_eligibility
  on public.user_price_submissions(points_eligible_by_location, status, created_at desc);

-- Keep normal users from altering review/points fields directly through PostgREST.
revoke update (status, verified_at, rejected_at, reviewer_notes, updated_at, points_awarded, points_eligible_by_location, points_eligibility_reason, distance_to_venue_meters)
  on public.user_price_submissions from authenticated;
grant update (status, verified_at, rejected_at, reviewer_notes, updated_at, points_awarded, points_eligible_by_location, points_eligibility_reason, distance_to_venue_meters)
  on public.user_price_submissions to authenticated;
