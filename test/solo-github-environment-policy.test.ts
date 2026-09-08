import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string): string =>
  readFileSync(join(root, path), "utf8");

const primaryRunbooks = [
  "docs/protected-provider-mutation-operations.md",
  "docs/protected-production-postgres-maintenance-role-limit.md",
  "docs/release-readiness-checklist.md",
  "docs/production-launch-runbook.md",
  "docs/production-logical-backup-operations.md",
  "docs/production-promotion-recovery.md",
  "docs/full-scale-postgres-migration-runbook.md",
  "docs/launch-readiness-review-2026-08-27.md",
  "docs/internal-readiness-audit-2026-07-15.md",
  "docs/postgres-migration-execution-status.md",
  "PROD_FOLLOWUPS.md",
] as const;

const soloPolicyRunbooks = primaryRunbooks.filter(
  (path) => path !== "docs/postgres-migration-execution-status.md",
);

const activationRunbooks = [
  "docs/protected-provider-mutation-operations.md",
  "docs/release-readiness-checklist.md",
  "docs/production-launch-runbook.md",
  "docs/production-promotion-recovery.md",
] as const;

describe("solo unattended GitHub Environment documentation", () => {
  it.each(primaryRunbooks)("%s contains no stale human Environment gate", (path) => {
    const document = read(path);

    expect(document).not.toMatch(/protected[- ]environment approvals?/i);
    expect(document).not.toMatch(/environment approval pending/i);
    expect(document).not.toMatch(/leave (?:its|the) environment approval pending/i);
    expect(document).not.toMatch(/require an independent (?:recovery )?reviewer/i);
    expect(document).not.toMatch(/production-environment reviewer/i);
    expect(document).not.toMatch(/only then approve capture/i);
    expect(document).not.toMatch(/may the reviewer approve/i);
    expect(document).not.toMatch(
      /without (?:the )?protected GitHub\s+environment approval/i,
    );
  });

  it.each(soloPolicyRunbooks)(
    "%s records zero reviewers/wait and protected main",
    (path) => {
      const document = read(path);

      expect(document).toMatch(/zero required\s+reviewers/i);
      expect(document).toMatch(/zero\s+wait\s+timers/i);
      expect(document).toMatch(/protected\s+`main`\s+only/i);
    },
  );

  it("keeps cryptographic and automated authority separate from Environment entry", () => {
    const documentation = soloPolicyRunbooks.map(read).join("\n");

    expect(documentation).toMatch(/cryptographic signer\/reviewer/i);
    expect(documentation).toMatch(/signed change reference/i);
    expect(documentation).toMatch(/automated fail-closed/i);
  });

  it("documents the checked-in static-label activation as a hard NO-GO", () => {
    const workflow = read(
      ".github/workflows/activate-production-promotion-recovery.yml",
    );
    expect(workflow).toContain(
      "runs-on: [self-hosted, linux, x64, pintpath-production-backup]",
    );
    expect(workflow).toContain(
      "runs-on: [self-hosted, linux, x64, pintpath-disposable-recovery]",
    );

    for (const path of activationRunbooks) {
      const document = read(path);
      expect(document).toMatch(/static (?:production and disposable )?base labels?/i);
      expect(document).toMatch(/hard NO-GO/i);
      expect(document).toMatch(/authoritative exact-run/i);
      expect(document).not.toMatch(/mechanically queued/i);
      expect(document).not.toMatch(/capture (?:stays|remains) queued/i);
      expect(document).not.toMatch(/standing base-label runner cannot claim/i);
      expect(document).not.toMatch(/repository-scoped controller is implemented/i);
      expect(document).not.toMatch(/controller.{0,40}offline-tested/i);
      expect(document).not.toMatch(
        /pintpath-(?:production-promotion-recovery|disposable-recovery)-\$\{\{/i,
      );
    }
  });
});
