import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("source evidence linkage migration", () => {
  const sql = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "supabase/migrations/20260728131500_source_evidence_linkage.sql",
    ),
    "utf8",
  ).toLowerCase();
  const upsertIndexSql = fs.readFileSync(
    path.resolve(
      process.cwd(),
      "supabase/migrations/20260807023000_evidence_reference_upsert_index.sql",
    ),
    "utf8",
  ).toLowerCase();

  it("adds a private unique evidence reference without granting browser access", () => {
    expect(sql).toContain("add column if not exists evidence_reference text");
    expect(sql).toContain("create unique index if not exists venue_menu_captures_evidence_reference_idx");
    expect(sql).toContain("where evidence_reference is not null");
    expect(sql).toContain("revoke all on table public.venue_menu_captures from anon, authenticated");
  });

  it("replaces the partial index with an inferable PostgREST upsert target", () => {
    expect(upsertIndexSql).toContain(
      "drop index if exists public.venue_menu_captures_evidence_reference_idx",
    );
    expect(upsertIndexSql).toContain(
      "create unique index venue_menu_captures_evidence_reference_idx",
    );
    expect(upsertIndexSql).toContain(
      "on public.venue_menu_captures (evidence_reference)",
    );
    expect(upsertIndexSql).not.toContain("where evidence_reference is not null");
  });
});
