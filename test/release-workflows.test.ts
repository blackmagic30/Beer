import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function workflow(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), ".github/workflows", name), "utf8");
}

function evidenceValidator(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "scripts/validate-release-evidence.ts"), "utf8");
}

function productionSmoke(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "scripts/production-smoke-check.ts"), "utf8");
}

describe("release workflow contracts", () => {
  it("keeps ordinary CI informative and makes manual readiness checks strict", () => {
    const source = workflow("pintpath-release-readiness.yml");

    expect(source).toContain("name: Pint Path Automated Readiness");
    expect(source).toContain("npm run test:e2e:pintpath");
    expect(source).toContain("npm run release:evidence | tee release-evidence-summary.json");
    expect(source).toContain("npm run release:evidence:strict | tee release-evidence-summary.json");
    expect(source).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(evidenceValidator()).toContain("ok: launchReady");
    expect(evidenceValidator()).toContain("launchReady,");
  });

  it("requires authenticated production role checks and strict evidence in the manual release gate", () => {
    const source = workflow("pintpath-release-gate.yml");

    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: production");
    expect(source).toContain("PINTPATH_SMOKE_USER_TOKEN: ${{ secrets.PINTPATH_SMOKE_USER_TOKEN }}");
    expect(source).toContain("PINTPATH_SMOKE_VENUE_TOKEN: ${{ secrets.PINTPATH_SMOKE_VENUE_TOKEN }}");
    expect(source).toContain("PINTPATH_SMOKE_ADMIN_TOKEN: ${{ secrets.PINTPATH_SMOKE_ADMIN_TOKEN }}");
    expect(source).toContain("npm run smoke:production:auth");
    expect(source).toContain("npm run readiness:launch");
    expect(source).toContain("npm run release:evidence:strict");
    expect(source).toContain("PINTPATH_EXPECTED_COMMIT_SHA: ${{ github.sha }}");
    expect(source).toContain("tested-commit-sha.txt");
    expect(productionSmoke()).toContain("deployment.commitSha");
    expect(productionSmoke()).not.toContain("nestedData(payload).commitSha");
    expect(productionSmoke()).toContain('path: "/api/business/admin/queues?limit=1&offset=0"');
    expect(productionSmoke()).toContain("Array.isArray(data.wrongPriceReports)");

    const e2eStep = source.match(/- name: Automated release-readiness tests[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(e2eStep).toContain("NODE_ENV: test");
    expect(e2eStep).toContain("DATABASE_PATH: ./data/ci-production-release-gate.sqlite");
    expect(e2eStep).toContain("PINTPATH_TEST_DATABASE_PATH: ./data/ci-production-release-gate.sqlite");
    expect(e2eStep).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_USER_TOKEN");
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_VENUE_TOKEN");
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");

    const readinessStep = source.match(/- name: Enforce production provider readiness[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(readinessStep).toContain("NODE_ENV: production");
    expect(readinessStep).toContain("SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}");
    expect(readinessStep).toContain("STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}");

    const authenticatedSmokeStep = source.match(/- name: Verify authenticated production roles[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(authenticatedSmokeStep).toContain("PINTPATH_SMOKE_USER_TOKEN: ${{ secrets.PINTPATH_SMOKE_USER_TOKEN }}");
    expect(authenticatedSmokeStep).toContain("PINTPATH_SMOKE_VENUE_TOKEN: ${{ secrets.PINTPATH_SMOKE_VENUE_TOKEN }}");
    expect(authenticatedSmokeStep).toContain("PINTPATH_SMOKE_ADMIN_TOKEN: ${{ secrets.PINTPATH_SMOKE_ADMIN_TOKEN }}");

    const jobPrefix = source.slice(0, source.indexOf("    steps:"));
    expect(jobPrefix).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(jobPrefix).not.toContain("STRIPE_SECRET_KEY");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_USER_TOKEN");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_VENUE_TOKEN");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");
  });

  it("pins third-party actions to immutable commits", () => {
    for (const name of ["ci.yml", "native-apps.yml", "pintpath-release-readiness.yml", "pintpath-release-gate.yml"]) {
      const source = workflow(name);
      expect(source).not.toMatch(/uses:\s+[^\s]+@v\d+(?:\s|$)/);
    }
  });

  it("rebuilds native apps whenever their backend contract changes", () => {
    const source = workflow("native-apps.yml");
    for (const contractPath of [
      '"src/modules/business/**"',
      '"src/config/legal.ts"',
      '"src/config/business-rules.ts"',
      '"src/db/schema.sql"',
      '"test/native-mobile-remediation.test.ts"',
    ]) {
      expect(source.match(new RegExp(contractPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length)
        .toBe(2);
    }
  });

  it("checks the production admin queue against its real paginated response contract", () => {
    const source = workflow("production-health.yml");

    expect(source).toContain("/api/business/admin/queues?limit=1&offset=0");
    expect(source).toContain("data?.wrongPriceReports");
    expect(source).toContain("data?.pagination == null");
    expect(source).not.toContain('check_data /api/business/admin/queues "$PINTPATH_SMOKE_ADMIN_TOKEN" queues');
  });
});
