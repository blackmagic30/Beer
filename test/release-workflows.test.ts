import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function workflow(name: string): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), ".github/workflows", name),
    "utf8",
  );
}

function allWorkflows(): string[] {
  return fs
    .readdirSync(path.resolve(process.cwd(), ".github/workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
}

function workflowJobContaining(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  const jobsIndex = source.search(/^jobs:\s*$/m);
  if (markerIndex < 0 || jobsIndex < 0 || markerIndex <= jobsIndex) return "";

  const jobStarts = [...source.matchAll(/^  [A-Za-z0-9_-]+:\s*$/gm)]
    .map((match) => match.index ?? -1)
    .filter((index) => index > jobsIndex);
  const jobStart = [...jobStarts]
    .reverse()
    .find((index) => index < markerIndex);
  if (jobStart === undefined) return "";

  const nextJobStart = jobStarts.find((index) => index > jobStart);
  return source.slice(jobStart, nextJobStart ?? source.length);
}

function workflowSecretNames(source: string): string[] {
  return [...source.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map(
    (match) => match[1]!,
  );
}

function evidenceValidator(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), "scripts/validate-release-evidence.ts"),
    "utf8",
  );
}

function productionSmoke(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), "scripts/production-smoke-check.mjs"),
    "utf8",
  );
}

function releaseDocument(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "docs", name), "utf8");
}

function repositoryFile(name: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), name), "utf8");
}

function repositoryFileSha256(name: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.resolve(process.cwd(), name)))
    .digest("hex");
}

