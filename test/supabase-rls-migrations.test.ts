import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function migration(name: string) {
  return fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations", name), "utf8");
}

function databaseTest(name: string) {
  return fs.readFileSync(path.resolve(process.cwd(), "supabase/tests", name), "utf8");
}

describe("Supabase auth/upload RLS migrations", () => {
  it("keeps local resets deterministic without an imaginary production seed", () => {
    const config = fs.readFileSync(path.resolve(process.cwd(), "supabase/config.toml"), "utf8");

    expect(config).toMatch(/\[db\.seed\][\s\S]*?^enabled = false$/m);
    expect(config).toMatch(/\[db\.seed\][\s\S]*?^sql_paths = \[\]$/m);
    expect(config).not.toContain("./seed.sql");
    expect(fs.existsSync(path.resolve(process.cwd(), "supabase/seed.sql"))).toBe(false);
  });

  it("executes catalog-level pgTAP coverage for schema, privileges, and RLS", () => {
    const tests = [
      databaseTest("000_repository_schema.test.sql"),
      databaseTest("001_data_api_privileges.test.sql"),
      databaseTest("002_rls_policies.test.sql"),
    ];

    for (const sql of tests) {
      expect(sql).toContain("create extension if not exists pgtap");
      expect(sql).toMatch(/select plan\(\d+\)/);
      expect(sql).toContain("select * from finish()");
      expect(sql).toContain("rollback;");
    }

    expect(tests[0]).toContain("RLS is enabled on every repository-owned public table");
    expect(tests[0]).toContain("t.tgname = 'on_auth_user_created_beermap_profile'");
    expect(tests[0]).toContain("no private function is executable by PUBLIC");
    expect(tests[1]).toContain("anon has no table privileges");
    expect(tests[1]).toContain("only the intended table-level Data API privileges");
    expect(tests[2]).toContain("every UPDATE policy has both USING and WITH CHECK");
    expect(tests.join("\n")).not.toContain("'venues'");
  });

  it("removes broad browser table grants and legacy public reads", () => {
    const sql = migration("20260712013512_harden_browser_table_grants.sql");

    expect(sql).toContain('drop policy if exists "public read" on public.call_results');
    expect(sql).toContain('drop policy if exists "public read venues" on public.venues');
    expect(sql).toContain("revoke all on table public.venues from anon, authenticated");
    expect(sql).toContain("revoke all on table public.venue_menu_captures from anon, authenticated");
    expect(sql).toContain("grant select on table public.profiles to authenticated");
    expect(sql).toContain("grant update (display_name, username, avatar_url, updated_at) on table public.profiles to authenticated");
    expect(sql).not.toContain("grant truncate");
  });

  it("lets the backend readiness probe select profiles without widening browser access", () => {
    const sql = migration("20260718234027_grant_profiles_readiness_to_service_role.sql");

    expect(sql).toMatch(/grant select on table public\.profiles to service_role/i);
    expect(sql).not.toMatch(/\bto\s+(?:anon|authenticated)\b/i);
    expect(sql).not.toMatch(/grant\s+(?:insert|update|delete|truncate)/i);
  });

  it("guards every optional legacy relation so the clean migration chain does not require it", () => {
    const sql = migration("20260712013512_harden_browser_table_grants.sql");

    for (const relation of [
      "call_logs",
      "call_queue",
      "call_results",
      "guinness_prices",
      "venue_billing",
      "venues",
    ]) {
      expect(sql).toContain(`to_regclass('public.${relation}') is not null`);
    }
    expect(sql).toContain("execute 'drop policy if exists \"public read\" on public.call_results'");
    expect(sql).toContain("execute 'revoke all on table public.venues from anon, authenticated'");
  });

  it("keeps user uploads private and prevents normal users from self-verifying uploads", () => {
    const sql = migration("20260520000000_harden_auth_upload_rls.sql");

    expect(sql).toContain("alter table if exists public.beermap_uploads enable row level security");
    expect(sql).toContain('drop policy if exists "uploads_update_own_pending"');
    expect(sql).toContain("revoke all on public.beermap_uploads from anon");
    expect(sql).toContain("revoke update on public.beermap_uploads from authenticated");
    expect(sql).toContain("grant select, insert on public.beermap_uploads to authenticated");
    expect(sql).toContain("grant update (status, updated_at) on public.beermap_uploads to authenticated");
    expect(sql).toContain('create policy "uploads_admin_review_update"');
    expect(sql).toContain("private.beermap_is_admin(auth.uid())");
  });

  it("keeps activity and age verification private to owners/admins", () => {
    const sql = migration("20260520000000_harden_auth_upload_rls.sql");

    expect(sql).toContain("revoke all on public.user_activity_events from anon");
    expect(sql).toContain("revoke all on public.age_verifications from anon");
    expect(sql).toContain('create policy "activity_admin_select"');
    expect(sql).toContain('create policy "age_verifications_admin_select"');
    expect(sql).toContain("grant select on public.age_verifications to authenticated");
    expect(sql).not.toContain("grant insert on public.age_verifications to authenticated");
  });

  it("stores upload-location proof privately for point eligibility", () => {
    const sql = migration("20260523000000_submission_location_points.sql");

    expect(sql).toContain("upload_latitude");
    expect(sql).toContain("upload_longitude");
    expect(sql).toContain("distance_to_venue_meters");
    expect(sql).toContain("points_eligible_by_location");
    expect(sql).toContain("Do not expose publicly");
    expect(sql).not.toMatch(/grant\s+select\s+on\s+public\.user_price_submissions\s+to\s+anon/i);
  });

  it("lets signed-in users manage only their own account privacy settings", () => {
    const sql = migration("20260524010000_account_privacy_settings.sql");

    expect(sql).toContain("create table if not exists public.account_privacy_settings");
    expect(sql).toContain("alter table public.account_privacy_settings enable row level security");
    expect(sql).toContain('create policy "privacy_settings_select_own"');
    expect(sql).toContain('create policy "privacy_settings_insert_own"');
    expect(sql).toContain('create policy "privacy_settings_update_own"');
    expect(sql).toContain("auth.uid() = user_id");
    expect(sql).toContain("revoke all on public.account_privacy_settings from anon");
    expect(sql).toContain("grant select, insert, update on public.account_privacy_settings to authenticated");
  });

  it("deprecates direct Supabase contributor scaffolds in favour of the server-side submission API", () => {
    const sql = migration("20260530000000_deprecate_direct_supabase_contributor_tables.sql");

    expect(sql).toContain("/api/business/submissions");
    expect(sql).toContain("alter table public.beermap_uploads enable row level security");
    expect(sql).toContain("alter table public.beermap_verifications enable row level security");
    expect(sql).toContain("alter table public.user_price_submissions enable row level security");
    expect(sql).toContain("revoke all on public.beermap_uploads from anon");
    expect(sql).toContain("revoke all on public.beermap_verifications from anon");
    expect(sql).toContain("revoke all on public.user_price_submissions from anon");
    expect(sql).toContain("revoke insert, update, delete on public.beermap_uploads from authenticated");
    expect(sql).toContain("revoke insert, update, delete on public.beermap_verifications from authenticated");
    expect(sql).toContain("revoke insert, update, delete on public.user_price_submissions from authenticated");
    expect(sql).not.toMatch(/grant\s+insert\s+on\s+public\.(beermap_uploads|beermap_verifications|user_price_submissions)\s+to\s+authenticated/i);
  });

  it("creates privacy-safe account IDs and hashed discount passes without storing raw pass codes", () => {
    const sql = migration("20260529000000_account_leaderboard_discount_passes.sql");

    expect(sql).toContain("create extension if not exists pgcrypto with schema extensions");
    expect(sql).toContain("profiles_public_account_id_key");
    expect(sql).toContain("private.generate_public_account_id()");
    expect(sql).toContain("session_token_hash text not null");
    expect(sql).toContain("code_hash text not null unique");
    expect(sql).toContain("Raw codes are not stored");
    expect(sql).not.toContain("code text not null");
  });

  it("keeps leaderboard prize vouchers private and server-write-only", () => {
    const sql = migration("20260617000000_leaderboard_prizes_and_reward_vouchers.sql");

    expect(sql).toContain("create table if not exists public.account_reward_vouchers");
    expect(sql).toContain("create table if not exists public.leaderboard_prize_campaigns");
    expect(sql).toContain("create table if not exists public.leaderboard_prize_awards");
    expect(sql).toContain("alter table public.account_reward_vouchers enable row level security");
    expect(sql).toContain("alter table public.leaderboard_prize_campaigns enable row level security");
    expect(sql).toContain("alter table public.leaderboard_prize_awards enable row level security");
    expect(sql).toContain('create policy "reward_vouchers_select_own"');
    expect(sql).toContain("(select auth.uid()) = user_id");
    expect(sql).toContain("revoke all on public.account_reward_vouchers from anon");
    expect(sql).toContain("revoke all on public.account_reward_vouchers from authenticated");
    expect(sql).toContain("grant select on public.account_reward_vouchers to authenticated");
    expect(sql).toContain("revoke all on public.leaderboard_prize_awards from anon");
    expect(sql).toContain("revoke all on public.leaderboard_prize_awards from authenticated");
    expect(sql).not.toMatch(/grant\s+(insert|update|delete).*account_reward_vouchers\s+to\s+authenticated/i);
  });

  it("indexes every reward and leaderboard foreign key reported by the live advisor", () => {
    const sql = migration("20260715003427_add_missing_foreign_key_indexes.sql");

    for (const [table, column] of [
      ["free_pint_reward_codes", "redeemed_by_user_id"],
      ["free_pint_reward_redemptions", "redeemed_by_user_id"],
      ["free_pint_reward_redemptions", "reward_code_id"],
      ["leaderboard_prize_awards", "voucher_id"],
      ["leaderboard_prize_campaigns", "finalized_by"],
      ["pint_point_drink_records", "recorded_by_user_id"],
      ["pint_point_drink_records", "reward_code_id"],
      ["pint_point_ledger", "drink_record_id"],
      ["pint_point_ledger", "reward_code_id"],
    ]) {
      expect(sql).toContain(`on public.${table} (${column})`);
    }
  });

  it("keeps future public objects private until a migration grants Data API access", () => {
    const sql = migration("20260715010000_harden_future_data_api_defaults.sql");
    const config = fs.readFileSync(path.resolve(process.cwd(), "supabase/config.toml"), "utf8");

    expect(sql).toMatch(/alter default privileges for role postgres in schema public\s+revoke all on tables from anon, authenticated, service_role/i);
    expect(sql).toMatch(/alter default privileges for role postgres in schema public\s+revoke all on sequences from anon, authenticated, service_role/i);
    expect(sql).toMatch(/alter default privileges for role postgres in schema public\s+revoke execute on functions from public, anon, authenticated, service_role/i);
    expect(sql).not.toMatch(/alter default privileges for role supabase_admin/i);
    expect(config).toMatch(/^auto_expose_new_tables = false$/m);
    expect(config).toContain("[local_smtp]");
    expect(config).not.toContain("[inbucket]");
  });

  it("hardens private security-definer helpers against public execution and mutable search paths", () => {
    const sql = migration("20260603000000_harden_private_helper_functions.sql");

    expect(sql).toContain("revoke all on schema private from public");
    expect(sql).toContain("revoke all on all functions in schema private from public");
    expect(sql).toContain("grant usage on schema private to authenticated");
    expect(sql).toContain("set search_path = pg_catalog");
    expect(sql).toContain("revoke all on function private.beermap_upload_owner(uuid) from public");
    expect(sql).toContain("grant execute on function private.beermap_upload_owner(uuid) to authenticated");
    expect(sql).toContain("revoke all on function private.beermap_is_admin(uuid) from public");
    expect(sql).toContain("grant execute on function private.beermap_is_admin(uuid) to authenticated");
    expect(sql).toContain("revoke all on function private.generate_public_account_id() from public");
    expect(sql).toContain("revoke all on function private.create_profile_for_new_user() from public");
    expect(sql).not.toContain("raw_user_meta_data ->> 'terms_accepted'");
    expect(sql).not.toContain("raw_user_meta_data ->> 'privacy_accepted'");
    expect(sql).not.toContain("raw_user_meta_data ->> 'terms_version'");
    expect(sql).not.toContain("raw_user_meta_data ->> 'privacy_version'");
  });

  it("captures live Supabase advisor hardening for public RPCs and RLS policies", () => {
    const sql = migration("20260603111859_harden_live_supabase_advisor_findings.sql");

    expect(sql).toContain("server_only_no_client_access");
    expect(sql).toContain("revoke all on function public.can_manage_venue(uuid) from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.get_bar_dashboard_analytics(uuid, timestamp with time zone, timestamp with time zone, integer) from public, anon, authenticated");
    expect(sql).toContain("alter function public.set_updated_at() set search_path = pg_catalog");
    expect(sql).toContain("to authenticated");
    expect(sql).toContain("using ((select auth.uid()) = id)");
    expect(sql).toContain("private.beermap_is_admin((select auth.uid()))");
    expect(sql).toContain("drop policy if exists \"bar members can read own venue\" on public.venues");
    expect(sql).toContain("create index if not exists idx_beermap_verifications_upload_id");
    expect(sql).toContain("create index if not exists idx_discount_redemptions_redeemed_by_user_id");
  });

  it("retires legacy analytics RPCs after their backing table was removed", () => {
    const sql = migration("20260711023641_retire_legacy_bar_analytics_rpcs.sql");

    expect(sql).toContain("drop function if exists public.get_bar_dashboard_analytics(");
    expect(sql).toContain("drop function if exists public.track_bar_analytics_event(");
    expect(sql).toContain("timestamp with time zone");
    expect(sql).toContain("jsonb");
    expect(sql).not.toContain("create table public.bar_analytics_events");
  });

  it("tunes remaining live RLS policies without widening owner/admin access", () => {
    const sql = migration("20260603114139_tune_remaining_rls_advisor_policies.sql");

    expect(sql).toContain("privacy_settings_select_own_or_admin");
    expect(sql).toContain("uploads_select_own_or_admin");
    expect(sql).toContain("user_price_submissions_select_own_or_admin");
    expect(sql).toContain("(select auth.uid()) = user_id");
    expect(sql).toContain("private.beermap_is_admin((select auth.uid()))");
    expect(sql).toContain("drop policy if exists \"privacy_settings_admin_select\"");
    expect(sql).toContain("drop policy if exists \"uploads_admin_select\"");
    expect(sql).toContain("drop policy if exists \"user_price_submissions_admin_select\"");
    expect(sql).toContain("discount_redemptions_select_own");
    expect(sql).not.toContain("roles = '{public}'");
  });

  it("keeps public display names unique and guarded by community rules", () => {
    const sql = migration("20260624083128_unique_public_display_names.sql");

    expect(sql).toContain("add column if not exists display_name_key");
    expect(sql).toContain("profiles_display_name_key_key");
    expect(sql).toContain("private.guard_public_display_name()");
    expect(sql).toContain("That display name is already taken.");
    expect(sql).toContain("Choose a display name that follows the community rules.");
    expect(sql).toContain("revoke all on function private.guard_public_display_name() from public");
  });
});
