alter table public.venues
  validate constraint venues_business_status_check;

alter table public.venues
  validate constraint venues_australian_postcode_check;
