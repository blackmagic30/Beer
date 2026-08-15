DO $$
DECLARE
  posture_row record;
  posture_rows bigint;
BEGIN
  SELECT count(*)
    INTO posture_rows
    FROM public.pintpath_storage_policy_posture;

  IF posture_rows <> 1 THEN
    RAISE EXCEPTION 'Storage posture view must return exactly one row.';
  END IF;

  SELECT *
    INTO STRICT posture_row
    FROM public.pintpath_storage_policy_posture;

  IF posture_row.object_policy_count IS DISTINCT FROM 0
     OR posture_row.bucket_policy_count IS DISTINCT FROM 0
     OR posture_row.object_rls_enabled IS NOT TRUE
     OR posture_row.bucket_rls_enabled IS NOT TRUE
     OR posture_row.public_bucket_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Storage posture migration did not restore the exact deny-by-default contract.';
  END IF;
END
$$;
