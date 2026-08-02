import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function workflow(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), ".github/workflows", name), "utf8");
}

function allWorkflows(): string[] {
  return fs.readdirSync(path.resolve(process.cwd(), ".github/workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
}

function evidenceValidator(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "scripts/validate-release-evidence.ts"), "utf8");
}

function productionSmoke(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "scripts/production-smoke-check.mjs"), "utf8");
}

function releaseDocument(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "docs", name), "utf8");
}

function repositoryFile(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), name), "utf8");
}

describe("release workflow contracts", () => {
  it("keeps ordinary CI informative and makes manual readiness checks strict", () => {
    const source = workflow("pintpath-release-readiness.yml");

    expect(source).toContain("name: Pint Path Automated Readiness");
    expect(source).toContain("fetch-depth: 0");
    expect(source).toContain("npm run test:e2e:pintpath");
    expect(source).toContain("npm run --silent release:evidence | tee release-evidence-summary.json");
    expect(source).toContain("npm run --silent release:evidence:strict | tee release-evidence-summary.json");
    expect(source).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(evidenceValidator()).toContain("ok: launchReady");
    expect(evidenceValidator()).toContain("launchReady,");
    expect(evidenceValidator()).toContain("expectedRequiredIds");
    expect(evidenceValidator()).toContain("duplicateIds");
    expect(evidenceValidator()).toContain("missingRequiredIds");
    expect(evidenceValidator()).toContain("unexpectedIds");
    expect(evidenceValidator()).toContain("isoTimestamp");
  });

  it("requires authenticated production role checks and strict evidence in the manual release gate", () => {
    const source = workflow("pintpath-release-gate.yml");

    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: production");
    expect(source).toContain("fetch-depth: 0");
    expect(source).toContain("PINTPATH_SMOKE_USER_EMAIL: ${{ secrets.PINTPATH_SMOKE_USER_EMAIL }}");
    expect(source).toContain("PINTPATH_SMOKE_USER_PASSWORD: ${{ secrets.PINTPATH_SMOKE_USER_PASSWORD }}");
    expect(source).toContain("PINTPATH_SMOKE_VENUE_EMAIL: ${{ secrets.PINTPATH_SMOKE_VENUE_EMAIL }}");
    expect(source).toContain("PINTPATH_SMOKE_VENUE_PASSWORD: ${{ secrets.PINTPATH_SMOKE_VENUE_PASSWORD }}");
    expect(source).toContain("PINTPATH_SMOKE_ADMIN_TOKEN: ${{ secrets.PINTPATH_SMOKE_ADMIN_TOKEN }}");
    expect(source).toContain('PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "true"');
    expect(source).toContain("npm run --silent smoke:production:auth");
    expect(source).toContain("npm run --silent readiness:launch");
    expect(source).toContain("npm run --silent release:evidence:strict");
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
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");

    const readinessStep = source.match(/- name: Enforce production provider readiness[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(readinessStep).toContain("NODE_ENV: production");
    expect(readinessStep).toContain("SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}");
    expect(readinessStep).toContain("STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}");

    const authenticatedSmokeStep = source.match(/- name: Verify authenticated production roles[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(authenticatedSmokeStep).toContain("PINTPATH_SMOKE_USER_EMAIL: ${{ secrets.PINTPATH_SMOKE_USER_EMAIL }}");
    expect(authenticatedSmokeStep).toContain("PINTPATH_SMOKE_USER_PASSWORD: ${{ secrets.PINTPATH_SMOKE_USER_PASSWORD }}");
    expect(authenticatedSmokeStep).toContain("PINTPATH_SMOKE_VENUE_EMAIL: ${{ secrets.PINTPATH_SMOKE_VENUE_EMAIL }}");
    expect(authenticatedSmokeStep).toContain("PINTPATH_SMOKE_VENUE_PASSWORD: ${{ secrets.PINTPATH_SMOKE_VENUE_PASSWORD }}");
    expect(authenticatedSmokeStep).toContain("PINTPATH_SMOKE_ADMIN_TOKEN: ${{ secrets.PINTPATH_SMOKE_ADMIN_TOKEN }}");
    expect(authenticatedSmokeStep).toContain("SUPABASE_URL: ${{ secrets.SUPABASE_URL }}");
    expect(authenticatedSmokeStep).toContain("SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}");
    expect(authenticatedSmokeStep).not.toContain("PINTPATH_SMOKE_ADMIN_PASSWORD");
    expect(authenticatedSmokeStep).not.toContain("TOTP");

    const jobPrefix = source.slice(0, source.indexOf("    steps:"));
    expect(jobPrefix).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(jobPrefix).not.toContain("STRIPE_SECRET_KEY");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");
  });

  it("pins third-party actions to immutable commits", () => {
    for (const name of allWorkflows()) {
      const source = workflow(name);
      expect(source).not.toMatch(/uses:\s+[^\s]+@v\d+(?:\s|$)/);
    }
  });

  it("fetches commit history wherever release-evidence validation runs", () => {
    for (const name of ["ci.yml", "pintpath-release-readiness.yml", "pintpath-release-gate.yml"]) {
      expect(workflow(name), name).toContain("fetch-depth: 0");
    }
  });

  it("pins every JavaScript action to the audited Node 24 release", () => {
    const source = allWorkflows()
      .map(workflow)
      .join("\n");
    const expectedPins = new Map([
      ["actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0", 8],
      ["actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", 5],
      ["actions/setup-java@0f481fcb613427c0f801b606911222b5b6f3083a", 1],
      ["actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", 2],
      ["android-actions/setup-android@40fd30fb8d7440372e1316f5d1809ec01dcd3699", 1],
      ["github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9", 1],
      ["github/codeql-action/autobuild@99df26d4f13ea111d4ec1a7dddef6063f76b97e9", 1],
      ["github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9", 1],
    ]);
    const actionReferences = [...source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map((match) => match[1]!);

    expect(actionReferences).toHaveLength([...expectedPins.values()].reduce((total, count) => total + count, 0));
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      expect(expectedPins.has(reference), reference).toBe(true);
    }
    for (const [pin, count] of expectedPins) expect(actionReferences.filter((reference) => reference === pin)).toHaveLength(count);

    const lines = source.split("\n");
    const checkoutIndexes = lines
      .map((line, index) => line.includes("uses: actions/checkout@") ? index : -1)
      .filter((index) => index >= 0);
    expect(checkoutIndexes).toHaveLength(8);
    for (const index of checkoutIndexes) {
      expect(lines.slice(index, index + 4).join("\n")).toContain("persist-credentials: false");
    }
  });

  it("keeps development types and CI on the production Node 22 baseline", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      engines?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(repositoryFile(".node-version").trim()).toBe("22");
    expect(packageJson.engines?.node).toBe(">=22");
    expect(packageJson.devDependencies?.["@types/node"]).toMatch(/^\^22\./);
    for (const name of [
      "ci.yml",
      "pintpath-release-gate.yml",
      "pintpath-release-readiness.yml",
      "production-health.yml",
    ]) {
      expect(workflow(name), name).toContain("node-version: 22");
    }
  });

  it("fails CI for dependency vulnerabilities at every npm severity", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["security:audit"]).toBe("npm audit --audit-level=low");
    expect(workflow("ci.yml")).toContain("npm run security:audit");
  });

  it("checksum-pins the Android Gradle distribution", () => {
    const wrapper = repositoryFile("apps/android/gradle/wrapper/gradle-wrapper.properties");

    expect(wrapper).toContain("distributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip");
    expect(wrapper).toContain(
      "distributionSha256Sum=d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab",
    );
  });

  it("does not let tee hide a failed release command", () => {
    for (const name of allWorkflows()) {
      const lines = workflow(name).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.includes("| tee")) continue;
        expect(lines.slice(Math.max(0, index - 3), index).join("\n"), `${name}:${index + 1}`)
          .toContain("set -o pipefail");
      }
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

  it("separates public availability from disposable user and venue authenticated monitoring", () => {
    const source = workflow("production-health.yml");

    expect(source).toContain("public-production-health:");
    expect(source).toContain("authenticated-user-venue-health:");
    expect(source).toContain("environment: production");
    expect(source).toContain('cron: "*/15 * * * *"');
    expect(source).toContain('cron: "7 * * * *"');
    expect(source).toContain("Public production health is checked separately and this is not evidence of a public outage.");
    expect(source).toContain("PINTPATH_SMOKE_USER_EMAIL: ${{ secrets.PINTPATH_SMOKE_USER_EMAIL }}");
    expect(source).toContain("PINTPATH_SMOKE_USER_PASSWORD: ${{ secrets.PINTPATH_SMOKE_USER_PASSWORD }}");
    expect(source).toContain("PINTPATH_SMOKE_VENUE_EMAIL: ${{ secrets.PINTPATH_SMOKE_VENUE_EMAIL }}");
    expect(source).toContain("PINTPATH_SMOKE_VENUE_PASSWORD: ${{ secrets.PINTPATH_SMOKE_VENUE_PASSWORD }}");
    expect(source).toContain("SUPABASE_URL: ${{ secrets.SUPABASE_URL }}");
    expect(source).toContain("SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}");
    expect(source).toContain("--auth-only --roles=user,venue");
    expect(source).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");
    expect(source).not.toContain("PINTPATH_SMOKE_ADMIN_PASSWORD");
    expect(source).not.toContain("TOTP");

    const authenticatedJobPrefix = source.match(/authenticated-user-venue-health:[\s\S]*?steps:/)?.[0] || "";
    expect(authenticatedJobPrefix).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(authenticatedJobPrefix).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(authenticatedJobPrefix).not.toContain("SUPABASE_URL: ${{ secrets.SUPABASE_URL }}");
    expect(authenticatedJobPrefix).not.toContain("SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}");
    const checkoutStep = source.match(/- name: Checkout[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    const setupNodeStep = source.match(/- name: Setup Node[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(checkoutStep).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(checkoutStep).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(setupNodeStep).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(setupNodeStep).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(checkoutStep).not.toContain("SUPABASE_URL: ${{ secrets.SUPABASE_URL }}");
    expect(checkoutStep).not.toContain("SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}");
    expect(setupNodeStep).not.toContain("SUPABASE_URL: ${{ secrets.SUPABASE_URL }}");
    expect(setupNodeStep).not.toContain("SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}");

    const smoke = productionSmoke();
    expect(smoke).toContain('path: "/api/business/admin/queues?limit=1&offset=0"');
    expect(smoke).toContain("Array.isArray(data.wrongPriceReports)");
    expect(smoke).toContain("/api/business/auth/supabase-session");
    expect(smoke).toContain("/api/business/auth/logout");
    expect(smoke).toContain("Public Supabase URL does not match protected SUPABASE_URL");
    expect(smoke).toContain("Public Supabase key does not match protected SUPABASE_ANON_KEY");
  });

  it("does not mix failed retry bodies into successful production health JSON", () => {
    const source = workflow("production-health.yml");
    const monitor = repositoryFile("scripts/production-health-check.mjs");

    expect(source).toContain("node scripts/production-health-check.mjs");
    expect(source).not.toContain("curl --retry");
    expect(monitor).toContain("readinessAttempts: 6");
    expect(monitor).toContain("readinessRetryDelayMs: 15_000");
    expect(monitor).toContain("SAFE_DEPENDENCY_FIELDS");
    expect(monitor).not.toContain("body.slice");
  });

  it("keeps Railway production activation local while retaining deep non-production readiness", () => {
    const railway = repositoryFile("railway.toml");
    const app = repositoryFile("src/app.ts");

    expect(railway).toContain('healthcheckPath = "/ready"');
    expect(railway).toContain('[environments.production.deploy]\nhealthcheckPath = "/health"');
    expect(app).toContain("probeCapabilities: false");
    expect(app).toContain('logger.warn("Operational readiness check failed"');
  });

  it("documents the live POS reference, rotation, and discount-only contract", () => {
    const contract = releaseDocument("pos-integration-contract.md");
    const checklist = releaseDocument("external-launch-signoffs.md");

    for (const source of [contract, checklist]) {
      expect(source).toContain("posReference");
      expect(source).not.toMatch(/POS[\s\S]{0,1600}`transactionReference`/);
    }
    expect(contract).toContain("previousTokenValidUntil");
    expect(contract).toContain("10-minute handover window");
    expect(contract).toContain("pointsEarned: 0");
    expect(checklist).toContain("does not award Pint Points");
  });

  it("keeps external closeout evidence aligned with workflow triggers and artifacts", () => {
    const checklist = releaseDocument("external-launch-signoffs.md");

    expect(checklist).toContain("Native Apps** must be manually dispatched");
    expect(checklist).toContain("documentation-only pushes do not match its path filters");
    expect(checklist).toContain("security-scan and dependency-audit steps passed");
    expect(checklist).toContain("are not files in the artifact");
    expect(checklist).toContain("does **not** prove public App Store approval");
    expect(checklist).toContain("does **not** prove production-track approval");
  });

  it("keeps machine-readable launch scripts free of dotenv banner text", () => {
    for (const filename of [
      "src/config/env.ts",
      "scripts/backup-data-offsite.ts",
      "scripts/backup-data.ts",
      "scripts/benchmark-menu-ocr.ts",
      "scripts/provider-readiness-check.ts",
      "scripts/rehearse-data-restore.ts",
    ]) {
      expect(repositoryFile(filename), filename).toContain("dotenv.config({ quiet: true })");
    }
  });

  it("uses the repository SDK downloader without credentialed runtime package downloads", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const checklist = releaseDocument("external-launch-signoffs.md");
    const runbook = releaseDocument("provider-configuration-runbook.md");
    const downloader = repositoryFile("scripts/download-offsite-backup.ts");

    expect(packageJson.scripts?.["data:backup:download-offsite"])
      .toBe("tsx scripts/download-offsite-backup.ts");
    expect(packageJson.devDependencies?.supabase).toBeUndefined();
    expect(downloader).not.toContain("dotenv");
    expect(downloader).not.toContain("OFFSITE_BACKUP_SERVICE_ROLE_KEY");

    for (const document of [checklist, runbook]) {
      expect(document).toContain("data:backup:download-offsite");
      expect(document).toContain('--service-role-key-file="$OFFSITE_BACKUP_SECRET_KEY_FILE"');
      expect(document).toContain('--expected-manifest-sha256="$EXPECTED_MANIFEST_SHA256"');
      expect(document).not.toContain("./node_modules/.bin/supabase");
      expect(document).not.toContain("--experimental");
      expect(document).not.toContain("storage cp");
      expect(document).not.toContain("SUPABASE_PROJECT_ID");
      expect(document).not.toContain("SUPABASE_AUTH_SERVICE_ROLE_KEY");
      expect(document).not.toContain("OFFSITE_BACKUP_PROJECT_REF");
    }

    expect(checklist).toContain('test -f "$BACKUP_PATH/manifest.json"');
    expect(checklist).toContain("offsite-backup-download.json");
    expect(checklist).toContain("offsite-backup-manifest.sha256");
    expect(checklist).toContain(".manifestSha256 == $manifestSha256");
  });

  it("keeps smoke bearer tokens out of process arguments", () => {
    const checklist = releaseDocument("external-launch-signoffs.md");

    expect(checklist).toContain('jq -nc --rawfile accessToken "$TOKEN_FILE"');
    expect(checklist).toContain("--data-binary @-");
    expect(checklist).not.toContain("--arg accessToken");
    expect(checklist).not.toContain('SUPABASE_ACCESS_TOKEN="$(');
  });
});
