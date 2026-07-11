-- Pint Path analytics are served by the Express application and its private
-- event store. These revoked legacy RPCs referenced the already-retired
-- public.bar_analytics_events table and had no remaining database dependants.
drop function if exists public.get_bar_dashboard_analytics(
  uuid,
  timestamp with time zone,
  timestamp with time zone,
  integer
);

drop function if exists public.track_bar_analytics_event(
  text,
  uuid,
  text,
  text,
  text,
  text,
  jsonb
);
