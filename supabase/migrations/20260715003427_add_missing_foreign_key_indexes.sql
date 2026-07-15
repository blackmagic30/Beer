-- Foreign-key columns need supporting indexes so parent-row updates/deletes and
-- relationship lookups do not degrade into sequential scans as these launch-era
-- reward and leaderboard tables begin to grow.
create index if not exists idx_free_pint_reward_codes_redeemed_by_user_id
  on public.free_pint_reward_codes (redeemed_by_user_id);

create index if not exists idx_free_pint_reward_redemptions_redeemed_by_user_id
  on public.free_pint_reward_redemptions (redeemed_by_user_id);

create index if not exists idx_free_pint_reward_redemptions_reward_code_id
  on public.free_pint_reward_redemptions (reward_code_id);

create index if not exists idx_leaderboard_prize_awards_voucher_id
  on public.leaderboard_prize_awards (voucher_id);

create index if not exists idx_leaderboard_prize_campaigns_finalized_by
  on public.leaderboard_prize_campaigns (finalized_by);

create index if not exists idx_pint_point_drink_records_recorded_by_user_id
  on public.pint_point_drink_records (recorded_by_user_id);

create index if not exists idx_pint_point_drink_records_reward_code_id
  on public.pint_point_drink_records (reward_code_id);

create index if not exists idx_pint_point_ledger_drink_record_id
  on public.pint_point_ledger (drink_record_id);

create index if not exists idx_pint_point_ledger_reward_code_id
  on public.pint_point_ledger (reward_code_id);
