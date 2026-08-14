import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function read(filename: string): string {
  return fs.readFileSync(path.join(root, filename), "utf8");
}

describe("protected provider mutation workflows", () => {
  it("keeps provider variables behind one protected, main-only, non-rerunnable mutation", () => {
    const workflow = read(
      ".github/workflows/permanent-staging-provider-mutation.yml",
    );
    const executor = read(
      "scripts/execute-protected-permanent-staging-variable-mutation.ts",
    );
    const policy = JSON.parse(
      read("ops/railway/permanent-staging-variable-mutation-policy.json"),
    ) as Record<string, unknown>;

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(
      "environment: permanent-staging-provider-mutation",
    );
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("test \"$DISPATCH_REF\" = 'refs/heads/main'");
    expect(workflow).toContain("test \"$RUN_ATTEMPT\" = '1'");
    expect(workflow).toContain("supabase:keys:consumer-compatibility:check");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain(
      "run-name: Permanent staging provider mutation | ${{ inputs.operation }} | ${{ inputs.candidate_sha }}",
    );
    const authority = workflow.indexOf(
      "github:reviewed-candidate-authority:verify",
    );
    expect(authority).toBeGreaterThan(-1);
    expect(authority).toBeLessThan(workflow.indexOf("${{ secrets."));
    expect(workflow.slice(0, authority)).not.toContain("${{ secrets.");
    expect(workflow).toContain(
      "if: always()\n        env:\n          PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
    );
    expect(workflow).toContain(
      "if: always()\n        uses: actions/upload-artifact@",
    );
    expect(workflow).not.toMatch(/pull_request:|push:|schedule:/);
    expect(policy).toMatchObject({
      activationState: "GITHUB_ENVIRONMENT_PROTECTED",
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      productionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
      stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      mutation: {
        maximumAttempts: 1,
        automaticRetriesAllowed: false,
        rerunsAllowed: false,
        unconditionalPostflightRequired: true,
      },
    });
    expect(
      executor.match(/PROTECTED_STAGING_VARIABLE_MUTATION_QUERY/g),
    ).toHaveLength(2);
    expect(executor).toContain("checks.postflightAttempted = true");
    expect(executor).toContain("retryAllowed: false");
  });

  it("authenticates cutover and runtime-variable callers before secret custody", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(
      packageJson.scripts?.["github:reviewed-candidate-authority:verify"],
    ).toBe(
      "node --frozen-intrinsics --disable-proto=throw scripts/verify-github-reviewed-candidate-authority.mjs",
    );
    const cutover = read(
      ".github/workflows/permanent-staging-supabase-legacy-cutover.yml",
    );
    const worker = read(".github/workflows/runtime-variable-worker.yml");
    const dispatcher = read(".github/workflows/configure-runtime-variable.yml");
    for (const [name, source] of [
      ["cutover", cutover],
      ["runtime worker", worker],
    ] as const) {
      const authority = source.indexOf(
        "github:reviewed-candidate-authority:verify",
      );
      const firstSecret = source.search(/\$\{\{\s*secrets(?:\.|\[)/);
      expect(authority, name).toBeGreaterThan(-1);
      expect(firstSecret, name).toBeGreaterThan(-1);
      expect(authority, name).toBeLessThan(firstSecret);
      expect(source.slice(0, authority), name).not.toMatch(
        /\$\{\{\s*secrets(?:\.|\[)/,
      );
      const permissions = source.match(
        /^permissions:\n(?<body>(?:  [^\n]+\n)+)/m,
      )?.groups?.body ?? "";
      expect(permissions, name).toContain("actions: read");
      expect(permissions, name).toContain("contents: read");
      expect(permissions, name).toContain("pull-requests: read");
    }
    expect(cutover).toContain('--replacement-run-id "$REPLACEMENT_RUN_ID"');
    expect(cutover).toContain('--deployment-run-id "$DEPLOYMENT_RUN_ID"');
    expect(worker).toContain("--operation runtime-variable");
    expect(worker).toContain('--target "$TARGET"');
    expect(worker).toContain('--variable-name "$VARIABLE_NAME"');
    expect(dispatcher).toContain(
      "run-name: Configure runtime variable | ${{ inputs.target }} | ${{ inputs.variable_name }} | ${{ inputs.candidate_sha }}",
    );
    const dispatcherPermissions = dispatcher.match(
      /^permissions:\n(?<body>(?:  [^\n]+\n)+)/m,
    )?.groups?.body ?? "";
    expect(dispatcherPermissions).toContain("actions: read");
    expect(dispatcherPermissions).toContain("pull-requests: read");
  });

  it("always converges the two-replica evidence window back to one", () => {
    const workflow = read(
      ".github/workflows/permanent-staging-scale-evidence.yml",
    );
    const executor = read(
      "scripts/execute-protected-permanent-staging-scale.ts",
    );
    const policy = JSON.parse(
      read("ops/railway/permanent-staging-scale-evidence-policy.json"),
    ) as Record<string, unknown>;

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: permanent-staging-scale-evidence");
    expect(workflow).toContain("--profile=expected-peak --duration-minutes=5");
    expect(workflow).toContain("--profile=2x-peak --duration-minutes=5");
    expect(workflow).toContain("--profile=soak --duration-minutes=60");
    expect(workflow).toContain(
      "name: Unconditionally converge permanent staging to one replica",
    );
    expect(workflow).toContain(
      "PINTPATH_SCALE_CONFIRMATION: CONVERGE_PERMANENT_STAGING_TO_ONE",
    );
    expect(workflow).toContain("--direction converge-one");
    expect(workflow).toContain(
      "if: always()\n        env:\n          GITHUB_REF:",
    );
    expect(workflow).not.toMatch(/pull_request:|push:|schedule:/);
    expect(policy).toMatchObject({
      activationState: "GITHUB_ENVIRONMENT_PROTECTED",
      productionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
      stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      lifecycle: {
        permanentReplicaCount: 1,
        evidenceReplicaCount: 2,
        scaleOutMaximumAttempts: 1,
        convergeOneMaximumAttempts: 1,
        automaticRetriesAllowed: false,
        unconditionalConvergenceToOne: true,
        minimumSoakMinutes: 60,
      },
    });
    expect(executor).toContain(
      '"service", "scale", `${REGION}=${desiredReplicas}`',
    );
    expect(executor).toContain("attempts = 1");
    expect(executor).toContain("checks.postflightAttempted = true");
    expect(executor).toContain("retryAllowed: false");
  });

  it("provides a protected one-way production convergence to two replicas", () => {
    const workflow = read(
      ".github/workflows/production-converge-two-replicas.yml",
    );
    expect(workflow).toContain(
      "environment: production-topology-configuration",
    );
    expect(workflow).toContain("test \"$RUN_ATTEMPT\" = '1'");
    expect(workflow).toContain("git fetch --no-tags origin");
    expect(workflow).toContain("--direction converge-production-two");
    expect(workflow).toContain("--expected-deployment-sha");
    expect(workflow).toContain('--expected-deployment-sha "$CANDIDATE_SHA"');
    expect(workflow).not.toContain("inputs.expected_deployed_sha");
    expect(workflow).toContain("PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN");
    expect(workflow).not.toContain("converge-production-one");
    expect(workflow).not.toMatch(/pull_request:|push:|schedule:/);
  });

  it("maps every runtime variable bijectively to the same-named protected secret", () => {
    const dispatcher = read(".github/workflows/configure-runtime-variable.yml");
    const worker = read(".github/workflows/runtime-variable-worker.yml");
    expect(dispatcher).toContain(
      "value_secret_name: ${{ format('PINTPATH_STAGING_{0}', inputs.variable_name) }}",
    );
    expect(dispatcher).toContain(
      "value_secret_name: ${{ format('PINTPATH_PRODUCTION_{0}', inputs.variable_name) }}",
    );
    expect(dispatcher).toContain("- REDIS_URL");
    expect(dispatcher).toContain("- PINTPATH_POSTGRES_ROOT_CA_PEM");
    expect(dispatcher).toContain("- PINTPATH_POSTGRES_ROOT_CA_DER_SHA256");
    expect(dispatcher).not.toMatch(/\|\|\s*'PINTPATH_(?:STAGING|PRODUCTION)_/);
    expect(worker).toContain(
      'test "$VALUE_SECRET_NAME" = "PINTPATH_PRODUCTION_${VARIABLE_NAME}"',
    );
    expect(worker).toContain(
      'test "$VALUE_SECRET_NAME" = "PINTPATH_STAGING_${VARIABLE_NAME}"',
    );
    expect(worker).toContain(
      "if: always()\n        shell: bash\n        run: |",
    );
    expect(worker).toContain('test ! -e "$input_root"');
    expect(worker).not.toMatch(/(?:shred|rmdir).*\|\|\s*true/);
    const operations = read("docs/protected-provider-mutation-operations.md");
    expect(operations).toContain(
      "PINTPATH_STAGING_PINTPATH_POSTGRES_ROOT_CA_PEM",
    );
    expect(operations).toContain(
      "PINTPATH_PRODUCTION_PINTPATH_POSTGRES_ROOT_CA_DER_SHA256",
    );

    for (const filename of [
      ".github/workflows/permanent-staging-provider-mutation.yml",
      ".github/workflows/permanent-staging-supabase-legacy-cutover.yml",
      ".github/workflows/permanent-staging-scale-evidence.yml",
    ]) {
      const protectedInputWorkflow = read(filename);
      expect(protectedInputWorkflow).toContain('test ! -e "$input_root"');
      expect(protectedInputWorkflow).not.toMatch(
        /(?:shred|rmdir).*\|\|\s*true/,
      );
    }
  });

  it("protects exact HA PITR enablement and disposable restore teardown", () => {
    for (const filename of [
      ".github/workflows/enable-postgres-ha-pitr.yml",
      ".github/workflows/disposable-restore-teardown.yml",
    ]) {
      const workflow = read(filename);
      expect(workflow).toContain("workflow_dispatch:");
      expect(workflow).toContain("test \"$RUN_ATTEMPT\" = '1'");
      expect(workflow).toContain("git fetch --no-tags origin");
      expect(workflow).toContain(
        "if: always()\n        uses: actions/upload-artifact@",
      );
      expect(workflow).not.toMatch(/pull_request:|push:|schedule:/);
    }
    expect(read(".github/workflows/enable-postgres-ha-pitr.yml")).toContain(
      "environment: postgres-ha-pitr-${{ inputs.target_environment }}",
    );
    const pitrWorkflow = read(".github/workflows/enable-postgres-ha-pitr.yml");
    expect(pitrWorkflow).toContain("type: choice");
    expect(pitrWorkflow).toContain(
      "PINTPATH_POSTGRES_HA_PITR_AUTHORITY_TARGET",
    );
    expect(pitrWorkflow).toContain(
      "PINTPATH_POSTGRES_HA_PITR_EXPECTED_ROOT_SERVICE_ID",
    );
    expect(pitrWorkflow).not.toContain("root_service_id:");
    expect(pitrWorkflow).not.toContain("inputs.root_service_id");
    expect(read(".github/workflows/disposable-restore-teardown.yml")).toContain(
      "environment: disposable-restore-teardown",
    );
    expect(
      read(".github/workflows/production-converge-two-replicas.yml"),
    ).toContain(
      "if: always()\n        env:\n          PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
    );
    expect(read(".github/workflows/enable-postgres-ha-pitr.yml")).toContain(
      "if: always()\n        env:\n          PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
    );
    expect(read(".github/workflows/disposable-restore-teardown.yml")).toContain(
      "scripts/verify-disposable-restore-project-absent.ts",
    );
    expect(read(".github/workflows/disposable-restore-teardown.yml")).toContain(
      "if: always()\n        env:\n          PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
    );
  });
});
