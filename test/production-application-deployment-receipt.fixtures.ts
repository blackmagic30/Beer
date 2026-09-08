import crypto from "node:crypto";

function canonicalKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalKeyOrder);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [
    key,
    canonicalKeyOrder(record[key]),
  ]));
}

export function productionApplicationDeploymentReceiptFixture(input: {
  readonly candidateSha: string;
  readonly previousDeploymentIdSha256: string;
  readonly deploymentIdSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
}): Record<string, unknown> {
  const topologyBase = {
    configuredReplicas: 1,
    configuredRegions: [{
      region: "asia-southeast1-eqsg3a",
      numReplicas: 1,
    }],
  };
  const topology = {
    ...topologyBase,
    configuredTopologySha256: crypto.createHash("sha256").update(
      `${JSON.stringify(canonicalKeyOrder(topologyBase), null, 2)}\n`,
    ).digest("hex"),
  };
  return {
    schemaVersion: "pintpath-railway-application-deployment-executor/v6",
    operation: "pintpath-railway-application-source-upload",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    target: "production",
    outcome: "deployed",
    failureCode: null,
    candidateSha: input.candidateSha,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    writeAttempts: 1,
    acknowledgement: "received",
    previousDeploymentIdSha256: input.previousDeploymentIdSha256,
    deploymentIdSha256: input.deploymentIdSha256,
    intentSha256: "1".repeat(64),
    cliOutputSha256: "2".repeat(64),
    boundaryPreflightSha256: "3".repeat(64),
    boundaryPostflightSha256: "4".repeat(64),
    collateralSnapshotSha256s: { before: "5".repeat(64), after: "5".repeat(64) },
    replicaCounts: { before: 1, after: 1 },
    legacyReplicaCounts: {
      before: null,
      immediatelyBeforeWrite: 1,
      after: 0,
    },
    configuredTopology: {
      authoritativeSource: "environment.config(decryptVariables:false)",
      before: topology,
      immediatelyBeforeWrite: topology,
      after: topology,
    },
    runtimeAbsence: {
      required: false,
      immediatelyBeforeWrite: null,
      postflight: null,
    },
    runtimeResponseSha256s: {
      health: "6".repeat(64),
      startup: "7".repeat(64),
      ready: "8".repeat(64),
    },
    workerFencePrerequisite: {
      runId: "7000",
      verificationSha256: "9".repeat(64),
      bindingSha256: "a".repeat(64),
      terminalSha256: "b".repeat(64),
      deploymentIdSha256: input.previousDeploymentIdSha256,
    },
    checks: {
      policyExact: true,
      githubMainExact: true,
      sourceAuthorityExact: true,
      cliExact: true,
      writeTokenScopeExact: true,
      costPolicyExact: true,
      prerequisiteExact: true,
      workerFencePrerequisiteExact: true,
      workerFenceDeploymentContinuityExact: true,
      boundaryPreflightExact: true,
      targetPreflightExact: true,
      configuredTopologyExact: true,
      immediatePrewriteExact: true,
      fencedRuntimeAbsentBeforeWrite: true,
      fencedRuntimeAbsentPostflight: true,
      gitAutodeployAbsent: true,
      collateralInventoryExact: true,
      durableIntentExact: true,
      sourceReasserted: true,
      writeAttemptedAtMostOnce: true,
      targetPostflightAttempted: true,
      targetPostflightExact: true,
      reconciliationCompleted: true,
      topologyPreserved: true,
      deploymentExact: true,
      runtimeHealthExact: true,
      runtimeStartupExact: true,
      runtimeReadinessExact: true,
      collateralStateUnchanged: true,
      boundaryPostflightExact: true,
      terminalEvidenceExact: true,
    },
  };
}