describe("release workflow contracts", () => {
  it("keeps staging and production app upload behind protected exact-SHA workflows", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const executor = repositoryFile(
      "scripts/lib/permanent-staging-app-deployment-executor.ts",
    );
    const wrapper = repositoryFile(
      "scripts/execute-permanent-staging-app-deployment.ts",
    );
    const stagingPolicy = repositoryFile(
      "ops/railway/permanent-staging-app-deployment-policy.json",
    );
    const productionPolicy = repositoryFile(
      "ops/railway/production-app-deployment-policy.json",
    );
    const stagingPolicyValue = JSON.parse(stagingPolicy) as {
      schemaVersion: string;
      target: { allowedReplicaCounts: number[] };
    };
    const productionPolicyValue = JSON.parse(productionPolicy) as {
      schemaVersion: string;
      target: { allowedReplicaCounts: number[] };
      prerequisite: { expectedReplicaCount: number };
    };
    const stagingWorkflow = workflow("deploy-permanent-staging.yml");
    const productionWorkflow = workflow("deploy-production.yml");
    const releaseGate = workflow("pintpath-release-gate.yml");
    const requiredChecks = repositoryFile(
      ".github/release-required-checks.json",
    );
    const requiredChecksPolicy = JSON.parse(requiredChecks) as {
      schemaVersion: string;
      requiredChecks: {
        base: Array<{ name: string; workflowPath: string; event: string }>;
        staging: Array<{ name: string; workflowPath: string; event: string }>;
        production: Array<{
          name: string;
          workflowPath: string;
          event: string;
        }>;
      };
      requiredArtifacts: { staging: string[]; production: string[] };
    };

    expect(packageJson.scripts?.["railway:staging:app:deploy"]).toBe(
      "tsx scripts/execute-permanent-staging-app-deployment.ts --policy ops/railway/permanent-staging-app-deployment-policy.json",
    );
    expect(packageJson.scripts?.["railway:production:app:deploy"]).toBe(
      "tsx scripts/execute-permanent-staging-app-deployment.ts --policy ops/railway/production-app-deployment-policy.json",
    );
    expect(packageJson.scripts?.test).toBe("vitest run test --maxWorkers=1");
    expect(packageJson.scripts?.["permanent-staging:cost:contract:check"]).toBe(
      "vitest run test/permanent-staging-cost-policy.test.ts test/permanent-staging-app-deployment-executor.test.ts",
    );
    for (const policy of [stagingPolicy, productionPolicy]) {
      expect(policy).toContain(
        '"activationState": "GITHUB_ENVIRONMENT_PROTECTED"',
      );
      expect(policy).toContain('"transportImplemented": true');
      expect(policy).toContain('"exactTargetTokenScopeRequired": true');
      expect(policy).toContain('"maximumWriteAttempts": 1');
      expect(policy).toContain('"automaticRetryAllowed": false');
      expect(policy).toContain('"adjacentMutationAllowed": false');
      expect(policy).toContain('"topologyMutationAllowed": false');
      expect(policy).toContain('"replicaCountMustMatchPreflight": true');
      expect(policy).toContain('"requiredRuntimeRoutes"');
    }
    expect(stagingPolicy).toContain('"name": "permanent-staging"');
    expect(stagingPolicyValue.schemaVersion).toBe(
      "pintpath-railway-application-deployment-policy/v5",
    );
    expect(stagingPolicyValue.target.allowedReplicaCounts).toEqual([1]);
    expect(stagingPolicy).toContain(
      '"policySha256": "57984ced59fa356baa9c19ac1e5018dad9c52829a6d7cc95a05cbd52112ddf86"',
    );
    expect(stagingPolicy).toContain(
      '"deploymentMayClaimCostGatePassed": false',
    );
    expect(stagingPolicy).toContain('"receiptMayAuthorizeDeployment": false');
    expect(productionPolicy).toContain('"name": "production"');
    expect(productionPolicy).toContain('"sameCandidateRequired": true');
    expect(productionPolicyValue.schemaVersion).toBe(
      "pintpath-railway-application-deployment-policy/v5",
    );
    expect(productionPolicyValue.target.allowedReplicaCounts).toEqual([1, 2]);
    expect(productionPolicyValue.prerequisite.expectedReplicaCount).toBe(1);
    expect(executor).toContain('from "node:child_process"');
    expect(executor).toContain('dependencies.env.GITHUB_ACTIONS !== "true"');
    expect(executor).toContain('"READ_ONLY_RECONCILIATION_NO_RETRY"');
    expect(executor).toContain('"/health", "/startup", "/ready"');
    expect(executor).toContain("writeAttempts = 1");
    expect(executor).not.toContain("serviceInstanceDeploy");
    expect(executor).not.toContain("deploymentRollback");
    expect(wrapper).toContain("fileURLToPath(import.meta.url)");
    expect(wrapper).not.toContain("node:child_process");

    for (const source of [stagingWorkflow, productionWorkflow]) {
      expect(source).toContain("workflow_dispatch:");
      expect(source).toContain("candidate_sha:");
      expect(source).toContain('test "$DISPATCH_REF" = "refs/heads/main"');
      expect(source).toContain('test "$RUN_ATTEMPT" = "1"');
      expect(
        source.match(
          /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/g,
        ),
      ).toHaveLength(2);
      expect(source).toContain(
        'test "$(git rev-parse refs/remotes/origin/main)" = "$CANDIDATE_SHA"',
      );
      expect(source).toContain("npm run check");
      expect(source).toContain("github:release-candidate:verify");
      expect(
        source.indexOf("Create the private deployment evidence directory"),
      ).toBeLessThan(source.indexOf("github:release-candidate:verify"));
      expect(source).toContain(
        "railway-v5.32.0-x86_64-unknown-linux-musl.tar.gz",
      );
      expect(source).toContain(
        "cd69b2ecb556601751165d85ac31a5fbc38cff46397939356df28d2b96a005f5",
      );
      expect(source).toContain(
        "27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43",
      );
      expect(source).toContain("if-no-files-found: error");
      expect(source).not.toContain("continue-on-error:");
    }
    expect(stagingWorkflow).toContain(
      "environment: permanent-staging-deployment",
    );
    expect(stagingWorkflow).toContain(
      "PUBLIC_BASE_URL: https://beer-staging.up.railway.app",
    );
    expect(stagingWorkflow).toContain(
      "Require the policy-pinned permanent-staging public origin",
    );
    expect(stagingWorkflow).toContain(
      'require("./ops/railway/permanent-staging-app-deployment-policy.json").target.publicOrigin',
    );
    expect(stagingWorkflow).not.toContain("vars.PUBLIC_BASE_URL");
    expect(stagingWorkflow).toContain("PINTPATH_RAILWAY_STAGING_DEPLOY_TOKEN");
    expect(stagingWorkflow).toContain("railway:staging:app:deploy");
    expect(productionWorkflow).toContain("environment: production-deployment");
    expect(productionWorkflow).toContain(
      "PUBLIC_BASE_URL: https://pintpath.au",
    );
    expect(productionWorkflow).toContain(
      "Require the policy-pinned production public origin",
    );
    expect(productionWorkflow).not.toContain("vars.PUBLIC_BASE_URL");
    expect(productionWorkflow).toContain(
      "PINTPATH_RAILWAY_PRODUCTION_DEPLOY_TOKEN",
    );
    expect(productionWorkflow).toContain("railway:production:app:deploy");
    expect(productionWorkflow).toContain("npm run --silent release:evidence");
    expect(productionWorkflow).not.toContain("release:evidence:strict");
    expect(productionWorkflow).toContain(
      "PINTPATH_PRODUCTION_PROVIDER_READINESS_ENVELOPE_BASE64",
    );
    expect(productionWorkflow).toContain(
      "production:provider-readiness:receipt:verify",
    );
    expect(productionWorkflow).toContain(
      "${{ runner.temp }}/github-candidate-evidence/provider-readiness-verification.json",
    );
    expect(productionWorkflow).toContain("trap cleanup_private_readiness EXIT");
    expect(productionWorkflow).toContain(
      "test/provider-readiness-reporting.test.ts",
    );
    expect(
      productionWorkflow.indexOf("npm run --silent release:evidence"),
    ).toBeLessThan(
      productionWorkflow.indexOf("PINTPATH_RAILWAY_PRODUCTION_DEPLOY_TOKEN"),
    );
    expect(
      productionWorkflow.indexOf(
        "production:provider-readiness:receipt:verify",
      ),
    ).toBeLessThan(
      productionWorkflow.indexOf("PINTPATH_RAILWAY_PRODUCTION_DEPLOY_TOKEN"),
    );
    expect(
      productionWorkflow.indexOf("Reassert current main immediately"),
    ).toBeLessThan(
      productionWorkflow.indexOf("PINTPATH_RAILWAY_PRODUCTION_DEPLOY_TOKEN"),
    );
    expect(stagingWorkflow).not.toContain("release:evidence:strict");
    expect(stagingWorkflow).not.toContain(
      "PRODUCTION_PROVIDER_READINESS_ENVELOPE",
    );
    expect(requiredChecks).toContain("Deploy permanent staging");
    expect(requiredChecks).toContain("Deploy protected production");
    expect(requiredChecks).toContain("Scale 1→2, prove, and converge 2→1");
    expect(requiredChecks).toContain(
      "Converge exact production deployment to two replicas",
    );
    expect(requiredChecks).toContain("Close exact production route");
    expect(requiredChecks).toContain(
      "Activate exact production promotion recovery",
    );
    expect(requiredChecks).toContain(
      "Attest protected production promotion and recovery",
    );
    expect(requiredChecks).toContain("Open exact production route");
    expect(requiredChecks).toContain(
      "iOS protected production configuration archive",
    );
    expect(requiredChecks).not.toContain('"android"');
    expect(requiredChecks).toContain(
      "pintpath-permanent-staging-deployment-{candidateSha}",
    );
    expect(requiredChecks).toContain(
      "pintpath-permanent-staging-scale-evidence-{candidateSha}",
    );
    expect(requiredChecks).toContain(
      "pintpath-production-scale-evidence-{candidateSha}",
    );
    expect(requiredChecks).toContain(
      "pintpath-production-deployment-{candidateSha}",
    );
    expect(requiredChecks).toContain(
      "pintpath-production-route-close-{candidateSha}",
    );
    expect(requiredChecks).toContain(
      "pintpath-production-promotion-recovery-activation-{candidateSha}",
    );
    expect(requiredChecks).toContain(
      "pintpath-production-route-open-{candidateSha}",
    );
    expect(requiredChecks).toContain(
      "pintpath-production-promotion-recovery-{candidateSha}",
    );
    expect(requiredChecksPolicy.schemaVersion).toBe(
      "pintpath-github-release-required-checks/v3",
    );
    expect(
      requiredChecksPolicy.requiredChecks.staging.map((check) => check.name),
    ).not.toContain("Converge exact production deployment to two replicas");
    expect(
      requiredChecksPolicy.requiredArtifacts.staging.map(
        (artifact) => artifact.name,
      ),
    ).not.toContain("pintpath-production-scale-evidence-{candidateSha}");
    expect(
      requiredChecksPolicy.requiredChecks.production.map((check) => check.name),
    ).toContain("Converge exact production deployment to two replicas");
    expect(
      requiredChecksPolicy.requiredArtifacts.production.map(
        (artifact) => artifact.name,
      ),
    ).toContain("pintpath-production-scale-evidence-{candidateSha}");
    expect(
      requiredChecksPolicy.requiredChecks.production.map(
        (check) => check.stage,
      ),
    ).toEqual([
      "deploy",
      "scale",
      "close",
      "activation",
      "promotion-recovery",
      "open",
    ]);
    expect(
      requiredChecksPolicy.requiredArtifacts.production.map(
        (artifact) => artifact.stage,
      ),
    ).toEqual([
      "deploy",
      "scale",
      "close",
      "activation",
      "promotion-recovery",
      "open",
    ]);
    expect(requiredChecksPolicy.phaseConsumers).toMatchObject({
      production: { workflowPath: ".github/workflows/deploy-production.yml" },
      close: { workflowPath: ".github/workflows/close-production-route.yml" },
      activation: {
        workflowPath:
          ".github/workflows/activate-production-promotion-recovery.yml",
      },
      "promotion-recovery": {
        workflowPath:
          ".github/workflows/attest-production-promotion-recovery.yml",
      },
      open: { workflowPath: ".github/workflows/open-production-route.yml" },
      release: { workflowPath: ".github/workflows/pintpath-release-gate.yml" },
    });
    expect(requiredChecksPolicy.requiredChecks.base).toContainEqual({
      name: "ios",
      workflowPath: ".github/workflows/native-apps.yml",
      event: "push",
    });
    expect(requiredChecksPolicy.requiredChecks.staging).toContainEqual({
      name: "iOS protected production configuration archive",
      workflowPath: ".github/workflows/native-apps.yml",
      event: "workflow_dispatch",
    });
    expect(releaseGate).toContain("--phase release");
    expect(releaseGate).toContain(
      "pintpath-production-release-gate-${{ inputs.candidate_sha }}",
    );
  });

  it("keeps the legacy provider fixture inert and exposes only the protected successor", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const executor = repositoryFile(
      "scripts/lib/permanent-staging-provider-variable-write-executor.ts",
    );
    const wrapper = repositoryFile(
      "scripts/execute-permanent-staging-provider-variable-write.ts",
    );
    const policy = repositoryFile(
      "ops/railway/permanent-staging-provider-variable-write-policy.json",
    );
    expect(
      packageJson.scripts?.["railway:staging:provider-variable:legacy-fixture"],
    ).toBe("tsx scripts/execute-permanent-staging-provider-variable-write.ts");
    expect(
      packageJson.scripts?.["railway:staging:provider-variable:write"],
    ).toBeUndefined();
    expect(
      packageJson.scripts?.["railway:staging:provider-mutation:protected"],
    ).toBe(
      "tsx scripts/execute-protected-permanent-staging-variable-mutation.ts",
    );
    expect(policy).toContain(
      '"activationState": "HARD_DISABLED_REVIEW_REQUIRED"',
    );
    expect(executor).toContain(
      "runPermanentStagingProviderVariableWriteExecutor():",
    );
    expect(executor).toContain('mode: "framework-disabled"');
    expect(executor).toContain('outcome: "blocked"');
    expect(executor).not.toContain("node:child_process");
    expect(executor).not.toContain("process.argv");
    expect(executor).not.toContain("process.stdin");
    expect(executor).not.toContain("process.env");
    expect(executor).not.toContain("variableCollectionUpsert");
    expect(wrapper).toContain("fileURLToPath(import.meta.url)");
    expect(wrapper).not.toContain("node:child_process");
  });

  it("keeps automated readiness informative and reserves manual authority for the release gate", () => {
    const source = workflow("pintpath-release-readiness.yml");

    expect(source).toContain("name: Pint Path Automated Readiness");
    expect(source).toContain("fetch-depth: 0");
    expect(source).toContain("npm run test:e2e:pintpath");
    expect(source).toContain(
      "npm run --silent release:evidence | tee release-evidence-summary.json",
    );
    expect(source).not.toContain("workflow_dispatch:");
    expect(source).not.toContain("release:evidence:strict");
    expect(source).toContain("name: pintpath-automated-readiness-evidence");
    expect(source).toContain("if-no-files-found: error");
    expect(evidenceValidator()).toContain("ok: launchReady");
    expect(evidenceValidator()).toContain("launchReady,");
    expect(evidenceValidator()).toContain("expectedRequiredIds");
    expect(evidenceValidator()).toContain('"permanent_staging_cost"');
    expect(evidenceValidator()).toContain(
      "maximumPermanentStagingMonthlyCents = 5_000",
    );
    expect(evidenceValidator()).toContain(
      "externalProviderExportValidationImplemented === true",
    );
    expect(evidenceValidator()).toContain(
      "providerObservationBindingImplemented === true",
    );
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
    expect(source).toContain(
      "PINTPATH_SMOKE_USER_EMAIL: ${{ secrets.PINTPATH_SMOKE_USER_EMAIL }}",
    );
    expect(source).toContain(
      "PINTPATH_SMOKE_USER_PASSWORD: ${{ secrets.PINTPATH_SMOKE_USER_PASSWORD }}",
    );
    expect(source).toContain(
      "PINTPATH_SMOKE_VENUE_EMAIL: ${{ secrets.PINTPATH_SMOKE_VENUE_EMAIL }}",
    );
    expect(source).toContain(
      "PINTPATH_SMOKE_VENUE_PASSWORD: ${{ secrets.PINTPATH_SMOKE_VENUE_PASSWORD }}",
    );
    expect(source).toContain(
      "PINTPATH_SMOKE_ADMIN_TOKEN: ${{ secrets.PINTPATH_SMOKE_ADMIN_TOKEN }}",
    );
    expect(source).toContain('PINTPATH_REVOKE_DIRECT_SMOKE_TOKENS: "true"');
    expect(source).toContain(
      "npm run --silent smoke:production | tee production-public-smoke.json",
    );
    expect(source).toContain("npm run --silent smoke:production:auth");
    expect(source).not.toContain("npm run --silent readiness:launch");
    expect(source).toContain(
      "npm run --silent readiness:railway:sealed | tee railway-sealed-variable-readiness.json",
    );
    expect(source).toContain(
      "npm run --silent readiness:railway:mutation-boundary | tee railway-mutation-boundary-readiness.json",
    );
    expect(source).toContain(
      "npm run --silent readiness:data | tee production-data-readiness.json",
    );
    expect(source).toContain("npm run --silent release:evidence:strict");
    const kernelContractStep =
      source.match(
        /- name: Prove activated reviewed-price kernel and protected operator contracts[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(kernelContractStep).toContain(
      "npm run db:postgres:reviewed-price:kernel:contract:check",
    );
    expect(kernelContractStep).toContain(
      "npm run db:postgres:reviewed-price:operator:contract:check",
    );
    expect(kernelContractStep).not.toContain("secrets.");
    expect(kernelContractStep).not.toContain("\n        if:");
    expect(kernelContractStep).not.toContain("continue-on-error:");
    const logicalStateV2ContractStep =
      source.match(
        /- name: Prove logical-state v2 remains additive and fail-closed[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(logicalStateV2ContractStep).toContain(
      "npm run db:postgres:logical-state:v2:contract:check",
    );
    expect(logicalStateV2ContractStep).not.toContain("secrets.");
    expect(logicalStateV2ContractStep).not.toContain("\n        if:");
    expect(logicalStateV2ContractStep).not.toContain("continue-on-error:");
    expect(
      source.match(
        /- name: Prove logical-state v2 remains additive and fail-closed/g,
      ),
    ).toHaveLength(1);
    const logicalBackupV4ContractStep =
      source.match(
        /- name: Prove passive logical-backup V4 contracts remain fail-closed[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(logicalBackupV4ContractStep).toContain(
      "npm run db:postgres:backup:v4:offline-contract:check",
    );
    expect(logicalBackupV4ContractStep).not.toContain("secrets.");
    expect(logicalBackupV4ContractStep).not.toContain("\n        if:");
    expect(logicalBackupV4ContractStep).not.toContain("continue-on-error:");
    expect(
      source.match(
        /- name: Prove passive logical-backup V4 contracts remain fail-closed/g,
      ),
    ).toHaveLength(1);
    expect(
      source.indexOf(
        "- name: Prove passive logical-backup V4 contracts remain fail-closed",
      ),
    ).toBeLessThan(source.indexOf("${{ secrets."));
    const operationalBackupStep =
      source.match(
        /- name: Prove operational digest-pinned PostgreSQL backup and restore runtime[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(operationalBackupStep).toContain(
      "npm run db:postgres:backup:oci-runtime:contract:check",
    );
    expect(operationalBackupStep).not.toContain("secrets.");
    expect(operationalBackupStep).not.toContain("continue-on-error:");
    expect(
      source.indexOf(
        "- name: Prove operational digest-pinned PostgreSQL backup and restore runtime",
      ),
    ).toBeLessThan(source.indexOf("${{ secrets."));
    const supabaseCompatibilityStep =
      source.match(
        /- name: Prove Supabase key consumer compatibility[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(supabaseCompatibilityStep).toContain(
      "npm run supabase:keys:consumer-compatibility:check",
    );
    expect(supabaseCompatibilityStep).not.toContain("secrets.");
    expect(
      source.indexOf("- name: Prove Supabase key consumer compatibility"),
    ).toBeLessThan(
      source.indexOf("- name: Verify authenticated production roles"),
    );
    expect(
      source.indexOf(
        "- name: Prove activated reviewed-price kernel and protected operator contracts",
      ),
    ).toBeLessThan(source.indexOf("${{ secrets."));
    expect(
      source.indexOf(
        "- name: Prove logical-state v2 remains additive and fail-closed",
      ),
    ).toBeLessThan(source.indexOf("${{ secrets."));
    const postgresRuntimeStep =
      source.match(
        /- name: Prove canonical PostgreSQL runtime selection[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(postgresRuntimeStep).toContain("test/runtime-persistence.test.ts");
    expect(postgresRuntimeStep).toContain(
      "test/provider-readiness-reporting.test.ts",
    );
    expect(source).toContain(
      "PINTPATH_EXPECTED_COMMIT_SHA: ${{ inputs.candidate_sha }}",
    );
    expect(source).toContain('PINTPATH_ENFORCE_LAUNCH_FLAGS: "true"');
    expect(source).toContain(
      'PINTPATH_EXPECTED_COMMERCIAL_LAUNCH_ENABLED: "false"',
    );
    expect(source).not.toContain("inputs.expected_commercial_launch_enabled");
    expect(source).toContain("tested-commit-sha.txt");
    expect(productionSmoke()).toContain("deployment.commitSha");
    expect(productionSmoke()).toContain(
      "exact 40-character lowercase commit SHA",
    );
    expect(productionSmoke()).not.toContain("commitSha.startsWith");
    expect(productionSmoke()).not.toContain("expectedCommitSha.startsWith");
    expect(productionSmoke()).toContain('checkJson("launch_flags"');
    expect(productionSmoke()).toContain("rateLimiterRedis?.required === true");
    expect(productionSmoke()).toContain(
      "rateLimiterRedis?.configured === true",
    );
    expect(productionSmoke()).toContain("rateLimiterRedis?.ready === true");
    expect(productionSmoke()).toContain(
      'id: "postgres_logical_backup_attestation"',
    );
    expect(productionSmoke()).toContain('offsiteBackup?.status === "ok"');
    expect(productionSmoke()).toContain("offsiteBackup?.required === true");
    expect(productionSmoke()).toContain("offsiteBackup?.liveProbe === true");
    expect(productionSmoke()).toContain(
      "data.consumerPaidEnrollmentEnabled === false",
    );
    expect(productionSmoke()).not.toContain("nestedData(payload).commitSha");
    expect(productionSmoke()).toContain(
      'path: "/api/business/admin/queues?limit=1&offset=0"',
    );
    expect(productionSmoke()).toContain(
      "Array.isArray(data.wrongPriceReports)",
    );

    const e2eStep =
      source.match(
        /- name: Automated release-readiness tests[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(e2eStep).toContain("NODE_ENV: test");
    expect(e2eStep).toContain(
      "DATABASE_PATH: ./data/ci-production-release-gate.sqlite",
    );
    expect(e2eStep).toContain(
      "PINTPATH_TEST_DATABASE_PATH: ./data/ci-production-release-gate.sqlite",
    );
    expect(e2eStep).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(e2eStep).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");

    const readinessStep =
      source.match(
        /- name: Enforce permanent-staging sealed-variable metadata[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
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

    const mutationBoundaryStep =
      source.match(
        /- name: Enforce empty Railway mutation boundary and production image authority[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(mutationBoundaryStep).toContain(
      "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: ${{ secrets.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN }}",
    );
    expect(mutationBoundaryStep).toContain(
      "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: ${{ secrets.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN }}",
    );
    expect(mutationBoundaryStep).toContain(
      "readiness:railway:mutation-boundary",
    );
    expect(mutationBoundaryStep).toContain("set -o pipefail");
    expect(mutationBoundaryStep.match(/\$\{\{ secrets\./g)).toHaveLength(2);
    expect(mutationBoundaryStep).not.toContain("DATABASE_URL");
    expect(mutationBoundaryStep).not.toContain("RAILWAY_TOKEN");
    expect(mutationBoundaryStep).not.toContain("RAILWAY_API_TOKEN");

    const authenticatedSmokeStep =
      source.match(
        /- name: Verify authenticated production roles[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(authenticatedSmokeStep).toContain(
      "PINTPATH_SMOKE_USER_EMAIL: ${{ secrets.PINTPATH_SMOKE_USER_EMAIL }}",
    );
    expect(authenticatedSmokeStep).toContain(
      "PINTPATH_SMOKE_USER_PASSWORD: ${{ secrets.PINTPATH_SMOKE_USER_PASSWORD }}",
    );
    expect(authenticatedSmokeStep).toContain(
      "PINTPATH_SMOKE_VENUE_EMAIL: ${{ secrets.PINTPATH_SMOKE_VENUE_EMAIL }}",
    );
    expect(authenticatedSmokeStep).toContain(
      "PINTPATH_SMOKE_VENUE_PASSWORD: ${{ secrets.PINTPATH_SMOKE_VENUE_PASSWORD }}",
    );
    expect(authenticatedSmokeStep).toContain(
      "PINTPATH_SMOKE_ADMIN_TOKEN: ${{ secrets.PINTPATH_SMOKE_ADMIN_TOKEN }}",
    );
    expect(authenticatedSmokeStep).toContain(
      "SUPABASE_URL: ${{ secrets.SUPABASE_URL }}",
    );
    expect(authenticatedSmokeStep).toContain(
      "SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}",
    );
    expect(authenticatedSmokeStep).not.toContain(
      "PINTPATH_SMOKE_ADMIN_PASSWORD",
    );
    expect(authenticatedSmokeStep).not.toContain("TOTP");

    const dataReadinessStep =
      source.match(
        /- name: Enforce production public data readiness[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(dataReadinessStep).toContain('PINTPATH_DATA_STRICT: "true"');
    expect(dataReadinessStep).toContain(
      "PINTPATH_DATA_MARKETED_SUBURBS: ${{ vars.PINTPATH_DATA_MARKETED_SUBURBS }}",
    );
    expect(dataReadinessStep).toContain(
      'PINTPATH_DATA_MIN_MARKETED_VENUE_COVERAGE_PERCENT: "70"',
    );
    expect(dataReadinessStep).toContain(
      'PINTPATH_DATA_MIN_CURRENT_PRICES_PER_VENUE: "3"',
    );
    expect(dataReadinessStep).toContain(
      'PINTPATH_DATA_MAX_CORE_FRESHNESS_HOURS: "48"',
    );
    expect(dataReadinessStep).toContain(
      'PINTPATH_DATA_MAX_VENUE_STATUS_AGE_HOURS: "24"',
    );
    expect(dataReadinessStep).toContain(
      'PINTPATH_DATA_MAX_TRUSTED_ROW_AGE_DAYS: "30"',
    );
    expect(dataReadinessStep).toContain(
      'PINTPATH_DATA_MIN_HAPPY_HOUR_COVERAGE_PERCENT: "25"',
    );
    expect(dataReadinessStep).toContain(
      'PINTPATH_DATA_NO_HAPPY_HOUR_LAUNCH_SCOPE: "true"',
    );
    expect(dataReadinessStep).toContain(
      "PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE: ${{ vars.PINTPATH_DATA_NO_HAPPY_HOUR_SCOPE_REFERENCE }}",
    );
    expect(dataReadinessStep).not.toContain("secrets.");
    expect(source).toContain("production-public-smoke.json");
    expect(source).toContain("production-data-readiness.json");
    expect(source).toContain("railway-mutation-boundary-readiness.json");

    const jobPrefix = source.slice(0, source.indexOf("    steps:"));
    expect(jobPrefix).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(jobPrefix).not.toContain("STRIPE_SECRET_KEY");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(jobPrefix).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");
  });

  it("keeps documented Railway writes behind the reviewed mutation executor", () => {
    const documentWideBoundary =
      "## Railway mutation boundary (document-wide stop)";
    const expectBoundaryBefore = (
      document: string,
      firstInstruction: string,
    ) => {
      const boundaryIndex = document.indexOf(documentWideBoundary);
      const instructionIndex = document.indexOf(firstInstruction);
      expect(boundaryIndex).toBeGreaterThan(-1);
      expect(instructionIndex).toBeGreaterThan(boundaryIndex);
    };
    const requiredDocuments = [
      repositoryFile("SECURITY.md"),
      repositoryFile("README.md"),
      repositoryFile("SECURITY_BACKLOG.md"),
      repositoryFile("PROD_FOLLOWUPS.md"),
      repositoryFile("FIELD_TEST_CHECKLIST.md"),
      releaseDocument("provider-configuration-runbook.md"),
      releaseDocument("permanent-staging-private-auth-rotation.md"),
      releaseDocument("production-launch-runbook.md"),
      releaseDocument("release-readiness-checklist.md"),
      releaseDocument("external-launch-signoffs.md"),
      releaseDocument("data-breach-response-runbook.md"),
      releaseDocument("internal-readiness-audit-2026-07-15.md"),
      releaseDocument("full-product-audit-2026-07-12.md"),
      releaseDocument("full-remediation-2026-07-14.md"),
      releaseDocument("full-scale-postgres-migration-runbook.md"),
      releaseDocument("postgres-migration-execution-status.md"),
      releaseDocument("launch-9-readiness-gates.md"),
    ];
    for (const document of requiredDocuments) {
      expect(document).toContain("mutation-boundary");
    }
    expect(repositoryFile("SECURITY.md")).toContain(
      "tracked\none-operation executor",
    );
    const providerConfiguration = releaseDocument(
      "provider-configuration-runbook.md",
    );
    expect(providerConfiguration).toContain(
      "Each protected successor below runs the\nboundary immediately before its exact write and again in an unconditional\npostflight.",
    );
    expect(providerConfiguration).toContain(
      "If that executor or any required authority is\nunavailable, leave Railway unchanged.",
    );
    expect(releaseDocument("production-launch-runbook.md")).toContain(
      "They do not authorize any\nother route, billing, arbitrary database/resource, backup, or rollback write.",
    );
    expect(releaseDocument("data-breach-response-runbook.md")).toContain(
      "Contain outside Railway instead",
    );
    for (const legacyChecklist of [
      repositoryFile("DEPLOYMENT_CHECKLIST.md"),
      repositoryFile("PRODUCTION_CHECKLIST.md"),
    ]) {
      expect(legacyChecklist).toContain("intentionally non-executable");
      expect(legacyChecklist).toContain("docs/production-launch-runbook.md");
      expect(legacyChecklist).not.toContain("DATABASE_PATH");
      expect(legacyChecklist).not.toContain("sqlite3");
      expect(legacyChecklist).not.toContain("railway run");
    }
    expectBoundaryBefore(
      releaseDocument("production-launch-runbook.md"),
      "This is the controlling sequence.",
    );
    expectBoundaryBefore(
      releaseDocument("provider-configuration-runbook.md"),
      "Use this before a Railway production or staging deployment",
    );
    expectBoundaryBefore(
      releaseDocument("release-readiness-checklist.md"),
      "After each protected provider environment is configured",
    );
  });

  it("keeps sealed Railway readiness external, metadata-only, and policy-bound", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const gate = repositoryFile("scripts/railway-sealed-variable-readiness.ts");
    const providerReadiness = repositoryFile(
      "scripts/provider-readiness-check.ts",
    );
    const policy = repositoryFile(
      "ops/railway/permanent-staging-sealed-variable-policy.json",
    );
    const parsedPolicy = JSON.parse(policy) as {
      variables?: unknown[];
      forbiddenVariableNames?: string[];
    };
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
    const compatibilityGate =
      packageJson.scripts?.["supabase:keys:consumer-compatibility:check"] || "";
    for (const suite of [
      "test/permanent-staging-supabase-key-replacement.test.ts",
      "test/permanent-staging-supabase-key-canary-b.test.ts",
      "test/permanent-staging-supabase-legacy-key-disable.test.ts",
      "test/permanent-staging-supabase-old-key-denial.test.ts",
      "test/railway-sealed-variable-readiness.test.ts",
      "test/app-deployment-metadata.test.ts",
    ])
      expect(compatibilityGate).toContain(suite);
    expect(gate).toContain('"https://backboard.railway.com/graphql/v2"');
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
    expect(parsedPolicy.variables).toHaveLength(16);
    expect(parsedPolicy.forbiddenVariableNames).toEqual([
      "OFFSITE_BACKUP_SUPABASE_URL",
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      "OFFSITE_BACKUP_BUCKET",
    ]);
    for (const document of [providerRunbook, rotationRunbook, checklist]) {
      expect(document).toContain("readiness:railway:sealed");
      expect(document).toContain("permanent_staging_complete");
      expect(document).toContain("railway run");
    }
    for (const document of [rotationRunbook, checklist, externalSignoffs]) {
      expect(document).toContain("16 populated");
      expect(document).not.toContain("14 populated");
    }
    for (const document of [
      providerRunbook,
      rotationRunbook,
      checklist,
      externalSignoffs,
    ]) {
      expect(document).toContain("forbiddenVariablesAbsent=true");
      for (const forbiddenName of [
        "OFFSITE_BACKUP_SUPABASE_URL",
        "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
        "OFFSITE_BACKUP_BUCKET",
      ])
        expect(document).toContain(forbiddenName);
    }
    expect(rotationRunbook).toContain(
      "not a prerequisite for the PostgreSQL-admin or\nRedis rotation",
    );
    expect(rotationRunbook).toContain(
      "a prerequisite\nfor the first seal action",
    );
    expect(externalSignoffs).toContain(
      "permanent-staging sealed-variable metadata JSON",
    );
    expect(externalSignoffs).toContain(
      "the GitHub runner must not regenerate them from duplicated application",
    );
    expect(externalSignoffs).toContain("readiness:railway:mutation-boundary");
    expect(externalSignoffs).toContain(
      "pass-capable only while the live provider state matches",
    );
    const boundaryDocuments = [
      releaseDocument("production-launch-runbook.md"),
      releaseDocument("release-readiness-checklist.md"),
      releaseDocument("launch-9-readiness-gates.md"),
      externalSignoffs,
    ];
    for (const document of boundaryDocuments) {
      expect(document).toContain("pass-capable");
      expect(document).not.toContain("current incident baseline");
    }
    expect(boundaryDocuments[0]).not.toContain(
      "current boundary policy intentionally fails",
    );
    expect(boundaryDocuments[0]).not.toContain(
      "require at least one approval from someone other than the author",
    );
    expect(boundaryDocuments[0]).toContain(
      "do not require human PR approval under the current solo-owner policy",
    );
    expect(boundaryDocuments[0]).toContain(
      "exact reviewed-head verification",
    );
  });

  it("pins third-party actions to immutable commits", () => {
    for (const name of allWorkflows()) {
      const source = workflow(name);
      expect(source).not.toMatch(/uses:\s+[^\s]+@v\d+(?:\s|$)/);
    }
  });

  it("authenticates and fetches the distinct reviewed PR head before release-evidence validation", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    for (const name of [
      "deploy-production.yml",
      "pintpath-release-readiness.yml",
      "pintpath-release-gate.yml",
    ]) {
      const source = workflow(name);
      expect(source, name).toContain("fetch-depth: 0");
      expect(source, name).toContain(
        "npm run --silent github:release-reviewed-head:fetch --",
      );
      expect(source, name).toContain(
        '--evidence "$GITHUB_WORKSPACE/docs/release-evidence.json"',
      );
      expect(source, name).toContain("GITHUB_TOKEN: ${{ github.token }}");
      expect(source.indexOf("github:release-reviewed-head:fetch"), name)
        .toBeLessThan(source.indexOf("release:evidence"));
    }
    expect(packageJson.scripts?.["github:release-reviewed-head:fetch"]).toBe(
      "node --frozen-intrinsics --disable-proto=throw scripts/fetch-github-reviewed-pr-head.mjs",
    );
  });

  it("grants pull-request read authority to every PR-aware GitHub verifier", () => {
    const consumers = allWorkflows().filter((name) => {
      const source = workflow(name);
      return source.includes("github:release-candidate:verify") ||
        source.includes("github:release-reviewed-head:fetch") ||
        source.includes("github:reviewed-candidate-authority:verify") ||
        name === "configure-runtime-variable.yml";
    });
    expect(consumers).toEqual([
      "activate-production-promotion-recovery.yml",
      "attest-production-promotion-recovery.yml",
      "close-production-route.yml",
      "configure-runtime-variable.yml",
      "deploy-permanent-staging.yml",
      "deploy-production.yml",
      "open-production-route.yml",
      "permanent-staging-provider-mutation.yml",
      "permanent-staging-supabase-legacy-cutover.yml",
      "pintpath-release-gate.yml",
      "pintpath-release-readiness.yml",
      "runtime-variable-worker.yml",
    ]);
    for (const name of consumers) {
      const permissions = workflow(name).match(
        /^permissions:\n(?<body>(?:  [^\n]+\n)+)/m,
      )?.groups?.body ?? "";
      expect(permissions, name).toContain("pull-requests: read");
    }
  });

  it("pins every workflow action to an audited immutable release", () => {
    const source = allWorkflows().map(workflow).join("\n");
    const expectedPins = new Map([
      ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", 38],
      ["actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", 30],
      ["actions/setup-java@b6effb05e454b25005698d916606bdc6ffcbf961", 2],
      ["actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", 29],
      ["actions/download-artifact@70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3", 1],
      ["actions/download-artifact@b7c52a5f7a25fce4c22e476a93420dd79a061a70", 7],
      [
        "android-actions/setup-android@40fd30fb8d7440372e1316f5d1809ec01dcd3699",
        2,
      ],
      ["github/codeql-action/init@5595ccaf912efad79be6eef63a5619ff05969be3", 3],
      [
        "github/codeql-action/autobuild@5595ccaf912efad79be6eef63a5619ff05969be3",
        1,
      ],
      [
        "github/codeql-action/analyze@5595ccaf912efad79be6eef63a5619ff05969be3",
        3,
      ],
      ["supabase/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520", 1],
    ]);
    const usesReferences = [
      ...source.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm),
    ].map((match) => match[1]!);
    const reusableWorkflowReferences = usesReferences.filter((reference) =>
      reference.startsWith("./"),
    );
    const actionReferences = usesReferences.filter(
      (reference) => !reference.startsWith("./"),
    );

    expect(actionReferences).toHaveLength(
      [...expectedPins.values()].reduce((total, count) => total + count, 0),
    );
    expect(reusableWorkflowReferences).toEqual([
      "./.github/workflows/runtime-variable-worker.yml",
      "./.github/workflows/runtime-variable-worker.yml",
    ]);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      expect(expectedPins.has(reference), reference).toBe(true);
    }
    for (const [pin, count] of expectedPins)
      expect(
        actionReferences.filter((reference) => reference === pin),
      ).toHaveLength(count);

    const lines = source.split("\n");
    const checkoutIndexes = lines
      .map((line, index) =>
        line.includes("uses: actions/checkout@") ? index : -1,
      )
      .filter((index) => index >= 0);
    expect(checkoutIndexes).toHaveLength(38);
    for (const index of checkoutIndexes) {
      expect(lines.slice(index, index + 4).join("\n")).toContain(
        "persist-credentials: false",
      );
    }
  });

  it("keeps CodeQL focused on production and operational sources", () => {
    const codeqlWorkflow = workflow("codeql.yml");
    const codeqlConfig = repositoryFile(".github/codeql/codeql-config.yml");

    expect(codeqlWorkflow).toContain("queries: security-extended");
    expect(codeqlWorkflow).toContain(
      "config-file: ./.github/codeql/codeql-config.yml",
    );
    expect(codeqlWorkflow).toContain("name: CodeQL Swift");
    expect(codeqlWorkflow).toContain("runs-on: macos-15");
    expect(codeqlWorkflow).toContain("languages: swift");
    expect(codeqlWorkflow).toContain("build-mode: manual");
    expect(codeqlWorkflow).toContain("xcodebuild clean build");
    expect(codeqlWorkflow).toContain("name: CodeQL Java and Kotlin");
    expect(codeqlWorkflow).toContain("languages: java-kotlin");
    expect(codeqlWorkflow).toContain(
      "./gradlew --no-daemon --no-build-cache assembleDebug assembleRelease",
    );
    expect(codeqlConfig).toContain('paths-ignore:\n  - "test/**"');
    expect(codeqlConfig).not.toContain("src/**");
    expect(codeqlConfig).not.toContain("scripts/**");
  });

  it("rebuilds and tests the repository-owned Supabase schema in isolated CI", () => {
    const source = workflow("ci.yml");
    const databaseJob = source.slice(source.indexOf("  supabase-database:"));

    expect(databaseJob).toContain(
      "uses: supabase/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520",
    );
    expect(databaseJob).toContain("version: 2.109.1");
    expect(databaseJob).toContain("supabase db start");
    expect(databaseJob).toContain("supabase db reset --local");
    expect(databaseJob).toContain(
      "PINTPATH_LOCAL_SUPABASE_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable",
    );
    expect(databaseJob).toContain(
      'psql "$PINTPATH_LOCAL_SUPABASE_DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=on --file scripts/ci/supabase-storage-policy-drift.sql',
    );
    expect(databaseJob.match(
      /psql "\$PINTPATH_LOCAL_SUPABASE_DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=on --file supabase\/migrations\/20260815120455_revoke_all_direct_storage_policies\.sql/g,
    )).toHaveLength(2);
    expect(databaseJob).toContain(
      'psql "$PINTPATH_LOCAL_SUPABASE_DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=on --file scripts/ci/supabase-storage-policy-posture-verify.sql',
    );
    expect(databaseJob).not.toContain("supabase db query --local --file");
    expect(databaseJob).toContain(
      "supabase db lint --local --schema public,private,pintpath_app,pintpath_ops --level warning --fail-on warning",
    );
    expect(databaseJob).toContain(
      "supabase db advisors --local --type security --level warn --fail-on warn",
    );
    expect(databaseJob).toContain(
      "supabase db advisors --local --type performance --level warn --fail-on error",
    );
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
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const start = source.indexOf("  postgres-migration-integration:");
    const end = source.indexOf("\n  supabase-database:", start);
    const job = source.slice(start, end);
    const migrationIntegration = repositoryFile(
      "test/postgres-migration-target.integration.test.ts",
    );
    const kernelIntegration = repositoryFile(
      "test/postgres-reviewed-price-promotion-kernel.integration.test.ts",
    );
    const promotionE2eIntegration = repositoryFile(
      "test/postgres-reviewed-price-promotion-e2e.integration.test.ts",
    );
    const logicalStateV2Integration = repositoryFile(
      "test/postgres-logical-state-v2.integration.test.ts",
    );
    const logicalBackupV4SourceAuthorityIntegration = repositoryFile(
      "test/postgres-logical-backup-v4-source-authority.integration.test.ts",
    );
    const logicalBackupV4PhysicalSchemaIntegration = repositoryFile(
      "test/postgres-logical-physical-schema-v4.integration.test.ts",
    );
    const missionContractStep = job.indexOf(
      "      - name: Run mission discovery and automation Postgres contract",
    );
    const missionScaleStep = job.indexOf(
      "      - name: Run mandatory mission discovery production-scale PostgreSQL 17 gate",
    );
    const missionScaleEvidenceStep = job.indexOf(
      "      - name: Retain mission discovery production-scale PostgreSQL 17 evidence",
    );
    const venueRequestStep = job.indexOf(
      "      - name: Run venue-request Postgres contract",
    );
    const missionScaleStepSource = job
      .slice(missionScaleStep, missionScaleEvidenceStep)
      .trimEnd();
    const missionScaleEvidenceStepSource = job
      .slice(missionScaleEvidenceStep, venueRequestStep)
      .trimEnd();
    const jobHeader = job.slice(0, job.indexOf("    steps:"));

    expect(job).toContain(
      "image: postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
    );
    expect(job).toContain(
      "POSTGRES_INITDB_ARGS: --auth-local=trust --auth-host=scram-sha-256",
    );
    expect(job).toContain("PUBLIC_BASE_URL: http://localhost:3000");
    expect(job).toContain("pg_isready -U postgres -d postgres");
    expect(job).toContain("PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL:");
    expect(job).toContain('PINTPATH_POSTGRES_MIGRATION_TEST_REQUIRED: "true"');
    expect(job).toContain(
      "PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_ADMIN_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
    );
    expect(job).toContain(
      'PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_REQUIRED: "true"',
    );
    expect(job).toContain(
      "PINTPATH_POSTGRES_LOGICAL_STATE_V2_TEST_ADMIN_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
    );
    expect(job).toContain(
      'PINTPATH_POSTGRES_LOGICAL_STATE_V2_TEST_REQUIRED: "true"',
    );
    expect(job).toContain(
      "PINTPATH_POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_TEST_ADMIN_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
    );
    expect(job).toContain(
      'PINTPATH_POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_TEST_REQUIRED: "true"',
    );
    expect(
      job.match(
        /PINTPATH_POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_TEST_ADMIN_URL:/g,
      ),
    ).toHaveLength(1);
    expect(
      job.match(
        /PINTPATH_POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_TEST_REQUIRED:/g,
      ),
    ).toHaveLength(1);
    expect(job).toContain(
      "PINTPATH_POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_TEST_ADMIN_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
    );
    expect(job).toContain(
      'PINTPATH_POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_TEST_REQUIRED: "true"',
    );
    expect(
      job.match(
        /PINTPATH_POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_TEST_ADMIN_URL:/g,
      ),
    ).toHaveLength(1);
    expect(
      job.match(/PINTPATH_POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_TEST_REQUIRED:/g),
    ).toHaveLength(1);
    expect(job).toContain("PINTPATH_ACCOUNT_SESSION_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain(
      "PINTPATH_ACCOUNT_PROFILE_PREFERENCES_POSTGRES_TEST_ADMIN_URL:",
    );
    expect(job).toContain("PINTPATH_ACTIVITY_AUDIT_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain(
      "PINTPATH_ACCOUNT_DELETION_QUEUE_POSTGRES_TEST_ADMIN_URL:",
    );
    expect(job).toContain("PINTPATH_ACCOUNT_PRIVACY_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain(
      "PINTPATH_ACCOUNT_DELETION_RECOVERY_POSTGRES_TEST_ADMIN_URL:",
    );
    expect(job).toContain(
      "PINTPATH_POSTGRES_ACCOUNT_DELETION_REPLAY_TEST_ADMIN_URL:",
    );
    expect(job).toContain(
      "PINTPATH_POSTGRES_PRIVATE_STORAGE_RECOVERY_TEST_ADMIN_URL:",
    );
    expect(job).toContain("PINTPATH_BILLING_CHECKOUT_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_SUPPORT_FEEDBACK_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain("PINTPATH_VENUE_ACCESS_POSTGRES_TEST_ADMIN_URL:");
    expect(job).toContain(
      "PINTPATH_SOURCE_EVIDENCE_OBJECT_POSTGRES_TEST_ADMIN_URL:",
    );
    expect(job).toContain(
      "PINTPATH_VENUE_MANAGER_INTERNAL_SUBMISSION_POSTGRES_TEST_ADMIN_URL:",
    );
    expect(job).toContain("npm run db:postgres:schema:check");
    expect(job).toContain("npm run db:postgres:migration:contract:check");
    expect(job).toContain(
      "- name: Run real PostgreSQL 17 import, reconciliation, and reviewed-price planner no-write proof",
    );
    expect(job).toContain(
      "npx vitest run test/postgres-migration-target.integration.test.ts",
    );
    expect(job).toContain(
      "- name: Run inert, activated, and end-to-end reviewed-price promotion PostgreSQL 17 contracts",
    );
    expect(job).toContain(
      "test/postgres-reviewed-price-promotion-kernel.integration.test.ts",
    );
    expect(job).toContain(
      "test/postgres-reviewed-price-promotion-activation.integration.test.ts",
    );
    expect(job).toContain(
      "test/postgres-reviewed-price-promotion-e2e.integration.test.ts",
    );
    expect(
      job.match(
        /- name: Run inert, activated, and end-to-end reviewed-price promotion PostgreSQL 17 contracts/g,
      ),
    ).toHaveLength(1);
    const kernelIntegrationStep =
      job.match(
        /- name: Run inert, activated, and end-to-end reviewed-price promotion PostgreSQL 17 contracts[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(kernelIntegrationStep).toContain(
      "test/postgres-reviewed-price-promotion-kernel.integration.test.ts",
    );
    expect(kernelIntegrationStep).toContain(
      "test/postgres-reviewed-price-promotion-activation.integration.test.ts",
    );
    expect(kernelIntegrationStep).toContain(
      "test/postgres-reviewed-price-promotion-e2e.integration.test.ts",
    );
    expect(kernelIntegrationStep).toContain("--maxWorkers=1");
    expect(kernelIntegrationStep).not.toContain("\n        if:");
    expect(kernelIntegrationStep).not.toContain("continue-on-error:");
    expect(kernelIntegration).toContain(
      '"PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_ADMIN_URL"',
    );
    expect(kernelIntegration).toContain(
      '"PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_REQUIRED"',
    );
    expect(kernelIntegration).toContain(
      'configuredRequired === "true" && !configuredAdminUrl',
    );
    expect(kernelIntegration).toContain("describe.skipIf(!configuredAdminUrl)");
    expect(promotionE2eIntegration).toContain(
      '"PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_ADMIN_URL"',
    );
    expect(promotionE2eIntegration).toContain(
      '"PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_REQUIRED"',
    );
    expect(promotionE2eIntegration).toContain(
      'configuredRequired === "true" && !configuredAdminUrl',
    );
    expect(promotionE2eIntegration).toContain(
      "describe.skipIf(!configuredAdminUrl)",
    );
    expect(job).toContain(
      "- name: Run logical-state v2 PostgreSQL 17 contract",
    );
    expect(job).toContain(
      "npx vitest run test/postgres-logical-state-v2.integration.test.ts",
    );
    expect(
      job.match(/- name: Run logical-state v2 PostgreSQL 17 contract/g),
    ).toHaveLength(1);
    const logicalStateV2IntegrationStep =
      job.match(
        /- name: Run logical-state v2 PostgreSQL 17 contract[\s\S]*?(?=\n\s{6}- name:)/,
      )?.[0] || "";
    expect(logicalStateV2IntegrationStep).toContain(
      "run: npx vitest run test/postgres-logical-state-v2.integration.test.ts",
    );
    expect(logicalStateV2IntegrationStep).not.toContain("\n        if:");
    expect(logicalStateV2IntegrationStep).not.toContain("continue-on-error:");
    expect(logicalStateV2Integration).toContain(
      '"PINTPATH_POSTGRES_LOGICAL_STATE_V2_TEST_ADMIN_URL"',
    );
    expect(logicalStateV2Integration).toContain(
      '"PINTPATH_POSTGRES_LOGICAL_STATE_V2_TEST_REQUIRED"',
    );
    expect(logicalStateV2Integration).toContain(
      'configuredRequired === "true" && !configuredAdminUrl',
    );
    expect(logicalStateV2Integration).toContain(
      "describe.skipIf(!configuredAdminUrl)",
    );
    expect(logicalStateV2Integration).toContain(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(logicalStateV2Integration).toContain(
      "SET LOCAL search_path = pg_catalog, pg_temp",
    );
    expect(logicalStateV2Integration).toContain("observedV2Connection");
    expect(logicalStateV2Integration).toContain("autocommitQueries");
    expect(
      job.match(
        /- name: Run logical-backup V4 source-authority PostgreSQL 17 contract/g,
      ),
    ).toHaveLength(1);
    const logicalBackupV4SourceAuthorityIntegrationStep =
      job
        .match(
          /- name: Run logical-backup V4 source-authority PostgreSQL 17 contract[\s\S]*?(?=\n\s{6}- name:)/,
        )?.[0]
        .trimEnd() || "";
    expect(logicalBackupV4SourceAuthorityIntegrationStep).toBe(
      [
        "- name: Run logical-backup V4 source-authority PostgreSQL 17 contract",
        "        run: npx vitest run test/postgres-logical-backup-v4-source-authority.integration.test.ts",
      ].join("\n"),
    );
    expect(logicalBackupV4SourceAuthorityIntegrationStep).not.toContain(
      "\n        if:",
    );
    expect(logicalBackupV4SourceAuthorityIntegrationStep).not.toContain(
      "continue-on-error:",
    );
    expect(
      job.indexOf(
        "- name: Run logical-backup V4 source-authority PostgreSQL 17 contract",
      ),
    ).toBeGreaterThan(
      job.indexOf("- name: Run logical-state v2 PostgreSQL 17 contract"),
    );
    expect(job).toContain(
      [
        "      - name: Run logical-state v2 PostgreSQL 17 contract",
        "        run: npx vitest run test/postgres-logical-state-v2.integration.test.ts",
        "",
        "      - name: Run logical-backup V4 source-authority PostgreSQL 17 contract",
        "        run: npx vitest run test/postgres-logical-backup-v4-source-authority.integration.test.ts",
      ].join("\n"),
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      '"PINTPATH_POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_TEST_ADMIN_URL"',
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      '"PINTPATH_POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_TEST_REQUIRED"',
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      'configuredRequired === "true" && !configuredAdminUrl',
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      "describe.skipIf(!configuredAdminUrl)",
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      'expect(authenticatedSource.authenticationMethod).toBe("scram-sha-256")',
    );
    expect(
      job.match(
        /- name: Run logical-backup V4 physical-schema PostgreSQL 17 contract/g,
      ),
    ).toHaveLength(1);
    const logicalBackupV4PhysicalSchemaIntegrationStep =
      job
        .match(
          /- name: Run logical-backup V4 physical-schema PostgreSQL 17 contract[\s\S]*?(?=\n\s{6}- name:)/,
        )?.[0]
        .trimEnd() || "";
    expect(logicalBackupV4PhysicalSchemaIntegrationStep).toBe(
      [
        "- name: Run logical-backup V4 physical-schema PostgreSQL 17 contract",
        "        run: npx vitest run test/postgres-logical-physical-schema-v4.integration.test.ts --maxWorkers=1",
      ].join("\n"),
    );
    expect(logicalBackupV4PhysicalSchemaIntegrationStep).not.toContain(
      "\n        if:",
    );
    expect(logicalBackupV4PhysicalSchemaIntegrationStep).not.toContain(
      "continue-on-error:",
    );
    expect(
      job.indexOf(
        "- name: Run logical-backup V4 physical-schema PostgreSQL 17 contract",
      ),
    ).toBeGreaterThan(
      job.indexOf(
        "- name: Run logical-backup V4 source-authority PostgreSQL 17 contract",
      ),
    );
    expect(job).toContain(
      [
        "      - name: Run logical-backup V4 source-authority PostgreSQL 17 contract",
        "        run: npx vitest run test/postgres-logical-backup-v4-source-authority.integration.test.ts",
        "",
        "      - name: Run logical-backup V4 physical-schema PostgreSQL 17 contract",
        "        run: npx vitest run test/postgres-logical-physical-schema-v4.integration.test.ts --maxWorkers=1",
      ].join("\n"),
    );
    expect(logicalBackupV4PhysicalSchemaIntegration).toContain(
      '"PINTPATH_POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_TEST_ADMIN_URL"',
    );
    expect(logicalBackupV4PhysicalSchemaIntegration).toContain(
      '"PINTPATH_POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_TEST_REQUIRED"',
    );
    expect(logicalBackupV4PhysicalSchemaIntegration).toContain(
      'configuredRequired === "true" && !configuredAdminUrl',
    );
    expect(logicalBackupV4PhysicalSchemaIntegration).toContain(
      "describe.skipIf(!configuredAdminUrl)",
    );
    expect(logicalBackupV4PhysicalSchemaIntegration).toContain(
      "LOCK TABLE ${POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS.map(",
    );
    expect(logicalBackupV4PhysicalSchemaIntegration).toContain(
      '"SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY, NOT DEFERRABLE"',
    );
    expect(logicalBackupV4PhysicalSchemaIntegration).toContain(
      '"SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY, NOT DEFERRABLE"',
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      'expect(authenticatedPgDump.authenticationMethod).toBe("scram-sha-256")',
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      "ALTER ROLE ${quoteIdentifier(loginRoleName)} NOLOGIN",
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      "pg_catalog.pg_terminate_backend(activity.pid, 5000)",
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      "await waitForZeroActiveSessions(maintenance, loginRoleOid)",
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      "activeSessionCountBeforeDrop: 0",
    );
    expect(logicalBackupV4SourceAuthorityIntegration).toContain(
      "expectMembership(cleanedUp, false, false)",
    );
    expect(
      packageJson.scripts?.["db:postgres:reviewed-price:kernel:contract:check"],
    ).toBe(
      "vitest run test/postgres-reviewed-price-promotion-kernel.test.ts --maxWorkers=1",
    );
    expect(
      packageJson.scripts?.["db:postgres:logical-state:v2:contract:check"],
    ).toBe("vitest run test/postgres-logical-state.test.ts --maxWorkers=1");
    expect(
      packageJson.scripts?.["db:postgres:backup:v4:offline-contract:check"],
    ).toBe(
      "vitest run test/postgres-logical-backup-v4.test.ts test/postgres-logical-backup-v4-source-authority.test.ts test/postgres-logical-backup-v4-source-authority-v2.test.ts test/postgres-logical-backup-v4-toc.test.ts test/postgres-logical-physical-schema-v4.test.ts test/postgres-logical-scratch-restore-v4.test.ts test/postgres-tool-runtime-closure-v4.test.ts test/postgres-tool-authority.test.ts test/postgres-logical-restore.test.ts --maxWorkers=1",
    );
    expect(
      packageJson.scripts?.["db:postgres:backup:v4:offline-contract:check"],
    ).not.toContain(
      "postgres-logical-backup-v4-source-authority.integration.test.ts",
    );
    expect(packageJson.scripts?.["db:postgres:backup:v4:contract:check"]).toBe(
      "npm run db:postgres:backup:v4:offline-contract:check",
    );
    expect(
      packageJson.scripts?.["db:postgres:backup:oci-runtime:contract:check"],
    ).toBe(
      "vitest run test/postgres-railway-stock-localhost-ca.test.ts test/sql-database.test.ts test/postgres-oci-tool-runtime.test.ts test/postgres-logical-offsite-cli.test.ts test/postgres-logical-offsite-retrieval.test.ts test/production-backup-volatile-work-root.test.ts test/production-logical-backup-workflow.test.ts --maxWorkers=1",
    );
    expect(
      packageJson.scripts?.["menus:promote-reviewed:postgres"],
    ).toBeUndefined();
    expect(migrationIntegration).toContain(
      "runPostgresReviewedPricePromotionCli",
    );
    expect(migrationIntegration).toContain(
      '"--expected-target-database-identity-sha256"',
    );
    expect(migrationIntegration).toContain('"--deployment-attestation"');
    expect(migrationIntegration).toContain('"--deployment-attestation-sha256"');
    for (const legacyDeploymentFlag of [
      "--deployment-project-id-sha256",
      "--deployment-environment-id-sha256",
      "--deployment-service-id-sha256",
      "--deployment-id-sha256",
      "--deployment-image-digest-sha256",
    ]) {
      expect(migrationIntegration).not.toContain(`"${legacyDeploymentFlag}"`);
    }
    expect(migrationIntegration).not.toContain(
      '"--expected-planner-target-identity-sha256"',
    );
    expect(migrationIntegration).toContain('"--output-plan"');
    expect(migrationIntegration).toContain(
      '"postgresql://postgres-staging.railway.internal:5432/pintpath_staging"',
    );
    expect(migrationIntegration).toContain(
      'const rootCaPath = path.join(cliRoot, "railway-stock-root-ca.pem")',
    );
    expect(migrationIntegration).toContain(
      "expectedRootCaDerSha256: testRootCaDerSha256",
    );
    expect(migrationIntegration).toContain("environment: {}");
    expect(migrationIntegration).toContain(
      "expect(plannerAssertExactCount).toBe(3)",
    );
    expect(migrationIntegration).toContain(
      "expect(plannerReleaseCount).toBe(1)",
    );
    expect(migrationIntegration).toContain("fs.chmodSync(cliRoot, 0o700)");
    expect(migrationIntegration).toContain(
      "PINTPATH_POSTGRES_MIGRATION_TEST_REQUIRED",
    );
    expect(migrationIntegration).toContain(
      "is mandatory when ${REQUIRED_ENV}=true",
    );
    expect(migrationIntegration).toContain("mutationEnabled: false");
    expect(migrationIntegration).toContain('code: "42501"');
    expect(migrationIntegration).not.toContain("DROP OWNED BY");
    expect(migrationIntegration).not.toContain(
      "DROP ROLE IF EXISTS pintpath_reviewed_price_planner",
    );
    expect(job).toContain(
      "npx vitest run test/postgres-logical-offsite-retrieval.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/public-venue-directory.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/venue-identity.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/system-state.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/account-session.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/account-profile-preferences.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/activity-audit.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/account-deletion-queue.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/account-privacy.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/postgres-account-deletion-recovery-fixture.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/postgres-account-deletion-replay.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/postgres-private-storage-recovery.integration.test.ts",
    );
    expect(job).toContain("PINTPATH_STAGING_AUTH_PROBE_TEST_ADMIN_URL:");
    expect(job).toContain(
      "PINTPATH_CI_POSTGRES_CONTAINER_ID: ${{ job.services.postgres.id }}",
    );
    expect(job).toContain('PINTPATH_STAGING_AUTH_PROBE_TEST_REQUIRED: "true"');
    expect(job).toContain(
      'PATH="$GITHUB_WORKSPACE/scripts/ci:$PATH" npm run test:staging:auth:probe:pg17',
    );
    expect(job).toContain(
      "npx vitest run test/privacy-retention.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/stripe-subscription.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/billing-checkout.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/public-price.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/community-submission.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/source-evidence-object.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/source-evidence-retention.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/venue-manager-internal-submission.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/venue-inventory.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/venue-pending-change.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/venue-data-read.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/support-feedback.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/venue-access.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/mission-lifecycle.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/mission-discovery-automation.repository.integration.test.ts",
    );
    expect(job).toContain(
      "- name: Run mandatory mission discovery production-scale PostgreSQL 17 gate",
    );
    expect(job).toContain("PINTPATH_MISSION_DISCOVERY_SCALE_TEST_ADMIN_URL:");
    expect(job).toContain(
      'PINTPATH_MISSION_DISCOVERY_SCALE_TEST_REQUIRED: "true"',
    );
    expect(job).toContain(
      "npx vitest run --disableConsoleIntercept test/mission-discovery-automation-scale.integration.test.ts",
    );
    expect(missionContractStep).toBeGreaterThan(-1);
    expect(missionScaleStep).toBeGreaterThan(missionContractStep);
    expect(missionScaleEvidenceStep).toBeGreaterThan(missionScaleStep);
    expect(venueRequestStep).toBeGreaterThan(missionScaleEvidenceStep);
    expect(
      job.split(
        "      - name: Run mandatory mission discovery production-scale PostgreSQL 17 gate",
      ),
    ).toHaveLength(2);
    expect(
      job.split(
        "      - name: Retain mission discovery production-scale PostgreSQL 17 evidence",
      ),
    ).toHaveLength(2);
    expect(jobHeader).not.toMatch(/^\s+(?:if|continue-on-error):/m);
    expect(missionScaleStepSource).toBe(
      [
        "      - name: Run mandatory mission discovery production-scale PostgreSQL 17 gate",
        "        env:",
        "          PINTPATH_MISSION_DISCOVERY_SCALE_TEST_ADMIN_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
        "          PINTPATH_MISSION_DISCOVERY_SCALE_EVIDENCE_PATH: ${{ runner.temp }}/pintpath-mission-discovery-scale-evidence.json",
        '          PINTPATH_MISSION_DISCOVERY_SCALE_TEST_REQUIRED: "true"',
        "        run: npx vitest run --disableConsoleIntercept test/mission-discovery-automation-scale.integration.test.ts",
      ].join("\n"),
    );
    expect(missionScaleEvidenceStepSource).toBe(
      [
        "      - name: Retain mission discovery production-scale PostgreSQL 17 evidence",
        "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
        "        with:",
        "          name: pintpath-mission-discovery-scale-evidence",
        "          path: ${{ runner.temp }}/pintpath-mission-discovery-scale-evidence.json",
        "          if-no-files-found: error",
        "          retention-days: 14",
      ].join("\n"),
    );
    expect(job).toContain(
      "npx vitest run test/venue-request.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/venue-partner.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/admin-analytics.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/venue-manager-insights.repository.integration.test.ts",
    );
    expect(job).toContain(
      "npx vitest run test/admin-account.repository.integration.test.ts",
    );
    expect(job).not.toContain("secrets.");
    expect(job).not.toContain("supabase db push");

    const scaleIntegration = repositoryFile(
      "test/mission-discovery-automation-scale.integration.test.ts",
    );
    expect(scaleIntegration).toContain(
      "`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`",
    );
    expect(scaleIntegration).toContain(
      "`${EVIDENCE_PATH_ENV} is mandatory when ${REQUIRED_ENV}=true.`",
    );
    expect(scaleIntegration).toContain("const VENUE_COUNT = 10_000;");
    expect(scaleIntegration).toContain("const PRICE_COUNT = 100_000;");
    expect(scaleIntegration).toContain("const REQUEST_COUNT = 20_000;");
    expect(scaleIntegration).toContain("const MANUAL_MISSION_COUNT = 10_000;");
    expect(scaleIntegration).toContain("const AUTO_MISSION_COUNT = 5_000;");
    expect(scaleIntegration).toContain("publicFeed: 1_000");
    expect(scaleIntegration).toContain("searchFeed: 1_000");
    expect(scaleIntegration).toContain("radiusFeed: 1_000");
    expect(scaleIntegration).toContain("candidates: 2_000");
    expect(scaleIntegration).toContain("autoOwners: 100");
    expect(scaleIntegration).toContain("inactiveAuto: 250");
    expect(scaleIntegration).toContain("activeDemo: 250");
    expect(scaleIntegration).toContain(
      'path.resolve("src/db/postgres-schema.sql")',
    );
    expect(scaleIntegration).toContain("GRANT pintpath_runtime TO");
    expect(scaleIntegration).toContain(
      "EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)",
    );
    expect(scaleIntegration).toContain("pg_catalog.generate_series");
    expect(scaleIntegration).toContain("expect(facts.tempReadBlocks).toBe(0)");
    expect(scaleIntegration).toContain(
      "expect(facts.tempWrittenBlocks).toBe(0)",
    );
    expect(scaleIntegration).toContain(
      "expect(database!.metrics().completedQueries - completedBefore).toBe(1)",
    );
    expect(scaleIntegration).toContain(
      "relation.relforcerowsecurity AS forced",
    );
    expect(scaleIntegration).toContain(
      "expect(summaries.map((summary) => summary.name)).toEqual([",
    );
    for (const name of [
      "public-feed-deep-page",
      "address-search",
      "radius-sort",
      "venue-candidates-deep-page",
      "inactive-auto-pruning",
      "active-demo-deactivation",
      "auto-mission-owner-discovery",
    ])
      expect(scaleIntegration).toContain(`"${name}"`);
    expect(scaleIntegration).toContain("writeScaleEvidence(evidence)");
    expect(scaleIntegration).toContain("mission-discovery-scale-evidence=");
    expect(scaleIntegration).toContain("querySha256:");
    expect(scaleIntegration).toContain("parametersSha256:");
    expect(scaleIntegration).toContain("planSha256:");
    expect(scaleIntegration).toContain("sequentialScanRelations:");
    expect(scaleIntegration).toContain(
      "Refusing to reuse a preexisting database-scoped logical-backup role.",
    );
    expect(scaleIntegration).toContain("backupRoleCleanupAuthorized");
    expect(scaleIntegration).toContain("parents: []");
    expect(scaleIntegration).not.toContain("it.skip");
    expect(scaleIntegration).not.toContain("SET enable_seqscan");

    const migrationStatus = repositoryFile(
      "docs/postgres-migration-execution-status.md",
    );
    const productionFollowups = repositoryFile("PROD_FOLLOWUPS.md");
    expect(migrationStatus).toContain("idx_accounts_admin_search_trgm");
    expect(migrationStatus).toContain("CREATE INDEX CONCURRENTLY");
    expect(migrationStatus).toContain("permanent staging");
    for (const document of [migrationStatus, productionFollowups]) {
      expect(document).toContain("pintpath-mission-discovery-scale-evidence");
      expect(document).toContain("PostgreSQL 17.6");
      expect(document).toContain("2 seconds");
      expect(document).toContain("250 ms");
      expect(document).toContain("100 ms");
    }
  });

  it("requires a pinned PG17 TLS backup-to-restore receipt in isolated CI", () => {
    const source = workflow("ci.yml");
    const buildStart = source.indexOf("  build-test-scan:");
    const buildEnd = source.indexOf(
      "\n  postgres-migration-integration:",
      buildStart,
    );
    const requiredBuildJob = source.slice(buildStart, buildEnd);
    const start = source.indexOf("  postgres-migration-integration:");
    const end = source.indexOf("\n  supabase-database:", start);
    const job = source.slice(start, end);
    const installStep = job.indexOf(
      "      - name: Install pinned PostgreSQL 17 logical-backup client",
    );
    const setupStep = job.indexOf(
      "      - name: Configure disposable fd12 PostgreSQL TLS fixture",
    );
    const testStep = job.indexOf(
      "      - name: Run mandatory PostgreSQL 17 TLS logical backup and restore",
    );
    const cleanupStep = job.indexOf(
      "      - name: Remove disposable PostgreSQL TLS fixture",
    );
    const logicalRestoreSteps = job.slice(installStep);
    const clientInstaller = repositoryFile(
      "scripts/ci/install-postgresql-client-17",
    );
    const packageHashCheck = clientInstaller.indexOf(
      'printf \'%s  %s\\n\' "$EXPECTED_PACKAGE_SHA256" "$package_deb"',
    );
    const packageMetadataCheck = clientInstaller.indexOf(
      'dpkg-deb --field "$package_deb" Package',
    );
    const localPackageInstall = clientInstaller.indexOf(
      "sudo env DEBIAN_FRONTEND=noninteractive apt-get install",
    );
    const dumpHashCheck = clientInstaller.indexOf(
      'printf \'%s  %s\\n\' "$EXPECTED_PG_DUMP_SHA256" "$PG_DUMP"',
    );
    const restoreHashCheck = clientInstaller.indexOf(
      'printf \'%s  %s\\n\' "$EXPECTED_PG_RESTORE_SHA256" "$PG_RESTORE"',
    );
    const hashExports = clientInstaller.indexOf(
      '"PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_PG_DUMP_SHA256"',
    );
    const tlsFixture = repositoryFile(
      "scripts/ci/postgres-logical-restore-tls-fixture",
    );
    const restoreIntegration = repositoryFile(
      "test/postgres-logical-restore.integration.test.ts",
    );
    const migrationStatus = repositoryFile(
      "docs/postgres-migration-execution-status.md",
    );
    const restoreRehearsal = repositoryFile(
      "docs/postgres-logical-restore-rehearsal.md",
    );
    const initialStateReceipt = tlsFixture.indexOf(
      'write_state_receipt "$fixture_root" "$network_name" "$network_id" "$container_id" false',
    );
    const networkCreation = tlsFixture.indexOf(
      "network_id=$(docker network create",
    );
    const cleanupFunction = tlsFixture.slice(
      tlsFixture.indexOf("cleanup_fixture()"),
      tlsFixture.indexOf("fixture_paths\ncase"),
    );

    expect(requiredBuildJob).toContain("needs: postgres-migration-integration");
    expect(requiredBuildJob).toContain("if: ${{ always() }}");
    expect(requiredBuildJob).toContain(
      "POSTGRES_MIGRATION_INTEGRATION_RESULT: ${{ needs.postgres-migration-integration.result }}",
    );
    expect(requiredBuildJob).toContain(
      'if [ "$POSTGRES_MIGRATION_INTEGRATION_RESULT" != "success" ]; then',
    );
    expect(requiredBuildJob).toContain("exit 1");
    expect(requiredBuildJob).not.toContain("continue-on-error");
    expect(
      requiredBuildJob.indexOf("POSTGRES_MIGRATION_INTEGRATION_RESULT:"),
    ).toBeLessThan(requiredBuildJob.indexOf("Checkout"));
    expect(migrationStatus).not.toContain(
      "remains a separately executed local proof",
    );
    expect(migrationStatus).toContain("needs: postgres-migration-integration");
    expect(migrationStatus).toContain("schema-version-3");
    expect(migrationStatus).toContain(
      "synthetic/disposable CI implementation evidence",
    );
    expect(migrationStatus).toContain(
      "This historical version-2 set remains valid retrieval/restore evidence.",
    );
    expect(restoreRehearsal).toContain(
      "required isolated CI PostgreSQL 17 integration",
    );
    expect(restoreRehearsal).toContain(
      "source data, CA, route, database, and roles are synthetic and disposable",
    );
    expect(job).toContain("timeout-minutes: 30");
    expect(job).toContain("runs-on: ubuntu-24.04");
    expect(installStep).toBeGreaterThan(-1);
    expect(setupStep).toBeGreaterThan(installStep);
    expect(testStep).toBeGreaterThan(setupStep);
    expect(cleanupStep).toBeGreaterThan(testStep);
    expect(logicalRestoreSteps).toContain(
      "run: bash scripts/ci/install-postgresql-client-17",
    );
    expect(logicalRestoreSteps).toContain(
      "PINTPATH_CI_POSTGRES_CONTAINER_ID: ${{ job.services.postgres.id }}",
    );
    expect(logicalRestoreSteps).toContain(
      "run: bash scripts/ci/postgres-logical-restore-tls-fixture setup",
    );
    expect(logicalRestoreSteps).toContain(
      'PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_REQUIRED: "true"',
    );
    expect(logicalRestoreSteps).toContain(
      "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_ADMIN_URL:",
    );
    expect(logicalRestoreSteps).toContain(
      "npx vitest run test/postgres-logical-restore.integration.test.ts",
    );
    expect(logicalRestoreSteps).toContain("if: always()");
    expect(logicalRestoreSteps).toContain(
      "run: bash scripts/ci/postgres-logical-restore-tls-fixture cleanup",
    );
    expect(logicalRestoreSteps).not.toContain("continue-on-error");
    expect(logicalRestoreSteps).not.toContain("secrets.");

    expect(clientInstaller).toContain(
      'EXPECTED_KEY_SHA256="0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76"',
    );
    expect(clientInstaller).toContain(
      'EXPECTED_PACKAGE_VERSION="17.10-1.pgdg24.04+1"',
    );
    expect(clientInstaller).toContain(
      'EXPECTED_PACKAGE_SHA256="e8806cd10a1c9ce453ef5feec242c6f9ba1229ce31ea862a6335277eae027987"',
    );
    expect(clientInstaller).toContain(
      'EXPECTED_PG_DUMP_VERSION="17.10 (Ubuntu 17.10-1.pgdg24.04+1)"',
    );
    expect(clientInstaller).toContain(
      'EXPECTED_PG_RESTORE_VERSION="17.10 (Ubuntu 17.10-1.pgdg24.04+1)"',
    );
    expect(clientInstaller).toContain(
      'EXPECTED_PG_DUMP_SHA256="8cca9f4a2380df3cfa47704e13722059fd88291451b6c7be3642081db59d743b"',
    );
    expect(clientInstaller).toContain(
      'EXPECTED_PG_RESTORE_SHA256="1b58a9c383ccee5f30c8a09d48ba0d50826a6841904430955295e1a6a6e7f34d"',
    );
    expect(clientInstaller).toContain(
      '[[ "${VERSION_CODENAME:-}" == "noble" ]]',
    );
    expect(clientInstaller).toContain(
      '[[ "$(dpkg --print-architecture)" == "amd64" ]]',
    );
    expect(clientInstaller).toContain("/usr/lib/postgresql/17/bin/pg_dump");
    expect(clientInstaller).toContain("/usr/lib/postgresql/17/bin/pg_restore");
    expect(clientInstaller).toContain("signed-by=$KEYRING");
    expect(clientInstaller).toContain(
      'apt-get download "postgresql-client-17=$EXPECTED_PACKAGE_VERSION"',
    );
    expect(clientInstaller).toContain(
      '[[ "${#downloaded_packages[@]}" -eq 1 ]]',
    );
    expect(clientInstaller).toContain(
      'dpkg-deb --field "$package_deb" Package)" == "postgresql-client-17"',
    );
    expect(clientInstaller).toContain(
      'dpkg-deb --field "$package_deb" Version)" == "$EXPECTED_PACKAGE_VERSION"',
    );
    expect(clientInstaller).toContain(
      'dpkg-deb --field "$package_deb" Architecture)" == "amd64"',
    );
    expect(clientInstaller).toContain(
      'printf \'%s  %s\\n\' "$EXPECTED_PACKAGE_SHA256" "$package_deb"',
    );
    expect(clientInstaller.match(/sha256sum --check --status -/g)).toHaveLength(
      3,
    );
    expect(clientInstaller).toContain('"$package_deb"');
    expect(packageHashCheck).toBeGreaterThan(-1);
    expect(packageMetadataCheck).toBeGreaterThan(packageHashCheck);
    expect(localPackageInstall).toBeGreaterThan(packageMetadataCheck);
    expect(clientInstaller).toContain("--connect-timeout 15");
    expect(clientInstaller).toContain("--max-time 60");
    expect(clientInstaller).toContain("stat -c '%u:%g:%a:%h' \"$PG_DUMP\"");
    expect(clientInstaller).toContain(
      '"$($PG_DUMP --version)" == "pg_dump (PostgreSQL) $EXPECTED_PG_DUMP_VERSION"',
    );
    expect(clientInstaller).toContain(
      '"$($PG_RESTORE --version)" == "pg_restore (PostgreSQL) $EXPECTED_PG_RESTORE_VERSION"',
    );
    expect(clientInstaller).toContain(
      'printf \'%s  %s\\n\' "$EXPECTED_PG_DUMP_SHA256" "$PG_DUMP"',
    );
    expect(clientInstaller).toContain(
      'printf \'%s  %s\\n\' "$EXPECTED_PG_RESTORE_SHA256" "$PG_RESTORE"',
    );
    expect(clientInstaller).toContain(
      '"PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_PG_DUMP_SHA256" "$EXPECTED_PG_DUMP_SHA256"',
    );
    expect(clientInstaller).toContain(
      '"PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_PG_RESTORE_SHA256" "$EXPECTED_PG_RESTORE_SHA256"',
    );
    expect(dumpHashCheck).toBeGreaterThan(localPackageInstall);
    expect(restoreHashCheck).toBeGreaterThan(dumpHashCheck);
    expect(hashExports).toBeGreaterThan(restoreHashCheck);
    expect(clientInstaller).not.toMatch(
      /EXPECTED_(?:PACKAGE|PG_DUMP|PG_RESTORE)_SHA256=\$\(/,
    );
    expect(clientInstaller).not.toMatch(
      /PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_PG_(?:DUMP|RESTORE)_SHA256"\s+"?\$\([^\n]*sha256sum/,
    );
    expect(clientInstaller).not.toContain("set -x");

    expect(tlsFixture).toContain('IPV6_SUBNET="fd12:7069:6e74:7061::/64"');
    expect(tlsFixture).toContain('IPV6_ADDRESS="fd12:7069:6e74:7061::17"');
    expect(tlsFixture).toContain("--ipv6");
    expect(tlsFixture).toContain('--subnet "$IPV6_SUBNET"');
    expect(tlsFixture).toContain('--ip6 "$IPV6_ADDRESS"');
    expect(tlsFixture).toContain(
      '--label "$NETWORK_FIXTURE_LABEL=$NETWORK_FIXTURE_LABEL_VALUE"',
    );
    expect(tlsFixture).toContain('"basicConstraints=critical,CA:TRUE"');
    expect(tlsFixture).toContain('"subjectAltName=DNS:localhost"');
    expect(tlsFixture).toContain('chmod 0600 "$ca_key" "$ca_cert"');
    expect(tlsFixture).toContain("ALTER SYSTEM SET ssl = 'on'");
    expect(tlsFixture).toContain("ALTER SYSTEM RESET $parameter");
    expect(tlsFixture).toContain(
      'BASELINE_SSL_SETTINGS="off|server.crt|server.key"',
    );
    expect(tlsFixture).toContain(
      'write_state_receipt "$fixture_root" "$network_name" "$network_id" "$container_id" false',
    );
    expect(tlsFixture).toContain('network_id="pending"');
    expect(tlsFixture).toContain("restore_ssl_baseline");
    expect(tlsFixture).toContain("network_names=$(docker network ls");
    expect(tlsFixture).toContain("container_tls_directory_absent");
    expect(tlsFixture).toContain(
      "postgres_logical_restore_tls_cleanup_pending",
    );
    expect(initialStateReceipt).toBeGreaterThan(-1);
    expect(networkCreation).toBeGreaterThan(initialStateReceipt);
    expect(
      cleanupFunction.indexOf('restore_ssl_baseline "$container_id"'),
    ).toBeLessThan(
      cleanupFunction.indexOf('remove_container_keys "$container_id"'),
    );
    expect(tlsFixture.match(/rm -f -- "\$state_file"/g)).toHaveLength(1);
    expect(tlsFixture).not.toContain("cleanup_fixture || true");
    expect(tlsFixture).not.toContain("if: always()");
    expect(tlsFixture).toContain("remove_container_keys");
    expect(tlsFixture).toContain("remove_network");
    expect(tlsFixture).toContain("remove_host_fixture");
    expect(tlsFixture).not.toContain("--network host");
    expect(tlsFixture).not.toContain("set -x");

    expect(restoreIntegration).toContain("createPostgresLogicalBackup({");
    expect(restoreIntegration).toContain(
      "openPostgresRailwayStockLocalhostCaTransport(options",
    );
    expect(restoreIntegration).toContain(
      'const REQUIRED_ENV = "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_REQUIRED"',
    );
    expect(restoreIntegration).toContain(
      'const EXPECTED_POSTGRES_TOOL_VERSION = "17.10 (Ubuntu 17.10-1.pgdg24.04+1)"',
    );
    expect(restoreIntegration).not.toMatch(
      /it\.skip\(\s*["']restores a portable PG17 archive/,
    );
    expect(restoreIntegration).not.toContain(
      "The loopback restore harness cannot create a v3 backup",
    );
  });

  it("requires the real cross-OID V4 scratch-restore mechanism after tool installation", () => {
    const source = workflow("ci.yml");
    const start = source.indexOf("  postgres-migration-integration:");
    const end = source.indexOf("\n  supabase-database:", start);
    const job = source.slice(start, end);
    const installStep = job.indexOf(
      "      - name: Install pinned PostgreSQL 17 logical-backup client",
    );
    const scratchStep = job.indexOf(
      "      - name: Run mandatory V4 cross-OID scratch-restore mechanism observation",
    );
    const hbaSetupStep = job.indexOf(
      "      - name: Protect PostgreSQL HBA baseline for V4 behavior observation",
    );
    const scratchSource = job.slice(scratchStep, hbaSetupStep).trimEnd();
    const integration = repositoryFile(
      "test/postgres-logical-scratch-restore-v4.integration.test.ts",
    );

    expect(installStep).toBeGreaterThan(-1);
    expect(scratchStep).toBeGreaterThan(installStep);
    expect(hbaSetupStep).toBeGreaterThan(scratchStep);
    expect(
      job.match(
        /- name: Run mandatory V4 cross-OID scratch-restore mechanism observation/g,
      ),
    ).toHaveLength(1);
    expect(scratchSource).toBe(
      [
        "      - name: Run mandatory V4 cross-OID scratch-restore mechanism observation",
        "        # This disposable round trip proves the data-only restore mechanics.",
        "        # It does not establish native runtime closure or operational V4 authority.",
        "        env:",
        "          PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_ADMIN_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
        "          PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_PG_BIN: /usr/lib/postgresql/17/bin",
        '          PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_REQUIRED: "true"',
        "        run: npx vitest run test/postgres-logical-scratch-restore-v4.integration.test.ts --maxWorkers=1",
      ].join("\n"),
    );
    expect(scratchSource).not.toContain("\n        if:");
    expect(scratchSource).not.toContain("continue-on-error:");
    expect(scratchSource).not.toContain("secrets.");
    expect(integration).toContain(
      'const ADMIN_URL_ENV = "PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_ADMIN_URL"',
    );
    expect(integration).toContain(
      'const PG_BIN_ENV = "PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_PG_BIN"',
    );
    expect(integration).toContain(
      'const REQUIRED_ENV = "PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_REQUIRED"',
    );
    expect(integration).toContain(
      'configuredRequired === "true" && (!configuredAdminUrl || !configuredPgBin)',
    );
    expect(integration).toContain(
      "const describeIntegration = configuredAdminUrl && configuredPgBin ? describe : describe.skip",
    );
    expect(integration).toContain(
      "sourceCapture = await capturePostgresLogicalStateV2",
    );
    expect(integration).toContain(
      "SELECT pg_catalog.pg_export_snapshot() AS snapshot",
    );
    expect(integration).toContain("after_export_probe");
    expect(integration).toContain("`--snapshot=${exportedSnapshot}`");
    expect(integration).toContain("`--role=${backupGroupRoleName}`");
    expect(integration).toContain(
      "env: toolEnvironment(sourceLoginUrl, sourceDatabase)",
    );
    expect(integration).toContain("CONNECTION LIMIT 2 PASSWORD");
    expect(integration).toContain("WITH ADMIN FALSE, INHERIT FALSE, SET TRUE");
    const loginCreate = integration.indexOf(
      "CREATE ROLE ${quoteIdentifier(ephemeralLoginRoleName)}",
    );
    const sourceSetRole = integration.indexOf(
      "sourceExporter.query(`SET ROLE ${quoteIdentifier(backupGroupRoleName)}`)",
      loginCreate,
    );
    const detachedRevoke = integration.indexOf(
      "activeMaintenance.query(`REVOKE ${quoteIdentifier(backupGroupRoleName)}",
      sourceSetRole,
    );
    const sourceBegin = integration.indexOf(
      'sourceExporter.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")',
      detachedRevoke,
    );
    const sourceCapture = integration.indexOf(
      "sourceCapture = await capturePostgresLogicalStateV2",
      sourceBegin,
    );
    const snapshotExport = integration.indexOf(
      "SELECT pg_catalog.pg_export_snapshot() AS snapshot",
      sourceCapture,
    );
    const dumpRegrant = integration.indexOf(
      "activeMaintenance.query(`GRANT ${quoteIdentifier(backupGroupRoleName)}",
      snapshotExport,
    );
    const dumpSpawn = integration.indexOf(
      "const dump = spawnSync(pgDump",
      dumpRegrant,
    );
    const loginDisabled = integration.indexOf(
      "ALTER ROLE ${quoteIdentifier(ephemeralLoginRoleName)} NOLOGIN",
      dumpSpawn,
    );
    const backendTermination = integration.indexOf(
      "pg_catalog.pg_terminate_backend(activity.pid, 5000)",
      loginDisabled,
    );
    const loginDrop = integration.indexOf(
      "DROP ROLE ${quoteIdentifier(ephemeralLoginRoleName)}",
      backendTermination,
    );
    expect([
      loginCreate,
      sourceSetRole,
      detachedRevoke,
      sourceBegin,
      sourceCapture,
      snapshotExport,
      dumpRegrant,
      dumpSpawn,
      loginDisabled,
      backendTermination,
      loginDrop,
    ]).toEqual(
      [
        ...[
          loginCreate,
          sourceSetRole,
          detachedRevoke,
          sourceBegin,
          sourceCapture,
          snapshotExport,
          dumpRegrant,
          dumpSpawn,
          loginDisabled,
          backendTermination,
          loginDrop,
        ],
      ].sort((left, right) => left - right),
    );
    expect(loginCreate).toBeGreaterThan(-1);
    expect(integration).toContain(
      "parsePostgresLogicalBackupV4TocListing(listing.stdout)",
    );
    expect(integration).toContain(
      "validatePostgresLogicalScratchRestoreV4PreLoadObservation",
    );
    expect(integration).toContain(
      "validatePostgresLogicalScratchRestoreV4PostLoadObservation",
    );
    expect(integration).toContain(
      "for (const descriptor of POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS)",
    );
    expect(integration).toContain("DISABLE TRIGGER");
    expect(integration).toContain("transactionRolledBack: true");
    expect(integration).toContain("disposal.permitsSuccessReceipt");
    expect(integration).toContain(
      "This does not establish source-recorder authority,",
    );
    expect(integration).not.toContain("NativeRuntimeClosureVerified: true");
  });

  it("requires the service-backed V4 authentication and raw-list behavior observation before TLS mutation", () => {
    const source = workflow("ci.yml");
    const start = source.indexOf("  postgres-migration-integration:");
    const end = source.indexOf("\n  supabase-database:", start);
    const job = source.slice(start, end);
    const installStep = job.indexOf(
      "      - name: Install pinned PostgreSQL 17 logical-backup client",
    );
    const hbaSetupStep = job.indexOf(
      "      - name: Protect PostgreSQL HBA baseline for V4 behavior observation",
    );
    const v4TestStep = job.indexOf(
      "      - name: Run mandatory V4 PostgreSQL 17 authentication and raw-list behavior observation",
    );
    const hbaCleanupStep = job.indexOf(
      "      - name: Restore and remove PostgreSQL HBA baseline after V4 behavior observation",
    );
    const tlsSetupStep = job.indexOf(
      "      - name: Configure disposable fd12 PostgreSQL TLS fixture",
    );
    const installer = repositoryFile("scripts/ci/install-postgresql-client-17");
    const helper = repositoryFile(
      "scripts/ci/postgres-tool-authority-v4-hba-fixture",
    );
    const integration = repositoryFile(
      "test/postgres-tool-authority-v4-pg17.integration.test.ts",
    );
    const operationalSourceAuthority = repositoryFile(
      "src/lib/postgres-logical-backup-v4-source-authority-v2.ts",
    );
    const setupSource = job.slice(hbaSetupStep, v4TestStep).trimEnd();
    const testSource = job.slice(v4TestStep, hbaCleanupStep).trimEnd();
    const cleanupSource = job.slice(hbaCleanupStep, tlsSetupStep).trimEnd();

    expect(job).toContain(
      "image: postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
    );
    expect(installStep).toBeGreaterThan(-1);
    expect(hbaSetupStep).toBeGreaterThan(installStep);
    expect(v4TestStep).toBeGreaterThan(hbaSetupStep);
    expect(hbaCleanupStep).toBeGreaterThan(v4TestStep);
    expect(tlsSetupStep).toBeGreaterThan(hbaCleanupStep);
    expect(setupSource).toBe(
      [
        "      - name: Protect PostgreSQL HBA baseline for V4 behavior observation",
        "        env:",
        "          PINTPATH_CI_POSTGRES_CONTAINER_ID: ${{ job.services.postgres.id }}",
        "          PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_DATABASE: pintpath_v4_tool_3e7a8c19d4f2",
        "          PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_ROLE: pintpath_v4_backup_3e7a8c19d4f2",
        "        run: bash scripts/ci/postgres-tool-authority-v4-hba-fixture setup",
      ].join("\n"),
    );
    expect(testSource).toBe(
      [
        "      - name: Run mandatory V4 PostgreSQL 17 authentication and raw-list behavior observation",
        "        # This disposable gate observes PG17 behavior only. It does not verify",
        "        # native runtime closure or establish production tool authority.",
        "        env:",
        "          PINTPATH_CI_POSTGRES_CONTAINER_ID: ${{ job.services.postgres.id }}",
        "          PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_ADMIN_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable",
        "          PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_DATABASE: pintpath_v4_tool_3e7a8c19d4f2",
        "          PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_MODE: service",
        '          PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_REQUIRED: "true"',
        "          PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_ROLE: pintpath_v4_backup_3e7a8c19d4f2",
        "        run: npx vitest run test/postgres-tool-authority-v4-pg17.integration.test.ts --maxWorkers=1",
      ].join("\n"),
    );
    expect(cleanupSource).toBe(
      [
        "      - name: Restore and remove PostgreSQL HBA baseline after V4 behavior observation",
        "        if: always()",
        "        env:",
        "          PINTPATH_CI_POSTGRES_CONTAINER_ID: ${{ job.services.postgres.id }}",
        "        run: bash scripts/ci/postgres-tool-authority-v4-hba-fixture cleanup",
      ].join("\n"),
    );
    expect(setupSource).not.toContain("\n        if:");
    expect(testSource).not.toContain("\n        if:");
    expect(testSource).not.toContain("continue-on-error:");
    expect(`${setupSource}\n${testSource}\n${cleanupSource}`).not.toContain(
      "secrets.",
    );
    expect(testSource).toContain(
      "# This disposable gate observes PG17 behavior only. It does not verify",
    );
    expect(testSource).toContain(
      "# native runtime closure or establish production tool authority.",
    );
    const observationGateSources = [
      setupSource,
      testSource,
      cleanupSource,
      installer,
      helper,
      integration,
    ].join("\n");
    for (const unsupportedClosureClaim of [
      "pgDumpNativeRuntimeClosureVerified",
      "pgDumpNativeRuntimeClosureEvidenceSha256",
      "pgRestoreNativeRuntimeClosureVerified",
      "pgRestoreNativeRuntimeClosureEvidenceSha256",
    ])
      expect(observationGateSources).not.toContain(unsupportedClosureClaim);
    expect(observationGateSources).not.toMatch(
      /PINTPATH_[A-Z0-9_]*PRODUCTION[A-Z0-9_]*TOOL[A-Z0-9_]*AUTHORITY/,
    );
    expect(observationGateSources).not.toMatch(
      /production tool authority (?:is )?verified/i,
    );
    expect(integration).not.toContain(
      "postgres-logical-backup-v4-source-authority-v2",
    );
    expect(operationalSourceAuthority).toContain(
      "tools.pgDumpNativeRuntimeClosureVerified !== true",
    );
    expect(operationalSourceAuthority).toContain(
      "!safeHash(tools.pgDumpNativeRuntimeClosureEvidenceSha256)",
    );
    expect(operationalSourceAuthority).toContain(
      "tools.pgRestoreNativeRuntimeClosureVerified !== true",
    );
    expect(operationalSourceAuthority).toContain(
      "!safeHash(tools.pgRestoreNativeRuntimeClosureEvidenceSha256)",
    );
    expect(installer).toContain(
      "# This does not verify native shared-library/runtime closure and cannot",
    );
    expect(installer).toContain("# establish production tool authority.");

    for (const value of [
      '"PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_BIN" "$PG_BIN"',
      '"PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_DUMP_VERSION" "$EXPECTED_PG_DUMP_VERSION"',
      '"PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_DUMP_SHA256" "$EXPECTED_PG_DUMP_SHA256"',
      '"PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_RESTORE_VERSION" "$EXPECTED_PG_RESTORE_VERSION"',
      '"PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_RESTORE_SHA256" "$EXPECTED_PG_RESTORE_SHA256"',
    ])
      expect(installer).toContain(value);
    const v4DumpHashExport = installer.indexOf(
      '"PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_DUMP_SHA256" "$EXPECTED_PG_DUMP_SHA256"',
    );
    const v4RestoreHashExport = installer.indexOf(
      '"PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_RESTORE_SHA256" "$EXPECTED_PG_RESTORE_SHA256"',
    );
    expect(v4DumpHashExport).toBeGreaterThan(
      installer.indexOf(
        'printf \'%s  %s\\n\' "$EXPECTED_PG_DUMP_SHA256" "$PG_DUMP"',
      ),
    );
    expect(v4RestoreHashExport).toBeGreaterThan(
      installer.indexOf(
        'printf \'%s  %s\\n\' "$EXPECTED_PG_RESTORE_SHA256" "$PG_RESTORE"',
      ),
    );
    expect(installer).not.toMatch(
      /PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_PG_(?:DUMP|RESTORE)_SHA256"\s+"?\$\([^\n]*sha256sum/,
    );

    expect(
      fs.statSync(
        path.resolve(
          process.cwd(),
          "scripts/ci/postgres-tool-authority-v4-hba-fixture",
        ),
      ).mode & 0o777,
    ).toBe(0o755);
    expect(helper).toContain(
      "printf '%s\\n' \"hostnossl $state_database $state_role $state_client_ipv4/32 trust\"",
    );
    expect(helper).toContain("trap cleanup_incomplete_setup EXIT");
    expect(helper).toContain("pg_catalog.pg_hba_file_rules");
    expect(helper).toContain(
      "SELECT type, database[1], user_name[1], address, netmask, auth_method",
    );
    expect(helper).toContain('-v netmask="255.255.255.255"');
    expect(helper).toContain("pg_catalog.pg_reload_conf()");
    expect(helper).toContain("current_matches_baseline");
    expect(helper).toContain("baseline_matches_state");
    expect(helper).toContain(
      'if ! current_matches_baseline "$container_id" && ! current_matches_fixture "$container_id"; then',
    );
    expect(helper).toContain("postgres_tool_authority_v4_hba_drift_detected");
    const incompleteSetupCleanup = helper.slice(
      helper.indexOf("cleanup_incomplete_setup()"),
      helper.indexOf("docker_exec_root()"),
    );
    expect(
      incompleteSetupCleanup.indexOf(
        'baseline_matches_state "$setup_container_id"',
      ),
    ).toBeGreaterThan(-1);
    expect(
      incompleteSetupCleanup.indexOf(
        'current_matches_baseline "$setup_container_id"',
      ),
    ).toBeGreaterThan(
      incompleteSetupCleanup.indexOf(
        'baseline_matches_state "$setup_container_id"',
      ),
    );
    expect(
      incompleteSetupCleanup.indexOf('rm -f "$CONTAINER_HBA_BACKUP"'),
    ).toBeGreaterThan(
      incompleteSetupCleanup.indexOf(
        'current_matches_baseline "$setup_container_id"',
      ),
    );
    const restoreFunction = helper.slice(
      helper.indexOf("restore_fixture()"),
      helper.indexOf("cleanup_fixture()"),
    );
    const cleanupFunction = helper.slice(
      helper.indexOf("cleanup_fixture()"),
      helper.indexOf("for command_name in awk docker"),
    );
    const missingBackupBranch = cleanupFunction.slice(
      cleanupFunction.indexOf(
        'if docker_exec_root "$state_container_id" test ! -e "$CONTAINER_HBA_BACKUP"',
      ),
      cleanupFunction.indexOf("  restore_fixture || return 1"),
    );
    expect(missingBackupBranch).toContain(
      'current_matches_baseline "$state_container_id" || return 1',
    );
    expect(missingBackupBranch).toContain(
      'docker_exec_root "$state_container_id" test ! -L "$CONTAINER_HBA_BACKUP"',
    );
    expect(missingBackupBranch).toContain(
      'validate_hba_rules "$state_container_id" || return 1',
    );
    expect(missingBackupBranch).toContain(
      'reload_hba "$state_container_id" || return 1',
    );
    expect(
      missingBackupBranch.indexOf('rm -f -- "$state_file"'),
    ).toBeGreaterThan(
      missingBackupBranch.indexOf(
        'current_matches_baseline "$state_container_id"',
      ),
    );
    expect(restoreFunction).toContain(
      'if ! current_matches_baseline "$container_id" && ! current_matches_fixture "$container_id"; then',
    );
    expect(
      restoreFunction.indexOf('baseline_matches_state "$container_id" || fail'),
    ).toBeLessThan(
      restoreFunction.indexOf('if ! current_matches_baseline "$container_id"'),
    );
    expect(
      restoreFunction.indexOf("postgres_tool_authority_v4_hba_drift_detected"),
    ).toBeLessThan(restoreFunction.indexOf('mv -f "$sibling" "$hba"'));
    expect(restoreFunction).not.toContain('rm -f "$CONTAINER_HBA_BACKUP"');
    expect(restoreFunction).not.toContain('rm -f -- "$state_file"');
    expect(cleanupFunction.indexOf("restore_fixture || return 1")).toBeLessThan(
      cleanupFunction.indexOf(
        'docker_exec_root "$state_container_id" rm -f "$CONTAINER_HBA_BACKUP"',
      ),
    );
    expect(
      cleanupFunction.indexOf(
        'baseline_matches_state "$state_container_id" || return 1',
      ),
    ).toBeLessThan(
      cleanupFunction.indexOf(
        'docker_exec_root "$state_container_id" rm -f "$CONTAINER_HBA_BACKUP"',
      ),
    );
    expect(
      cleanupFunction.indexOf(
        'docker_exec_root "$state_container_id" test ! -e "$CONTAINER_HBA_BACKUP"',
      ),
    ).toBeLessThan(cleanupFunction.lastIndexOf('rm -f -- "$state_file"'));
    expect(
      cleanupFunction.lastIndexOf(
        'docker_exec_root "$state_container_id" test ! -L "$CONTAINER_HBA_BACKUP"',
      ),
    ).toBeLessThan(cleanupFunction.lastIndexOf('rm -f -- "$state_file"'));
    expect(cleanupFunction).toContain(
      '[[ ! -e "$state_file" && ! -L "$state_file" ]]',
    );
    expect(helper).toContain('mv -f "$sibling" "$hba"');
    expect(helper).toContain('failure_stage="baseline-copy"');
    expect(helper).toContain('failure_stage="baseline-verify"');
    expect(helper).toContain('failure_stage="hba-parse"');
    expect(helper).toContain(
      "SELECT pg_catalog.host(pg_catalog.inet_client_addr())",
    );
    expect(helper).not.toContain("SELECT pg_catalog.inet_client_addr()::text");
    expect(helper).toContain(
      '"postgres_tool_authority_v4_hba_fixture_failed" "$failure_stage"',
    );
    expect(helper).toContain('cp "$source" "$destination"');
    expect(helper).toContain('chown "$uid:$gid" "$destination"');
    expect(helper).toContain('chmod "$mode" "$destination"');
    expect(helper).not.toContain('cp -p "$hba_path" "$CONTAINER_HBA_BACKUP"');
    expect(helper).toContain(
      "for command_name in cat chmod chown cmp cp grep mv readlink sed sha256sum stat tail",
    );
    expect(helper).not.toContain("host all all trust");
    expect(helper).not.toContain("host all all 0.0.0.0/0 trust");
    expect(helper).not.toContain("cleanup_fixture || true");

    expect(integration).toContain(
      'const MODE_ENV = "PINTPATH_POSTGRES_TOOL_AUTHORITY_V4_TEST_MODE"',
    );
    expect(integration).toContain(
      'const EXPECTED_SERVER_VERSION_NUM = "170006"',
    );
    expect(integration).toContain('PGREQUIREAUTH: "scram-sha-256"');
    expect(integration).toContain(
      'if (mode !== "disabled" && configuredRequired !== "true")',
    );
    expect(integration).toContain('parsed.username !== "postgres"');
    expect(integration).toContain('parsed.password !== "postgres"');
    expect(integration).toContain("expectedPgDumpSha256");
    expect(integration).toContain("expectedPgRestoreSha256");
    expect(integration).toContain(
      "expect(sha256File(pgDump)).toBe(evidence.pgDumpSha256)",
    );
    expect(integration).toContain(
      "POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS.length",
    );
    expect(integration).toContain(
      "POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS).toHaveLength(59)",
    );
    expect(integration).toContain('run(HBA_FIXTURE, ["activate"]');
    expect(integration).toContain('run(HBA_FIXTURE, ["restore"]');
    expect(integration).toContain(
      "SELECT pg_catalog.host(pg_catalog.inet_client_addr())",
    );
    expect(integration).not.toContain(
      "SELECT pg_catalog.inet_client_addr()::text",
    );
    expect(integration).toContain(
      "runReviewedDump(afterRestorePath, environment, toolEvidence)",
    );
    expect(integration).toContain('purpose: "list-v4"');
    expect(integration).toContain("parsePostgresLogicalBackupV4TocListing(");
    expect(integration).toContain("parsed.listingSha256");
    expect(integration).toContain(
      'describeIntegration("PostgreSQL 17 V4 authentication and raw-list behavior observation"',
    );
    expect(integration).toContain("const PROCESS_TIMEOUT_MS = 30_000");
    expect(integration).toContain('killSignal: "SIGKILL"');
    expect(integration).toContain("timeout: PROCESS_TIMEOUT_MS");
    expect(integration).toContain("service_objects_cleanup_incomplete");
    expect(integration).toContain(
      "// runtime-closure evidence required by the operational V4 source authority.",
    );
    const integrationLifecycle = integration.slice(
      integration.indexOf("describeIntegration("),
    );
    const isolatedStartAttempt = integrationLifecycle.indexOf(
      "isolatedStartAttempted = true;",
    );
    const isolatedStart = integrationLifecycle.indexOf(
      'run(executable(PG_CTL), ["-D", dataDirectory, "-l", path.join(root, "postgres.log"), "-w", "start"]);',
    );
    const roleCreationAttempt = integrationLifecycle.indexOf(
      "roleCreationAttempted = true;",
    );
    const roleCreation = integrationLifecycle.indexOf("`CREATE ROLE ${role}");
    const databaseCreationAttempt = integrationLifecycle.indexOf(
      "databaseCreationAttempted = true;",
    );
    const databaseCreation = integrationLifecycle.indexOf(
      "`CREATE DATABASE ${database}",
    );
    expect(isolatedStartAttempt).toBeGreaterThan(-1);
    expect(isolatedStartAttempt).toBeLessThan(isolatedStart);
    expect(roleCreationAttempt).toBeGreaterThan(-1);
    expect(roleCreationAttempt).toBeLessThan(roleCreation);
    expect(databaseCreationAttempt).toBeGreaterThan(-1);
    expect(databaseCreationAttempt).toBeLessThan(databaseCreation);
    const lifecycleFinally = integrationLifecycle.slice(
      integrationLifecycle.indexOf("    } finally {"),
    );
    expect(lifecycleFinally).toContain(
      "if (databaseCreationAttempted || roleCreationAttempted)",
    );
    expect(lifecycleFinally).toContain(
      "`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`",
    );
    expect(lifecycleFinally).toContain("`DROP ROLE IF EXISTS ${role}`");
    expect(lifecycleFinally).toContain(
      "remainingObjects.status !== 0 || remainingObjects.signal !== null",
    );
    expect(lifecycleFinally).toContain(
      'remainingObjects.error !== undefined || remainingObjects.stdout !== "0|0\\n"',
    );
    const statusCheck = lifecycleFinally.indexOf(
      'const status = spawnBounded(pgCtl, ["-D", dataDirectory, "status"]);',
    );
    const attemptedStop = lifecycleFinally.indexOf(
      'spawnBounded(pgCtl, ["-D", dataDirectory, "-m", "immediate", "-w", "stop"]);',
    );
    const finalStatusCheck = lifecycleFinally.indexOf(
      'const finalStatus = spawnBounded(pgCtl, ["-D", dataDirectory, "status"]);',
    );
    expect(lifecycleFinally).toContain("if (isolatedStartAttempted)");
    expect(statusCheck).toBeGreaterThan(-1);
    expect(attemptedStop).toBeGreaterThan(statusCheck);
    expect(finalStatusCheck).toBeGreaterThan(attemptedStop);
    expect(lifecycleFinally).toContain(
      "isolatedServerQuiescent = finalStatus.status === 3",
    );
    expect(
      lifecycleFinally.indexOf("if (isolatedServerQuiescent)"),
    ).toBeLessThan(lifecycleFinally.indexOf("fs.rmSync(root"));
    expect(integration).not.toContain("databaseCreated");
    expect(integration).not.toContain("roleCreated");
    expect(integration).not.toContain("describe.skipIf");
    expect(integration).not.toContain("it.skip");
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
    expect(wrapper).toContain('\' sh "$@" < <(');
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
    expect(runbook).toContain("with GraphQL `usePreviousImageTag: true`");
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
    expect(runbook).toContain("Never\nrestore an exposed credential");
  });

  it("keeps private Storage recovery provider-gated and bound to the local PG17 contract", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const runbook = releaseDocument("postgres-private-storage-recovery.md");

    expect(
      packageJson.scripts?.["db:postgres:backup:private-storage-recovery"],
    ).toBe(
      "node --frozen-intrinsics --disable-proto=throw --import tsx " +
        "scripts/capture-postgres-private-storage-recovery.ts",
    );
    expect(
      packageJson.scripts?.["db:postgres:restore:private-storage-recovery"],
    ).toBe(
      "node --frozen-intrinsics --disable-proto=throw --import tsx " +
        "scripts/restore-postgres-private-storage-recovery.ts",
    );
    expect(runbook).toContain("launch gates remain **OPEN**");
    expect(runbook).toContain("No Supabase, Railway, AWS, production, or");
    expect(runbook).toContain("retry with a fresh");
    expect(runbook).toContain("destinationDisposalRequired=true");
    expect(runbook).toContain(
      "The integration above is checked-in capability, not live recovery evidence.",
    );
  });

  it("pins development to the reviewed Node 22 runtime baseline", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      engines?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(repositoryFile(".node-version").trim()).toBe("22.23.2");
    expect(packageJson.engines?.node).toBe("22.23.2");
    expect(packageJson.devDependencies?.["@types/node"]).toMatch(/^\^22\./);
    for (const name of [
      "ci.yml",
      "pintpath-release-gate.yml",
      "pintpath-release-readiness.yml",
      "production-health.yml",
      "venue-directory-refresh.yml",
    ]) {
      expect(workflow(name), name).toContain(
        "node-version-file: .node-version",
      );
    }
    const ci = workflow("ci.yml");
    expect(ci.match(/node-version-file: \.node-version/g)).toHaveLength(3);
    expect(ci).toContain(
      'PINTPATH_LOCKED_SENSITIVE_WORKER_TEST_REQUIRED: "true"',
    );
    expect(ci).toContain(
      "run: npx vitest run test/locked-sensitive-worker-boundary.test.ts --maxWorkers=1",
    );
  });

  it("refreshes every production Place ID daily with exact-target and fail-closed checks", () => {
    const source = workflow("venue-directory-refresh.yml");
    const transportValidator = repositoryFile(
      "scripts/validate-production-supabase-transport.ts",
    );

    expect(source).toContain('cron: "23 14 * * *"');
    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("environment: production");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).toContain(
      "PINTPATH_EXPECTED_SUPABASE_PROJECT_REF: jxpubqlmqnnqwadmjgyk",
    );
    expect(source).toContain(
      "GOOGLE_PLACES_API_KEY: ${{ secrets.GOOGLE_PLACES_API_KEY }}",
    );
    expect(source.match(/--status-only/g)).toHaveLength(2);
    expect(source).toContain("--dry-run");
    expect(source).toContain(
      "npm exec tsx -- scripts/validate-production-supabase-transport.ts",
    );
    expect(
      source.indexOf("Verify the exact production Supabase target"),
    ).toBeLessThan(
      source.indexOf("Check whether the directory-status schema is released"),
    );
    expect(transportValidator).toContain(
      'PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au"',
    );
    expect(transportValidator).toContain(
      'PRODUCTION_SUPABASE_PROJECT_REF = "jxpubqlmqnnqwadmjgyk"',
    );
    expect(transportValidator).toContain("assertSupabaseServerApiKey(");
    expect(source).toContain("id: directory_schema");
    expect(source).toContain(
      "20260728120312_venue_directory_operational_status",
    );
    expect(
      source.match(/if: steps\.directory_schema\.outputs\.ready == 'true'/g),
    ).toHaveLength(2);
    expect(source).toContain(
      "if: always() && steps.directory_schema.outputs.ready == 'true'",
    );
    expect(source).toContain("ageHours >= 120");
    expect(source).toContain("ageHours >= 138");
    expect(source).toContain("directory_eligible");
    expect(source).toContain("id: supabase_transport");
    expect(source).toContain("--print-key-kind");
    expect(source).not.toContain('serviceRoleKey.startsWith("eyJ")');
    expect(source.match(/keyKind === "legacy_service_role"/g)).toHaveLength(2);
    expect(source.match(/PINTPATH_SUPABASE_SERVER_KEY_KIND/g)).toHaveLength(4);
    expect(source.match(/node --input-type=module <<'NODE'/g)).toHaveLength(2);
    expect(source).not.toMatch(/^[ \t]+node <<'NODE'$/m);
    const inlineModuleBodies = [
      ...source.matchAll(
        /^[ \t]+node --input-type=module <<'NODE'\n([\s\S]*?)^[ \t]+NODE$/gm,
      ),
    ].map((match) => match[1]!);
    expect(inlineModuleBodies).toHaveLength(2);
    for (const body of inlineModuleBodies) {
      const syntaxCheck = spawnSync(
        process.execPath,
        ["--input-type=module", "--check"],
        { encoding: "utf8", input: body },
      );
      expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
    }
    const schemaProbeStep = source.slice(
      source.indexOf(
        "- name: Check whether the directory-status schema is released",
      ),
      source.indexOf(
        "- name: Validate a complete status refresh without writes",
      ),
    );
    const freshnessStep = source.slice(
      source.indexOf("- name: Enforce five-day warning and pre-expiry failure"),
    );
    for (const step of [schemaProbeStep, freshnessStep]) {
      expect(step).toContain(
        "PINTPATH_SUPABASE_SERVER_KEY_KIND: ${{ steps.supabase_transport.outputs.key_kind }}",
      );
      expect(step).toContain(
        "const keyKind = process.env.PINTPATH_SUPABASE_SERVER_KEY_KIND;",
      );
    }
    expect(source).toContain(
      "headers.Authorization = `Bearer ${serviceRoleKey}`",
    );
    expect(source.match(/redirect: "error"/g)).toHaveLength(2);
    expect(source).not.toContain("Authorization: `Bearer ${serviceRoleKey}`");
    expect(source).not.toContain("upload-artifact");

    const jobPrefix = source.slice(0, source.indexOf("    steps:"));
    expect(jobPrefix).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(jobPrefix).not.toContain("GOOGLE_PLACES_API_KEY");
  });

  it("fails CI for dependency vulnerabilities at every npm severity", () => {
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["security:audit"]).toBe(
      "npm audit --audit-level=low",
    );
    expect(workflow("ci.yml")).toContain("npm run security:audit");
  });

  it("pins the audited Gradle 9.7.0 wrapper distribution and generated launchers", () => {
    const wrapper = repositoryFile(
      "apps/android/gradle/wrapper/gradle-wrapper.properties",
    );

    expect(wrapper).toContain(
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.7.0-bin.zip",
    );
    expect(wrapper).toContain(
      "distributionSha256Sum=84fbba45c7f4c64abc77460e1c00f541e9f960e3c7ed2538f1ede19eacd873ae",
    );
    expect(repositoryFileSha256("apps/android/gradlew")).toBe(
      "a5a5c199ba02189ae8c46a334223371a20599d9c298ef65e7540ede4a3f72d59",
    );
    expect(repositoryFileSha256("apps/android/gradlew.bat")).toBe(
      "d539676c48b596afda64c963ec8f7ee56c7b3fe7e3b81d1dbe2d1a1e3dd9e9f8",
    );
    expect(
      repositoryFileSha256("apps/android/gradle/wrapper/gradle-wrapper.jar"),
    ).toBe("7a9ce74cff467ca1bf60a4fcd9f05185acceda4d0f382434d393e17864262c5d");
    expect(
      repositoryFileSha256(
        "apps/android/gradle/wrapper/gradle-wrapper.properties",
      ),
    ).toBe("dfe4f5a7c503ce4c2e29e020a1614c7ce5e40d5529e6c2ae59016094497d768c");
  });

  it("pins one AGP 9 built-in Kotlin Android dependency contract", () => {
    const rootBuild = repositoryFile("apps/android/build.gradle.kts");
    const appBuild = repositoryFile("apps/android/app/build.gradle.kts");
    const gradleProperties = repositoryFile("apps/android/gradle.properties");

    expect(rootBuild).toContain(
      'id("com.android.application") version "9.3.1" apply false',
    );
    expect(rootBuild).toContain(
      'id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false',
    );
    expect(rootBuild).not.toContain("org.jetbrains.kotlin.android");
    expect(appBuild).not.toContain("org.jetbrains.kotlin.android");
    expect(gradleProperties).not.toContain("android.builtInKotlin=false");
    expect(gradleProperties).not.toContain("android.newDsl=false");
    expect(appBuild).toContain('id("org.jetbrains.kotlin.plugin.compose")');
    expect(appBuild).not.toContain("kotlinOptions");
    expect(appBuild).toContain(
      "import org.jetbrains.kotlin.gradle.dsl.JvmTarget",
    );
    expect(appBuild).toContain("kotlin {\n    compilerOptions {");
    expect(appBuild).toContain("jvmTarget.set(JvmTarget.JVM_17)");
    expect(appBuild).toContain("compileSdk = 37");
    expect(appBuild).toContain("targetSdk = 36");
    for (const dependency of [
      "androidx.activity:activity-compose:1.13.0",
      "androidx.core:core-ktx:1.19.0",
      "androidx.lifecycle:lifecycle-runtime-compose:2.11.0",
      "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0",
    ]) {
      expect(appBuild).toContain(`implementation("${dependency}")`);
    }
  });

  it("does not let tee hide a failed release command", () => {
    for (const name of allWorkflows()) {
      const lines = workflow(name).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.includes("| tee")) continue;
        expect(
          lines.slice(Math.max(0, index - 3), index).join("\n"),
          `${name}:${index + 1}`,
        ).toContain("set -o pipefail");
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
    expect(source).toContain(
      "must not report success without end-to-end credentials",
    );
    expect(source).toContain(
      "PINTPATH_SMOKE_USER_EMAIL: ${{ secrets.PINTPATH_SMOKE_USER_EMAIL }}",
    );
    expect(source).toContain(
      "PINTPATH_SMOKE_USER_PASSWORD: ${{ secrets.PINTPATH_SMOKE_USER_PASSWORD }}",
    );
    expect(source).toContain(
      "PINTPATH_SMOKE_VENUE_EMAIL: ${{ secrets.PINTPATH_SMOKE_VENUE_EMAIL }}",
    );
    expect(source).toContain(
      "PINTPATH_SMOKE_VENUE_PASSWORD: ${{ secrets.PINTPATH_SMOKE_VENUE_PASSWORD }}",
    );
    expect(source).toContain("SUPABASE_URL: ${{ secrets.SUPABASE_URL }}");
    expect(source).toContain(
      "SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}",
    );
    expect(source).toContain("--auth-only --roles=user,venue");
    expect(source).toContain(
      "public probes alone cannot observe authenticated user and venue-manager paths",
    );
    expect(source).toContain("          exit 1");
    expect(source).not.toContain("PINTPATH_SMOKE_ADMIN_TOKEN");
    expect(source).not.toContain("PINTPATH_SMOKE_ADMIN_PASSWORD");
    expect(source).not.toContain("TOTP");
    const publicJob = source.slice(
      source.indexOf("  public-production-health:"),
      source.indexOf("  authenticated-user-venue-health:"),
    );
    expect(publicJob).toContain(
      "npm run --silent readiness:data | tee production-data-readiness.json",
    );
    expect(publicJob).toContain("PINTPATH_DATA_BASE_URL: https://pintpath.au");
    expect(publicJob).not.toContain("PINTPATH_DATA_STRICT");
    expect(publicJob).not.toContain("secrets.");

    const authenticatedJobPrefix =
      source.match(/authenticated-user-venue-health:[\s\S]*?steps:/)?.[0] || "";
    expect(authenticatedJobPrefix).not.toContain(
      "PINTPATH_SMOKE_USER_PASSWORD",
    );
    expect(authenticatedJobPrefix).not.toContain(
      "PINTPATH_SMOKE_VENUE_PASSWORD",
    );
    expect(authenticatedJobPrefix).not.toContain(
      "SUPABASE_URL: ${{ secrets.SUPABASE_URL }}",
    );
    expect(authenticatedJobPrefix).not.toContain(
      "SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}",
    );
    const checkoutStep =
      source.match(/- name: Checkout[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    const setupNodeStep =
      source.match(/- name: Setup Node[\s\S]*?(?=\n\s{6}- name:)/)?.[0] || "";
    expect(checkoutStep).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(checkoutStep).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(setupNodeStep).not.toContain("PINTPATH_SMOKE_USER_PASSWORD");
    expect(setupNodeStep).not.toContain("PINTPATH_SMOKE_VENUE_PASSWORD");
    expect(checkoutStep).not.toContain(
      "SUPABASE_URL: ${{ secrets.SUPABASE_URL }}",
    );
    expect(checkoutStep).not.toContain(
      "SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}",
    );
    expect(setupNodeStep).not.toContain(
      "SUPABASE_URL: ${{ secrets.SUPABASE_URL }}",
    );
    expect(setupNodeStep).not.toContain(
      "SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}",
    );

    const smoke = productionSmoke();
    expect(smoke).toContain(
      'path: "/api/business/admin/queues?limit=1&offset=0"',
    );
    expect(smoke).toContain("Array.isArray(data.wrongPriceReports)");
    expect(smoke).toContain("/api/business/auth/supabase-session");
    expect(smoke).toContain("/api/business/auth/logout");
    expect(smoke).toContain(
      "Public Supabase URL does not match protected SUPABASE_URL",
    );
    expect(smoke).toContain(
      "Public Supabase key does not match protected SUPABASE_ANON_KEY",
    );
  });

  it("pages failed production monitors with provider-credential-free deadman signals", () => {
    const health = workflow("production-health.yml");
    const refresh = workflow("venue-directory-refresh.yml");
    const authenticatedHealth = workflowJobContaining(
      health,
      "PINTPATH_SMOKE_BASE_URL",
    );
    const healthNotifier = workflowJobContaining(
      health,
      "environment: production-monitoring-alerts",
    );
    const refreshNotifier = workflowJobContaining(
      refresh,
      "environment: production-monitoring-alerts",
    );

    expect(authenticatedHealth).toMatch(
      /^    environment:\s*production-monitoring\s*$/m,
    );
    expect(healthNotifier).not.toBe("");
    expect(refreshNotifier).not.toBe("");

    const assertNotifierTransport = (
      notifier: string,
      payloadEnvironmentNames: string[],
    ) => {
      expect(notifier).toMatch(
        /^    if:\s*(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?\s*$/m,
      );
      expect(notifier).toMatch(
        /^    environment:\s*production-monitoring-alerts\s*$/m,
      );
      expect(workflowSecretNames(notifier)).toEqual([
        "PINTPATH_PRODUCTION_MONITOR_WEBHOOK_URL",
      ]);
      expect(notifier).not.toContain("actions/checkout");
      expect(notifier).not.toContain("actions/setup-node");
      expect(notifier).not.toMatch(
        /SUPABASE_|GOOGLE_PLACES|PINTPATH_SMOKE_|PROVIDER_/,
      );

      const payloadStart = notifier.indexOf('payload="');
      const curlStart = notifier.indexOf("curl ", payloadStart);
      expect(payloadStart).toBeGreaterThan(-1);
      expect(curlStart).toBeGreaterThan(payloadStart);
      const payloadBuilder = notifier.slice(payloadStart, curlStart);
      const referencedPayloadEnvironmentNames = [
        ...new Set(
          [...payloadBuilder.matchAll(/\$([A-Z][A-Z0-9_]*)/g)].map(
            (match) => match[1]!,
          ),
        ),
      ].sort();
      expect(referencedPayloadEnvironmentNames).toEqual(
        [...payloadEnvironmentNames].sort(),
      );
      expect(payloadBuilder).not.toMatch(
        /password|secret|credential|authorization|cookie|webhook|supabase|google[_-]?places/i,
      );

      const curlCommand = notifier.slice(curlStart);
      expect(curlCommand).toMatch(/--proto\s+['"]?=https['"]?/);
      expect(curlCommand).toMatch(/--tlsv1\.2\b/);
      expect(curlCommand).toMatch(/--connect-timeout\s+[1-9][0-9]*/);
      expect(curlCommand).toMatch(/--max-time\s+[1-9][0-9]*/);
      expect(curlCommand).toMatch(/--retry\s+[1-9][0-9]*/);
      expect(curlCommand).toMatch(/--retry-delay\s+1\b/);
      expect(curlCommand).toContain('--data-binary "$payload"');
      expect(curlCommand).toContain('"$MONITOR_WEBHOOK_URL"');
      expect(notifier).toMatch(
        /case\s+"\$http_status"\s+in[\s\S]*?2\?\?\)\s*;;/,
      );
      const deliveredFailureGuard =
        /if\s+\[\[\s*"\$status"\s*={1,2}\s*"failure"\s*\]\];\s*then[\s\S]*?\bexit\s+1\b[\s\S]*?\bfi\b/g.exec(
          notifier,
        );
      expect(deliveredFailureGuard).not.toBeNull();
      expect(deliveredFailureGuard?.index ?? -1).toBeGreaterThan(curlStart);
    };

    expect(healthNotifier).toContain(
      "${{ needs.public-production-health.result }}",
    );
    expect(healthNotifier).toContain(
      "${{ needs.authenticated-user-venue-health.result }}",
    );
    expect(healthNotifier).toContain(
      "EVENT_NAME: ${{ github.event_name }}",
    );
    expect(healthNotifier).toContain(
      "EVENT_SCHEDULE: ${{ github.event.schedule }}",
    );
    expect(healthNotifier).toMatch(/\\"trigger\\":\\"%s\\"/);
    expect(healthNotifier).toMatch(/\\"schedule\\":\\"%s\\"/);

    const normalizedHealthNotifier = healthNotifier
      .replace(/\\\n\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(normalizedHealthNotifier).toContain(
      'monitor="unknown" if [[ "$EVENT_NAME" == "schedule" && "$EVENT_SCHEDULE" == "*/15 * * * *" ]]; then monitor="public"',
    );
    expect(normalizedHealthNotifier).toContain(
      'elif [[ "$EVENT_NAME" == "schedule" && "$EVENT_SCHEDULE" == "7 * * * *" ]]; then monitor="authenticated"',
    );
    expect(normalizedHealthNotifier).toContain(
      'elif [[ "$EVENT_NAME" == "workflow_dispatch" && -z "$EVENT_SCHEDULE" ]]; then monitor="manual"',
    );

    const expectExactHealthSuccessBranch = (
      event: string,
      comparisons: string[],
    ) => {
      const eventAssignment = `event="${event}"`;
      const eventIndex = healthNotifier.indexOf(eventAssignment);
      expect(eventIndex).toBeGreaterThan(-1);

      const branchPrefix = healthNotifier.slice(0, eventIndex);
      const branches = [
        ...branchPrefix.matchAll(
          /(?:^|\n)\s*(?:if|elif)\s+\[\[([\s\S]*?)\]\];\s*then/g,
        ),
      ];
      const branch = branches[branches.length - 1];
      expect(branch).toBeDefined();
      const condition = branch?.[1] ?? "";
      const actualComparisons = [
        ...condition.matchAll(
          /"\$(monitor|PUBLIC_RESULT|AUTHENTICATED_RESULT)"\s*={1,2}\s*"([^"]*)"/g,
        ),
      ]
        .map((match) => `${match[1]}=${match[2]}`)
        .sort();
      expect(actualComparisons).toEqual([...comparisons].sort());
      expect(condition).not.toContain("||");
      expect(condition.match(/&&/g)).toHaveLength(comparisons.length - 1);

      const branchBodyStart = (branch?.index ?? 0) + (branch?.[0].length ?? 0);
      expect(healthNotifier.slice(branchBodyStart, eventIndex)).toContain(
        'status="success"',
      );
    };

    expectExactHealthSuccessBranch(
      "pintpath-production-public-health-heartbeat",
      [
        "monitor=public",
        "PUBLIC_RESULT=success",
        "AUTHENTICATED_RESULT=skipped",
      ],
    );
    expectExactHealthSuccessBranch(
      "pintpath-production-authenticated-health-heartbeat",
      [
        "monitor=authenticated",
        "PUBLIC_RESULT=skipped",
        "AUTHENTICATED_RESULT=success",
      ],
    );
    expectExactHealthSuccessBranch("pintpath-production-health-manual-check", [
      "monitor=manual",
      "PUBLIC_RESULT=success",
      "AUTHENTICATED_RESULT=success",
    ]);
    expect(healthNotifier).not.toContain(
      'event="pintpath-production-health-heartbeat"',
    );
    expect(healthNotifier).toContain(
      'event="pintpath-production-health-failed"',
    );
    const failureEventIndex = healthNotifier.indexOf(
      'event="pintpath-production-health-failed"',
    );
    const manualEventIndex = healthNotifier.indexOf(
      'event="pintpath-production-health-manual-check"',
    );
    expect(
      healthNotifier.slice(manualEventIndex, failureEventIndex),
    ).toMatch(/\n\s*else\s*\n\s*status="failure"\s*\n\s*$/);
    assertNotifierTransport(healthNotifier, [
      "AUTHENTICATED_RESULT",
      "EVENT_NAME",
      "EVENT_SCHEDULE",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "PUBLIC_RESULT",
    ]);

    expect(refresh).toMatch(
      /^    outputs:\s*$[\s\S]*?^      directory_schema_ready:\s*\$\{\{\s*steps\.directory_schema\.outputs\.ready\s*\}\}\s*$/m,
    );
    expect(refreshNotifier).toContain(
      "${{ needs.refresh-production-directory-status.result }}",
    );
    expect(refreshNotifier).toContain(
      "${{ needs.refresh-production-directory-status.outputs.directory_schema_ready }}",
    );
    expect(refreshNotifier).toContain(
      "EVENT_NAME: ${{ github.event_name }}",
    );
    expect(refreshNotifier).toContain(
      "EVENT_SCHEDULE: ${{ github.event.schedule }}",
    );
    expect(refreshNotifier).toMatch(/\\"trigger\\":\\"%s\\"/);
    expect(refreshNotifier).toMatch(/\\"schedule\\":\\"%s\\"/);

    const normalizedRefreshNotifier = refreshNotifier
      .replace(/\\\n\s*/g, " ")
      .replace(/\s+/g, " ");
    expect(normalizedRefreshNotifier).toContain(
      'monitor="unknown" if [[ "$EVENT_NAME" == "schedule" && "$EVENT_SCHEDULE" == "23 14 * * *" ]]; then monitor="daily"',
    );
    expect(normalizedRefreshNotifier).toContain(
      'elif [[ "$EVENT_NAME" == "workflow_dispatch" && -z "$EVENT_SCHEDULE" ]]; then monitor="manual"',
    );
    expect(normalizedRefreshNotifier).toContain(
      'if [[ "$monitor" == "daily" && "$REFRESH_RESULT" == "success" && "$DIRECTORY_SCHEMA_READY" == "true" ]]; then status="success" event="pintpath-venue-directory-refresh-heartbeat"',
    );
    expect(normalizedRefreshNotifier).toContain(
      'elif [[ "$monitor" == "manual" && "$REFRESH_RESULT" == "success" && "$DIRECTORY_SCHEMA_READY" == "true" ]]; then status="success" event="pintpath-venue-directory-refresh-manual-check"',
    );
    expect(normalizedRefreshNotifier).toContain(
      'else status="failure" event="pintpath-venue-directory-refresh-failed"',
    );
    expect(refreshNotifier).toContain(
      'event="pintpath-venue-directory-refresh-heartbeat"',
    );
    expect(refreshNotifier).toContain(
      'event="pintpath-venue-directory-refresh-manual-check"',
    );
    expect(refreshNotifier).toContain(
      'event="pintpath-venue-directory-refresh-failed"',
    );
    assertNotifierTransport(refreshNotifier, [
      "DIRECTORY_SCHEMA_READY",
      "EVENT_NAME",
      "EVENT_SCHEDULE",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "REFRESH_RESULT",
    ]);
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
    expect(railway).toContain(
      '[environments.production.deploy]\nhealthcheckPath = "/startup"',
    );
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
    expect(checklist).toContain(
      "without enabling Pro, trial, paid, reward, counter, or POS",
    );
    expect(checklist).not.toContain("posReference");
    expect(checklist).not.toContain("/api/business/pos/discount-redemptions");
  });

  it("keeps external closeout evidence aligned with workflow triggers and artifacts", () => {
    const checklist = releaseDocument("external-launch-signoffs.md");

    expect(checklist).toContain("Native Apps** must be manually dispatched");
    expect(checklist).toContain("-f run_android=false");
    expect(checklist).toContain("`iOS dispatch prerequisite` check");
    expect(checklist).toContain("`ios-production-configuration` job to pass");
    expect(checklist).toContain("automatic exact-SHA `ios`");
    expect(checklist).toContain("Android job must be skipped");
    expect(checklist).toContain(
      "security-scan and dependency-audit steps passed",
    );
    expect(checklist).toContain("are not files in the artifact");
    expect(checklist).toContain("external TestFlight/Beta App Review");
    expect(checklist).toContain("full App Review approval");
    expect(checklist).toContain("Australia storefront");
    expect(checklist).toContain("manual release");
    expect(checklist).toContain("phased release");
    expect(checklist).toContain("approved build held");
    expect(checklist).not.toContain(
      "does **not** prove public App Store approval",
    );
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
    const migration = releaseDocument(
      "full-scale-postgres-migration-runbook.md",
    );
    const checklist = releaseDocument("external-launch-signoffs.md");
    const provider = releaseDocument("provider-configuration-runbook.md");
    const migrationStatus = releaseDocument(
      "postgres-migration-execution-status.md",
    );
    const normalizedMigration = migration.replace(/\s+/g, " ");
    const normalizedMigrationStatus = migrationStatus.replace(/\s+/g, " ");
    const evidence = JSON.parse(releaseDocument("release-evidence.json")) as {
      items?: Array<{ id?: string; label?: string; nextAction?: string }>;
    };
    const backup = evidence.items?.find((item) => item.id === "backup_restore");

    expect(launch).toContain(
      "The availability decision is closed for this release",
    );
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
    expect(normalizedMigration).toContain(
      "non-exposed server-only application schema",
    );
    expect(normalizedMigration).toContain("least-privilege runtime role");
    expect(normalizedMigration).toContain("FOR UPDATE SKIP LOCKED");
    expect(normalizedMigration).toContain("object-lock/WORM");
    expect(normalizedMigration).toContain("must never resume SQLite writes");
    expect(normalizedMigrationStatus).toContain(
      "Activated the reviewed-price plan, authorization, apply, and receipt-bound quarantine path",
    );
    expect(normalizedMigrationStatus).toContain(
      "separate mode-0600 private review packet",
    );
    expect(normalizedMigrationStatus).toContain(
      "valid signed authorize/apply/replay/quarantine",
    );
    expect(`${launch}\n${migration}\n${migrationStatus}`).not.toContain(
      "high-severity wrong-price reports",
    );

    expect(provider).toContain(
      "Identity pins always hash the exact configured DATABASE_URL bytes",
    );
    expect(provider).toContain("private operational restore copy");
    expect(checklist).toContain("newly created restore-only");
    expect(checklist).toContain("RESTORE_REHEARSAL_EXPECTED_*");
    expect(checklist).not.toMatch(/https:\/\/[a-z0-9]{20}\.supabase\.co/);
    expect(checklist).not.toContain("one app replica and one region");

    expect(backup?.label).toContain("Postgres, private Storage, and WORM");
    expect(backup?.nextAction).toContain(
      "ephemeral destructive restore environment",
    );
    expect(backup?.nextAction).toContain(
      "distinct from production and permanent staging",
    );
  });

  it("keeps launch, provider, Supabase, and budget runbooks aligned with the current no-go", () => {
    const launch = releaseDocument("production-launch-runbook.md");
    const provider = releaseDocument("provider-configuration-runbook.md");
    const databaseTesting = releaseDocument("supabase-database-testing.md");
    const followups = repositoryFile("PROD_FOLLOWUPS.md");
    const launchGates = releaseDocument("launch-9-readiness-gates.md");
    const migrationStatus = releaseDocument(
      "postgres-migration-execution-status.md",
    );
    const fullScaleMigration = releaseDocument(
      "full-scale-postgres-migration-runbook.md",
    );
    const supabaseContainment = releaseDocument(
      "permanent-staging-supabase-key-containment.md",
    );
    const logicalOffsite = releaseDocument(
      "postgres-logical-offsite-attestation.md",
    );
    const normalizedLaunch = launch.replace(/\s+/g, " ");
    const normalizedProvider = provider.replace(/\s+/g, " ");

    expect(normalizedLaunch).toContain(
      "No-go for the requested full-scale web and iOS launch today",
    );
    expect(normalizedLaunch).toContain(
      "no authentic application-deployment attestation receipt exists",
    );
    expect(normalizedLaunch).toContain(
      "`launchReady=false` with 0 of 13 external evidence items passed",
    );
    expect(normalizedLaunch).toContain("All 13 items remain launch gates");
    expect(normalizedLaunch).toContain("approximately US$46.80/month");
    expect(normalizedLaunch).toContain(
      "approximately US$20.13/month if retained for a full month",
    );
    expect(normalizedLaunch).toContain(
      "keep teardown behind the Railway mutation boundary",
    );
    expect(normalizedLaunch).toContain(
      "candidate-bound post-merge permanent-staging import/reconciliation",
    );
    expect(normalizedLaunch).toContain(
      "immutable cross-failure-domain retrieval",
    );
    for (const document of [launch, migrationStatus, fullScaleMigration]) {
      const normalized = document.replace(/\s+/g, " ");
      expect(normalized).toContain(
        "not a staging-only cost or authority boundary",
      );
      expect(normalized).toContain("operational-copy");
      expect(normalized).not.toContain("recurring permanent-staging envelope");
      expect(normalized).not.toContain("recurring staging envelope");
    }
    const normalizedLaunchGates = launchGates.replace(/\s+/g, " ");
    expect(normalizedLaunchGates).toContain(
      "checked-in permanent-staging target",
    );
    expect(normalizedLaunchGates).toContain(
      "production operational-copy and disposable restore under separate hashed authorities",
    );
    expect(normalizedLaunchGates).toContain(
      "One combined v2 receipt is the post-deployment release gate; it cannot authorize deployment",
    );
    expect(normalizedLaunch).toContain("provider-evidence");
    expect(launch).not.toContain(
      "The current repository does not yet contain the complete Postgres adapter",
    );

    expect(normalizedProvider).toContain(
      "Railway Postgres is the application system-of-record target",
    );
    expect(normalizedProvider).toContain(
      "Supabase is not the application system-of-record target",
    );
    expect(normalizedProvider).not.toContain(
      "the target managed Postgres service",
    );
    expect(normalizedProvider).toContain(
      "the separate Supabase cutover ceremony for canary-B, legacy disablement, and old-key denial",
    );
    expect(normalizedProvider).toContain(
      "old `HARD_DISABLED_REVIEW_REQUIRED` CLIs/policies are deprecated fixture kernels, not missing operator paths",
    );
    expect(normalizedProvider).not.toContain(
      "provider-side key creation and local configuration may continue",
    );

    for (const document of [
      provider,
      followups,
      launchGates,
      migrationStatus,
      fullScaleMigration,
    ]) {
      const normalized = document.replace(/\s+/g, " ").toLowerCase();
      expect(normalized).toContain("three google/openai provider categories");
      expect(normalized).toMatch(
        /four exact railway (?:variable operations|variables)/,
      );
      expect(normalized).toContain("prohibited in permanent staging");
      expect(normalized).toMatch(/(?:protected|superseded)/);
      for (const variableName of [
        "GOOGLE_MAPS_API_KEY",
        "GOOGLE_MAPS_MAP_ID",
        "GOOGLE_PLACES_API_KEY",
        "OPENAI_API_KEY",
      ])
        expect(document).toContain(variableName);
      expect(normalized).not.toMatch(
        /three (?:remaining )?(?:staging )?provider credential/,
      );
      expect(normalized).not.toContain("three provider credentials");
    }

    for (const document of [launch, provider, followups, launchGates]) {
      const normalized = document.replace(/\s+/g, " ").toLowerCase();
      expect(normalized).toContain("delete, destroy, or teardown");
      expect(normalized).toContain("complete resource/evidence reconciliation");
      expect(normalized).toContain("specific authorization");
      expect(normalized).toContain("exact reviewed teardown executor");
      expect(normalized).toContain("readiness:railway:mutation-boundary");
      expect(normalized).toContain("unconditional postflight");
      expect(normalized).toContain(
        "signed evidence or two-person sign-off alone is not mutation authority",
      );
    }

    const normalizedFullScale = fullScaleMigration
      .replace(/\s+/g, " ")
      .toLowerCase();
    for (const requirement of [
      "complete resource/evidence reconciliation",
      "specific authorization",
      "exact reviewed teardown executor",
      "mutation-boundary preflight",
      "unconditional postflight",
    ])
      expect(normalizedFullScale).toContain(requirement);
    expect(normalizedFullScale).toContain("delete or destroy");
    expect(normalizedFullScale).toContain(
      "two-person sign-off is necessary but not sufficient for teardown",
    );

    expect(normalizedProvider).toContain(
      "`SUPABASE_ANON_KEY` carries the target project's `sb_publishable_...` key",
    );
    expect(normalizedProvider).toContain(
      "`SUPABASE_SERVICE_ROLE_KEY` carries that project's server-only `sb_secret_...` key",
    );
    expect(normalizedProvider).toContain(
      "Canonical production separately uses a distinct `sb_secret_...` value in `OFFSITE_BACKUP_SERVICE_ROLE_KEY` for the operational restore-copy project; permanent staging must not receive it",
    );
    expect(normalizedProvider).toContain(
      "Do not use legacy JWT `anon` or `service_role` keys",
    );
    expect(provider).toContain(
      "SUPABASE_ANON_KEY=REDACTED_USE_PROJECT_SB_PUBLISHABLE_KEY",
    );
    expect(provider).toContain(
      "SUPABASE_SERVICE_ROLE_KEY=REDACTED_USE_PROJECT_SB_SECRET_KEY",
    );
    expect(
      provider.match(
        /OFFSITE_BACKUP_SERVICE_ROLE_KEY=REDACTED_USE_DISTINCT_RESTORE_SB_SECRET_KEY/g,
      ),
    ).toHaveLength(2);
    expect(normalizedProvider).toContain(
      "Permanent staging must omit `OFFSITE_BACKUP_SUPABASE_URL`, `OFFSITE_BACKUP_SERVICE_ROLE_KEY`, and `OFFSITE_BACKUP_BUCKET`",
    );
    expect(provider).not.toContain("publishable_or_anon");
    expect(provider).not.toContain("your_server_only_service_role_key");
    expect(provider).not.toContain(
      "replace_with_operational_restore_copy_service_role_key",
    );

    expect(supabaseContainment).toContain(
      "replacing exactly two Railway\nvariables",
    );
    expect(supabaseContainment).toContain(
      "accepts exactly two `Buffer` values",
    );
    expect(supabaseContainment).toContain("three exact references");
    expect(supabaseContainment).toContain(
      "performs the same three read-only checks on a\nprotected runner",
    );
    expect(supabaseContainment).toContain(
      "pins only the permanent-staging project ref",
    );
    expect(supabaseContainment).toContain(
      "The prior checked-in/live policies coupled staging to that production copy",
    );
    expect(supabaseContainment).toContain(
      "checks.forbiddenVariablesAbsent=true",
    );
    expect(supabaseContainment).not.toContain("hfbmhdxrwtihukmixxta");
    const normalizedLogicalOffsite = logicalOffsite.replace(/\s+/g, " ");
    expect(normalizedLogicalOffsite).toContain(
      "prior checked-in/live contract that coupled permanent staging to the production operational-copy URL, key, and bucket",
    );
    expect(normalizedLogicalOffsite).toContain(
      "The current candidate makes this CLI canonical-production-only",
    );
    expect(normalizedLogicalOffsite).toContain(
      "No provider query in this remediation proves deletion",
    );
    expect(normalizedLogicalOffsite).toContain(
      "a fresh complete Railway inventory must independently prove all three names are deleted",
    );
    const normalizedFullScaleMigration = fullScaleMigration.replace(
      /\s+/g,
      " ",
    );
    expect(normalizedFullScaleMigration).toContain(
      "prior checked-in/live contract coupling permanent staging to the production operational-copy URL, key, and bucket",
    );
    expect(normalizedFullScaleMigration).toContain(
      "no provider query in this remediation proves deletion",
    );
    expect(normalizedFullScaleMigration).toContain(
      "No new staging off-site transport is authorized",
    );

    const lintCommands = [launch, provider, databaseTesting]
      .flatMap((document) => document.split("\n"))
      .filter((line) => line.includes("supabase db lint"));
    expect(lintCommands.length).toBeGreaterThanOrEqual(3);
    for (const command of lintCommands) {
      expect(command).toContain(
        "--schema public,private,pintpath_app,pintpath_ops",
      );
      expect(command).not.toContain("--schema public,private --");
    }
  });

  it("keeps candidate sequencing, protected recovery authority, and hosted Supabase keys aligned", () => {
    const launch = releaseDocument("production-launch-runbook.md");
    const protectedOperations = releaseDocument(
      "protected-provider-mutation-operations.md",
    );
    const migration = releaseDocument(
      "full-scale-postgres-migration-runbook.md",
    );
    const normalizedMigration = migration.replace(/\s+/g, " ");
    const provider = releaseDocument("provider-configuration-runbook.md");
    const checklist = releaseDocument("release-readiness-checklist.md");
    const launchGates = releaseDocument("launch-9-readiness-gates.md");
    const envExample = repositoryFile(".env.example");

    const phase12 = launch.slice(
      launch.indexOf("## Phase 12"),
      launch.indexOf("## Phase 13"),
    );
    const phase16 = launch.slice(
      launch.indexOf("## Phase 16"),
      launch.indexOf("## Phase 17"),
    );
    expect(phase12).toContain(
      "it accepts only the exact commit currently at protected `main`",
    );
    expect(phase12).not.toContain(
      "Deploy all implementation to permanent integrated staging",
    );
    expect(
      phase16.indexOf("### 16.1 Merge the reviewed candidate"),
    ).toBeLessThan(
      phase16.indexOf("### 16.5 Deploy the exact protected `main` build"),
    );
    expect(phase16).toContain(
      "execute the complete Phase 12 staging and rollback",
    );
    expect(protectedOperations).toContain(
      "The workflow rejects a PR head or any SHA other than protected `main`",
    );

    expect(migration).toContain("protected production logical-backup workflow");
    expect(normalizedMigration).toContain(
      "These example restore and deletion-replay commands remain review-only when",
    );
    expect(normalizedMigration).toContain(
      "its receipt never authorizes copying these commands to an",
    );

    const productionProviderExample = provider.slice(
      provider.indexOf("NODE_ENV=production"),
      provider.indexOf("This block is the canonical-production profile"),
    );
    expect(productionProviderExample).toContain(
      "@postgres-production.railway.internal:5432/",
    );
    expect(productionProviderExample).not.toContain(
      "@postgres-staging.railway.internal:5432/",
    );

    for (const document of [checklist, launchGates]) {
      const preCandidate = document.slice(
        document.indexOf("## Automated"),
        document.indexOf("After real provider configuration") > -1
          ? document.indexOf("After real provider configuration")
          : document.indexOf("After each protected provider environment"),
      );
      expect(preCandidate).toContain("npm run check");
      expect(preCandidate).toContain("npm run readiness:providers");
      expect(preCandidate).toContain("npm run release:evidence");
      expect(preCandidate).toContain("npm run security:audit");
      expect(preCandidate).not.toMatch(/^npm run test:release:pintpath$/m);
    }

    expect(envExample).toContain(
      "SUPABASE_ANON_KEY=sb_publishable_REPLACE_WITH_PROJECT_PUBLISHABLE_KEY",
    );
    expect(envExample).toContain(
      "SUPABASE_SERVICE_ROLE_KEY=replace_with_exact_project_server_key",
    );
    expect(envExample).toContain(
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY=replace_with_exact_operational_copy_server_key",
    );
    expect(envExample).toContain(
      "Legacy JWT keys remain accepted only for local",
    );
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
    const stepEnd = ci.indexOf(
      "\n\n  postgres-migration-integration:",
      stepStart,
    );
    const gatedStep = ci.slice(stepStart, stepEnd);
    const runbook = releaseDocument("postgres-logical-worm-attestation.md");
    const status = releaseDocument("postgres-migration-execution-status.md");
    const implementation = repositoryFile("src/lib/postgres-logical-worm.ts");

    expect(packageJson.scripts?.["db:postgres:backup:logical:worm"]).toBe(
      "tsx scripts/attest-postgres-logical-worm.ts",
    );
    expect(
      packageJson.scripts?.["test:db:postgres:backup:logical:worm:aws"],
    ).toBe("vitest run test/postgres-logical-worm.integration.test.ts");
    for (const dependency of [
      "@aws-sdk/client-s3",
      "@aws-sdk/client-sts",
      "@aws-sdk/credential-providers",
    ])
      expect(packageJson.dependencies?.[dependency], dependency).toBe(
        "3.1106.0",
      );

    expect(stepStart).toBeGreaterThan(-1);
    expect(gatedStep).toContain(
      'PINTPATH_TEST_POSTGRES_LOGICAL_WORM_AWS: "disabled"',
    );
    expect(gatedStep).toContain('PINTPATH_POSTGRES_LOGICAL_WORM: "disabled"');
    expect(gatedStep).toContain(
      'PINTPATH_POSTGRES_LOGICAL_WORM_AWS: "disabled"',
    );
    expect(gatedStep).toContain(
      "npm run test:db:postgres:backup:logical:worm:aws",
    );
    expect(gatedStep).not.toContain("secrets.");
    expect(gatedStep).not.toMatch(
      /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/,
    );

    expect(runbook).toContain("IMPLEMENTED, NOT PROVISIONED");
    expect(runbook).toContain("The launch gate remains **OPEN**");
    expect(runbook).toContain(
      "No AWS account, bucket, role, credential, or object was created",
    );
    expect(status).toContain("This is implementation evidence only");
    expect(status).toContain(
      "no AWS recovery account, bucket, role, credential, or object was provisioned",
    );
    expect(implementation).toContain('Action: "s3:PutObject"');
    expect(implementation).toContain('"s3:if-none-match": "*"');
    expect(implementation).toContain(
      "POSTGRES_LOGICAL_WORM_RETENTION_DAYS = 30",
    );
    expect(implementation).toContain(
      'POSTGRES_LOGICAL_WORM_REGION = "ap-southeast-4"',
    );
  });

  it("keeps the launch runbook aligned with all 13 required evidence IDs", () => {
    const runbook = releaseDocument("production-launch-runbook.md");
    const evidence = JSON.parse(releaseDocument("release-evidence.json")) as {
      items?: Array<{ id?: string }>;
    };
    const requiredIds = (evidence.items ?? [])
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));

    expect(requiredIds).toHaveLength(13);
    for (const id of requiredIds) expect(runbook).toContain(`- \`${id}\`;`);
    expect(runbook).toContain(
      "Complete all 13 web-and-iOS evidence items from Phase 14.",
    );
    expect(runbook).toContain(
      "repeat the\nprotected Phases 16.5–16.7 chain for `deployedMainSha`",
    );
    expect(runbook).toContain('-f candidate_sha="$deployedMainSha"');
    expect(runbook).not.toContain("Complete all 12 web-and-iOS evidence items");
    expect(releaseDocument("full-remediation-2026-07-14.md")).toContain(
      "current schema-v4 register supersedes this historical count with 13 required gates",
    );
    expect(releaseDocument("internal-readiness-audit-2026-07-15.md")).toContain(
      "live schema-v4 register\ncurrently requires 13 items",
    );
  });

  it("keeps permanent-staging cost evidence candidate-bound and provider-complete", () => {
    const evidence = JSON.parse(releaseDocument("release-evidence.json")) as {
      version?: number;
      items?: Array<Record<string, unknown>>;
    };
    const costItem = evidence.items?.find(
      (item) => item.id === "permanent_staging_cost",
    );
    const deployment = releaseDocument("permanent-staging-app-deployment.md");
    const costRunbook = releaseDocument("permanent-staging-cost-evidence.md");
    const stagingPolicy = repositoryFile(
      "ops/railway/permanent-staging-app-deployment-policy.json",
    );
    const validator = evidenceValidator();
    const packageJson = JSON.parse(repositoryFile("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(evidence.version).toBe(4);
    expect((evidence as { release?: Record<string, unknown> }).release).toMatchObject({
      id: null,
      reviewedPrHeadSha: null,
      candidateSha: null,
      environment: "production",
    });
    expect(costItem).toMatchObject({
      required: true,
      status: "pending",
      evidence: null,
      evidenceSha256: null,
      verifiedAt: null,
      verifiedBy: null,
      costReceipt: null,
    });
    for (const value of [
      "railway",
      "staging-supabase",
      "staging-external-providers",
      "unknownResourceCount",
      "unpricedResourceCount",
      "sharedResourceCount",
      "unboundedResourceCount",
      "totalUpperBoundMonthlyCents",
      "maximumObservedAcrossPhasesMonthlyCents",
      "requiredHeadroomMonthlyCents",
      "production-operational-copy",
      "disposable-restore",
    ])
      expect(validator).toContain(value);
    expect(validator).toContain(
      "costReceipt.candidateSha must match release.candidateSha",
    );
    expect(validator).toContain("stalePermanentStagingCostReceipt");
    expect(packageJson.scripts?.["permanent-staging:cost:receipt:bind"]).toBe(
      "tsx scripts/bind-permanent-staging-cost-receipt.ts",
    );
    expect(costRunbook).toContain("validator and candidate binder implemented");
    expect(costRunbook).toContain(
      "57984ced59fa356baa9c19ac1e5018dad9c52829a6d7cc95a05cbd52112ddf86",
    );
    expect(costRunbook).toContain(
      "maximum accepted observed bound: `4700` cents",
    );
    expect(costRunbook).toContain("required explicit headroom: `300` cents");
    expect(costRunbook).toContain(
      "single combined post-deployment release receipt",
    );
    expect(costRunbook).toContain("It is not a deployment authorization");
    expect(costRunbook).not.toContain("providerCollectorImplemented");
    expect(costRunbook).toContain(
      "no network, provider SDK, environment-variable",
    );
    expect(stagingPolicy).toContain(
      '"deploymentMayClaimCostGatePassed": false',
    );
    expect(stagingPolicy).toContain('"receiptMayAuthorizeDeployment": false');
    expect(deployment).toContain("neither fabricates provider facts");
    expect(deployment).toContain("The receipt cannot authorize deployment");
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
      expect(repositoryFile(filename), filename).toContain(
        "dotenv.config({ quiet: true })",
      );
    }
  });

  it("documents the isolated Postgres account-deletion rehearsal readiness command", () => {
    const runbook = releaseDocument("production-launch-runbook.md");
    const providerReadiness = repositoryFile(
      "scripts/provider-readiness-check.ts",
    );

    expect(runbook).toContain(
      'test -z "${OFFSITE_BACKUP_SUPABASE_URL:-}${OFFSITE_BACKUP_SERVICE_ROLE_KEY:-}${OFFSITE_BACKUP_BUCKET:-}"',
    );
    expect(runbook).toContain('test -n "${REDIS_URL:-}"');
    expect(runbook).toContain(
      'test "${REQUIRE_REDIS_RATE_LIMITING:?}" = "true"',
    );
    expect(runbook).toContain(
      'test "${ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION:-false}" = "false"',
    );
    expect(runbook).toContain(
      "move account-deletion requests, outbox, recipient",
    );
    expect(runbook).toContain("at least two replicas");
    expect(runbook).toContain("npm run --silent readiness:providers");
    expect(runbook).toContain(
      '.readinessProfile == "account_deletion_rehearsal" and .ok == true',
    );
    expect(runbook).toContain('"${PUBLIC_BASE_URL%/}/ready"');
    expect(providerReadiness).toContain(
      "storageCanariesAllowed && !preflightBlocked",
    );
    expect(providerReadiness).toContain("permanentStagingCompleteChecks");
    expect(providerReadiness).toContain(
      "permanent_staging_identity_bootstrap_incomplete",
    );
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

    expect(packageJson.scripts?.["data:backup:download-offsite"]).toBe(
      "tsx scripts/download-offsite-backup.ts",
    );
    expect(packageJson.devDependencies?.supabase).toBeUndefined();
    expect(downloader).not.toContain("dotenv");
    expect(downloader).not.toContain(
      "process.env.OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    );
    expect(downloader).toContain(
      'assertSupabaseServerApiKey(\n    destinationServiceRoleKey,\n    "OFFSITE_BACKUP_SERVICE_ROLE_KEY"',
    );

    for (const document of [checklist, runbook]) {
      expect(document).toContain("data:backup:download-offsite");
      expect(document).toContain(
        '--service-role-key-file="$OFFSITE_BACKUP_SECRET_KEY_FILE"',
      );
      expect(document).toContain(
        '--expected-manifest-sha256="$EXPECTED_MANIFEST_SHA256"',
      );
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

  it("requires the exact OCI PostgreSQL 17 runtime observation before migration integration", () => {
    const ci = workflow("ci.yml");
    const migrationStart = ci.indexOf("  postgres-migration-integration:");
    const migrationEnd = ci.indexOf("\n  supabase-database:", migrationStart);
    const migrationJob = ci.slice(migrationStart, migrationEnd);
    const observationStart = ci.indexOf(
      "  postgres-tool-runtime-closure-observation:",
    );
    const observationJob = ci.slice(observationStart);
    const contract = repositoryFile(
      "src/lib/postgres-tool-runtime-closure-v4.ts",
    );
    const unit = repositoryFile(
      "test/postgres-tool-runtime-closure-v4.test.ts",
    );
    const integration = repositoryFile(
      "test/postgres-tool-runtime-closure-v4.integration.test.ts",
    );

    expect(migrationStart).toBeGreaterThan(-1);
    expect(observationStart).toBeGreaterThan(-1);
    expect(
      ci.indexOf(
        "  postgres-tool-runtime-closure-observation:",
        observationStart + 1,
      ),
    ).toBe(-1);
    expect(migrationJob).toContain(
      "    needs: postgres-tool-runtime-closure-observation",
    );
    expect(observationJob).toContain("    runs-on: ubuntu-24.04");
    expect(observationJob).toContain("    timeout-minutes: 15");
    expect(observationJob).toContain(
      "      - name: Verify passive V4 PostgreSQL tool-runtime closure contract",
    );
    expect(observationJob).toContain(
      "run: npx vitest run test/postgres-tool-runtime-closure-v4.test.ts test/postgres-tool-runtime-closure-v4-registry.test.ts --maxWorkers=1",
    );
    expect(observationJob).toContain(
      "      - name: Run mandatory exact OCI PostgreSQL 17 runtime observation",
    );
    expect(observationJob).toContain(
      "PINTPATH_POSTGRES_TOOL_RUNTIME_CLOSURE_V4_TEST_DOCKER: /usr/bin/docker",
    );
    expect(observationJob).toContain(
      "PINTPATH_POSTGRES_TOOL_RUNTIME_CLOSURE_V4_TEST_EVIDENCE_PATH: ${{ runner.temp }}/pintpath-postgres-tool-runtime-closure-v4-observation.json",
    );
    expect(observationJob).toContain(
      'PINTPATH_POSTGRES_TOOL_RUNTIME_CLOSURE_V4_TEST_REQUIRED: "true"',
    );
    expect(observationJob).toContain(
      "run: npx vitest run test/postgres-tool-runtime-closure-v4.integration.test.ts --maxWorkers=1",
    );
    expect(observationJob).toContain(
      "uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
    );
    expect(observationJob).toContain(
      "name: pintpath-postgres-tool-runtime-closure-v4-observation",
    );
    expect(observationJob).toContain("if-no-files-found: error");
    expect(observationJob).toContain("retention-days: 14");
    expect(observationJob).toContain(
      "# observation-only and grants no source, artifact, or production authority.",
    );
    expect(observationJob).not.toContain("continue-on-error:");
    expect(observationJob).not.toContain("secrets.");
    expect(observationJob).not.toContain("NativeRuntimeClosureVerified: true");

    expect(contract).toContain(
      'platformManifestDigest:\n    "sha256:c529722b47431f2478e5bef927f61bfc60433c8fa04e3d011b545192068ec677"',
    );
    expect(contract).toContain("nativeRuntimeClosureVerified: false");
    expect(contract).toContain("operationalToolAuthorityGranted: false");
    expect(contract).toContain("artifactEmissionAuthorized: false");
    expect(contract).not.toContain("nativeRuntimeClosureVerified: true");
    expect(unit).toContain("exact recursive loader/shared-library closure");
    expect(integration).toContain(
      "for (const layer of POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS)",
    );
    expect(integration).toContain('compressed.digest("hex")');
    expect(integration).toContain('uncompressed.digest("hex")');
    expect(integration).toContain(
      'docker(["pull", "--platform", "linux/amd64", exactImage]',
    );
    expect(integration).toContain('"--read-only"');
    expect(integration).toContain('"--user", "65532:65532"');
    expect(integration).toContain('"--cap-drop", "ALL"');
    expect(integration).toContain('"--security-opt", "no-new-privileges=true"');
    expect(integration).toContain('"--network", "none"');
    expect(integration).toContain("verifyElfClosure(rootfs, environment)");
    expect(integration).toContain(
      'classification: "UNVERIFIED_CI_OBSERVATION_ONLY"',
    );
    expect(integration).toContain(
      "independentLiveRuntimeRecorderBrandCreated: false",
    );
    expect(integration).toContain(
      "writeObservationEvidence(dockerServerVersion)",
    );
    expect(integration).toContain(
      'docker(["rm", "--force", "--volumes", name]',
    );
    expect(integration).not.toContain("PGPASSWORD:");
    expect(integration).not.toContain('"PGPASSWORD=');
    expect(integration).not.toContain("process.env.SUPABASE");
  });
});
