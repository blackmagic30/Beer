import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function read(filename: string): string {
  return fs.readFileSync(path.join(root, filename), "utf8");
}

describe("protected provider mutation workflows", () => {
  it("keeps staging variables behind one protected, main-only, non-rerunnable plan", () => {
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
    expect(workflow).toContain("remove-forbidden-offsite-backup-variables");
    expect(workflow).toContain(
      "resume-forbidden-offsite-backup-deletion-patch",
    );
    expect(workflow).toContain(
      "cancel-forbidden-offsite-backup-deletion-patch",
    );
    expect(workflow).toContain(
      "cancel-masked-forbidden-offsite-backup-deletion-patch",
    );
    expect(workflow).toContain(
      "test \"$PRIOR_CLEANUP_RUN_ID\" = '33164687424'",
    );
    expect(workflow).toContain('--prior-run-id "$PRIOR_CLEANUP_RUN_ID"');
    expect(workflow).toContain("run-id: ${{ inputs.prior_cleanup_run_id }}");
    expect(workflow).toContain("id: prior_cleanup_evidence");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain(
      "if: steps.prior_cleanup_evidence.outcome == 'success'",
    );
    const incidentDownload = workflow.match(
      /- name: Download the exact retained incident cleanup evidence(?<body>[\s\S]*?)\n      - name:/,
    )?.groups?.body ?? "";
    expect(incidentDownload).toContain(
      "if: inputs.operation == 'cancel-masked-forbidden-offsite-backup-deletion-patch'",
    );
    expect(incidentDownload).not.toContain("continue-on-error");
    expect(incidentDownload).toContain("run-id: 33164687424");
    expect(incidentDownload).toContain(
      "name: pintpath-permanent-staging-provider-mutation-remove-forbidden-offsite-backup-variables-ac7130e0306802825922d21a4c61135b84edd43b",
    );
    expect(incidentDownload).toContain(
      "path: ${{ runner.temp }}/pintpath-provider-input/incident-prior-offsite-cleanup-evidence",
    );
    const incidentSeal = workflow.match(
      /- name: Seal the exact incident cleanup evidence as read-only input(?<body>[\s\S]*?)\n      - name:/,
    )?.groups?.body ?? "";
    expect(incidentSeal).toContain(
      "if: inputs.operation == 'cancel-masked-forbidden-offsite-backup-deletion-patch'",
    );
    expect(incidentSeal).toContain(
      "for leaf in dispatch.json intent.json terminal.json; do",
    );
    expect(incidentSeal).toContain('test -f "$evidence/$leaf"');
    expect(incidentSeal).toContain('test ! -L "$evidence/$leaf"');
    expect(incidentSeal).toContain(
      "! -name dispatch.json ! -name intent.json ! -name terminal.json",
    );
    expect(workflow).toContain(
      "test \"$PINTPATH_INCIDENT_PRIOR_CLEANUP_EVIDENCE_OUTCOME\" = 'success'",
    );
    expect(workflow).toContain(
      '--reviewed-authority-file "$RUNNER_TEMP/pintpath-provider-input/reviewed-authority.json"',
    );
    expect(workflow).toContain(
      "if test \"$PINTPATH_PRIOR_CLEANUP_EVIDENCE_OUTCOME\" = 'success'; then",
    );
    expect(workflow).toContain(
      "pintpath-permanent-staging-provider-mutation-remove-forbidden-offsite-backup-variables-${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain(
      "Execute one reviewed protected Railway mutation plan",
    );
    expect(workflow).toContain("external_mutation_freeze_attestation:");
    expect(workflow).toContain(
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
    );
    expect(workflow).toContain(
      "PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION: ${{ inputs.external_mutation_freeze_attestation }}",
    );
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
      authorizedBaselines: {
        coldDeadNullReplica: {
          serviceInstanceId: "5a2f3970-2850-44e0-9b6c-f5c7627dde13",
          replicas: null,
          latestDeploymentId: "c71fdb35-2be0-4031-b952-85595dfb2913",
          latestDeploymentStatus: "FAILED",
          latestDeploymentStopped: true,
          activeDeploymentCount: 0,
          sourceRepo: null,
          sourceImage: null,
        },
      },
      mutationPlans: {
        variableUpsert: { maximumAttempts: 1, skipDeploys: true },
        forbiddenVariableDeletion: {
          merge: false,
          stageMaximumAttempts: 1,
          commitSkipDeploys: true,
          commitMaximumAttempts: 1,
          exactApplicationServicePatchOnly: true,
          strandedPatchRecovery: {
            reviewedPriorCandidateRunAuthorityRequired: true,
            priorArtifactVerification: "OPTIONAL_ADDITIONAL_IF_AVAILABLE",
            exactPatchSha256:
              "3650174bf695aaebb3b9ba7f91a4f2a724a0806b30511578448964c36eebfb91",
            completedDeletionReadOnlyReconciliationAllowed: true,
            completedDeletionMaximumAttempts: 0,
            noEffectRecovery: {
              exactOriginalRowsAndEmptyPatchRequired: true,
              resumeStageMaximumAttempts: 1,
              resumeCommitMaximumAttempts: 1,
              cancelReadOnlyMaximumAttempts: 0,
              ambiguousSameModeRedispatchAllowed: true,
            },
            maximumAttempts: 1,
            crossOperationRetryAllowed: false,
            incidentBoundMaskedPatchCancellation: {
              operation:
                "cancel-masked-forbidden-offsite-backup-deletion-patch",
              originalCandidateSha:
                "ac7130e0306802825922d21a4c61135b84edd43b",
              currentCandidateMustBeDirectChild: true,
              priorCleanupRunId: "33164687424",
              priorCleanupArtifactId: "9683176636",
              priorCleanupArtifactDigest:
                "sha256:0df300c84d53ece3fca5f7c72007bf5dd4a8ba9d1ea989e5d74bc80904aed98e",
              priorCleanupArtifactRequired: true,
              stagedPatchId: "63b3cc8a-f68f-4b99-adb7-70dfdfa7d6ae",
              stagedPatchCreatedAt: "2026-08-28T10:51:38.861Z",
              maskedPatchShape:
                "EXACT_THREE_OFFSITE_VARIABLE_WRAPPERS_WITH_FIVE_ASTERISK_VALUES",
              deletionSemanticsProven: false,
              originalBaselineMetadataSha256:
                "c88c7915e91f391c4d40e4869d18b44783746a2b4e153c99637f34333c021abd",
              recoveryDeadline: "2026-08-29T10:51:43.000Z",
              operationName: "environmentStageChanges",
              replacementPatch: {},
              merge: false,
              maximumAttempts: 1,
              commitAllowed: false,
              resumeAllowed: false,
              providerCasOrLockVerified: false,
            },
          },
        },
        automaticRetriesAllowed: false,
        rerunsAllowed: false,
        externalMutationFreeze: {
          required: true,
          enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
          providerCommitSelector: "ENVIRONMENT_ID_ONLY",
          providerStagedCommitPatchIdCasOrLockAvailable: false,
        },
        unconditionalPostflightRequired: true,
      },
    });
    expect(
      executor.match(/PROTECTED_STAGING_VARIABLE_MUTATION_QUERY/g),
    ).toHaveLength(2);
    expect(executor).toContain("checks.postflightAttempted = true");
    expect(executor).toContain("PROTECTED_STAGING_VARIABLE_PATCH_QUERY");
    expect(executor).toContain("checks.committedDeletionPatchExact");
    expect(executor).toContain("retryAllowed: false");
    expect(executor).not.toContain("CANARY_SERVICE_ID");
    expect(executor).not.toContain("supabaseCanaryServiceId");
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
    expect(cutover).toContain('--cutover-mode "$OPERATION"');
    expect(worker).toContain("--operation runtime-variable");
    expect(worker).toContain('--target "$TARGET"');
    expect(worker).toContain('--variable-name "$VARIABLE_NAME"');
    expect(worker).toContain(
      "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:\n        required: false",
    );
    expect(worker).toContain(
      "PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN:\n        required: false",
    );
    expect(worker).toContain(
      "PINTPATH_PRODUCTION_SUPABASE_ANON_KEY:\n        required: false",
    );
    expect(worker).toContain(
      "PINTPATH_STAGING_SOURCE_EVIDENCE_SIGNING_SECRET:\n        required: false",
    );
    const tokenConfiguration = worker.match(
      /- name: Require protected Railway token configuration(?<body>[\s\S]*?)\n      - name:/,
    )?.groups?.body ?? "";
    expect(tokenConfiguration).toContain(
      "PRODUCTION_METADATA_TOKEN: ${{ secrets.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN }}",
    );
    expect(tokenConfiguration).toContain(
      "STAGING_METADATA_TOKEN: ${{ secrets.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN }}",
    );
    expect(tokenConfiguration).toContain('test -n "$TARGET_METADATA_TOKEN"');
    expect(tokenConfiguration).toContain('test -n "$TARGET_VARIABLE_TOKEN"');
    expect(tokenConfiguration).toContain(
      'test "$TARGET_METADATA_TOKEN" != "$TARGET_VARIABLE_TOKEN"',
    );
    expect(tokenConfiguration).not.toMatch(/echo|printf/);
    expect(worker.indexOf("github:reviewed-candidate-authority:verify")).toBeLessThan(
      worker.indexOf("Require protected Railway token configuration"),
    );
    expect(worker.indexOf("Require protected Railway token configuration")).toBeLessThan(
      worker.indexOf("Create private input and evidence custody"),
    );
    const repositoryGate = worker.match(
      /- name: Verify the complete repository before protected input(?<body>[\s\S]*?)\n      - name:/,
    )?.groups?.body ?? "";
    expect(repositoryGate).toContain("NODE_ENV: test");
    expect(repositoryGate).toContain(
      "PUBLIC_BASE_URL: http://localhost:3000",
    );
    expect(repositoryGate).toContain(
      "DATABASE_PATH: ./data/ci-runtime-variable.sqlite",
    );
    expect(repositoryGate).toContain("OUTBOUND_CALLS_ENABLED: false");
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
    const variableOptions = dispatcher.match(
      /variable_name:\n(?<body>[\s\S]*?)\n      confirmation:/,
    )?.groups?.body ?? "";
    const variableNames = [...variableOptions.matchAll(/^          - ([A-Z0-9_]+)$/gm)]
      .map((match) => match[1]!);
    expect(variableNames).toHaveLength(17);
    const secretBackedVariableNames = variableNames.filter((variableName) =>
      variableName !== "PINTPATH_RUNTIME_DATABASE_URL"
    );
    expect(secretBackedVariableNames).toHaveLength(16);
    for (const variableName of secretBackedVariableNames) {
      expect(worker).toContain(
        `PINTPATH_PRODUCTION_${variableName}:\n        required: false`,
      );
      expect(worker).toContain(
        `PINTPATH_STAGING_${variableName}:\n        required: false`,
      );
    }
    expect(dispatcher).toContain(
      "value_secret_name: ${{ inputs.target == 'permanent-staging-postgres' && 'PINTPATH_REVIEWED_FIXED_POSTGRES_RUNTIME_URL' || format('PINTPATH_STAGING_{0}', inputs.variable_name) }}",
    );
    expect(dispatcher).toContain(
      "value_secret_name: ${{ format('PINTPATH_PRODUCTION_{0}', inputs.variable_name) }}",
    );
    expect(dispatcher).toContain("- permanent-staging-postgres");
    expect(dispatcher).toContain("- PINTPATH_RUNTIME_DATABASE_URL");
    expect(dispatcher).toContain(
      "'PINTPATH_REVIEWED_FIXED_POSTGRES_RUNTIME_URL'",
    );
    expect(worker).toContain(
      'test "$TARGET" = permanent-staging-postgres',
    );
    expect(worker).toContain(
      'test "$VARIABLE_NAME" = PINTPATH_RUNTIME_DATABASE_URL',
    );
    expect(worker).toContain('test -z "$RUNTIME_VALUE"');
    expect(worker).toContain('"REVIEWED_COMPILE_TIME_CONSTANT"');
    expect(worker).not.toContain(
      "PINTPATH_STAGING_PINTPATH_RUNTIME_DATABASE_URL:",
    );
    expect(worker).not.toContain(
      "PINTPATH_PRODUCTION_PINTPATH_RUNTIME_DATABASE_URL:",
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
