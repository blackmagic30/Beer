import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const workflowPath =
  ".github/workflows/stop-permanent-staging-post-q-deployment.yml";
const activePolicyPath =
  "ops/railway/permanent-staging-post-q-deployment-stop-policy-v4.json";
const archivedV1PolicyPath =
  "ops/railway/permanent-staging-post-q-deployment-stop-policy.json";
const archivedV2PolicyPath =
  "ops/railway/permanent-staging-post-q-deployment-stop-policy-v2.json";
const archivedV3PolicyPath =
  "ops/railway/permanent-staging-post-q-deployment-stop-policy-v3.json";

type JsonRecord = Record<string, unknown>;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function json(relativePath: string): JsonRecord {
  return JSON.parse(read(relativePath)) as JsonRecord;
}

function sha256(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function expectLocalArchiveExact(value: unknown): void {
  const archive = value as {
    path: string;
    sizeBytes: number;
    byteSha256: string;
  };
  const source = read(archive.path);
  expect(Buffer.byteLength(source), archive.path).toBe(archive.sizeBytes);
  expect(sha256(source), archive.path).toBe(archive.byteSha256);
}

describe("post-Q permanent staging deployment-stop workflow", () => {
  it("binds the sole manual run-3 writer to active V4 authority", () => {
    const workflow = read(workflowPath);
    const policy = json(activePolicyPath);

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(
      /^\s*(?:push|pull_request|schedule|workflow_call):/mu,
    );
    expect(workflow).toContain(
      "run-name: Permanent staging post-Q deployment stop | ${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain("q_run_id:");
    expect(workflow).toContain("q_artifact_id:");
    expect(workflow).toContain("expected_deployment_id:");
    expect(workflow).toContain("external_mutation_freeze_attestation:");
    expect(workflow).toContain('test "$Q_RUN_ID" = 34229745722');
    expect(workflow).toContain('test "$Q_ARTIFACT_ID" = 10057495901');
    expect(workflow).toContain(
      "pintpath-permanent-staging-cold-quiesce-606d33facb515dd10bc94c360e43c20beb999cc1",
    );
    expect(
      workflow.match(
        /scripts\/verify-permanent-staging-post-q-authority-v4\.mjs/gu,
      ),
    ).toHaveLength(3);
    expect(workflow.match(/--downloaded-dir /gu)).toHaveLength(3);
    expect(workflow.match(/--output-dir /gu)).toHaveLength(3);
    expect(workflow.match(/--q-authority-file/gu)).toHaveLength(3);
    expect(workflow.match(/--reviewed-authority-file/gu)).toHaveLength(3);
    expect(workflow).not.toMatch(
      /sealed\/(?:q|reviewed-containment)-authority\.json/gu,
    );

    const verifierSteps = workflow.match(
      /^      - name: (?:Authenticate|Reauthenticate|Reassert)[^\n]*\n[\s\S]*?(?=^      - name: )/gmu,
    );
    expect(verifierSteps).toHaveLength(3);
    for (const step of verifierSteps ?? []) {
      expect(step).toContain(
        "PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:",
      );
      expect(step).toContain(
        "scripts/verify-permanent-staging-post-q-authority-v4.mjs",
      );
    }

    expect(policy).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-post-q-deployment-stop-policy/v4",
      policyId: "pintpath-permanent-staging-post-q-deployment-stop-successor-v4",
      activationState: "GITHUB_ENVIRONMENT_PROTECTED",
      repository: "blackmagic30/Beer",
      requiredRef: "refs/heads/main",
      requiredRunAttempt: 1,
      githubEnvironment: "permanent-staging-scale-evidence",
      concurrencyGroup: "pintpath-permanent-staging-key-rollout",
      workflow: {
        path: workflowPath,
        workflowId: 353312302,
        requiredRunNumber: 3,
        requiredTotalHistoryRows: 3,
        historyQueryEventFilterAllowed: false,
        currentWriterMustNotHaveStarted: true,
        rerunAllowed: false,
        currentWriterVerificationPhases: [
          "prepare",
          "apply-reauth",
          "apply-prewrite",
        ],
        applyPrewriteFutureWriterStatesAllowed: ["pending"],
        newDispatchAfterRun3Allowed: false,
      },
      secretMaterialAllowed: false,
      secretDerivedCommitmentsAllowed: false,
    });
  });

  it("persists intent before the only staging writer and finalizes credential-free", () => {
    const workflow = read(workflowPath);
    const policy = json(activePolicyPath);

    expect(
      workflow.match(/environment: permanent-staging-scale-evidence/gu),
    ).toHaveLength(2);
    expect(workflow).toContain("needs: prepare");
    expect(workflow).toContain(
      "concurrency:\n  group: pintpath-permanent-staging-key-rollout\n" +
        "  queue: max\n  cancel-in-progress: false\n",
    );
    expect(workflow.match(/^permissions:\n(?:  .+\n)+/mu)?.[0]).toBe(
      "permissions:\n  actions: read\n  checks: read\n  contents: read\n" +
        "  pull-requests: read\n",
    );
    expect(workflow.match(/npm run check/gu)).toHaveLength(2);
    expect(workflow).toContain("--phase prepare");
    expect(workflow.match(/--phase apply(?:-reauth|-prewrite)?(?: |$)/gmu))
      .toHaveLength(3);
    expect(workflow.match(/--phase finalize/gu)).toHaveLength(1);
    expect(
      workflow.match(/Stop the exact accidental staging deployment once/gu),
    ).toHaveLength(1);
    expect(
      workflow.match(/PINTPATH_RAILWAY_STAGING_SCALE_TOKEN/gu),
    ).toHaveLength(2);
    expect(workflow).not.toContain("PINTPATH_RAILWAY_PRODUCTION_MUTATION_TOKEN");
    expect(workflow).not.toContain("PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN");
    expect(workflow).not.toContain(
      "PINTPATH_RAILWAY_STAGING_DEPLOYMENT_STOP_TOKEN",
    );
    expect(workflow).not.toContain("railway down");
    expect(workflow).not.toContain("deploymentRemove");
    expect(workflow).not.toMatch(/^\s{2}reconcile:/mu);
    expect(workflow).not.toContain("continue-on-error:");

    const prepareGate = workflow.indexOf("npm run check");
    const applyGate = workflow.lastIndexOf("npm run check");
    const intentUpload = workflow.indexOf(
      "Persist the exact stop intent before any stop credential exists",
    );
    const intentBinding = workflow.indexOf(
      "Bind the exact durable intent artifact before the writer",
    );
    const boundaryPreflight = workflow.indexOf(
      "Prove the production-staging boundary in a metadata-only process",
    );
    const reassertion = workflow.indexOf(
      "Reassert current main, Q authority, and intent immediately before the writer",
    );
    const writer = workflow.indexOf(
      "Stop the exact accidental staging deployment once",
    );
    const stopCredential = workflow.indexOf(
      "PINTPATH_RAILWAY_STAGING_SCALE_TOKEN",
    );
    const applyInvocation = workflow.indexOf("--phase apply", writer);
    const terminalUpload = workflow.indexOf(
      "Upload bounded secret-free stop intent and terminal evidence",
    );

    expect(intentUpload).toBeGreaterThan(prepareGate);
    expect(intentBinding).toBeGreaterThan(intentUpload);
    expect(boundaryPreflight).toBeGreaterThan(applyGate);
    expect(reassertion).toBeGreaterThan(boundaryPreflight);
    expect(writer).toBeGreaterThan(reassertion);
    expect(stopCredential).toBeGreaterThan(writer);
    expect(stopCredential).toBeLessThan(applyInvocation);
    expect(applyInvocation).toBeGreaterThan(writer);
    expect(terminalUpload).toBeGreaterThan(writer);
    const stepAfterReassertion = workflow.indexOf(
      "\n      - name:",
      reassertion,
    );
    expect(
      workflow.slice(stepAfterReassertion).startsWith(
        "\n      - name: Stop the exact accidental staging deployment once",
      ),
    ).toBe(true);
    expect(workflow.slice(0, intentUpload)).not.toContain(
      "PINTPATH_RAILWAY_STAGING_SCALE_TOKEN",
    );

    const writerBlock = workflow.slice(
      writer,
      workflow.indexOf(
        "Reconcile the Railway production-staging mutation boundary",
        writer,
      ),
    );
    expect(writerBlock).toContain("PINTPATH_RAILWAY_STAGING_SCALE_TOKEN");
    expect(writerBlock).not.toContain("PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN");
    expect(writerBlock).not.toContain("PINTPATH_RAILWAY_STAGING_METADATA_TOKEN");
    expect(writerBlock).not.toContain("GITHUB_TOKEN");

    const finalize = workflow.indexOf(
      "Finalize the outer durable receipt without any provider credential",
    );
    const afterFinalize = workflow.indexOf("\n      - name:", finalize);
    const finalizeBlock = workflow.slice(finalize, afterFinalize);
    expect(finalizeBlock).toContain("--phase finalize");
    expect(finalizeBlock).not.toContain("PINTPATH_RAILWAY_");

    expect(workflow).toContain(
      "pintpath-permanent-staging-post-q-deployment-stop-intent-${{ inputs.candidate_sha }}-${{ github.run_id }}",
    );
    expect(workflow).toContain("stop-intent.json");
    expect(workflow).toContain("stop-apply-terminal-completion.json");
    expect(workflow).toContain("stop-terminal.json");
    expect(workflow).toContain("stop-terminal-completion.json");
    expect(workflow).toContain("boundary-preflight.json");
    expect(workflow).toContain("boundary-postflight.json");
    expect(workflow.match(/--intent-artifact-metadata-file/gu)).toHaveLength(2);
    expect(workflow).toContain("intent-artifact-metadata.json");
    expect(workflow).toContain('jq -S . "$completion" | cmp --silent');
    expect(workflow).toContain(
      "- name: Upload bounded secret-free stop intent and terminal evidence\n" +
        "        if: always()",
    );
    expect(workflow).toContain(
      "pintpath-permanent-staging-post-q-deployment-stop-${{ inputs.candidate_sha }}-${{ github.run_id }}",
    );

    expect(policy).toMatchObject({
      target: {
        projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
        environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
        forbiddenProductionEnvironmentId:
          "13dab015-df74-45c6-b26f-69323daea99a",
        serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
        serviceInstanceId: "5a2f3970-2850-44e0-9b6c-f5c7627dde13",
        deploymentId: "6300a324-9407-4b1c-b651-749c47e9537f",
      },
      operation: {
        mutation: "deploymentStop",
        maximumAttempts: 1,
        automaticRetryAllowed: false,
        prepareCredentials: [
          "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN",
          "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
        ],
        applyCredentials: ["PINTPATH_RAILWAY_STAGING_SCALE_TOKEN"],
        productionWriteCredentialAllowed: false,
        productionMutationAllowed: false,
        postWriteReconciliationRequired: true,
        terminalFinalizationRequired: true,
      },
    });
  });

  it("archives V1/V2/V3 and requires a fresh child of failed V3", () => {
    const policy = json(activePolicyPath);
    const archivedV1 = policy.archivedV1 as JsonRecord;
    const archivedV2 = policy.archivedV2 as JsonRecord;
    const archivedV3 = policy.archivedV3 as JsonRecord;

    expect(json(archivedV1PolicyPath).schemaVersion).toBe(
      "pintpath-permanent-staging-post-q-deployment-stop-policy/v1",
    );
    expect(json(archivedV2PolicyPath).schemaVersion).toBe(
      "pintpath-permanent-staging-post-q-deployment-stop-policy/v2",
    );
    expect(json(archivedV3PolicyPath).schemaVersion).toBe(
      "pintpath-permanent-staging-post-q-deployment-stop-policy/v3",
    );
    expect(archivedV1).toMatchObject({
      policyPath: archivedV1PolicyPath,
      authorityDeadline: "2026-09-08T18:57:20.000Z",
      expired: true,
      reused: false,
    });
    expect(sha256(read(archivedV1PolicyPath))).toBe(
      archivedV1.policyByteSha256,
    );
    expect(sha256(read(String(archivedV1.verifierPath)))).toBe(
      archivedV1.verifierByteSha256,
    );

    expect(archivedV2).toMatchObject({
      candidateSha: "78162cf42a0ef3190343a657ff94f288d4a4c7ca",
      candidateTreeSha: "410fd437bb0c459049f08bbff63ee605f2e65c9e",
      candidateSoleParentSha: "d27275f4c101b764c6016e8b378969c14719258e",
      pullRequest: {
        number: 99,
        mergeCommitSha: "78162cf42a0ef3190343a657ff94f288d4a4c7ca",
        baseSha: "d27275f4c101b764c6016e8b378969c14719258e",
        approvalRequirement: "not_required",
      },
      ineligibility: {
        reason: "required_attempt_1_build_test_scan_failed",
        workflowId: 275221294,
        runId: 34281452199,
        runNumber: 563,
        runAttempt: 1,
        conclusion: "failure",
        failedJobName: "build-test-scan",
        failedStepName: "Dependency audit",
        canonicalWorkflowRunAbsent: true,
        authorityConsumed: false,
        rerunCanQualify: false,
      },
    });
    for (const key of [
      "authorization",
      "policy",
      "verifier",
      "authorityLibrary",
      "executor",
    ]) {
      expectLocalArchiveExact(archivedV2[key]);
    }

    expect(archivedV3).toMatchObject({
      candidateSha: "c6f0f66302a96086c5a60962224af739050e8ff1",
      candidateTreeSha: "73028c14f816ed9599606add3d131a25737db2d2",
      candidateSoleParentSha: "78162cf42a0ef3190343a657ff94f288d4a4c7ca",
      failedRun: {
        runId: 34304764597,
        runNumber: 2,
        runAttempt: 1,
        conclusion: "failure",
        failedStepNumber: 9,
        writerStepNumber: 15,
        deploymentStopAttempts: 0,
        writerNeverStartedExact: true,
        rerunCanQualify: false,
      },
      authorityConsumed: true,
      deploymentStopAuthorityConsumed: false,
      canonicalRun3SuccessorRequired: true,
    });
    for (const key of [
      "authorization",
      "policy",
      "verifier",
      "authorityLibrary",
      "executor",
    ]) {
      expectLocalArchiveExact(archivedV3[key]);
    }

    expect(policy).toMatchObject({
      inheritedV3Contracts: {
        sourcePolicyPath: archivedV3PolicyPath,
        sourcePolicyByteSha256:
          "e7c0adec553e42e28ff2ae877835aa3255cfaa2ee8584f64c08ebe7983d901dd",
        failedQArtifactAndReceiptExact: true,
        expiredV1RunNoWriteExact: true,
        postQBaselineExact: true,
        providerTargetAndOffTargetBoundaryExact: true,
        credentialSeparationExact: true,
        singleDeploymentStopAttemptExact: true,
        durableIntentAndTerminalContractsExact: true,
        postWriteReconciliationAndFinalizationExact: true,
        productionMutationForbiddenExact: true,
      },
      candidateLineage: {
        candidateMustBeCurrentMainTip: true,
        candidateMustBeSoleParentSquash: true,
        directParentSha: "c6f0f66302a96086c5a60962224af739050e8ff1",
        directParentTreeSha: "73028c14f816ed9599606add3d131a25737db2d2",
        directParentSoleParentSha:
          "78162cf42a0ef3190343a657ff94f288d4a4c7ca",
        freshReviewedPullRequestRequired: true,
        freshPullRequestNumberMustBeGreaterThan: 102,
        freshMergeMustFollowFailedV3RunCompletion: true,
        freshBaseChecksRequired: 8,
        freshBaseArtifactsRequired: 3,
      },
      deadline: {
        explicitExpiry: "2026-09-10T08:00:00.000Z",
        maximumAfterPullRequestMergeSeconds: 14400,
        maximumAfterRunStartSeconds: 5400,
        persistDerivedDeadline: true,
        rederiveImmediatelyBeforeWriter: true,
        expirySuppressesPostWriteReconciliation: false,
        expirySuppressesFinalization: false,
      },
    });
  });

  it("binds strict secret-free dynamic collateral without replacing static eligibility", () => {
    const policy = json(activePolicyPath);

    expect(policy).toMatchObject({
      environmentConfigProjection: {
        sourceQueryDecryptVariables: false,
        canonicalSerialization: "recursively-sorted-keys-pretty-json-plus-LF",
        staticEligibilityProjection: {
          schemaVersion:
            "pintpath-permanent-staging-post-q-target-deploy-config-projection/v1",
          scope: "exact-target-service-deploy-object",
          projectionSizeBytes: 540,
          projectionSha256:
            "8ab34441af1ec87d5068ce0155975a9fea46a192537b70c54677e64f60ae183e",
          historicalFullEnvironmentHashRequired: false,
        },
        dynamicCollateralCommitment: {
          schemaVersion:
            "pintpath-permanent-staging-post-q-observed-environment-config/v1",
          exactKnownRootServiceVolumeAndNestedPathsRequired: true,
          unknownOrMissingPathRejected: true,
          variableValueMustBeNull: true,
          onlyKnownPasswordGeneratorsMayBeStrings: true,
          generatorGrammarExact:
            "secret(32,lowercase-then-uppercase-ascii)",
          generatorProjectedAsSemanticDescriptor: true,
          rawGeneratorPersistedOrHashed: false,
          preflightPrewriteAndEveryTerminalObservationEqualityRequired: true,
          historicalDigestPinned: false,
          onlySchemaAndDigestPersisted: true,
        },
        sourceIdentityBoundSeparately: true,
        networkingDomainsBoundSeparately: true,
        exactVariableMetadataRowsAndCollateralBoundSeparately: true,
        stagedPatchBoundSeparately: true,
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      },
      authorization: {
        authorizationId:
          "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v4",
        sourcePath:
          "ops/railway/permanent-staging-post-q-deployment-stop-authorization-v4.json",
        sourceThreadId: "01a0840a-3590-74d1-9567-0e9eec01a9a4",
        sourceSchemaVersion:
          "pintpath-reviewed-user-authorization-provenance/v2",
        sourceSizeBytes: 613,
        sourceSha256:
          "ccaf9c49e38f97368f6187d7c3ff1c853cffe8334fdfaf3478835c7e93f4028c",
        reviewedProvenanceOnly: true,
        cryptographicUserSignatureClaimed: false,
      },
    });
  });

  it("cannot unlock another release prerequisite or mutate production", () => {
    const workflow = read(workflowPath);
    const isolatedAuthorityConsumers = [
      ".github/workflows/deploy-permanent-staging.yml",
      ".github/workflows/permanent-staging-venue-directory.yml",
      ".github/workflows/permanent-staging-supabase-legacy-cutover.yml",
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
      "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
      "ops/railway/permanent-staging-app-deployment-policy.json",
      "ops/railway/permanent-staging-app-deployment-attestation-policy.json",
      "ops/railway/permanent-staging-worker-bootstrap-prerequisites-policy.json",
      "ops/railway/protected-automatic-maintenance-worker-fence-policy.json",
      "scripts/verify-github-permanent-staging-deployment.mjs",
      "scripts/verify-permanent-staging-worker-bootstrap-prerequisites.ts",
    ] as const;
    const forbiddenReferences = [
      "stop-permanent-staging-post-q-deployment.yml",
      "permanent-staging-post-q-deployment-stop-policy",
      "execute-protected-permanent-staging-post-q-deployment-stop",
      "verify-permanent-staging-post-q-authority",
      "pintpath-permanent-staging-post-q-deployment-stop-successor",
    ] as const;

    for (const consumer of isolatedAuthorityConsumers) {
      const source = read(consumer);
      for (const forbidden of forbiddenReferences) {
        expect(
          source,
          `${consumer} unexpectedly trusts ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }

    const excludedPolicyNames = new Set([
      path.basename(activePolicyPath),
      path.basename(archivedV1PolicyPath),
      path.basename(archivedV2PolicyPath),
      path.basename(archivedV3PolicyPath),
    ]);
    const otherContracts = [
      ...fs
        .readdirSync(path.join(root, ".github/workflows"))
        .filter(
          (name) =>
            /\.ya?ml$/u.test(name) && name !== path.basename(workflowPath),
        )
        .map((name) => `.github/workflows/${name}`),
      ...fs
        .readdirSync(path.join(root, "ops/railway"))
        .filter(
          (name) => name.endsWith(".json") && !excludedPolicyNames.has(name) &&
            !name.startsWith(
              "permanent-staging-post-q-deployment-stop-authorization-",
            ),
        )
        .map((name) => `ops/railway/${name}`),
    ];
    for (const contract of otherContracts) {
      const source = read(contract);
      for (const forbidden of forbiddenReferences) {
        expect(
          source,
          `${contract} unexpectedly trusts ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }

    expect(workflow).not.toContain("workflow_run:");
    expect(workflow).not.toContain("workflow_call:");
    expect(workflow).not.toContain("gh workflow run");
    expect(workflow).not.toContain("createWorkflowDispatch");
    expect(workflow).not.toContain("create_workflow_dispatch");
    expect(workflow).not.toContain("actions/workflows/");
    expect(workflow).not.toContain("13dab015-df74-45c6-b26f-69323daea99a");
    expect(workflow).toContain(
      "pintpath-post-q-deployment-stop-evidence/reviewed-containment-authority.json",
    );
  });
});
