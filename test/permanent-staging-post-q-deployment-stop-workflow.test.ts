import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const workflowPath =
  ".github/workflows/stop-permanent-staging-post-q-deployment.yml";
const policyPath =
  "ops/railway/permanent-staging-post-q-deployment-stop-policy.json";

describe("post-Q permanent staging deployment-stop workflow", () => {
  it("binds the exact failed Q attempt, its sole writer, and immutable artifact", () => {
    const workflow = read(workflowPath);
    const policy = JSON.parse(read(policyPath)) as Record<string, unknown>;

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
    expect(workflow).toContain(
      "scripts/verify-permanent-staging-post-q-authority.mjs",
    );
    expect(
      workflow.match(
        /scripts\/verify-permanent-staging-post-q-authority\.mjs/gu,
      ),
    ).toHaveLength(3);
    expect(workflow).toContain('--q-run-id "$Q_RUN_ID"');
    expect(workflow).toContain('--q-artifact-id "$Q_ARTIFACT_ID"');
    expect(workflow.match(/--downloaded-dir /gu)).toHaveLength(3);
    expect(workflow.match(/--output-dir /gu)).toHaveLength(3);
    expect(workflow.match(/--q-authority-file/gu)).toHaveLength(3);
    expect(workflow.match(/--reviewed-authority-file/gu)).toHaveLength(3);
    expect(workflow).toContain(
      '--q-authority-file "$RUNNER_TEMP/pintpath-post-q-deployment-stop-q-reassert/q-authority.json"',
    );
    expect(workflow).toContain(
      '--reviewed-authority-file "$RUNNER_TEMP/pintpath-post-q-deployment-stop-q-reassert/reviewed-containment-authority.json"',
    );
    expect(workflow).not.toMatch(
      /sealed\/reviewed-containment-authority\.json/gu,
    );
    expect(workflow).not.toMatch(/sealed\/q-authority\.json/gu);
    const verifierSteps = workflow.match(
      /^      - name: (?:Authenticate|Reauthenticate|Reassert)[^\n]*\n[\s\S]*?(?=^      - name: )/gmu,
    );
    expect(verifierSteps).toHaveLength(3);
    for (const step of verifierSteps ?? []) {
      expect(step).toContain(
        "PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:",
      );
      expect(step).toContain(
        "scripts/verify-permanent-staging-post-q-authority.mjs",
      );
    }
    expect(policy).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-post-q-deployment-stop-policy/v1",
      policyId: "pintpath-permanent-staging-post-q-deployment-stop-containment",
      activationState: "GITHUB_ENVIRONMENT_PROTECTED",
      repository: "blackmagic30/Beer",
      requiredRef: "refs/heads/main",
      requiredRunAttempt: 1,
      githubEnvironment: "permanent-staging-scale-evidence",
      concurrencyGroup: "pintpath-permanent-staging-key-rollout",
      failedQAuthority: {
        workflowPath:
          ".github/workflows/recover-permanent-staging-cold-zero.yml",
        workflowId: 344383802,
        runId: 34229745722,
        runAttempt: 1,
        event: "workflow_dispatch",
        displayTitle:
          "Permanent staging cold recovery | quiesce | 606d33facb515dd10bc94c360e43c20beb999cc1",
        headBranch: "main",
        headSha: "606d33facb515dd10bc94c360e43c20beb999cc1",
        createdAt: "2026-09-08T13:04:29Z",
        updatedAt: "2026-09-08T13:10:47Z",
        conclusion: "failure",
        job: {
          id: 102072625320,
          conclusion: "failure",
          bridgeStep: { number: 17, conclusion: "success" },
          soleWriterStep: {
            number: 18,
            conclusion: "failure",
          },
          boundaryStep: { number: 21, conclusion: "success" },
          artifactUploadStep: { number: 22, conclusion: "success" },
          soleWriterAcrossAttempt: true,
        },
        artifact: {
          id: 10057495901,
          sizeBytes: 12561,
          digest:
            "sha256:32a404cdd7078dc04d4b2531deec460dd4f44b4309fe35d873c8bcd46a367c4b",
          repositoryId: 1215862300,
        },
        receipt: {
          outcome: "mutation_uncertain",
          failureCode: "reconciliation_failed",
          attempts: 1,
          retryAllowed: false,
          transportOutcome: "acknowledged",
          acknowledgementExact: true,
          exactZeroStateAfter: false,
          configuredOneToZeroReceiptClaimed: false,
          mustNotBeRetried: true,
          mustNotBeReinterpretedAsZero: true,
        },
        acknowledgedPatch: {
          id: "c6fe9c8a-b26e-4a1d-9d46-4b6ea7d84ad1",
          status: "COMMITTED",
          projectionSha256:
            "20a9837d61c6c192da021fa07d453c29691b248537d6617c9ba2f9985aa4e8ce",
        },
      },
    });

    const failedQ = policy.failedQAuthority as {
      artifact: { members: Array<Record<string, unknown>> };
      skippedJobs: Array<Record<string, unknown>>;
    };
    expect(failedQ.skippedJobs).toEqual([
      {
        id: 102072626482,
        name: "Bind the exact replacement and prepare the dead baseline",
        conclusion: "skipped",
        stepCount: 0,
      },
      {
        id: 102072626886,
        name: "Reconcile an ambiguous cold prepare at the exact dead baseline",
        conclusion: "skipped",
        stepCount: 0,
      },
      {
        id: 102072656578,
        name: "Reconcile an ambiguous cold quiesce at exact zero",
        conclusion: "skipped",
        stepCount: 0,
      },
    ]);
    expect(failedQ.artifact.members).toEqual([
      {
        path: "pintpath-cold-github-candidate/reviewed-authority.json",
        sizeBytes: 5354,
        sha256:
          "877d697225c6f8a6290386a1f2e9b003ee1a521b01af0cd046d482a4b16c8dfc",
      },
      {
        path: "pintpath-permanent-staging-cold-evidence/cold-quiesce-intent.json",
        sizeBytes: 2952,
        sha256:
          "2937fa93e50fd01ed36f7578e6da3d236eec73d1efc65f120aa02581d7b81d99",
      },
      {
        path: "pintpath-permanent-staging-cold-evidence/cold-quiesce-receipt.json",
        sizeBytes: 6466,
        sha256:
          "f1ee14e3d8082add77cefeaafde38f188df36e29688cba679cbc92b75bb322c5",
      },
      {
        path: "pintpath-permanent-staging-cold-evidence/cold-quiesce-successor-bridge.json",
        sizeBytes: 12505,
        sha256:
          "b355f3474a368e4f4b97c98d6d5fc1f35b01e0aa48d22f1c19e6a1d8ccadaec3",
      },
      {
        path: "pintpath-permanent-staging-cold-evidence/prerequisites-verification.json",
        sizeBytes: 2724,
        sha256:
          "fe423786cb2db2af8230fc8e3fb7bb6a19a9cbe366adb1a6542aade79c8f7867",
      },
    ]);
  });

  it("persists intent before the only writer and never exposes a production mutation path", () => {
    const workflow = read(workflowPath);
    const policy = JSON.parse(read(policyPath)) as Record<string, unknown>;

    expect(
      workflow.match(/environment: permanent-staging-scale-evidence/gu),
    ).toHaveLength(2);
    expect(workflow).toContain("needs: prepare");
    expect(workflow).toContain("group: pintpath-permanent-staging-key-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow.match(/^permissions:\n(?:  .+\n)+/mu)?.[0]).toBe(
      "permissions:\n  actions: read\n  checks: read\n  contents: read\n" +
        "  pull-requests: read\n",
    );
    expect(workflow).toContain(
      "concurrency:\n  group: pintpath-permanent-staging-key-rollout\n" +
        "  queue: max\n  cancel-in-progress: false\n",
    );
    expect(workflow.match(/npm run check/gu)).toHaveLength(2);
    expect(workflow).toContain("--phase prepare");
    expect(workflow).toContain("--phase apply");
    expect(workflow.match(/--phase apply/gu)).toHaveLength(1);
    expect(
      workflow.match(/Stop the exact accidental staging deployment once/gu),
    ).toHaveLength(1);
    expect(
      workflow.match(/PINTPATH_RAILWAY_STAGING_SCALE_TOKEN/gu),
    ).toHaveLength(2);
    expect(workflow).not.toContain(
      "PINTPATH_RAILWAY_PRODUCTION_MUTATION_TOKEN",
    );
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
    const reassertion = workflow.indexOf(
      "Reassert current main, Q authority, and intent immediately before the writer",
    );
    const boundaryPreflight = workflow.indexOf(
      "Prove the production-staging boundary in a metadata-only process",
    );
    const stopCredential = workflow.indexOf(
      "PINTPATH_RAILWAY_STAGING_SCALE_TOKEN",
    );
    const writer = workflow.indexOf(
      "Stop the exact accidental staging deployment once",
    );
    const terminalUpload = workflow.indexOf(
      "Upload bounded secret-free stop intent and terminal evidence",
    );
    const applyInvocation = workflow.indexOf("--phase apply");
    expect(intentUpload).toBeGreaterThan(prepareGate);
    expect(intentBinding).toBeGreaterThan(intentUpload);
    expect(boundaryPreflight).toBeGreaterThan(applyGate);
    expect(reassertion).toBeGreaterThan(boundaryPreflight);
    expect(reassertion).toBeGreaterThan(intentBinding);
    expect(writer).toBeGreaterThan(applyGate);
    expect(writer).toBeGreaterThan(reassertion);
    expect(stopCredential).toBeGreaterThan(reassertion);
    expect(stopCredential).toBeGreaterThan(writer);
    expect(stopCredential).toBeLessThan(applyInvocation);
    const stepAfterReassertion = workflow.indexOf(
      "\n      - name:",
      reassertion,
    );
    expect(
      workflow
        .slice(stepAfterReassertion)
        .startsWith(
          "\n      - name: Stop the exact accidental staging deployment once",
        ),
    ).toBe(true);
    expect(workflow.slice(0, intentUpload)).not.toContain(
      "PINTPATH_RAILWAY_STAGING_SCALE_TOKEN",
    );
    expect(terminalUpload).toBeGreaterThan(writer);
    expect(workflow).toContain(
      "- name: Upload bounded secret-free stop intent and terminal evidence\n" +
        "        if: always()",
    );
    expect(workflow).toContain(
      "pintpath-permanent-staging-post-q-deployment-stop-intent-${{ inputs.candidate_sha }}-${{ github.run_id }}",
    );
    expect(workflow).toContain(
      "pintpath-permanent-staging-post-q-deployment-stop-${{ inputs.candidate_sha }}-${{ github.run_id }}",
    );
    expect(workflow).toContain("stop-intent.json");
    expect(workflow).toContain("stop-apply-terminal-completion.json");
    expect(workflow).toContain("stop-terminal.json");
    expect(workflow).toContain("stop-terminal-completion.json");
    expect(workflow).toContain('jq -S . "$completion" | cmp --silent');
    expect(workflow).toContain(
      "pintpath-permanent-staging-post-q-deployment-stop-terminal-completion/v1",
    );
    expect(workflow).toContain(
      '--arg terminalSha256 "$terminal_sha256"',
    );
    expect(workflow).toContain("boundary-preflight.json");
    expect(workflow).toContain("boundary-postflight.json");
    expect(workflow).toContain('--boundary-preflight-file "$RUNNER_TEMP/');
    expect(workflow.match(/--intent-artifact-metadata-file/gu)).toHaveLength(2);
    expect(workflow).toContain("intent-artifact-metadata.json");
    expect(workflow).toContain('jq -S -c . "$metadata"');

    const writerBlock = workflow.slice(
      writer,
      workflow.indexOf(
        "Reconcile the Railway production-staging mutation boundary",
        writer,
      ),
    );
    expect(writerBlock).toContain("PINTPATH_RAILWAY_STAGING_SCALE_TOKEN");
    expect(writerBlock).not.toContain(
      "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
    );
    expect(writerBlock).not.toContain(
      "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN",
    );
    expect(writerBlock).not.toContain("GITHUB_TOKEN");

    expect(policy).toMatchObject({
      environmentProtection: {
        requiredReviewers: 0,
        waitTimerMinutes: 0,
        protectedMainOnly: true,
        humanApprovalRequired: false,
        automatedFailClosedGatesRequired: true,
      },
      reviewedContainmentCandidateAuthority: {
        schemaVersion:
          "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v1",
        verifierPath: "scripts/verify-permanent-staging-post-q-authority.mjs",
        outputFilename: "reviewed-containment-authority.json",
        outsideSealedQArtifactTree: true,
        repository: "blackmagic30/Beer",
        branch: "main",
        candidateMustEqualDispatchSha: true,
        candidateMustEqualCurrentMainTip: true,
        reviewedPullRequestRequired: true,
        releasePolicySha256Required: true,
        soleParentMergedCandidateRequired: true,
        directParentSha: "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7",
        recoveryBridge: {
          candidateSha: "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7",
          treeSha: "9978dca9491f7bf7bee77ce39debe1f713e89c53",
          soleParentSha: "606d33facb515dd10bc94c360e43c20beb999cc1",
        },
        currentContainmentRunRequired: true,
        currentContainmentRunAttempt: 1,
        requiredBaseCheckCount: 8,
        requiredBaseArtifactCount: 3,
        authorizationDeadline: "2026-09-08T18:57:20.000Z",
        secretMaterialAllowed: false,
        secretDerivedCommitmentsAllowed: false,
      },
      target: {
        projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
        environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
        forbiddenProductionEnvironmentId:
          "13dab015-df74-45c6-b26f-69323daea99a",
        serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
        serviceInstanceId: "5a2f3970-2850-44e0-9b6c-f5c7627dde13",
      },
      operation: {
        prepare: {
          metadataOnly: true,
          stopCredentialAllowed: false,
          exactQArtifactRequired: true,
          exactPostQBaselineRequired: true,
          durableIntentFilename: "stop-intent.json",
        },
        apply: {
          mutation: "deploymentStop",
          operationName: "PintPathPostQDeploymentStop",
          deploymentId: "6300a324-9407-4b1c-b651-749c47e9537f",
          maximumAttempts: 1,
          automaticRetryAllowed: false,
          rerunAllowed: false,
          reconciliationJobAllowed: false,
          exactDurableIntentArtifactRequired: true,
          immediateRepositoryReassertionRequired: true,
          immediateQAuthorityReassertionRequired: true,
          immediateReviewedCandidateAuthorityReassertionRequired: true,
          immediateProviderBaselineReassertionRequired: true,
          applyTerminalEvidenceFilename: "stop-apply-terminal.json",
          applyTerminalCompletionFilename:
            "stop-apply-terminal-completion.json",
        },
        finalize: {
          providerCredentialsAllowed: false,
          qAuthorityRequired: true,
          reviewedCandidateAuthorityRequired: true,
          exactDurableIntentRequired: true,
          applyTerminalRequired: true,
          applyTerminalCompletionRequiredForSuccess: true,
          preflightBoundaryRequired: true,
          postflightBoundaryRequired: true,
          outerTerminalEvidenceFilename: "stop-terminal.json",
          outerTerminalCompletionFilename: "stop-terminal-completion.json",
          outerTerminalCompletionRequiredForSuccess: true,
        },
      },
      freshRunExclusivity: {
        workflowPath:
          ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        allWorkflowRunPagesRequired: true,
        allJobPagesRequired: true,
        currentRunMustBeSoleWriteEligibleRun: true,
        currentRunAttemptMustEqualOne: true,
        currentRunNumberMustEqual: 2,
        totalWorkflowDispatchRunsMustEqual: 2,
        everyHistoryRunAttemptMustEqualOne: true,
        priorWriterStartedConsumesAuthority: true,
        priorWriterDispositionIndeterminateConsumesAuthority: true,
        priorCompletedBeforeWriterRunsDoNotConsumeAuthority: true,
        additionalPriorDispatchAllowed: false,
        requiredWorkflowMetadata: {
          id: 353312302,
          name: "Stop the exact post-Q permanent staging deployment",
          path:
            ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
          state: "active",
        },
        requiredRecoveryBridge: {
          runId: "34255228036",
          runAttempt: 1,
          runNumber: 1,
          workflowId: 353312302,
          checkSuiteId: 92795131798,
          workflowPath:
            ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
          runName:
            "Permanent staging post-Q deployment stop | f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7",
          displayTitle:
            "Permanent staging post-Q deployment stop | f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7",
          headSha: "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7",
          headBranch: "main",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-09-08T17:07:48Z",
          runStartedAt: "2026-09-08T17:07:48Z",
          updatedAt: "2026-09-08T17:12:11Z",
          repositoryId: 1215862300,
          repositoryFullName: "blackmagic30/Beer",
          repositoryAndHeadRepositoryExact: true,
          actorId: 29029791,
          actorLogin: "blackmagic30",
          triggeringActorId: 29029791,
          triggeringActorLogin: "blackmagic30",
          prepareJobId: "102159216963",
          prepareJobStatus: "completed",
          prepareJobConclusion: "failure",
          prepareJobStartedAt: "2026-09-08T17:07:53Z",
          prepareJobCompletedAt: "2026-09-08T17:12:10Z",
          prepareJobExactStepCount: 15,
          applyJobId: "102160681336",
          applyJobStatus: "completed",
          applyJobConclusion: "skipped",
          applyJobStepCount: 0,
          artifactCount: 0,
          artifactsAbsentExact: true,
          prepareFailedBeforeIntentExact: true,
          applyCompletedSkippedWithoutStepsExact: true,
          writerNeverExistedOrStartedExact: true,
        },
        writerStepName: "Stop the exact accidental staging deployment once",
      },
      credentials: {
        prepare: [
          "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN",
          "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
        ],
        applyWriter: ["PINTPATH_RAILWAY_STAGING_SCALE_TOKEN"],
        boundaryProcesses: [
          "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN",
          "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
        ],
        applyWriterMetadataCredentialAllowed: false,
        applyWriterProductionCredentialAllowed: false,
        productionCredentialUnavailableToSoleWriterProcess: true,
        productionCredentialAllowedOnlyInBoundaryReadProcesses: true,
        productionCredentialUnavailableToWholeApplyJob: false,
        stopCredentialAllowedBeforeDurableIntentBinding: false,
        stopCredentialAllowedOutsideSoleWriterStep: false,
      },
      mutationBoundary: {
        receiptPolicy: "pintpath-production-staging-mutation-boundary",
        immediatePreflightRequired: true,
        unconditionalPostflightRequired: true,
      },
    });
  });

  it("pins H14/P127 and requires provider-terminal convergence, not an endpoint shortcut", () => {
    const policy = JSON.parse(read(policyPath)) as Record<string, unknown>;

    expect(policy).toMatchObject({
      postQBaseline: {
        deploymentId: "6300a324-9407-4b1c-b651-749c47e9537f",
        deploymentStatus: "SUCCESS",
        deploymentStopped: false,
        deploymentMetaPatchId: null,
        activeDeploymentCount: 1,
        snapshotId: "92c2253a-60c4-47fb-8053-a2aee33fc944",
        sourceSha: "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba",
        imageDigest:
          "sha256:35787ff955a6f2f729ebe7e2220a6146d9429d2ab37e2a88b86225ff0681816e",
        legacyNumReplicas: null,
        configuredReplicas: 1,
        configuredRegions: {
          "us-west2": { numReplicas: 1, stackerAssignment: null },
        },
        stagedPatchEmpty: true,
        stateProjectionSchemaVersion:
          "pintpath-permanent-staging-post-q-state-projection/v1",
        stateProjectionFields: [
          "environmentId",
          "serviceInstanceId",
          "serviceId",
          "numReplicas",
          "configuredReplicas",
          "configuredRegions",
          "deploymentRegions",
          "source",
          "latestDeployment",
          "activeDeployments",
          "domains",
          "deployment",
          "rows",
        ],
        stateSha256:
          "c5301d50929dd463a45868b5e7c4db869eec9b95113f609b4631fc24ba629425",
        environmentConfigSha256:
          "8ab34441af1ec87d5068ce0155975a9fea46a192537b70c54677e64f60ae183e",
        stagedPatchSha256:
          "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
        sourceIdentitySha256:
          "d4fd7186aeed76717f612e2671cd6ec5bc20086d819a6644ad73e4934baea205",
        topologySha256:
          "63b2f7cf3dd9f12b05ab9f695555764d5908d3048cdc98be3938499daa079ea9",
        allVariableRowsSha256:
          "2164ff3f0b321e8de557e91394fc96dced4100d84405f1c32174a567ade9fc15",
        collateralVariableRowsSha256:
          "76aeec3ee15ddb7c6f628d841815ab1a86d2e04b7685b9ec2ce165bcb500bf7f",
        offTargetStateSha256:
          "2e09efb56d0101fd30c7d1d217e52e51f1b75efefa5342b5472b28ddedc476e7",
        providerLedger: {
          historyCount: 14,
          historyRowsSha256:
            "c148abfa11eda85933b6f80ec3a682bd58afe8cf03ca17c8c55b72d6fdda7296",
          qLifecycleRowsSha256:
            "b03b5f774b5e76100251bb32f4d22118ee1869961e01e2c65ffb39b7fd975374",
          patchCount: 127,
          patchRowsSha256:
            "8625b57c0a91e83447b3194992642a129c9d55470e203cc41fddff67a2680bbf",
        },
      },
      desiredPostState: {
        deploymentId: "6300a324-9407-4b1c-b651-749c47e9537f",
        deploymentStopped: true,
        stateSha256:
          "133afe93ed56697ea4ea621e5c07112833084c8994ac9073fce919dc89f5717b",
        deploymentMetaPatchId: null,
        activeDeploymentCount: 0,
        configuredReplicas: 1,
        configuredRegions: {
          "us-west2": { numReplicas: 1, stackerAssignment: null },
        },
        topologyMustRemainUnchanged: true,
        variablesMustRemainUnchanged: true,
        sourceMustRemainUnchanged: true,
        stagedPatchMustRemainEmpty: true,
        productionMustRemainUnchanged: true,
        noTopologyMutationAfterStop: true,
        nextRequiredProof:
          "EXACT_SUPPORTED_US_WEST_ONE_TO_ASIA_ONE_TOPOLOGY_REPAIR_WHILE_STOPPED",
      },
      terminalConvergence: {
        maximumObservationSeconds: 300,
        maximumPollRounds: 28,
        minimumRoundIoReserveSeconds: 75,
        maximumLedgerPagesPerConnection: 2,
        actualElapsedTimeMustNotBeClamped: true,
        pollIntervalSeconds: 10,
        requiredStableObservations: 3,
        minimumStableWindowSeconds: 20,
        providerDeploymentStoppedRequired: true,
        providerActiveDeploymentCountRequired: 0,
        providerDeploymentIdentityRequiredAtEveryObservation: true,
        fullStateEqualityRequiredAcrossStableObservations: true,
        stopRequestTimestampRequiredBeforeMutation: true,
        providerHistoryMustRemainUnchanged: true,
        unauthenticatedDeploymentHistoryDeltaForbidden: true,
        unexpectedEnvironmentPatchForbidden: true,
        providerHistoryStableAcrossTerminalObservations: true,
        providerPatchLedgerStableAcrossTerminalObservations: true,
        endpointObservationSupplementalOnly: true,
        endpointAbsenceRequiredWithProviderState: true,
        endpointAloneNeverSufficient: true,
        explicitHttpNon2xxResponseRequired: true,
        nullStatusObservationForbidden: true,
        endpointCacheBustingRequired: true,
        endpointStableWindowRequired: true,
        dynamicEndpointUrlAndBodyHashesExcludedFromStableStateComparison: true,
        endpoint404Sufficient: false,
        singleEmptyActiveDeploymentObservationSufficient: false,
      },
      evidence: {
        durableSecretFreeIntentRequiredBeforeWrite: true,
        canonicalIntentArtifactApiMetadataBindingRequired: true,
        exactQRunJobStepArtifactAndContentBindingRequired: true,
        sealedQArtifactTreeMustRemainExactFiveMembers: true,
        qAuthorityOutsideSealedTreeRequired: true,
        reviewedCandidateAuthorityOutsideSealedTreeRequired: true,
        reviewedCandidateAuthorityExactBytesBindingRequired: true,
        recoveryBridgeCandidateTreeAndParentBindingRequired: true,
        failedPreIntentContainmentBridgeBindingRequired: true,
        staticWorkflowMetadataBindingRequired: true,
        providerLedgerH14P127BindingRequired: true,
        innerApplyTerminalRequired: true,
        innerApplyTerminalCompletionRequiredForSuccess: true,
        innerApplyTerminalCompletionMustBindExactSha256AndSize: true,
        outerTerminalReceiptRequired: true,
        outerTerminalCompletionRequiredForSuccess: true,
        outerTerminalCompletionMustBindExactSha256AndSize: true,
        outerTerminalReceiptRequiredAfterEveryWriterOutcome: true,
        outerTerminalReceiptSelfHashForbidden: true,
        beforeAndTerminalSnapshotsAndLedgersBindingRequired: true,
        stateProjectionDigestComputedByWriterAndBoundByInnerArtifact: true,
        outerRecomputesVisibleTopologyAndSourceCommitments: true,
        topologySourceVariableAndStagedHashesBindingRequired: true,
        stableObservationTimestampsHashesAndSpanBindingRequired: true,
        runtimeEvidenceBindingRequired: true,
        unexpectedHistoryRowDigestOnlyRequired: true,
        unexpectedHistoryRowEvidence: {
          digestField: "addedHistoryRowSha256",
          countField: "addedHistoryRowCount",
          positionField: "addedHistoryRowPosition",
          recognizedPosition: "newest-prefix",
          unchangedValues: {
            addedHistoryRowSha256: null,
            addedHistoryRowCount: 0,
            addedHistoryRowPosition: null,
          },
          rawRowAllowed: false,
        },
        requestQueryVariablesAndAcknowledgementHashesBindingRequired: true,
        postflightBoundaryHashBindingRequired: true,
        coldQuiesceSatisfied: false,
        authorizesDownstream: false,
        authorizedSuccessors: ["post-Q-topology-repair-only"],
        terminalReceiptRequired: true,
        stableProviderAbsenceObservationsRequired: true,
        productionBoundaryProofRequired: true,
        secretMaterialAllowed: false,
        secretDerivedCommitmentsAllowed: false,
        providerCredentialsAllowed: false,
        rawProviderMetadataAllowed: false,
      },
    });

    const baseline = policy.postQBaseline as {
      providerLedger: { qLifecycleNewestFirst: Array<Record<string, unknown>> };
    };
    expect(baseline.providerLedger.qLifecycleNewestFirst).toEqual([
      {
        id: "650b3b06-0320-43d4-9359-f319a316878e",
        createdAt: "2026-09-08T13:11:11.634Z",
        action: "deployed",
        status: "SUCCESS",
      },
      {
        id: "3ae50c9c-620d-458d-b29f-ac23ee5ce575",
        createdAt: "2026-09-08T13:10:41.008Z",
        action: "deploying",
        status: "DEPLOYING",
      },
      {
        id: "cd049a7f-9e08-41f8-948b-824825e2e8e1",
        createdAt: "2026-09-08T13:09:27.503Z",
        action: "building",
        status: "BUILDING",
      },
      {
        id: "e114d7de-140c-49b3-887a-a85ff796b9e7",
        createdAt: "2026-09-08T13:09:25.527Z",
        action: "redeployed",
        status: "INITIALIZING",
      },
    ]);

    const convergence = policy.terminalConvergence as {
      minimumStableWindowSeconds: number;
      pollIntervalSeconds: number;
    };
    expect(convergence.pollIntervalSeconds).toBeGreaterThanOrEqual(10);
    expect(convergence.minimumStableWindowSeconds).toBeGreaterThanOrEqual(20);
  });

  it("is an isolated containment producer that cannot unlock F/V/S/A/D", () => {
    const workflow = read(workflowPath);
    const policy = JSON.parse(read(policyPath)) as Record<string, unknown>;
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
    const forbiddenContainmentReferences = [
      "stop-permanent-staging-post-q-deployment.yml",
      "permanent-staging-post-q-deployment-stop-policy.json",
      "execute-protected-permanent-staging-post-q-deployment-stop.ts",
      "verify-permanent-staging-post-q-authority.mjs",
      "pintpath-permanent-staging-post-q-deployment-stop-containment",
      "pintpath-permanent-staging-post-q-deployment-stop-",
    ] as const;

    for (const consumer of isolatedAuthorityConsumers) {
      const source = read(consumer);
      for (const forbidden of forbiddenContainmentReferences) {
        expect(
          source,
          `${consumer} unexpectedly trusts ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }

    const existingWorkflowAndPolicyContracts = [
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
          (name) =>
            name.endsWith(".json") && name !== path.basename(policyPath),
        )
        .map((name) => `ops/railway/${name}`),
    ];
    for (const contract of existingWorkflowAndPolicyContracts) {
      const source = read(contract);
      for (const forbidden of forbiddenContainmentReferences) {
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
    expect(policy).toMatchObject({
      authorityIsolation: {
        producerKind:
          "pintpath-permanent-staging-post-q-deployment-stop-containment",
        maySatisfyExistingReleasePrerequisite: false,
        mayWidenExistingReleasePrerequisite: false,
        mayDispatchDownstreamWorkflow: false,
        forbiddenPrerequisiteKinds: ["F", "V", "S", "A", "D"],
      },
    });
  });
});
