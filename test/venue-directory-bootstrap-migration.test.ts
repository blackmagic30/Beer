import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  "supabase/migrations/20260828010000_bootstrap_external_venue_directory.sql",
);
const DRIFT_REHEARSAL_PATH = path.resolve(
  process.cwd(),
  "scripts/ci/supabase-venue-directory-drift.sql",
);
const SCHEMA_VERIFIER_PATH = path.resolve(
  process.cwd(),
  "scripts/ci/supabase-venue-directory-schema-verify.sql",
);
const CI_WORKFLOW_PATH = path.resolve(process.cwd(), ".github/workflows/ci.yml");

describe("external venue-directory bootstrap migration", () => {
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8").toLowerCase();

  it("creates the production-compatible external identity and directory columns", () => {
    expect(sql).toContain("create table if not exists public.venues");
    expect(sql).toContain("id uuid not null default gen_random_uuid()");
    expect(sql).toContain("constraint venues_google_place_id_key unique (google_place_id)");
    expect(sql).toContain("opening_hours jsonb not null default '{}'::jsonb");
    expect(sql).toContain("tags text[] not null default '{}'::text[]");
    expect(sql).toContain("add column if not exists business_status text");
    expect(sql).toContain("add column if not exists last_checked_at timestamptz");
    expect(sql).toContain(
      "add column if not exists directory_eligible boolean not null default false",
    );
  });

  it("keeps browser roles denied while granting the server role only", () => {
    expect(sql).toContain("alter table public.venues enable row level security");
    expect(sql).toContain(
      "revoke all privileges on table public.venues from public, anon, authenticated",
    );
    expect(sql).toContain(
      "grant select, insert, update, delete on table public.venues to service_role",
    );
    expect(sql).not.toMatch(/create\s+policy/i);
  });

  it("maintains updated_at without copying the legacy public security-definer guard", () => {
    expect(sql).toContain("create function public.set_updated_at()");
    expect(sql).toContain("set search_path = pg_catalog");
    expect(sql).toContain("create trigger set_venues_updated_at");
    expect(sql).not.toContain("security definer");
    expect(sql).not.toContain("prevent_venue_private_field_client_updates");
  });

  it("retains fail-closed status constraints and the operational-only index", () => {
    expect(sql).toContain("venues_business_status_check");
    expect(sql).toContain("venues_australian_postcode_check");
    expect(sql).toContain("not valid");
    expect(sql).toContain("venues_operational_directory_name_id_idx");
    expect(sql).toContain("where directory_eligible = true");
    expect(sql).toContain("and business_status = 'operational'");
    expect(sql).not.toMatch(/update\s+public\.venues[\s\S]*set\s+business_status\s*=\s*'operational'/);
  });

  it("rehearses the observed missing-column drift, preserves legacy rows, and proves idempotency", () => {
    const rehearsal = fs.readFileSync(DRIFT_REHEARSAL_PATH, "utf8").toLowerCase();
    const verifier = fs.readFileSync(SCHEMA_VERIFIER_PATH, "utf8").toLowerCase();
    const ci = fs.readFileSync(CI_WORKFLOW_PATH, "utf8");

    expect(rehearsal).toContain("begin;");
    expect(rehearsal).toContain("drop column business_status");
    expect(rehearsal).toContain("drop column last_checked_at");
    expect(rehearsal).toContain("drop column directory_eligible");
    expect(
      rehearsal.match(/20260828010000_bootstrap_external_venue_directory\.sql/g),
    ).toHaveLength(2);
    expect(rehearsal).toContain("business_status is null");
    expect(rehearsal).toContain("directory_eligible = false");
    expect(rehearsal.trimEnd()).toMatch(/rollback;$/);

    expect(verifier).toContain("venue directory status columns do not match");
    expect(verifier).toContain("venues_business_status_check");
    expect(verifier).toContain("venues_australian_postcode_check");
    expect(verifier).toContain("venues_operational_directory_name_id_idx");
    expect(verifier).toContain("row level security is disabled");
    expect(verifier).toContain("browser roles retain direct public.venues privileges");
    expect(verifier).toContain("venue updated_at trigger is absent or not invoker-safe");
    expect(verifier).not.toContain("\\set");
    expect(ci).toContain("--file scripts/ci/supabase-venue-directory-drift.sql");
  });
});
