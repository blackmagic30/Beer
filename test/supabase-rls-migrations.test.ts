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
});
