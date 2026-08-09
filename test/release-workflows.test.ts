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
    expect(evidenceValidator()).not.toContain('"android_release"');
  });

  it("requires authenticated production role checks and strict evidence in the manual release gate", () => {
    const source = workflow("pintpath-release-gate.yml");

    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toContain("expected_commercial_launch_enabled:");
    expect(source).toContain("environment: production");
    expect(source).toContain("fetch-depth: 0");
    expect(source).toContain("PINTPATH_SMOKE_USER_EMAIL: ${{ secrets.PINTPATH_SMOKE_USER_EMAIL }}");
    expect(source).toContain("PINTPATH_SMOKE_USER_PASSWORD: ${{ secrets.PINTPATH_SMOKE_USER_PASSWORD }}");
    expect(source).toContain("PINTPATH_SMOKE_VENUE_EMAIL: ${{ secrets.PINTPATH_SMOKE_VENUE_EMAIL }}");
    expect(source).toContain("PINTPATH_SMOKE_VENUE_PASSWORD: ${{ secrets.PINTPATH_SMOKE_VENUE_PASSWORD }}");
    expect(source).toContain("PINTPATH_SMOKE_ADMIN_TOKEN: ${{ secrets.PINTPATH_SMOKE_ADMIN_TOKEN }}");
    expect(source).toContain('PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "true"');
    expect(source).toContain("npm run --silent smoke:production | tee production-public-smoke.json");
    expect(source).toContain("npm run --silent smoke:production:auth");
    expect(source).not.toContain("npm run --silent readiness:launch");
    expect(source).toContain(
      "npm run --silent readiness:railway:sealed | tee railway-sealed-variable-readiness.json",
    );
    expect(source).toContain("npm run --silent readiness:data | tee production-data-readiness.json");
    expect(source).toContain("npm run --silent release:evidence:strict");
    const postgresRuntimeStep = source.match(
      /- name: Prove canonical PostgreSQL runtime selection[\s\S]*?(?=\n\s{6}- name:)/,
    )?.[0] || "";
    expect(postgresRuntimeStep).toContain("test/runtime-persistence.test.ts");
    expect(postgresRuntimeStep).toContain(
      "test/provider-readiness-reporting.test.ts",
    );
    expect(source).toContain("PINTPATH_EXPECTED_COMMIT_SHA: ${{ github.sha }}");
    expect(source).toContain('PINTPATH_ENFORCE_LAUNCH_FLAGS: "true"');
    expect(source).toContain('PINTPATH_EXPECTED_COMMERCIAL_LAUNCH_ENABLED: "false"');
    expect(source).not.toContain("inputs.expected_commercial_launch_enabled");
    expect(source).toContain("tested-commit-sha.txt");
    expect(productionSmoke()).toContain("deployment.commitSha");
    expect(productionSmoke()).toContain("exact 40-character lowercase commit SHA");
    expect(productionSmoke()).not.toContain("commitSha.startsWith");
    expect(productionSmoke()).not.toContain("expectedCommitSha.startsWith");
    expect(productionSmoke()).toContain('checkJson("launch_flags"');
    expect(productionSmoke()).toContain("rateLimiterRedis?.required === true");
    expect(productionSmoke()).toContain("rateLimiterRedis?.configured === true");
    expect(productionSmoke()).toContain("rateLimiterRedis?.ready === true");
    expect(productionSmoke()).toContain(
      'id: "postgres_logical_backup_attestation"',
    );
    expect(productionSmoke()).toContain('offsiteBackup?.status === "ok"');
    expect(productionSmoke()).toContain("offsiteBackup?.required === true");
    expect(productionSmoke()).toContain("offsiteBackup?.liveProbe === true");
    expect(productionSmoke()).toContain("data.consumerPaidEnrollmentEnabled === false");
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

    const readinessStep = source.match(/- name: Enforce permanent-staging sealed-variable metadata[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(readinessStep).toContain(
      "PINTPATH_RAILWAY_METADATA_TOKEN: ${{ secrets.PINTPATH_RAILWAY_METADATA_TOKEN }}",
    );
    expect(readinessStep).toContain("readiness:railway:sealed");
    expect(readinessStep).toContain("railway-sealed-variable-readiness.json");
    expect(readinessStep.match(/\$\{\{ secrets\./g)).toHaveLength(1);
    expect(readinessStep).not.toContain("DATABASE_URL");
    expect(readinessStep).not.toContain("REDIS_URL");
    expect(readinessStep).not.toContain("SUPABASE_");
    expect(readinessStep).not.toContain("SOURCE_EVIDENCE_SIGNING_SECRET");
    expect(source).not.toContain("provider-readiness-summary.json");

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

    const dataReadinessStep = source.match(/- name: Enforce production public data readiness[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(dataReadinessStep).toContain('PINTPATH_DATA_STRICT: "true"');
    expect(dataReadinessStep).toContain("PINTPATH_DATA_MARKETED_SUBURBS: ${{ vars.PINTPATH_DATA_MARKETED_SUBURBS }}");
    expect(dataReadinessStep).toContain('PINTPATH_DATA_MIN_MARKETED_VENUE_COVERAGE_PERCENT: "70"');
    expect(dataReadinessStep).toContain('PINTPATH_DATA_MIN_CURRENT_PRICES_PER_VENUE: "3"');
    expect(dataReadinessStep).toContain('PINTPATH_DATA_MAX_CORE_FRESHNESS_HOURS: "48"');
    expect(dataReadinessStep).toContain('PINTPATH_DATA_MAX_VENUE_STATUS_AGE_HOURS: "24"');
    expect(dataReadinessStep).toContain('PINTPATH_DATA_MAX_TRUSTED_ROW_AGE_DAYS: "30"');
    expect(dataReadinessStep).toContain('PINTPATH_DATA_MIN_HAPPY_HOUR_COVERAGE_PERCENT: "25"');
    expect(dataReadinessStep).toContain('PINTPATH_DATA_NO_HAPPY_HOUR_LAUNCH_SCOPE: "true"');
    expect(dataReadinessStep).toContain("PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE: ${{ vars.PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE }}");
    expect(dataReadinessStep).not.toContain("secrets.");
    expect(source).toContain("production-public-smoke.json");
    expect(source).toContain("production-data-readiness.json");

    const jobPrefix = source.slice(0, source.indexOf("    steps:"));
    expect(jobPrefix).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(jobPrefix).not.toContain("STRIPE_SECRET_KEY");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");
  });

  it("keeps sealed Railway readiness external, metadata-only, and policy-bound", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const gate = repositoryFile(
      "scripts/railway-sealed-variable-readiness.ts",
    );
    const providerReadiness = repositoryFile(
      "scripts/provider-readiness-check.ts",
    );
    const policy = repositoryFile(
      "ops/railway/permanent-staging-sealed-variable-policy.json",
    );
    const providerRunbook = releaseDocument(
      "provider-configuration-runbook.md",
    );
    const rotationRunbook = releaseDocument(
      "permanent-staging-private-auth-rotation.md",
    );
    const checklist = releaseDocument("release-readiness-checklist.md");
    const externalSignoffs = releaseDocument("external-launch-signoffs.md");

    expect(packageJson.scripts?.["readiness:railway:sealed"]).toBe(
      "tsx scripts/railway-sealed-variable-readiness.ts --policy ops/railway/permanent-staging-sealed-variable-policy.json",
    );
    expect(gate).toContain(
      '"https://backboard.railway.com/graphql/v2"',
    );
    expect(gate).toContain('"Project-Access-Token": token');
    expect(gate).toContain("first: 100");
    expect(gate).toContain("after: $after");
    expect(gate).toContain("isSealed");
    expect(gate).toContain("references");
    expect(gate).not.toContain("child_process");
    expect(providerReadiness).toContain(
      'id: "RAILWAY_DEPLOYED_READINESS_CONTEXT"',
    );
    expect(providerReadiness).toContain("RAILWAY_DEPLOYMENT_ID");
    expect(providerReadiness).toContain("RAILWAY_REPLICA_ID");
    expect(policy).not.toContain("postgresql://");
    expect(policy).not.toContain("redis://");
    expect(policy).not.toContain("supabase.co");
    for (const document of [providerRunbook, rotationRunbook, checklist]) {
      expect(document).toContain("readiness:railway:sealed");
      expect(document).toContain("permanent_staging_complete");
      expect(document).toContain("railway run");
    }
    expect(rotationRunbook).toContain(
      "not a prerequisite for the PostgreSQL-admin or\nRedis rotation",
    );
    expect(rotationRunbook).toContain("a prerequisite\nfor the first seal action");
    expect(externalSignoffs).toContain(
      "permanent-staging sealed-variable metadata JSON",
    );
    expect(externalSignoffs).toContain(
      "the GitHub runner must not regenerate them from duplicated application",
    );
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

  it("pins every workflow action to an audited immutable release", () => {
    const source = allWorkflows()
      .map(workflow)
      .join("\n");
    const expectedPins = new Map([
      ["actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0", 12],
      ["actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", 7],
      ["actions/setup-java@0f481fcb613427c0f801b606911222b5b6f3083a", 1],
      ["actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", 2],
      ["android-actions/setup-android@40fd30fb8d7440372e1316f5d1809ec01dcd3699", 1],
      ["github/codeql-action/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9", 1],
      ["github/codeql-action/autobuild@99df26d4f13ea111d4ec1a7dddef6063f76b97e9", 1],
      ["github/codeql-action/analyze@99df26d4f13ea111d4ec1a7dddef6063f76b97e9", 1],
      ["supabase/setup-cli@3c2f5e2ae34c34e428e8e206e2c4d21fa2d20fbf", 1],
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
    expect(checkoutIndexes).toHaveLength(12);
    for (const index of checkoutIndexes) {
      expect(lines.slice(index, index + 4).join("\n")).toContain("persist-credentials: false");
    }
  });

  it("rebuilds and tests the repository-owned Supabase schema in isolated CI", () => {
    const source = workflow("ci.yml");
    const databaseJob = source.slice(source.indexOf("  supabase-database:"));

    expect(databaseJob).toContain("uses: supabase/setup-cli@3c2f5e2ae34c34e428e8e206e2c4d21fa2d20fbf");
    expect(databaseJob).toContain("version: 2.109.1");
    expect(databaseJob).toContain("supabase db start");
    expect(databaseJob).toContain("supabase db reset --local");
    expect(databaseJob).toContain(
      "supabase db lint --local --schema public,private,pintpath_app,pintpath_ops --level warning --fail-on warning",
    );
    expect(databaseJob).toContain("supabase db advisors --local --type security --level warn --fail-on warn");
    expect(databaseJob).toContain("supabase db advisors --local --type performance --level warn --fail-on error");
    expect(databaseJob).toContain("supabase test db --local supabase/tests");
    expect(databaseJob).toContain("if: always()");
    expect(databaseJob).toContain("supabase stop --no-backup");
    expect(databaseJob).not.toContain("--linked");
    expect(databaseJob).not.toContain("supabase db push");
    expect(databaseJob).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(databaseJob).not.toContain("SUPABASE_DB_PASSWORD");
    expect(databaseJob).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("runs the real native Postgres contracts against an isolated PostgreSQL 17 service", () => {
    const source = workflow("ci.yml");
    const start = source.indexOf("  postgres-migration-integration:");
    const end = source.indexOf("\n  supabase-database:", start);
    const job = source.slice(start, end);

    expect(job).toContain("image: postgres:17.6-alpine");
    expect(job).toContain(
      "POSTGRES_INITDB_ARGS: --auth-local=trust --auth-host=scram-sha-256",
    );
    expect(job).toContain("PUBLIC_BASE_URL: http://localhost:3000");
    expect(job).toContain("pg_isready -U postgres -d postgres");
    expect(job).toContain("PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_ACCOUNT_SESSION_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_ACCOUNT_PROFILE_PREFERENCES_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_ACTIVITY_AUDIT_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_ACCOUNT_DELETION_QUEUE_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_ACCOUNT_PRIVACY_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_ACCOUNT_DELETION_RECOVERY_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_POSTGRES_ACCOUNT_DELETION_REPLAY_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_POSTGRES_PRIVATE_STORAGE_RECOVERY_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_BILLING_CHECKOUT_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_SUPPORT_FEEDBACK_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_VENUE_ACCESS_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_SOURCE_EVIDENCE_OBJECT_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_VENUE_MANAGER_INTERNAL_SUBMISSION_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("npm run db:postgres:schema:check");
    expect(job).toContain("npm run db:postgres:migration:contract:check");
    expect(job).toContain("npx vitest run test/postgres-migration-target.integration.test.ts");
    expect(job).toContain("npx vitest run test/postgres-logical-offsite-retrieval.integration.test.ts");
    expect(job).toContain("npx vitest run test/public-venue-directory.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-identity.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/system-state.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/account-session.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/account-profile-preferences.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/activity-audit.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/account-deletion-queue.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/account-privacy.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/postgres-account-deletion-recovery-fixture.integration.test.ts");
    expect(job).toContain("npx vitest run test/postgres-account-deletion-replay.integration.test.ts");
    expect(job).toContain("npx vitest run test/postgres-private-storage-recovery.integration.test.ts");
    expect(job).toContain("PINTPATH_STAGING_AUTH_PROBE_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_CI_POSTGRES_CONTAINER_ID: ${{ job.services.postgres.id }}");
    expect(job).toContain('PINTPATH_STAGING_AUTH_PROBE_TEST_REQUIRED: "true"');
    expect(job).toContain(
      'PATH="$GITHUB_WORKSPACE/scripts/ci:$PATH" npm run test:staging:auth:probe:pg17',
    );
    expect(job).toContain("npx vitest run test/privacy-retention.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/stripe-subscription.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/billing-checkout.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/public-price.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/community-submission.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/source-evidence-object.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/source-evidence-retention.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-manager-internal-submission.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-inventory.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-pending-change.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-data-read.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/support-feedback.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-access.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/mission-lifecycle.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/mission-discovery-automation.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-request.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-partner.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/admin-analytics.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/venue-manager-insights.repository.integration.test.ts");
    expect(job).toContain("npx vitest run test/admin-account.repository.integration.test.ts");
    expect(job).not.toContain("secrets.");
    expect(job).not.toContain("supabase db push");

    const migrationStatus = repositoryFile("docs/postgres-migration-execution-status.md");
    expect(migrationStatus).toContain("idx_accounts_admin_search_trgm");
    expect(migrationStatus).toContain("CREATE INDEX CONCURRENTLY");
    expect(migrationStatus).toContain("permanent staging");
  });

  it("uses the pinned PostgreSQL 17 client for the staging authentication probe contract", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const wrapperPath = path.resolve(process.cwd(), "scripts/ci/psql");
    const wrapper = repositoryFile("scripts/ci/psql");
    const runbook = releaseDocument(
      "permanent-staging-private-auth-rotation.md",
    );

    expect(packageJson.scripts?.["staging:auth:probe"]).toBe(
      "node dist/scripts/staging-private-auth-probe.js",
    );
    expect(packageJson.scripts?.["test:staging:auth:probe:pg17"]).toBe(
      "vitest run test/staging-private-auth-probe.integration.test.ts",
    );
    expect(wrapper).toContain("docker exec");
    expect(wrapper).toContain(
      'exec docker exec --interactive --user postgres "$container_id" sh -c',
    );
    expect(fs.statSync(wrapperPath).mode & 0o777).toBe(0o755);
    expect(wrapper).toContain("PINTPATH_CI_POSTGRES_CONTAINER_ID");
    expect(wrapper).toContain(
      '"6:-X -q -A -t --no-password --set=ON_ERROR_STOP=1"',
    );
    expect(wrapper).toContain(
      '"7:-X -q -A -t --no-password --set=ON_ERROR_STOP=1 --set=VERBOSITY=sqlstate"',
    );
    expect(wrapper).toContain('emit "${PGPASSWORD-}"');
    expect(wrapper).toContain("IFS= read -r PGPASSWORD");
    expect(wrapper).toContain("IFS= read -r PGREQUIREAUTH");
    expect(wrapper).toContain("unset PGCONNECT_TIMEOUT");
    expect(wrapper).toContain("unset PGAPPNAME");
    expect(wrapper).toContain("unset PGSSLROOTCERT");
    expect(wrapper).toContain("exec timeout -s KILL 9 psql");
    expect(wrapper).toContain("' sh \"$@\" < <(");
    expect(wrapper).not.toContain("3<&");
    expect(wrapper).not.toContain("--env");
    expect(wrapper).not.toContain("docker run");
    expect(wrapper).not.toContain("--network host");
    expect(wrapper).not.toContain("set -x");
    expect(runbook).toContain("live gate remains **OPEN**");
    expect(runbook).toContain("PGREQUIREAUTH=scram-sha-256");
    expect(runbook).toContain("watch-old-rejection");
    expect(runbook).toContain("fresh locked manual recovery point");
    expect(runbook).toContain("hard timeout\n  plus a 20-minute buffer");
    expect(runbook).toContain("never delete and guess at the schedule");
    expect(runbook).toContain("exact canonical file path");
    expect(runbook).toContain("Never run recursive `rg`, `grep`, `find`");
    expect(runbook).toContain("derive their phase from the reviewed mode");
    expect(runbook).not.toContain("derive their phase and reject a mismatch");
    expect(runbook).toContain("restartPolicyMaxRetries` value `1`");
    expect(runbook).not.toContain("with zero retries");
    expect(runbook).toContain(
      "with GraphQL `usePreviousImageTag: true`",
    );
    expect(runbook).toContain(
      "Ordinary\n  Railway CLI redeploy omits this flag",
    );
    expect(runbook).not.toContain("redeploy the already-reviewed built image");
    expect(runbook).not.toContain(
      "A fresh image digest is expected and is not, by itself, a mismatch",
    );
    expect(runbook).toContain(
      'RAILPACK_PACKAGES="node@22.23.2 postgres@17.10"',
    );
    expect(runbook).toContain(
      'RAILPACK_BUILD_APT_PACKAGES="... bison flex uuid-dev"',
    );
    expect(runbook).toContain(
      'RAILPACK_DEPLOY_APT_PACKAGES="... libicu72 libreadline8 libssl3 libuuid1 zlib1g"',
    );
    expect(runbook).toContain(
      "regional configuration requires at least one desired replica",
    );
    expect(runbook).not.toContain("zero desired replicas");
    const runtimeRotation = runbook.slice(
      runbook.indexOf("## Runtime-login rotation"),
      runbook.indexOf("## Template-admin and Redis rotation"),
    );
    expect(runtimeRotation).toContain(
      "direct non-grantable `CONNECT` on the hardened staging database",
    );
    expect(runtimeRotation).toContain(
      "retirement revoke that direct database grant",
    );
    expect(runtimeRotation.indexOf("configure A")).toBeGreaterThan(-1);
    expect(runtimeRotation.indexOf("configure A")).toBeLessThan(
      runtimeRotation.indexOf("With deploys skipped"),
    );
    const postgresAuthority = runtimeRotation.indexOf(
      "update only the\n   Postgres runtime-password authority",
    );
    const candidateVerification = runtimeRotation.indexOf(
      "Redeploy B so it resolves the successor reference",
    );
    const beerReference = runtimeRotation.indexOf(
      "update the Beer runtime\n   reference",
    );
    expect(postgresAuthority).toBeGreaterThan(-1);
    expect(candidateVerification).toBeGreaterThan(postgresAuthority);
    expect(beerReference).toBeGreaterThan(candidateVerification);
    expect(runtimeRotation.indexOf("retire-old-runtime")).toBeGreaterThan(
      beerReference,
    );
    expect(runtimeRotation).toContain("Never redeploy A after");
    expect(runbook).toContain("Regenerate password");
    expect(runbook).toContain(
      "Never\nrestore an exposed credential",
    );
  });

  it("keeps private Storage recovery provider-gated and bound to the local PG17 contract", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const runbook = releaseDocument("postgres-private-storage-recovery.md");

    expect(
      packageJson.scripts?.["db:postgres:backup:private-storage-recovery"],
    ).toBe("tsx scripts/capture-postgres-private-storage-recovery.ts");
    expect(
      packageJson.scripts?.["db:postgres:restore:private-storage-recovery"],
    ).toBe("tsx scripts/restore-postgres-private-storage-recovery.ts");
    expect(runbook).toContain("launch gates remain **OPEN**");
    expect(runbook).toContain("No Supabase, Railway, AWS, production, or");
    expect(runbook).toContain("retry with a fresh");
    expect(runbook).toContain("destinationDisposalRequired=true");
    expect(runbook).toContain("This foundation is not live recovery evidence");
  });

  it("pins development to the reviewed Node 22 runtime baseline", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      engines?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(repositoryFile(".node-version").trim()).toBe("22.23.2");
    expect(packageJson.engines?.node).toBe(">=22");
    expect(packageJson.devDependencies?.["@types/node"]).toMatch(/^\^22\./);
    for (const name of [
      "ci.yml",
      "pintpath-release-gate.yml",
      "pintpath-release-readiness.yml",
      "production-health.yml",
      "venue-directory-refresh.yml",
    ]) {
      expect(workflow(name), name).toContain("node-version: 22");
    }
  });

  it("refreshes every production Place ID daily with exact-target and fail-closed checks", () => {
    const source = workflow("venue-directory-refresh.yml");

    expect(source).toContain('cron: "23 14 * * *"');
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: production");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).toContain("PINTPATH_EXPECTED_SUPABASE_PROJECT_REF: jxpubqlmqnnqwadmjgyk");
    expect(source).toContain("GOOGLE_PLACES_API_KEY: ${{ secrets.GOOGLE_PLACES_API_KEY }}");
    expect(source.match(/--status-only/g)).toHaveLength(2);
    expect(source).toContain("--dry-run");
    expect(source).toContain('test "$actualProjectRef" = "$PINTPATH_EXPECTED_SUPABASE_PROJECT_REF"');
    expect(source).toContain("id: directory_schema");
    expect(source).toContain("20260728120312_venue_directory_operational_status");
    expect(source.match(/if: steps\.directory_schema\.outputs\.ready == 'true'/g)).toHaveLength(2);
    expect(source).toContain("if: always() && steps.directory_schema.outputs.ready == 'true'");
    expect(source).toContain("ageHours >= 120");
    expect(source).toContain("ageHours >= 138");
    expect(source).toContain("directory_eligible");
    expect(source).toContain('serviceRoleKey.startsWith("eyJ")');
    expect(source).toContain("if (isLegacyJwtKey)");
    expect(source).toContain("headers.Authorization = `Bearer ${serviceRoleKey}`");
    expect(source).not.toContain(
      "Authorization: `Bearer ${serviceRoleKey}`",
    );
    expect(source).not.toContain("upload-artifact");

    const jobPrefix = source.slice(0, source.indexOf("    steps:"));
    expect(jobPrefix).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(jobPrefix).not.toContain("GOOGLE_PLACES_API_KEY");
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

  it("always reports native checks for protected pull requests and main", () => {
    const source = workflow("native-apps.yml");

    expect(source).toContain("on:\n  pull_request:\n  push:");
    expect(source).toContain("branches:\n      - main");
    expect(source).not.toContain("paths:");
    expect(source).toContain("  ios:");
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
    expect(source).toContain('if [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" ]]; then');
    expect(source).toContain("Authenticated user/venue smoke credentials are required for a manual production-health proof.");
    expect(source).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");
    expect(source).not.toContain("PINTPATH_SMOKE_ADMIN_PASSWORD");
    expect(source).not.toContain("TOTP");
    const publicJob = source.slice(
      source.indexOf("  public-production-health:"),
      source.indexOf("  authenticated-user-venue-health:"),
    );
    expect(publicJob).toContain("npm run --silent readiness:data | tee production-data-readiness.json");
    expect(publicJob).toContain("PINTPATH_DATA_BASE_URL: https://pintpath.au");
    expect(publicJob).not.toContain("PINTPATH_DATA_STRICT");
    expect(publicJob).not.toContain("secrets.");

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

  it("keeps Railway production activation local while retaining deep staging readiness", () => {
    const railway = repositoryFile("railway.toml");
    const app = repositoryFile("src/app.ts");

    expect(railway).toContain('healthcheckPath = "/ready"');
    expect(railway).toContain('[environments.production.deploy]\nhealthcheckPath = "/startup"');
    expect(app).toContain("probeCapabilities: false");
    expect(app).toContain('logger.warn("Operational readiness check failed"');
  });

  it("keeps the future POS contract isolated from the current launch checklist", () => {
    const contract = releaseDocument("pos-integration-contract.md");
    const checklist = releaseDocument("external-launch-signoffs.md");

    expect(contract).toContain("posReference");
    expect(contract).not.toMatch(/POS[\s\S]{0,1600}`transactionReference`/);
    expect(contract).toContain("previousTokenValidUntil");
    expect(contract).toContain("10-minute handover window");
    expect(contract).toContain("pointsEarned: 0");
    expect(checklist).toContain("## 8. `moderation_operations`");
    expect(checklist).toContain("without enabling Pro, trial, paid, reward, counter, or POS");
    expect(checklist).not.toContain("posReference");
    expect(checklist).not.toContain("/api/business/pos/discount-redemptions");
  });

  it("keeps external closeout evidence aligned with workflow triggers and artifacts", () => {
    const checklist = releaseDocument("external-launch-signoffs.md");

    expect(checklist).toContain("Native Apps** must be manually dispatched");
    expect(checklist).toContain("-f run_android=false");
    expect(checklist).toContain("`ios-production-configuration` jobs to pass");
    expect(checklist).toContain("the Android job must be skipped");
    expect(checklist).toContain("security-scan and dependency-audit steps passed");
    expect(checklist).toContain("are not files in the artifact");
    expect(checklist).toContain("external TestFlight/Beta App Review");
    expect(checklist).toContain("full App Review approval");
    expect(checklist).toContain("Australia storefront");
    expect(checklist).toContain("manual release");
    expect(checklist).toContain("phased release");
    expect(checklist).toContain("approved build held");
    expect(checklist).not.toContain("does **not** prove public App Store approval");
    expect(checklist).not.toContain("production-track approval");
  });

  it("keeps iOS and venue-pilot evidence aligned with the full-scale release contract", () => {
    const evidence = releaseDocument("release-evidence.json");
    const iosReadme = repositoryFile("apps/ios/README.md");
    const mobileChecklist = repositoryFile("MOBILE_APP_STORE_CHECKLIST.md");

    for (const document of [evidence, iosReadme, mobileChecklist]) {
      const normalized = document.replace(/\s+/g, " ");
      expect(normalized).toContain("exact frozen candidate SHA");
      expect(normalized).toContain("external TestFlight");
      expect(normalized).toContain("Beta App Review");
      expect(normalized).toContain("full App Review approval");
      expect(normalized).toContain("Australia storefront");
      expect(normalized).toContain("manual release");
      expect(normalized).toContain("phased release");
      expect(normalized).toContain("approved build");
    }

    expect(evidence.match(/docs\/venue-pilot-runbook\.md/g)).toHaveLength(3);
    expect(evidence.match(/internal-only happy-hour/g)).toHaveLength(3);
    expect(evidence.match(/absence from public web\/iOS/g)).toHaveLength(3);
  });

  it("keeps one Postgres, staging, restore, and WORM contract for full-scale launch", () => {
    const launch = releaseDocument("production-launch-runbook.md");
    const migration = releaseDocument("full-scale-postgres-migration-runbook.md");
    const checklist = releaseDocument("external-launch-signoffs.md");
    const provider = releaseDocument("provider-configuration-runbook.md");
    const normalizedMigration = migration.replace(/\s+/g, " ");
    const evidence = JSON.parse(releaseDocument("release-evidence.json")) as {
      items?: Array<{ id?: string; label?: string; nextAction?: string }>;
    };
    const backup = evidence.items?.find((item) => item.id === "backup_restore");

    expect(launch).toContain("The availability decision is closed for this release");
    expect(launch).toContain("A controlled single-region SQLite launch is");
    expect(launch).toContain("not an alternative for this full-scale release");
    expect(launch).toContain("Permanent integrated staging");
    expect(launch).toContain("Ephemeral destructive restore staging");
    expect(launch).toContain("at least two application replicas");
    expect(launch).not.toContain("gh pr checks 12");
    expect(launch).not.toContain("jxpubqlmqnnqwadmjgyk");

    expect(normalizedMigration).toContain(
      "Status: **NO-GO — Free-live PostgreSQL application implementation plus the permanent-staging import/runtime/logical-backup and disposable database-restore receipt are complete; provider, app-deploy, scale, full recovery, promotion, and cutover evidence is not complete**",
    );
    expect(normalizedMigration).toContain(
      "Writable SQLite is limited to development/test tooling",
    );
    expect(normalizedMigration).toContain("non-exposed server-only application schema");
    expect(normalizedMigration).toContain("least-privilege runtime role");
    expect(normalizedMigration).toContain("FOR UPDATE SKIP LOCKED");
    expect(normalizedMigration).toContain("object-lock/WORM");
    expect(normalizedMigration).toContain("must never resume SQLite writes");

    expect(provider).toContain(
      "Identity pins always hash the exact configured DATABASE_URL bytes",
    );
    expect(provider).toContain("private operational restore copy");
    expect(checklist).toContain("newly created restore-only");
    expect(checklist).toContain("RESTORE_REHEARSAL_EXPECTED_*");
    expect(checklist).not.toMatch(/https:\/\/[a-z0-9]{20}\.supabase\.co/);
    expect(checklist).not.toContain("one app replica and one region");

    expect(backup?.label).toContain("Postgres, private Storage, and WORM");
    expect(backup?.nextAction).toContain("ephemeral destructive restore environment");
    expect(backup?.nextAction).toContain("distinct from production and permanent staging");
  });

  it("keeps the AWS Object Lock implementation pinned and its live authority gate open", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const ci = workflow("ci.yml");
    const stepStart = ci.indexOf(
      "      - name: Assert live AWS WORM integration remains explicitly gated",
    );
    const stepEnd = ci.indexOf("\n\n  postgres-migration-integration:", stepStart);
    const gatedStep = ci.slice(stepStart, stepEnd);
    const runbook = releaseDocument("postgres-logical-worm-attestation.md");
    const status = releaseDocument("postgres-migration-execution-status.md");
    const implementation = repositoryFile("src/lib/postgres-logical-worm.ts");

    expect(packageJson.scripts?.["db:postgres:backup:logical:worm"])
      .toBe("tsx scripts/attest-postgres-logical-worm.ts");
    expect(packageJson.scripts?.["test:db:postgres:backup:logical:worm:aws"])
      .toBe("vitest run test/postgres-logical-worm.integration.test.ts");
    for (const dependency of [
      "@aws-sdk/client-s3",
      "@aws-sdk/client-sts",
      "@aws-sdk/credential-providers",
    ]) expect(packageJson.dependencies?.[dependency], dependency).toBe("3.1098.0");

    expect(stepStart).toBeGreaterThan(-1);
    expect(gatedStep).toContain('PINTPATH_TEST_POSTGRES_LOGICAL_WORM_AWS: "disabled"');
    expect(gatedStep).toContain('PINTPATH_POSTGRES_LOGICAL_WORM: "disabled"');
    expect(gatedStep).toContain('PINTPATH_POSTGRES_LOGICAL_WORM_AWS: "disabled"');
    expect(gatedStep).toContain("npm run test:db:postgres:backup:logical:worm:aws");
    expect(gatedStep).not.toContain("secrets.");
    expect(gatedStep).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);

    expect(runbook).toContain("IMPLEMENTED, NOT PROVISIONED");
    expect(runbook).toContain("The launch gate remains **OPEN**");
    expect(runbook).toContain("No AWS account, bucket, role, credential, or object was created");
    expect(status).toContain("This is implementation evidence only");
    expect(status).toContain("no AWS recovery account, bucket, role, credential, or object was provisioned");
    expect(implementation).toContain('Action: "s3:PutObject"');
    expect(implementation).toContain('"s3:if-none-match": "*"');
    expect(implementation).toContain("POSTGRES_LOGICAL_WORM_RETENTION_DAYS = 30");
    expect(implementation).toContain('POSTGRES_LOGICAL_WORM_REGION = "ap-southeast-4"');
  });

  it("keeps the launch runbook aligned with all 12 required evidence IDs", () => {
    const runbook = releaseDocument("production-launch-runbook.md");
    const evidence = JSON.parse(releaseDocument("release-evidence.json")) as {
      items?: Array<{ id?: string }>;
    };
    const requiredIds = (evidence.items ?? [])
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));

    expect(requiredIds).toHaveLength(12);
    for (const id of requiredIds) expect(runbook).toContain(`- \`${id}\`;`);
    expect(runbook).toContain("Complete all 12 web-and-iOS evidence items from Phase 14.");
    expect(runbook).not.toContain("Complete all 11 web-and-iOS evidence items");
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

  it("documents the isolated Postgres account-deletion rehearsal readiness command", () => {
    const runbook = releaseDocument("production-launch-runbook.md");
    const providerReadiness = repositoryFile("scripts/provider-readiness-check.ts");

    expect(runbook).toContain('test -z "${OFFSITE_BACKUP_SUPABASE_URL:-}${OFFSITE_BACKUP_SERVICE_ROLE_KEY:-}"');
    expect(runbook).toContain('test -n "${REDIS_URL:-}"');
    expect(runbook).toContain('test "${REQUIRE_REDIS_RATE_LIMITING:?}" = "true"');
    expect(runbook).toContain('test "${ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION:-false}" = "false"');
    expect(runbook).toContain("move account-deletion requests, outbox, recipient");
    expect(runbook).toContain("at least two replicas");
    expect(runbook).toContain("npm run --silent readiness:providers");
    expect(runbook).toContain('.readinessProfile == "account_deletion_rehearsal" and .ok == true');
    expect(runbook).toContain('"${PUBLIC_BASE_URL%/}/ready"');
    expect(providerReadiness).toContain("storageCanariesAllowed && !preflightBlocked");
    expect(providerReadiness).toContain("permanentStagingCompleteChecks");
    expect(providerReadiness).toContain("permanent_staging_identity_bootstrap_incomplete");
    expect(providerReadiness).toContain("permanent_staging_complete");
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
