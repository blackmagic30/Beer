import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  "supabase/migrations/20260728120312_venue_directory_operational_status.sql",
);

describe("venue directory operational-status migration", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8").toLowerCase();

  it("is conditional for the externally managed production venue relation", () => {
    expect(sql).toContain("to_regclass('public.venues') is null");
    expect(sql).toContain("add column if not exists business_status text");
    expect(sql).toContain("add column if not exists last_checked_at timestamptz");
    expect(sql).toContain("add column if not exists directory_eligible boolean not null default false");
  });

  it("constrains new structured values without rewriting or deleting quarantined legacy rows", () => {
    expect(sql).toContain("venues_business_status_check");
    expect(sql).toContain("'closed_temporarily'");
    expect(sql).toContain("'closed_permanently'");
    expect(sql).toContain("'future_opening'");
    expect(sql).toContain("venues_australian_postcode_check");
    expect(sql).toContain("postcode ~ '^[0-9]{4}$'");
    expect(sql).toContain("not valid");
    expect(sql).toContain("business_status is null");
    expect(sql).not.toMatch(/update\s+public\.venues[\s\S]*set\s+business_status\s*=\s*'operational'/);
    expect(sql).not.toContain("alter column business_status set default");
    expect(sql).not.toContain("alter column business_status set not null");
    expect(sql).not.toMatch(/\bdelete\s+from\s+public\.venues\b/);
  });

  it("adds an operational-directory partial index matching the public query", () => {
    expect(sql).toContain("venues_operational_directory_name_id_idx");
    expect(sql).toContain("where directory_eligible = true");
    expect(sql).toContain("and business_status = 'operational'");
  });
});
