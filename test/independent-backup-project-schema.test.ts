import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("independent backup project schema isolation", () => {
  it("keeps backup-destination DDL out of the production Supabase migration chain", () => {
    const migrationDirectory = path.resolve(process.cwd(), "supabase/migrations");
    const migrationFiles = fs.readdirSync(migrationDirectory)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const productionMigrations = migrationFiles
      .map((file) => fs.readFileSync(path.join(migrationDirectory, file), "utf8"))
      .join("\n");

    expect(migrationFiles).not.toContain("20260714010000_harden_offsite_backup_storage.sql");
    expect(productionMigrations).not.toContain("pintpath-backups");
    expect(productionMigrations).not.toMatch(/independent backup (?:project|destination)/i);

    const retainedMigrationVersion = fs.readFileSync(
      path.join(migrationDirectory, "20260712010147_create_private_offsite_backup_bucket.sql"),
      "utf8",
    );
    expect(retainedMigrationVersion).toContain("Intentionally empty");
    expect(retainedMigrationVersion).not.toMatch(/insert\s+into\s+storage\.buckets/i);

    const backupProjectSql = fs.readFileSync(
      path.resolve(process.cwd(), "ops/supabase/independent-backup-project-storage.sql"),
      "utf8",
    );
    expect(backupProjectSql).toMatch(/insert\s+into\s+storage\.buckets/i);
    expect(backupProjectSql).toContain("'pintpath-backups'");
    expect(backupProjectSql).toMatch(/values\s*\(\s*'pintpath-backups',\s*'pintpath-backups',\s*false,\s*null,/i);
    expect(backupProjectSql).toMatch(/public\s*=\s*false/i);
    expect(backupProjectSql).toMatch(/file_size_limit\s*=\s*null/i);
    expect(backupProjectSql).toContain("'application/pdf'");
    expect(backupProjectSql).not.toMatch(/create\s+policy/i);
  });

  it("points operators and readiness failures at the dedicated backup-project SQL", () => {
    const runbook = fs.readFileSync(
      path.resolve(process.cwd(), "docs/provider-configuration-runbook.md"),
      "utf8",
    );
    const readinessScript = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/provider-readiness-check.ts"),
      "utf8",
    );
    const setupPath = "ops/supabase/independent-backup-project-storage.sql";

    expect(runbook).toContain(setupPath);
    expect(readinessScript).toContain(setupPath);
    expect(runbook).not.toContain("supabase/migrations/20260714010000_harden_offsite_backup_storage.sql");
  });
});
