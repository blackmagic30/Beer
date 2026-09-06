import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function read(filename: string): string {
  return fs.readFileSync(path.join(root, filename), "utf8");
}

describe("protected provider mutation workflows", () => {
  it("locks the production Postgres source only after durable intent and supports one fail-closed reconciliation", () => {
    const workflow = read(
      ".github/workflows/repin-production-postgres-source.yml",
    );
    const executor = read(
      "scripts/execute-protected-production-postgres-source-repin.ts",
    );
    const policySource = read(
      "ops/railway/protected-production-postgres-source-repin-policy.json",
    );
    const boundaryPolicySource = read(
      "ops/railway/production-staging-mutation-policy.json",
    );
    const policy = JSON.parse(policySource) as Record<string, unknown>;
    const policySha = crypto
      .createHash("sha256")
      .update(policySource)
      .digest("hex");
    const boundaryPolicySha = crypto
      .createHash("sha256")
      .update(boundaryPolicySource)
      .digest("hex");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*(?:push|pull_request|schedule):/m);
    expect(workflow).toContain(
      "run-name: Production Postgres source lock | ${{ inputs.operation_mode }} | ${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain(
      "name: Lock or reconcile the protected production Postgres source",
    );
    expect(workflow).toContain(
      "name: Apply or reconcile the exact production Postgres source lock",
    );
    expect(workflow).toContain(
      "environment: production-postgres-source-repin",
    );
    expect(workflow).toContain("group: pintpath-production-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("operation_mode:");
    expect(workflow).toContain("prior_run_id:");
    expect(workflow).toContain("prior_candidate_sha:");
    expect(workflow).toContain("prior_run_grace_attestation:");
    expect(workflow).toContain(
      "LOCK_PRODUCTION_POSTGRES_SOURCE_AND_DISABLE_AUTO_UPDATES_WITHOUT_DEPLOY",
    );
    expect(workflow).toContain(
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
    );
    expect(workflow).toContain(
      "I_ATTEST_PRIOR_SOURCE_LOCK_RUN_ENDED_AND_NO_WRITER_IS_ACTIVE",
    );
    expect(workflow).toContain(
      "--operation production-postgres-source-repin-reconcile",
    );
    expect(workflow).toContain('--prior-run-id "$PRIOR_RUN_ID"');
    expect(workflow).toContain(
      '--prior-candidate-sha "$PRIOR_CANDIDATE_SHA"',
    );
    expect(workflow).toContain("--phase prepare");
    expect(workflow).toContain('--phase "$OPERATION_MODE"');
    expect(workflow).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(workflow).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(workflow).toContain(".artifacts[0].workflow_run.id == $priorRunId");
    expect(workflow).toContain(
      ".artifacts[0].workflow_run.head_sha == $candidate",
    );
    expect(workflow).toContain(
      "pintpath-production-postgres-source-lock-intent-${{ inputs.prior_candidate_sha }}-${{ inputs.prior_run_id }}",
    );
    expect(workflow).toContain(
      "pintpath-production-postgres-source-lock-apply-${{ inputs.prior_candidate_sha }}-${{ inputs.prior_run_id }}",
    );
    expect(workflow).toContain("9956146300");
    expect(workflow).toContain("9956147717");
    expect(workflow).toContain(
      "03f39ec4e154809d7f778067fed83ba908af4a30e4b17a5a70809c1bbe6654f3",
    );
    expect(workflow).toContain(
      "56829b4867083450e79eca099c75e1535453256cc4341611674f5228e34ec785",
    );
    expect(workflow).toContain(
      "608420a0186048d2f60b376774444f116d411029a359734e8d0b5fcdf296f431",
    );
    expect(workflow).toContain(
      "571c8b3269d557392c2fac317e330d9d28a38a95838265a926922f284b651b36",
    );
    expect(workflow).toContain(
      "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_DIGEST",
    );
    expect(workflow).toContain(
      '[[ "$APPLY_ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]',
    );
    expect(workflow).toContain(
      'artifact_digest="sha256:$APPLY_ARTIFACT_DIGEST"',
    );
    expect(workflow).not.toContain(
      'artifact_digest="$APPLY_ARTIFACT_DIGEST"',
    );
    expect(workflow).toContain(
      '[[ "$artifact_digest" =~ ^sha256:[a-f0-9]{64}$ ]]',
    );
    expect(workflow).toContain(
      "if: always() && steps.reviewed_authority.outcome == 'success'",
    );

    const repositoryGate = workflow.indexOf("npm run check");
    const authority = workflow.indexOf(
      "Verify reviewed-candidate authority before any mutation credential exists",
    );
    const prepare = workflow.indexOf(
      "Prepare the exact source-lock intent with metadata credentials only",
    );
    const intentUpload = workflow.indexOf(
      "Persist the exact source-lock intent before any mutation credential exists",
    );
    const artifactBinding = workflow.indexOf(
      "Bind the exact durable intent artifact before the writer",
    );
    const mutationCredential = workflow.indexOf(
      "PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN",
    );
    const writer = workflow.indexOf(
      "      - name: Apply or reconcile the exact production Postgres source lock",
    );
    expect(repositoryGate).toBeGreaterThan(-1);
    expect(authority).toBeGreaterThan(repositoryGate);
    expect(prepare).toBeGreaterThan(authority);
    expect(intentUpload).toBeGreaterThan(prepare);
    expect(artifactBinding).toBeGreaterThan(intentUpload);
    expect(writer).toBeGreaterThan(artifactBinding);
    expect(mutationCredential).toBeGreaterThan(artifactBinding);
    expect(workflow.slice(0, intentUpload)).not.toContain(
      "PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN",
    );
    expect(
      workflow.match(/PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN/g),
    ).toHaveLength(2);

    expect(policy).toMatchObject({
      schemaVersion:
        "pintpath-protected-production-postgres-source-lock-policy/v3",
      policyId: "pintpath-protected-production-postgres-source-lock",
      activationState: "GITHUB_ENVIRONMENT_PROTECTED",
      githubEnvironment: "production-postgres-source-repin",
      requiredGitRef: "refs/heads/main",
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      productionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
      stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      target: {
        serviceId: "4a2334a1-71e7-4745-970a-2cd95da10169",
        serviceInstanceId: "bba99cde-3f9b-4045-b349-93da78461b44",
        runningInstanceId: "0a8b344a-8d17-4f77-8f1b-1677dcf122de",
        deploymentId: "f31d3dbd-a997-42cf-b3a8-970b8c337841",
        snapshotId: "03f6d2ff-e78e-42a5-a78f-216a4a1f498d",
        volumeInstanceId: "74cbfae2-3383-40b4-8464-21a403ca509d",
        volumeId: "a3585b0a-b57a-4b69-ad45-05f798e739e1",
        expectedMutableSourceImage:
          "ghcr.io/railwayapp-templates/postgres-ssl:17",
        desiredImmutableSourceImage:
          "ghcr.io/railwayapp-templates/postgres-ssl@sha256:7383de344f558c61a16ecdcb3e6fc86f05c45c82a4e02ad77d96aa72b5ae2ba8",
        approvedImageDigest:
          "sha256:7383de344f558c61a16ecdcb3e6fc86f05c45c82a4e02ad77d96aa72b5ae2ba8",
        baselineConfigEtag:
          "e50589bf4093433313fd07b844b6e25eeb69878679626006edb9784629989bf9",
      },
      autoUpdates: {
        dismissed: {
          remediationNotice: null,
          schedule: [
            { day: 6, endHour: 24, startHour: 10 },
            { day: 0, endHour: 18, startHour: 0 },
          ],
          tagMode: "sha",
          type: "disabled",
        },
        desired: { schedule: null, tagMode: null, type: "disabled" },
      },
      crossCandidateRecoveryIncident: {
        priorCandidateSha:
          "52049a1ef414e274e47197e28726387c90d96990",
        priorRunId: "33923801697",
        dismissedConfigEtag:
          "ac5fb1e97cc4451ab5c09d05ecf1bcf591646a90d04945017a68616363b3227f",
      },
      mutationBoundary: {
        policySha256: boundaryPolicySha,
        prepareAndApplyAllowedFalseChecks: [
          "sourceImageExact",
          "autoUpdatesDisabledExact",
          "sourceReferenceImmutable",
        ],
      },
      recoveryStateMachine: {
        desiredWithEmptyStagedPatch: "RECONCILED_READ_ONLY",
        dismissedWithExactStagedPatch: "RECONCILED_COMMIT_ONLY",
        dismissedWithEmptyStagedPatch: "RECONCILED_STAGE_AND_COMMIT",
        armedWithEmptyStagedPatch: "NOT_APPLIED_NO_WRITE",
        allOtherStates: "FAIL_CLOSED_NO_WRITE",
      },
    });
    expect(executor).toContain(policySha);
    expect(executor).toContain(boundaryPolicySha);
  });

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
    const deletionProofAttestation = read(
      "docs/incident-evidence/railway-staged-deletion-proof-2026-08-29/attestation.json",
    );
    const cleanupCloseoutAttestation = read(
      "docs/incident-evidence/permanent-staging-cleanup-closeout-2026-08-29/attestation.json",
    );

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
    const operationOptions = workflow.match(
      /operation:\n(?<body>[\s\S]*?)\n      prior_cleanup_run_id:/,
    )?.groups?.body ?? "";
    expect(operationOptions).not.toContain(
      "reconcile-completed-forbidden-offsite-backup-deletion",
    );
    expect(workflow).toContain(
      "test \"$OPERATION\" != \\\n            'reconcile-completed-forbidden-offsite-backup-deletion'",
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
    const boundaryPreflight = workflow.match(
      /- name: Fail closed on the Railway boundary before staging protected values(?<body>[\s\S]*?)\n      - name:/,
    )?.groups?.body ?? "";
    expect(boundaryPreflight).toContain(
      "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: ${{ secrets.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN }}",
    );
    expect(boundaryPreflight).toContain(
      "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: ${{ secrets.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN }}",
    );
    expect(boundaryPreflight).toContain(
      "run: npm run readiness:railway:mutation-boundary",
    );
    const boundaryPreflightIndex = workflow.indexOf(
      "Fail closed on the Railway boundary before staging protected values",
    );
    const firstProtectedValueStage = workflow.indexOf(
      "Stage Google Maps API key in private custody",
    );
    const writeStep = workflow.indexOf(
      "Execute one reviewed protected Railway mutation plan",
    );
    expect(boundaryPreflightIndex).toBeGreaterThan(-1);
    expect(boundaryPreflightIndex).toBeLessThan(firstProtectedValueStage);
    expect(boundaryPreflightIndex).toBeLessThan(writeStep);
    const closeoutStep = workflow.match(
      /- name: Reconcile the completed cleanup with metadata only(?<body>[\s\S]*?)\n      - name:/,
    )?.groups?.body ?? "";
    expect(closeoutStep).toContain(
      "if: inputs.operation == 'reconcile-completed-forbidden-offsite-backup-deletion'",
    );
    expect(closeoutStep).toContain(
      "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: ${{ secrets.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN }}",
    );
    expect(closeoutStep).not.toContain(
      "PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN",
    );
    expect(closeoutStep).not.toContain("environmentStageChanges");
    expect(closeoutStep).not.toContain("environmentPatchCommitStaged");
    expect(closeoutStep).toContain("--failed-recovery-evidence-dir");
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
              deletionSemanticsProven: true,
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
            successorReadOnlyCloseout: {
              operation:
                "reconcile-completed-forbidden-offsite-backup-deletion",
              originalCandidateSha:
                "0eadad05ce6c313ed3c12492d3095609ce5872d5",
              closeoutCandidateWasDirectChildOfOriginal: true,
              closeoutCandidateSha:
                "d939a77d0950b27466f3b9ecd26643a2416059a7",
              closeoutCandidateTreeSha:
                "83b0b51efd2cf0ac5c2299c6cfd4c919d1973aff",
              closeoutEvidenceAttestationPath:
                "docs/incident-evidence/permanent-staging-cleanup-closeout-2026-08-29/attestation.json",
              closeoutEvidenceAttestationSha256:
                "2f7f0204e4962f33d87d59b09da5a81ee76d343b8d23a48947547ed1099f0a64",
              closeoutRunId: "33249810569",
              closeoutArtifactId: "9714046913",
              closeoutArtifactDigest:
                "sha256:625fca28703f9c4c7897c6d52a3e54cef8caee6e68f66c3b26a1565d7e4f655d",
              closeoutArtifactBytes: 2583,
              closeoutCompleted: true,
              closeoutDispatchState: "RETIRED_AFTER_COMPLETION",
              historicalRunRerunAllowed: false,
              laterCandidateCloseoutRerunsAllowed: false,
              originalCleanupRunId: "33246243698",
              failedRecoveryRunId: "33246655561",
              expectedPostCleanupMetadataSha256:
                "54fae04fd4dda1688bae3080a2c9c2220fb257f7b5c3ea1ce8677685cc4b18dc",
              committedPatchId: "63b3cc8a-f68f-4b99-adb7-70dfdfa7d6ae",
              committedPatchMessage:
                "pintpath:staging-offsite-cleanup:0eadad05ce6c313ed3c12492d3095609ce5872d5",
              committedPatchReadback:
                "ACTIVE_EMPTY_AND_SELECTED_COMMITTED_MASKED_DECRYPTED_EXACT",
              minimumObservationMinutes: 10,
              recoveryDeadline: "2026-08-30T09:49:29.000Z",
              metadataOnly: true,
              mutationCredentialAllowed: false,
              maximumAttempts: 0,
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
    expect(policy).toMatchObject({
      schemaVersion: "pintpath-permanent-staging-variable-mutation-policy/v9",
      operations: {
        legacyStagedDeletionDispatchState:
          "ENABLED_AFTER_SEALED_DISPOSABLE_PROOF",
        stagedDeletionProof: {
          attestationPath:
            "docs/incident-evidence/railway-staged-deletion-proof-2026-08-29/attestation.json",
          attestationSha256:
            "e1faa9daff1ff4927c852ccf08b917f77b7893f77a04c20bbe192f556e276de2",
          independentReviewOutcome: "GO_NO_P0_P1",
        },
      },
    });
    expect(crypto.createHash("sha256").update(deletionProofAttestation)
      .digest("hex")).toBe(
        "e1faa9daff1ff4927c852ccf08b917f77b7893f77a04c20bbe192f556e276de2",
      );
    expect(crypto.createHash("sha256").update(cleanupCloseoutAttestation)
      .digest("hex")).toBe(
        "2f7f0204e4962f33d87d59b09da5a81ee76d343b8d23a48947547ed1099f0a64",
      );
    expect(workflow).not.toContain(
      "Legacy staged deletion operations are disabled pending provider-verifiable deletion semantics.",
    );
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
    expect(variableNames).toHaveLength(20);
    const secretBackedVariableNames = variableNames.filter((variableName) =>
      variableName !== "PINTPATH_RUNTIME_DATABASE_URL"
    );
    expect(secretBackedVariableNames).toHaveLength(19);
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
    expect(dispatcher).toContain("- ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID");
    expect(dispatcher).toContain("- ACCOUNT_DELETION_NOTICE_FROM");
    expect(dispatcher).toContain("- ACCOUNT_DELETION_NOTICE_REPLY_TO");
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
