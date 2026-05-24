import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function migration(name: string) {
  return fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations", name), "utf8");
}

describe("Supabase auth/upload RLS migrations", () => {
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
});
