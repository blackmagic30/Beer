import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  runStagingWorkerBootstrapPrerequisiteVerifier,
  STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA,
  STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
  stagingWorkerBootstrapPrerequisiteInternals,
} from "../scripts/verify-permanent-staging-worker-bootstrap-prerequisites.js";
import {
  runPermanentStagingActivationReconciliationProbe,
} from "../scripts/probe-permanent-staging-automatic-maintenance-activation-reconciliation.js";
import { canonicalJson as canonicalVenueJson } from
  "../scripts/import-melbourne-venues.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";

const CANDIDATE = "a".repeat(40);
const OLD_SOURCE = "b".repeat(40);
const COLD_SOURCE = "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba";
const REVIEWED_HEAD = "c".repeat(40);
const TREE = "d".repeat(40);
const CURRENT_RUN = "9000";
const PREPARE_RUN = "1000";
const QUIESCE_RUN = "2000";
const FENCED_DEPLOYMENT_RUN = "3000";
const VENUE_DIRECTORY_RUN = "3500";
const POLICY_SHA =
  "3178685f32c9d49e359d089d5afd7c2d8c62860899a0cc70b25760155c8d7236";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const PREPARE_FILE =
  "/private/prepare/automatic-maintenance-worker-fence-terminal.json";
const QUIESCE_FILE = "/private/quiesce/quiesce-staging-zero-receipt.json";
const QUIESCE_VERIFICATION_FILE =
  "/private/quiesce/prerequisites-verification.json";
const FENCED_DEPLOYMENT_FILE =
  "/private/fenced/deployment-receipt.json";
const VENUE_DIRECTORY_FILE =
  "/private/venue-directory/venue-directory-terminal.json";
const ACTIVATE_FILE =
  "/private/activate/automatic-maintenance-worker-fence-terminal.json";
const ACTIVATE_VERIFICATION_FILE =
  "/private/activate/prerequisites-verification.json";
const COLD_PREPARE_FILE = "/private/cold/cold-prepare-terminal.json";
const COLD_QUIESCE_FILE = "/private/cold/cold-quiesce-receipt.json";
const COLD_QUIESCE_VERIFICATION_FILE =
  "/private/cold/prerequisites-verification.json";
const RESTORE_FILE = "/private/restore/bootstrap-staging-one-receipt.json";
const RESTORE_VERIFICATION_FILE =
  "/private/restore/prerequisites-verification.json";
const ACTIVE_DEPLOYMENT_FILE = "/private/active/deployment-receipt.json";
const OUTPUT_FILE = "/private/output/prerequisites-verification.json";
const MAXIMUM_EVIDENCE_BYTES = 1024 * 1024;
const MAXIMUM_VENUE_EVIDENCE_BYTES = 32 * 1024 * 1024;

const WORKER_CHECKS = {
  policyExact: true,
  githubAuthorityExact: true,
  tokenScopesExact: true,
  boundaryPreflightExact: true,
  targetPreflightExact: true,
  operationPreflightExact: true,
  durableIntentExact: true,
  writeAttemptedAtMostOnce: true,
  atomicVariablesExact: true,
  acknowledgementExact: true,
  postflightAttempted: true,
  targetPostflightExact: true,
  postflightDeploymentExact: true,
  runtimeRoutesPolledExact: true,
  runtimeMaintenanceStateExact: true,
  boundaryPostflightExact: true,
  noOtherProviderChanges: true,
  terminalEvidenceExact: true,
};

const SCALE_CHECKS = {
  policyExact: true,
  githubAuthorityExact: true,
  tokenScopesExact: true,
  cliExact: true,
  boundaryPreflightExact: true,
  targetPreflightExact: true,
  productionActivationPrerequisiteExact: true,
  productionActivationDeploymentContinuityExact: true,
  runtimePreflightExact: true,
  durableIntentExact: true,
  repositoryPrewriteReasserted: true,
  writeAttemptedAtMostOnce: true,
  acknowledgementExact: true,
  postflightAttempted: true,
  targetPostflightExact: true,
  runtimePostflightExact: true,
  candidateUnchanged: true,
  deploymentUnchanged: true,
  boundaryPostflightExact: true,
  terminalEvidenceExact: true,
  finalReceiptEvidenceExact: true,
};

const DEPLOYMENT_CHECKS = {
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
};

const VERIFICATION_CHECKS = {
  policiesExact: true,
  currentMainExact: true,
  reviewedCandidateExact: true,
  consumerRunAuthorityExact: true,
  prerequisiteRunsExact: true,
  artifactNamesAndDigestsExact: true,
  receiptSchemasAndBindingsExact: true,
  strictChronologyExact: true,
  noLaterMatchingRunsExact: true,
  evidenceSecretFreeExact: true,
};

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function prepareReceipt(): string {
  const binding = {
    policySha256: POLICY_SHA,
    candidateSha: CANDIDATE,
    target: "permanent-staging",
    operation: "prepare",
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    configuredVariables: {
      PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "false",
      PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
    },
    skipDeploys: true,
  };
  const deployment = sha("legacy-deployment");
  const topology = sha("legacy-topology");
  const collateral = sha("legacy-collateral");
  return canonical({
    schemaVersion: "pintpath-automatic-maintenance-worker-fence-terminal/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    binding,
    bindingSha256: sha(canonical(binding)),
    outcome: "prepared",
    attempts: 1,
    retryAllowed: false,
    failureCode: null,
    authoritySha256: sha("authority"),
    intentSha256: sha("intent"),
    providerEvidence: {
      graphqlOperation: "variableCollectionUpsert",
      mutationCallCount: 1,
      acknowledgementExact: true,
      providerBeforeSha256: sha("before"),
      providerAfterSha256: sha("after"),
      deploymentBeforeIdSha256: deployment,
      deploymentAfterIdSha256: deployment,
      sourceBeforeSha: OLD_SOURCE,
      sourceAfterSha: OLD_SOURCE,
      sourcePreservedExact: true,
      deploymentIdChanged: false,
      topologyBeforeSha256: topology,
      topologyAfterSha256: topology,
      collateralVariablesBeforeSha256: collateral,
      collateralVariablesAfterSha256: collateral,
    },
    runtimeEvidence: {
      required: false,
      observed: false,
      pollRounds: 0,
      expectedSourceSha: null,
      expectedAutomaticMaintenance: null,
      deploymentIdSha256: null,
      responseSha256s: {
        "/health": null,
        "/startup": null,
        "/ready": null,
      },
    },
    mutationBoundaryEvidence: {
      preflightReceiptSha256: sha("boundary-before"),
      postflightReceiptSha256: sha("boundary-after"),
    },
    checks: WORKER_CHECKS,
    stagingBootstrapVerification: {
      preparedReceiptExact: true,
      sufficientWithoutQuiescenceProof: false,
      nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
      legacySourceRuntimeFenceClaimed: false,
    },
    productionDeploymentVerification: {
      requiredReceiptFilename:
        "automatic-maintenance-worker-fence-terminal.json",
      eligible: false,
      exactCandidateTargetOperationBindingRequired: true,
      bindingSha256Required: true,
      oldRuntimeSafetyPrerequisite: null,
      oldRuntimeSafetyVerifiedByThisOperation: false,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function activateReceipt(): string {
  const binding = {
    policySha256: POLICY_SHA,
    candidateSha: CANDIDATE,
    target: "permanent-staging",
    operation: "activate",
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    configuredVariables: {
      PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "true",
      PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
    },
    skipDeploys: false,
  };
  const deploymentBefore = sha("candidate-before-activation");
  const deploymentAfter = sha("candidate-after-activation");
  const collateral = sha("activation-collateral");
  return canonical({
    schemaVersion: "pintpath-automatic-maintenance-worker-fence-terminal/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    binding,
    bindingSha256: sha(canonical(binding)),
    outcome: "activated",
    attempts: 1,
    retryAllowed: false,
    failureCode: null,
    authoritySha256: sha("activation-authority"),
    intentSha256: sha("activation-intent"),
    providerEvidence: {
      graphqlOperation: "variableCollectionUpsert",
      mutationCallCount: 1,
      acknowledgementExact: true,
      providerBeforeSha256: sha("activation-before"),
      providerAfterSha256: sha("activation-after"),
      deploymentBeforeIdSha256: deploymentBefore,
      deploymentAfterIdSha256: deploymentAfter,
      sourceBeforeSha: CANDIDATE,
      sourceAfterSha: CANDIDATE,
      sourcePreservedExact: true,
      deploymentIdChanged: true,
      topologyBeforeSha256: sha("activation-topology-before"),
      topologyAfterSha256: sha("activation-topology-after"),
      collateralVariablesBeforeSha256: collateral,
      collateralVariablesAfterSha256: collateral,
    },
    runtimeEvidence: {
      required: true,
      observed: true,
      pollRounds: 2,
      expectedSourceSha: CANDIDATE,
      expectedAutomaticMaintenance: { enabled: true, candidateBound: true },
      deploymentIdSha256: deploymentAfter,
      responseSha256s: {
        "/health": sha("activation-health"),
        "/startup": sha("activation-startup"),
        "/ready": sha("activation-ready"),
      },
    },
    mutationBoundaryEvidence: {
      preflightReceiptSha256: sha("activation-boundary-before"),
      postflightReceiptSha256: sha("activation-boundary-after"),
    },
    checks: WORKER_CHECKS,
    stagingBootstrapVerification: {
      preparedReceiptExact: false,
      sufficientWithoutQuiescenceProof: false,
      nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
      legacySourceRuntimeFenceClaimed: false,
    },
    productionDeploymentVerification: {
      requiredReceiptFilename:
        "automatic-maintenance-worker-fence-terminal.json",
      eligible: false,
      exactCandidateTargetOperationBindingRequired: true,
      bindingSha256Required: true,
      oldRuntimeSafetyPrerequisite: null,
      oldRuntimeSafetyVerifiedByThisOperation: false,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function scaleReceipt(): string {
  return canonical({
    schemaVersion: "pintpath-permanent-staging-scale-operation/v2",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    direction: "quiesce-staging-zero",
    outcome: "scaled",
    candidateSha: CANDIDATE,
    startedAt: "2026-08-21T01:03:10.000Z",
    completedAt: "2026-08-21T01:03:50.000Z",
    desiredReplicas: 0,
    deploymentIdSha256: sha("legacy-deployment"),
    attempts: 1,
    retryAllowed: false,
    intentSha256: sha("scale-intent"),
    terminalEvidenceSha256: sha("scale-terminal"),
    commandStdoutSha256: sha("scale-stdout"),
    commandStderrSha256: sha("scale-stderr"),
    productionActivationPrerequisite: null,
    checks: SCALE_CHECKS,
  });
}

function fencedDeploymentReceipt(): string {
  const collateral = sha("deployment-collateral");
  return canonical({
    schemaVersion: "pintpath-railway-application-deployment-executor/v5",
    operation: "pintpath-railway-application-source-upload",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    target: "permanent-staging",
    outcome: "deployed",
    failureCode: null,
    candidateSha: CANDIDATE,
    startedAt: "2026-08-21T01:05:10.000Z",
    completedAt: "2026-08-21T01:05:50.000Z",
    writeAttempts: 1,
    acknowledgement: "received",
    previousDeploymentIdSha256: sha("legacy-deployment"),
    deploymentIdSha256: sha("candidate-deployment"),
    intentSha256: sha("deployment-intent"),
    cliOutputSha256: sha("deployment-cli"),
    boundaryPreflightSha256: sha("deployment-boundary-before"),
    boundaryPostflightSha256: sha("deployment-boundary-after"),
    collateralSnapshotSha256s: { before: collateral, after: collateral },
    replicaCounts: { before: 0, after: 0 },
    runtimeResponseSha256s: { health: null, startup: null, ready: null },
    workerFencePrerequisite: null,
    checks: DEPLOYMENT_CHECKS,
  });
}

const VENUE_DATABASE_CONTRACT = {
  migrationVersion: "20260901032339",
  migrationPath:
    "supabase/migrations/20260901032339_validate_external_venue_directory_constraints.sql",
  migrationSha256:
    "5068c2a678813e57fde83b29d3cb5e438ce9070705f246827b7ee8e2a70ee96c",
  migrationBytes: 161,
  validatedConstraints: [
    "venues_australian_postcode_check",
    "venues_business_status_check",
  ],
} as const;
const VENUE_FIRST_RUN_MIGRATION_FILENAMES = [
  "20260901032339_validate_external_venue_directory_constraints.sql",
  "20260901122942_remove_redundant_accounts_public_account_index.sql",
] as const;

function venueCanonical(value: unknown): string {
  return `${canonicalVenueJson(value)}\n`;
}

function venueLocalMigrationVersions(): string[] {
  return fs.readdirSync("supabase/migrations")
    .filter((name) => /^[0-9]+_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => name.slice(0, name.indexOf("_")));
}

function venueConstraints(validated: boolean) {
  return [{
    name: "venues_australian_postcode_check",
    type: "c",
    validated,
    definition: "CHECK ((postcode ~ '^[0-9]{4}$'::text))",
  }, {
    name: "venues_business_status_check",
    type: "c",
    validated,
    definition:
      "CHECK ((business_status = ANY (ARRAY['OPERATIONAL', 'CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY', 'FUTURE_OPENING'])))",
  }];
}

function venueTargetLedger() {
  return {
    version: "20260901032339",
    name: "validate_external_venue_directory_constraints",
    statements: [
      "alter table public.venues\n  validate constraint venues_business_status_check",
      "alter table public.venues\n  validate constraint venues_australian_postcode_check",
    ],
  };
}

function venueDryRun(pendingFilenames: readonly string[]) {
  return {
    pendingFilenames,
    stdoutSha256: sha(`dry-run-stdout-${pendingFilenames.join(",")}`),
    stderrSha256: sha(`dry-run-stderr-${pendingFilenames.join(",")}`),
  };
}

function venueDirectoryEvidence(
  mode: "first_run" | "steady_state" = "steady_state",
  venueNameBytes = 0,
): Map<string, string> {
  const local = venueLocalMigrationVersions();
  const before = mode === "first_run"
    ? local.slice(0, -VENUE_FIRST_RUN_MIGRATION_FILENAMES.length) : local;
  const pending = mode === "first_run"
    ? VENUE_FIRST_RUN_MIGRATION_FILENAMES
    : [];
  const transitions = venueNameBytes === 0 ? [] : [{
    ordinal: 1,
    operation: "insert",
    identity: {
      venueId: null,
      googlePlaceId: "large-venue-place-id",
      normalizedNameAddressSha256: sha("large-venue-name-address"),
    },
    expectedBefore: null,
    desiredAfter: {
      google_place_id: "large-venue-place-id",
      name: "v".repeat(venueNameBytes),
      address: "1 Test Street",
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
      phone: "+61390000000",
      website: "https://example.test/large-venue",
      latitude: -37.8136,
      longitude: 144.9631,
      business_status: "OPERATIONAL",
      last_checked_at: "2026-08-21T01:06:14.000Z",
      directory_eligible: true,
      source: "google_places",
    },
  }];
  const transitionCount = transitions.length;
  const planWithoutSha = {
    schemaVersion: "pintpath-permanent-staging-venue-import-plan/v1",
    candidateSha: CANDIDATE,
    supabaseProjectRef: "bbfibbadwjxzrcdncavy",
    databaseContract: VENUE_DATABASE_CONTRACT,
    operation: "directory-discovery-and-status-refresh",
    startedAt: "2026-08-21T01:06:12.000Z",
    completedAt: "2026-08-21T01:06:15.000Z",
    checkedAt: "2026-08-21T01:06:14.000Z",
    inputSnapshot: {
      rowCount: transitionCount === 0 ? 2 : 0,
      sha256: sha("venue-directory-input"),
    },
    collection: {
      discoveryCellAttemptedCount: 0,
      discoveryCellSuccessfulCount: 0,
      discoveryCellFailureCount: 0,
      discoveryQueryAttemptedCount: 0,
      discoveryQuerySuccessfulCount: 0,
      discoveryQueryFailureCount: 0,
      existingPlaceIdAttemptedCount: 0,
      existingPlaceIdSuccessfulCount: 0,
      existingPlaceIdFailureCount: 0,
      existingPlaceIdSatisfiedByDiscoveryCount: 0,
      existingRowMissingPlaceIdCount: 0,
      quarantinedVenueCount: 0,
    },
    projected: {
      insertCount: transitionCount,
      updateCount: 0,
      exclusionCount: 0,
      totalTransitionCount: transitionCount,
    },
    transitions,
  };
  const planSha256 = sha(canonicalVenueJson(planWithoutSha));
  const planSource = venueCanonical({ ...planWithoutSha, planSha256 });
  const importTerminalSource = venueCanonical({
    schemaVersion: "pintpath-permanent-staging-venue-import-terminal/v1",
    status: "succeeded",
    outcome: "applied",
    candidateSha: CANDIDATE,
    supabaseProjectRef: "bbfibbadwjxzrcdncavy",
    databaseContract: VENUE_DATABASE_CONTRACT,
    planSha256,
    startedAt: "2026-08-21T01:06:20.000Z",
    completedAt: "2026-08-21T01:06:30.000Z",
    preflightSnapshot: {
      rowCount: transitionCount === 0 ? 2 : 0,
      sha256: sha("venue-directory-input"),
    },
    finalSnapshot: {
      rowCount: transitionCount === 0 ? 2 : transitionCount,
      sha256: sha("venue-directory-final"),
    },
    attemptedWriteCount: transitionCount,
    successfulWriteCount: transitionCount,
    insertedCount: transitionCount,
    updatedCount: 0,
    excludedCount: 0,
    partialWrite: false,
    samePlanRetryAllowed: false,
    failure: null,
  });
  const commonObservation = {
    candidateSha: CANDIDATE,
    supabaseProjectRef: "bbfibbadwjxzrcdncavy",
    databaseContract: VENUE_DATABASE_CONTRACT,
    migrationMode: mode,
    localMigrationVersions: local,
    remoteMigrationVersions: before,
    constraints: venueConstraints(mode === "steady_state"),
    violationCounts: { businessStatus: 0, postcode: 0 },
    targetLedger: mode === "steady_state" ? venueTargetLedger() : null,
    dryRun: venueDryRun(pending),
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  const preflightSource = venueCanonical({
    schemaVersion: "pintpath-permanent-staging-venue-constraint-preflight/v1",
    ...commonObservation,
    preflightVerifier: {
      path: "scripts/ci/supabase-venue-directory-preflight-verify.sql",
      sha256:
        "9ae8804c03f7f515beaa80b6fb99ae886f200712482c21ae5eae11f9709b8c6a",
      bytes: 6189,
      passed: true,
    },
    checkedAt: "2026-08-21T01:06:11.000Z",
    checks: {
      structureExact: true,
      zeroViolations: true,
      constraintLedgerStateExact: true,
      migrationFileExact: true,
      pendingSetExact: true,
      remoteLedgerExact: true,
    },
  });
  const prewriteSource = venueCanonical({
    schemaVersion: "pintpath-permanent-staging-venue-migration-prewrite/v1",
    ...commonObservation,
    planSha256,
    checkedAt: "2026-08-21T01:06:16.000Z",
    checks: {
      planSealed: true,
      repositoryMainExact: true,
      stateUnchanged: true,
      migrationFileExact: true,
      pendingSetExact: true,
      remoteLedgerExact: true,
    },
  });
  const migrationApplySource = venueCanonical({
    schemaVersion: "pintpath-permanent-staging-venue-migration-apply/v1",
    candidateSha: CANDIDATE,
    supabaseProjectRef: "bbfibbadwjxzrcdncavy",
    databaseContract: VENUE_DATABASE_CONTRACT,
    migrationMode: mode,
    planSha256,
    startedAt: "2026-08-21T01:06:17.000Z",
    completedAt: "2026-08-21T01:06:18.000Z",
    writeAttempts: mode === "first_run" ? 1 : 0,
    acknowledgement: mode === "first_run" ? "received" : "not_attempted",
    exitCode: mode === "first_run" ? 0 : null,
    command: [
      "supabase", "db", "push", "--linked", "--password", "<redacted>", "--yes",
    ],
    cliStdoutSha256: mode === "first_run" ? sha("migration-stdout") : null,
    cliStderrSha256: mode === "first_run" ? sha("migration-stderr") : null,
    samePlanRetryAllowed: false,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
  const postflightSource = venueCanonical({
    schemaVersion: "pintpath-permanent-staging-venue-constraint-postflight/v1",
    candidateSha: CANDIDATE,
    supabaseProjectRef: "bbfibbadwjxzrcdncavy",
    databaseContract: VENUE_DATABASE_CONTRACT,
    migrationMode: mode,
    planSha256,
    migrationApplySha256: sha(migrationApplySource),
    localMigrationVersions: local,
    remoteMigrationVersions: local,
    constraints: venueConstraints(true),
    violationCounts: { businessStatus: 0, postcode: 0 },
    targetLedger: venueTargetLedger(),
    dryRun: venueDryRun([]),
    strictVerifier: {
      path: "scripts/ci/supabase-venue-directory-schema-verify.sql",
      sha256:
        "e2a6d9cd5a5dcbc14c6932d2ac4c44f81814249c0338e9eb54e72a1a985a6130",
      bytes: 3956,
      passed: true,
    },
    checkedAt: "2026-08-21T01:06:19.000Z",
    checks: {
      migrationLedgerRecorded: true,
      noPendingMigrations: true,
      constraintsValidated: true,
      strictSchemaExact: true,
      migrationFileExact: true,
      remoteLedgerExact: true,
      zeroViolations: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
  const boundarySource = venueCanonical({
    schemaVersion: "pintpath-permanent-staging-venue-directory-terminal/v1",
    status: "succeeded",
    outcome: "applied_and_validated",
    candidateSha: CANDIDATE,
    supabaseProjectRef: "bbfibbadwjxzrcdncavy",
    databaseContract: VENUE_DATABASE_CONTRACT,
    migrationMode: mode,
    planSha256,
    importTerminalSha256: sha(importTerminalSource),
    constraintPreflightSha256: sha(preflightSource),
    migrationPrewriteSha256: sha(prewriteSource),
    migrationApplySha256: sha(migrationApplySource),
    constraintPostflightSha256: sha(postflightSource),
    startedAt: planWithoutSha.startedAt,
    completedAt: "2026-08-21T01:06:35.000Z",
    migrationWriteAttempts: mode === "first_run" ? 1 : 0,
    samePlanRetryAllowed: false,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    checks: {
      importApplied: true,
      preflightStructureExact: true,
      preflightZeroViolations: true,
      preflightConstraintLedgerStateExact: true,
      pendingSetPreflightExact: true,
      pendingSetPrewriteExact: true,
      migrationMutationExact: true,
      migrationLedgerRecorded: true,
      noPendingMigrationsPostflight: true,
      constraintsValidatedPostflight: true,
    },
    failure: null,
  });
  const root = path.dirname(VENUE_DIRECTORY_FILE);
  return new Map([
    [path.join(root, "venue-directory-plan.json"), planSource],
    [path.join(root, "venue-import-terminal.json"), importTerminalSource],
    [path.join(root, "constraint-preflight.json"), preflightSource],
    [path.join(root, "migration-prewrite.json"), prewriteSource],
    [path.join(root, "migration-apply.json"), migrationApplySource],
    [path.join(root, "constraint-postflight.json"), postflightSource],
    [VENUE_DIRECTORY_FILE, boundarySource],
  ]);
}

function activeDeploymentReceipt(): string {
  const value = JSON.parse(fencedDeploymentReceipt());
  value.startedAt = "2026-08-21T01:11:10.000Z";
  value.completedAt = "2026-08-21T01:11:50.000Z";
  value.replicaCounts = { before: 1, after: 1 };
  value.runtimeResponseSha256s = {
    health: sha("active-health"),
    startup: sha("active-startup"),
    ready: sha("active-ready"),
  };
  return canonical(value);
}

function reviewedCandidateFixture() {
  return {
    number: 51,
    reviewedHeadSha: REVIEWED_HEAD,
    mergeCommitSha: CANDIDATE,
    treeSha: TREE,
    mergedAt: "2026-08-20T23:00:00.000Z",
    authorId: 1,
    mergedById: 2,
  };
}

function prerequisiteEvidenceFixture(input: {
  readonly kind:
    | "prepare"
    | "quiesce"
    | "fenced-deployment"
    | "venue-directory"
    | "restore";
  readonly workflowPath: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly artifactName: string;
  readonly artifactId: string;
  readonly filename: string;
  readonly schemaVersion: string;
  readonly outcome: string;
  readonly sourceSha: string;
  readonly deploymentIdSha256: string;
  readonly replicasBefore: number | null;
  readonly replicasAfter: number | null;
  readonly prerequisiteVerificationSha256: string | null;
}) {
  return {
    kind: input.kind,
    workflowPath: input.workflowPath,
    runId: input.runId,
    runAttempt: 1,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    artifactName: input.artifactName,
    artifactId: input.artifactId,
    artifactDigest: `sha256:${sha(`${input.artifactName}-archive`)}`,
    artifactSizeBytes: 2048,
    receipt: {
      filename: input.filename,
      schemaVersion: input.schemaVersion,
      sha256: sha(`receipt-${input.kind}-${input.runId}`),
      outcome: input.outcome,
      candidateSha: CANDIDATE,
      sourceSha: input.sourceSha,
      deploymentIdSha256: input.deploymentIdSha256,
      replicasBefore: input.replicasBefore,
      replicasAfter: input.replicasAfter,
    },
    prerequisiteVerificationSha256:
      input.prerequisiteVerificationSha256,
  };
}

function priorQuiesceVerification(): string {
  return canonical({
    schemaVersion: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA,
    policySha256: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    operation: "quiesce",
    bootstrapPath: "healthy-legacy",
    candidateSha: CANDIDATE,
    expectedDeploymentSha: OLD_SOURCE,
    repository: "blackmagic30/Beer",
    reviewedPullRequest: reviewedCandidateFixture(),
    consumer: {
      workflowPath:
        ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
      githubEnvironment: "permanent-staging-scale-evidence",
      runId: QUIESCE_RUN,
      runAttempt: 1,
      startedAt: "2026-08-21T01:03:00.000Z",
    },
    prerequisites: [prerequisiteEvidenceFixture({
      kind: "prepare",
      workflowPath:
        ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
      runId: PREPARE_RUN,
      startedAt: "2026-08-21T01:01:00.000Z",
      completedAt: "2026-08-21T01:02:00.000Z",
      artifactName:
        `pintpath-automatic-maintenance-worker-fence-permanent-staging-prepare-${CANDIDATE}`,
      artifactId: "7001",
      filename: "automatic-maintenance-worker-fence-terminal.json",
      schemaVersion: "pintpath-automatic-maintenance-worker-fence-terminal/v1",
      outcome: "prepared",
      sourceSha: OLD_SOURCE,
      deploymentIdSha256: sha("legacy-deployment"),
      replicasBefore: 1,
      replicasAfter: 1,
      prerequisiteVerificationSha256: null,
    })],
    verifiedAt: "2026-08-21T01:03:05.000Z",
    expiresAt: "2026-08-21T01:18:05.000Z",
    checks: VERIFICATION_CHECKS,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function priorActivationVerification(
  operation: "activate" | "reconcile-activate" = "activate",
  runId = "5000",
): string {
  const kinds = [
    ["prepare", ".github/workflows/configure-automatic-maintenance-worker-fence.yml"],
    ["quiesce", ".github/workflows/bootstrap-permanent-staging-worker-fence.yml"],
    ["fenced-deployment", ".github/workflows/deploy-permanent-staging.yml"],
    ["venue-directory", ".github/workflows/permanent-staging-venue-directory.yml"],
    ["restore", ".github/workflows/bootstrap-permanent-staging-worker-fence.yml"],
  ] as const;
  const chronology = [
    ["2026-08-21T01:01:00.000Z", "2026-08-21T01:02:00.000Z"],
    ["2026-08-21T01:03:00.000Z", "2026-08-21T01:04:00.000Z"],
    ["2026-08-21T01:05:00.000Z", "2026-08-21T01:06:00.000Z"],
    ["2026-08-21T01:06:10.000Z", "2026-08-21T01:06:40.000Z"],
    ["2026-08-21T01:07:00.000Z", "2026-08-21T01:08:00.000Z"],
  ] as const;
  return canonical({
    schemaVersion: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA,
    policySha256: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    operation,
    bootstrapPath: "healthy-legacy",
    candidateSha: CANDIDATE,
    expectedDeploymentSha: null,
    repository: "blackmagic30/Beer",
    reviewedPullRequest: reviewedCandidateFixture(),
    consumer: {
      workflowPath:
        ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
      githubEnvironment: "permanent-staging-provider-mutation",
      runId,
      runAttempt: 1,
      startedAt: "2026-08-21T01:09:00.000Z",
    },
    prerequisites: kinds.map(([kind, workflowPath], index) => {
      const runId = String(index + 1_000);
      const artifactName = kind === "prepare"
        ? `pintpath-automatic-maintenance-worker-fence-permanent-staging-prepare-${CANDIDATE}`
        : kind === "quiesce"
          ? `pintpath-permanent-staging-worker-bootstrap-quiesce-${CANDIDATE}`
          : kind === "fenced-deployment"
            ? `pintpath-permanent-staging-fenced-deployment-${CANDIDATE}`
            : kind === "venue-directory"
              ? `pintpath-permanent-staging-venue-directory-${CANDIDATE}`
              : `pintpath-permanent-staging-worker-bootstrap-restore-${CANDIDATE}`;
      const scale = kind === "quiesce" || kind === "restore";
      return prerequisiteEvidenceFixture({
        kind,
        workflowPath,
        runId,
        startedAt: chronology[index]![0],
        completedAt: chronology[index]![1],
        artifactName,
        artifactId: String(7_001 + index),
        filename: kind === "prepare"
          ? "automatic-maintenance-worker-fence-terminal.json"
          : kind === "quiesce"
            ? "quiesce-staging-zero-receipt.json"
            : kind === "fenced-deployment"
              ? "deployment-receipt.json"
              : kind === "venue-directory"
                ? "venue-directory-terminal.json"
                : "bootstrap-staging-one-receipt.json",
        schemaVersion: kind === "prepare"
          ? "pintpath-automatic-maintenance-worker-fence-terminal/v1"
          : scale
            ? "pintpath-permanent-staging-scale-operation/v2"
            : kind === "venue-directory"
              ? "pintpath-permanent-staging-venue-directory-terminal/v1"
              : "pintpath-railway-application-deployment-executor/v5",
        outcome: kind === "prepare"
          ? "prepared"
          : kind === "fenced-deployment"
            ? "deployed"
            : kind === "venue-directory"
              ? "applied_and_validated"
              : "scaled",
        sourceSha: kind === "prepare" || kind === "quiesce"
          ? OLD_SOURCE
          : CANDIDATE,
        deploymentIdSha256: kind === "venue-directory"
          ? sha("venue-directory-plan")
          : sha(`activation-prerequisite-deployment-${kind}`),
        replicasBefore: kind === "quiesce"
          ? 1
          : kind === "fenced-deployment" || kind === "restore"
            ? 0
            : kind === "venue-directory"
              ? null
              : 1,
        replicasAfter: kind === "quiesce" || kind === "fenced-deployment"
          ? 0
          : kind === "venue-directory"
            ? null
            : 1,
        prerequisiteVerificationSha256: scale
          ? sha(`prior-verification-${kind}`)
          : null,
      });
    }),
    verifiedAt: "2026-08-21T01:09:05.000Z",
    expiresAt: "2026-08-21T01:24:05.000Z",
    checks: VERIFICATION_CHECKS,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function activationReconcileAuthority(): string {
  return `${JSON.stringify({
    command: "verify-github-reviewed-candidate-authority",
    ok: true,
    schemaVersion: 1,
    kind: "pintpath-github-reviewed-candidate-authority",
    repository: "blackmagic30/Beer",
    candidateSha: CANDIDATE,
    reviewedPrHeadSha: REVIEWED_HEAD,
    reviewedPullRequestNumber: 51,
    operation: "staging-worker-fence-reconcile-activate",
    workflowPath:
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    workflowRunId: CURRENT_RUN,
    workflowRunAttempt: 1,
    priorAmbiguousStagingActivateRunId: "4999",
    exactPriorStagingActivateCandidateRunBound: true,
    secondStagingActivateVariableWritePreventedExact: true,
    runnerLossRecoveryOriginalRunCompletedAt: "2026-08-21T01:08:30.000Z",
    runnerLossRecoveryGraceHours: 24,
    runnerLossRecoveryWithinGraceExact: true,
    reviewedAuthorityExact: true,
    freshDispatchWriteGuardExact: true,
  })}\n`;
}

function activatedProviderSnapshot() {
  const deploymentId = "77777777-7777-4777-8777-777777777777";
  const snapshotId = "88888888-8888-4888-8888-888888888888";
  return {
    environmentId: ENVIRONMENT_ID,
    serviceInstanceId: "99999999-9999-4999-8999-999999999999",
    serviceId: SERVICE_ID,
    numReplicas: 1,
    rows: [
      {
        id: "row-unrelated",
        name: "UNRELATED_FIXTURE",
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        isSealed: false,
        references: [],
      },
      {
        id: "row-enabled",
        name: "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED",
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        isSealed: false,
        references: [],
      },
      {
        id: "row-candidate",
        name: "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        isSealed: false,
        references: [],
      },
    ],
    domains: [{
      kind: "service" as const,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      domain: "beer-staging.up.railway.app",
      targetPort: 8_080,
    }],
    latestDeployment: {
      id: deploymentId,
      status: "SUCCESS",
      deploymentStopped: false,
      snapshotId,
    },
    activeDeployments: [{
      id: deploymentId,
      status: "SUCCESS",
      deploymentStopped: false,
    }],
    deployment: {
      id: deploymentId,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      snapshotId,
      commitHash: CANDIDATE,
      imageDigest: `sha256:${"e".repeat(64)}`,
      patchId: null,
    },
  };
}

function activatedRuntimeProof() {
  const deploymentId = activatedProviderSnapshot().deployment.id;
  return {
    required: true as const,
    observed: true as const,
    pollRounds: 1,
    expectedSourceSha: CANDIDATE,
    expectedAutomaticMaintenance: {
      enabled: true as const,
      candidateBound: true as const,
    },
    deploymentIdSha256: railwayDeploymentIdentityIdSha256(
      "deployment",
      deploymentId,
    )!,
    responseSha256s: {
      "/health": sha("health"),
      "/startup": sha("startup"),
      "/ready": sha("ready"),
    },
  };
}

interface RunInput {
  readonly id: string;
  readonly workflow: string;
  readonly name: string;
  readonly title: string;
  readonly created: string;
  readonly started: string;
  readonly completed: string;
  readonly current?: boolean;
}

function githubRun(input: RunInput): Record<string, unknown> {
  return {
    id: Number(input.id),
    repository: { full_name: "blackmagic30/Beer" },
    head_repository: { full_name: "blackmagic30/Beer" },
    name: input.name,
    path: input.workflow,
    display_title: input.title,
    event: "workflow_dispatch",
    head_sha: CANDIDATE,
    head_branch: "main",
    run_attempt: 1,
    status: input.current ? "in_progress" : "completed",
    conclusion: input.current ? null : "success",
    created_at: input.created,
    run_started_at: input.started,
    updated_at: input.completed,
  };
}

function artifact(name: string, runId: string, id: string) {
  return {
    id: Number(id),
    name,
    expired: false,
    digest: `sha256:${sha(`${name}-archive`)}`,
    size_in_bytes: 2048,
    archive_download_url:
      `https://api.github.com/repos/blackmagic30/Beer/actions/artifacts/${id}/zip`,
    workflow_run: { id: Number(runId), head_sha: CANDIDATE },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function harness(operation: "quiesce" | "restore" | "reconcile-restore", options: {
  readonly laterPrepare?: boolean;
  readonly artifactDigestInvalid?: boolean;
  readonly venueRunWrong?: boolean;
  readonly venueChronologyInvalid?: boolean;
  readonly venueReceiptTampered?: boolean;
  readonly venueCompanionMissing?: boolean;
  readonly venueStaticOnly?: boolean;
  readonly venueInternalChronologyInvalid?: boolean;
  readonly venueMigrationMode?: "first_run" | "steady_state";
  readonly venueNameBytes?: number;
} = {}) {
  const bootstrapWorkflow =
    ".github/workflows/bootstrap-permanent-staging-worker-fence.yml";
  const workerWorkflow =
    ".github/workflows/configure-automatic-maintenance-worker-fence.yml";
  const deploymentWorkflow = ".github/workflows/deploy-permanent-staging.yml";
  const venueDirectoryWorkflow =
    ".github/workflows/permanent-staging-venue-directory.yml";
  const prepare = githubRun({
    id: PREPARE_RUN,
    workflow: workerWorkflow,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    title:
      `Automatic maintenance worker fence | permanent-staging | prepare | ${CANDIDATE}`,
    created: "2026-08-21T01:00:00.000Z",
    started: "2026-08-21T01:01:00.000Z",
    completed: "2026-08-21T01:02:00.000Z",
  });
  const quiesce = githubRun({
    id: QUIESCE_RUN,
    workflow: bootstrapWorkflow,
    name: "Bootstrap permanent-staging automatic-maintenance worker fence", // security-scan allow: synthetic workflow fixture
    title: `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
    created: "2026-08-21T01:02:30.000Z",
    started: "2026-08-21T01:03:00.000Z",
    completed: "2026-08-21T01:04:00.000Z",
  });
  const fencedDeployment = githubRun({
    id: FENCED_DEPLOYMENT_RUN,
    workflow: deploymentWorkflow,
    name: "Deploy Pint Path permanent staging",
    title: `Deploy permanent staging | fenced | ${CANDIDATE}`,
    created: "2026-08-21T01:04:30.000Z",
    started: "2026-08-21T01:05:00.000Z",
    completed: "2026-08-21T01:06:00.000Z",
  });
  const venueDirectory = githubRun({
    id: VENUE_DIRECTORY_RUN,
    workflow: venueDirectoryWorkflow,
    name: "Apply and prove permanent-staging venue directory",
    title: options.venueRunWrong
      ? `Wrong venue directory producer | ${CANDIDATE}`
      : `Permanent staging venue directory | apply-refresh-validate | ${CANDIDATE}`,
    created: options.venueChronologyInvalid
      ? "2026-08-21T01:05:20.000Z"
      : "2026-08-21T01:06:01.000Z",
    started: options.venueChronologyInvalid
      ? "2026-08-21T01:05:30.000Z"
      : "2026-08-21T01:06:10.000Z",
    completed: "2026-08-21T01:06:40.000Z",
  });
  const current = githubRun({
    id: CURRENT_RUN,
    workflow: bootstrapWorkflow,
    name: "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: `Permanent staging worker bootstrap | ${operation} | ${CANDIDATE}`,
    created: operation === "quiesce"
      ? "2026-08-21T01:02:30.000Z"
      : "2026-08-21T01:06:30.000Z",
    started: operation === "quiesce"
      ? "2026-08-21T01:03:00.000Z"
      : "2026-08-21T01:07:00.000Z",
    completed: operation === "quiesce"
      ? "2026-08-21T01:03:00.000Z"
      : "2026-08-21T01:07:00.000Z",
    current: true,
  });
  const prepareArtifactName =
    `pintpath-automatic-maintenance-worker-fence-permanent-staging-prepare-${CANDIDATE}`;
  const quiesceArtifactName =
    `pintpath-permanent-staging-worker-bootstrap-quiesce-${CANDIDATE}`;
  const fencedArtifactName =
    `pintpath-permanent-staging-fenced-deployment-${CANDIDATE}`;
  const venueDirectoryArtifactName =
    `pintpath-permanent-staging-venue-directory-${CANDIDATE}`;
  const laterPrepare = {
    ...prepare,
    id: 1001,
    created_at: "2026-08-21T01:02:10.000Z",
    run_started_at: "2026-08-21T01:02:15.000Z",
    updated_at: "2026-08-21T01:02:20.000Z",
  };
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (!url.startsWith("https://api.github.com/repos/blackmagic30/Beer/")) {
      throw new Error("provider_contact_forbidden");
    }
    if (url.endsWith(`/actions/runs/${CURRENT_RUN}`)) return json(current);
    if (url.endsWith(`/actions/runs/${PREPARE_RUN}`)) return json(prepare);
    if (url.endsWith(`/actions/runs/${QUIESCE_RUN}`)) return json(quiesce);
    if (url.endsWith(`/actions/runs/${FENCED_DEPLOYMENT_RUN}`)) {
      return json(fencedDeployment);
    }
    if (url.endsWith(`/actions/runs/${VENUE_DIRECTORY_RUN}`)) {
      return json(venueDirectory);
    }
    if (url.endsWith("/git/ref/heads/main")) {
      return json({ ref: "refs/heads/main", object: { type: "commit", sha: CANDIDATE } });
    }
    if (url.includes(`/commits/${CANDIDATE}/pulls?`)) {
      return json([{
        number: 51,
        state: "closed",
        merge_commit_sha: CANDIDATE,
        base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
        head: { repo: { full_name: "blackmagic30/Beer" } },
      }]);
    }
    if (url.endsWith("/pulls/51")) {
      return json({
        number: 51,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: CANDIDATE,
        base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
        head: {
          sha: REVIEWED_HEAD,
          repo: { full_name: "blackmagic30/Beer" },
        },
        user: { id: 1 },
        merged_by: { id: 2 },
        merged_at: "2026-08-20T23:00:00.000Z",
      });
    }
    if (url.endsWith(`/git/commits/${CANDIDATE}`)) {
      return json({
        sha: CANDIDATE,
        tree: { sha: TREE },
        parents: [{ sha: "e".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${REVIEWED_HEAD}`)) {
      return json({ sha: REVIEWED_HEAD, tree: { sha: TREE }, parents: [] });
    }
    if (url.includes(`/actions/runs/${PREPARE_RUN}/artifacts?`)) {
      const value = artifact(prepareArtifactName, PREPARE_RUN, "7001");
      if (options.artifactDigestInvalid) value.digest = "sha256:not-a-digest";
      return json({ total_count: 1, artifacts: [value] });
    }
    if (url.includes(`/actions/runs/${QUIESCE_RUN}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(quiesceArtifactName, QUIESCE_RUN, "7002")],
      });
    }
    if (url.includes(`/actions/runs/${FENCED_DEPLOYMENT_RUN}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(fencedArtifactName, FENCED_DEPLOYMENT_RUN, "7003")],
      });
    }
    if (url.includes(`/actions/runs/${VENUE_DIRECTORY_RUN}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(
          venueDirectoryArtifactName,
          VENUE_DIRECTORY_RUN,
          "7004",
        )],
      });
    }
    if (url.includes("/actions/workflows/configure-automatic-maintenance-worker-fence.yml/runs?")) {
      const runs = options.laterPrepare ? [prepare, laterPrepare] : [prepare];
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    if (url.includes("/actions/workflows/bootstrap-permanent-staging-worker-fence.yml/runs?")) {
      return json({ total_count: 1, workflow_runs: [quiesce] });
    }
    if (url.includes("/actions/workflows/deploy-permanent-staging.yml/runs?")) {
      return json({ total_count: 1, workflow_runs: [fencedDeployment] });
    }
    if (url.includes("/actions/workflows/permanent-staging-venue-directory.yml/runs?")) {
      return json({ total_count: 1, workflow_runs: [venueDirectory] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const venueEvidence = venueDirectoryEvidence(
    options.venueMigrationMode,
    options.venueNameBytes,
  );
  if (options.venueReceiptTampered) {
    const filename = path.join(
      path.dirname(VENUE_DIRECTORY_FILE),
      "migration-prewrite.json",
    );
    const value = JSON.parse(venueEvidence.get(filename)!);
    value.checkedAt = "2026-08-21T01:06:16.001Z";
    venueEvidence.set(filename, venueCanonical(value));
  }
  if (options.venueCompanionMissing) {
    venueEvidence.delete(path.join(
      path.dirname(VENUE_DIRECTORY_FILE),
      "constraint-postflight.json",
    ));
  }
  if (options.venueStaticOnly) {
    venueEvidence.set(
      VENUE_DIRECTORY_FILE,
      venueEvidence.get(path.join(
        path.dirname(VENUE_DIRECTORY_FILE),
        "venue-import-terminal.json",
      ))!,
    );
  }
  if (options.venueInternalChronologyInvalid) {
    const importFilename = path.join(
      path.dirname(VENUE_DIRECTORY_FILE),
      "venue-import-terminal.json",
    );
    const importValue = JSON.parse(venueEvidence.get(importFilename)!);
    importValue.startedAt = "2026-08-21T01:06:18.500Z";
    const importSource = venueCanonical(importValue);
    venueEvidence.set(importFilename, importSource);
    const boundary = JSON.parse(venueEvidence.get(VENUE_DIRECTORY_FILE)!);
    boundary.importTerminalSha256 = sha(importSource);
    venueEvidence.set(VENUE_DIRECTORY_FILE, venueCanonical(boundary));
  }
  const files = new Map<string, string>([
    [PREPARE_FILE, prepareReceipt()],
    [QUIESCE_FILE, scaleReceipt()],
    [QUIESCE_VERIFICATION_FILE, priorQuiesceVerification()],
    [FENCED_DEPLOYMENT_FILE, fencedDeploymentReceipt()],
    ...venueEvidence,
  ]);
  const argv = [
    "--operation", operation,
    "--candidate-sha", CANDIDATE,
    "--expected-deployment-sha", operation === "quiesce" ? OLD_SOURCE : CANDIDATE,
    "--prepare-run-id", PREPARE_RUN,
    "--prepare-terminal-file", PREPARE_FILE,
    "--output", OUTPUT_FILE,
  ];
  if (operation === "restore" || operation === "reconcile-restore") {
    argv.push(
      "--quiesce-run-id", QUIESCE_RUN,
      "--quiesce-receipt-file", QUIESCE_FILE,
      "--quiesce-verification-file", QUIESCE_VERIFICATION_FILE,
      "--fenced-deployment-run-id", FENCED_DEPLOYMENT_RUN,
      "--fenced-deployment-receipt-file", FENCED_DEPLOYMENT_FILE,
      "--venue-directory-run-id", VENUE_DIRECTORY_RUN,
      "--venue-directory-receipt-file", VENUE_DIRECTORY_FILE,
    );
  }
  const output: string[] = [];
  const written = new Map<string, string>();
  const readMaximumBytes = new Map<string, number>();
  return {
    argv,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "blackmagic30/Beer",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: CANDIDATE,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: CURRENT_RUN,
      GITHUB_WORKFLOW_REF:
        `blackmagic30/Beer/${bootstrapWorkflow}@refs/heads/main`,
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
      PINTPATH_STAGING_WORKER_BOOTSTRAP_OPERATION: operation,
      PINTPATH_STAGING_WORKER_BOOTSTRAP_GITHUB_ENVIRONMENT:
        "permanent-staging-scale-evidence",
    },
    fetchImpl,
    readPrivateFile: (
      filename: string,
      maximumBytes = MAXIMUM_EVIDENCE_BYTES,
    ) => {
      readMaximumBytes.set(filename, maximumBytes);
      const bytes = Buffer.from(files.get(filename) ?? "");
      if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
        throw new Error("private evidence outside allowed byte boundary");
      }
      return bytes;
    },
    writeEvidence: (filename: string, source: string) => written.set(filename, source),
    writeOutput: (source: string) => output.push(source),
    now: () => new Date(operation === "quiesce"
      ? "2026-08-21T01:03:30.000Z"
      : "2026-08-21T01:07:30.000Z"),
    output,
    written,
    files,
    readMaximumBytes,
  };
}

describe("permanent-staging worker bootstrap prerequisites", () => {
  it("pins the policy and every producer policy digest", () => {
    const source = fs.readFileSync(
      "ops/railway/permanent-staging-worker-bootstrap-prerequisites-policy.json",
    );
    expect(sha(source.toString())).toBe(
      STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    );
    expect(stagingWorkerBootstrapPrerequisiteInternals.validatePolicies(
      process.cwd(),
    )).toBeUndefined();
  });

  it("keeps the operator runbook aligned with the venue-gated v4 chain", () => {
    const runbook = fs.readFileSync(
      "docs/permanent-staging-worker-bootstrap.md",
      "utf8",
    );
    const fenced = runbook.indexOf("3. Run the `fenced` phase");
    const venue = runbook.indexOf("4. Run `apply-refresh-validate`");
    const restore = runbook.indexOf("5. Run `restore`");
    const activate = runbook.indexOf("6. Run staging `activate`");

    expect(fenced).toBeGreaterThanOrEqual(0);
    expect(venue).toBeGreaterThan(fenced);
    expect(restore).toBeGreaterThan(venue);
    expect(activate).toBeGreaterThan(restore);
    expect(runbook).toContain("`venue_directory_run_id`");
    expect(runbook).toContain("`--venue-directory-run-id`");
    expect(runbook).toContain("`--venue-directory-receipt-file`");
    expect(runbook).toContain(STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA);
    expect(runbook).toContain(
      STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    );
    expect(runbook).toContain(
      "08d01a0c1d97677334c734354d691159084b4e432512d0d25e2617f10a07d94f",
    );
  });

  it("verifies prepare before authorizing the exact old-source quiescence", async () => {
    const fixture = harness("quiesce");
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(0);
    const receipt = JSON.parse(fixture.written.get(OUTPUT_FILE)!);
    expect(receipt).toMatchObject({
      operation: "quiesce",
      candidateSha: CANDIDATE,
      expectedDeploymentSha: OLD_SOURCE,
      reviewedPullRequest: {
        number: 51,
        mergeCommitSha: CANDIDATE,
        treeSha: TREE,
      },
      prerequisites: [{
        kind: "prepare",
        runId: PREPARE_RUN,
        artifactName:
          `pintpath-automatic-maintenance-worker-fence-permanent-staging-prepare-${CANDIDATE}`,
        artifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        receipt: { sourceSha: OLD_SOURCE, outcome: "prepared" },
      }],
      checks: VERIFICATION_CHECKS,
      secretMaterialIncluded: false,
    });
    expect(fixture.fetchImpl.mock.calls.every(([request]) =>
      String(request).startsWith("https://api.github.com/"))).toBe(true);
  });

  it("verifies prepare, quiescence, fenced deployment, and venue apply before restore", async () => {
    const fixture = harness("restore");
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(0);
    const receipt = JSON.parse(fixture.written.get(OUTPUT_FILE)!);
    expect(receipt.expectedDeploymentSha).toBe(CANDIDATE);
    expect(receipt.prerequisites.map((item: { kind: string }) => item.kind))
      .toEqual(["prepare", "quiesce", "fenced-deployment", "venue-directory"]);
    expect(receipt.prerequisites[1]).toMatchObject({
      receipt: {
        outcome: "scaled",
        sourceSha: OLD_SOURCE,
        replicasBefore: 1,
        replicasAfter: 0,
      },
      prerequisiteVerificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(receipt.prerequisites[2]).toMatchObject({
      receipt: {
        sourceSha: CANDIDATE,
        replicasBefore: 0,
        replicasAfter: 0,
      },
    });
    expect(receipt.prerequisites[3]).toMatchObject({
      workflowPath: ".github/workflows/permanent-staging-venue-directory.yml",
      runId: VENUE_DIRECTORY_RUN,
      artifactName:
        `pintpath-permanent-staging-venue-directory-${CANDIDATE}`,
      receipt: {
        filename: "venue-directory-terminal.json",
        schemaVersion:
          "pintpath-permanent-staging-venue-directory-terminal/v1",
        outcome: "applied_and_validated",
        candidateSha: CANDIDATE,
        sourceSha: CANDIDATE,
        deploymentIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        replicasBefore: null,
        replicasAfter: null,
      },
    });
  });

  it("accepts a venue plan above the generic evidence cap under the dedicated venue cap", async () => {
    const fixture = harness("restore", {
      venueNameBytes: MAXIMUM_EVIDENCE_BYTES,
    });
    const planFilename = path.join(
      path.dirname(VENUE_DIRECTORY_FILE),
      "venue-directory-plan.json",
    );
    expect(Buffer.byteLength(fixture.files.get(planFilename)!))
      .toBeGreaterThan(MAXIMUM_EVIDENCE_BYTES);
    expect(Buffer.byteLength(fixture.files.get(planFilename)!))
      .toBeLessThanOrEqual(MAXIMUM_VENUE_EVIDENCE_BYTES);

    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code, fixture.output.at(-1)).toBe(0);
    expect(fixture.readMaximumBytes.get(planFilename))
      .toBe(MAXIMUM_VENUE_EVIDENCE_BYTES);
    expect(fixture.readMaximumBytes.get(PREPARE_FILE))
      .toBe(MAXIMUM_EVIDENCE_BYTES);
  });

  it("preserves the generic cap for non-venue private evidence", async () => {
    const fixture = harness("quiesce");
    fixture.files.set(PREPARE_FILE, "x".repeat(MAXIMUM_EVIDENCE_BYTES + 1));

    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(fixture.readMaximumBytes.get(PREPARE_FILE))
      .toBe(MAXIMUM_EVIDENCE_BYTES);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "receipt_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects venue private evidence above the dedicated venue cap", async () => {
    const fixture = harness("restore");
    const planFilename = path.join(
      path.dirname(VENUE_DIRECTORY_FILE),
      "venue-directory-plan.json",
    );
    fixture.files.set(
      planFilename,
      "x".repeat(MAXIMUM_VENUE_EVIDENCE_BYTES + 1),
    );

    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(fixture.readMaximumBytes.get(planFilename))
      .toBe(MAXIMUM_VENUE_EVIDENCE_BYTES);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "receipt_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("accepts the same exact venue producer before read-only reconcile-restore", async () => {
    const fixture = harness("reconcile-restore");
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code, fixture.output.at(-1)).toBe(0);
    const receipt = JSON.parse(fixture.written.get(OUTPUT_FILE)!);
    expect(receipt).toMatchObject({
      operation: "reconcile-restore",
      candidateSha: CANDIDATE,
    });
    expect(receipt.prerequisites.map((item: { kind: string }) => item.kind))
      .toEqual(["prepare", "quiesce", "fenced-deployment", "venue-directory"]);
  });

  it("accepts first-run venue migration proof with one exact ledger write", async () => {
    const fixture = harness("restore", { venueMigrationMode: "first_run" });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code, fixture.output.at(-1)).toBe(0);
  });

  it("rejects restore when venue-directory evidence is missing", async () => {
    const fixture = harness("restore");
    const venueIndex = fixture.argv.indexOf("--venue-directory-run-id");
    fixture.argv.splice(venueIndex, 4);

    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);
    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "arguments_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a wrong venue-directory producer authority", async () => {
    const fixture = harness("restore", { venueRunWrong: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "run_authority_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects venue-directory evidence that overlaps fenced deployment chronology", async () => {
    const fixture = harness("restore", { venueChronologyInvalid: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "chronology_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects a tampered venue-directory companion despite a valid terminal", async () => {
    const fixture = harness("restore", { venueReceiptTampered: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "receipt_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects venue-directory proof with a missing dynamic companion", async () => {
    const fixture = harness("restore", { venueCompanionMissing: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "receipt_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects the old static-only importer receipt as venue boundary proof", async () => {
    const fixture = harness("restore", { venueStaticOnly: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "receipt_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects internally rehashed venue evidence with impossible chronology", async () => {
    const fixture = harness("restore", { venueInternalChronologyInvalid: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "receipt_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects an invalid GitHub artifact digest before any provider contact", async () => {
    const fixture = harness("quiesce", { artifactDigestInvalid: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "artifact_authority_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects a later same-candidate prepare run in the consumer window", async () => {
    const fixture = harness("quiesce", { laterPrepare: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "history_invalid",
      productionContactAttempted: false,
    });
  });

  it("validates the activation and active-closeout receipts used by later modes", () => {
    const activationSource = activateReceipt();
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateWorkerReceipt(
      activationSource,
      JSON.parse(activationSource),
      CANDIDATE,
      "activate",
    )).toMatchObject({
      outcome: "activated",
      sourceSha: CANDIDATE,
      replicasAfter: 1,
    });
    const deploymentSource = activeDeploymentReceipt();
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateDeploymentReceipt(
      deploymentSource,
      JSON.parse(deploymentSource),
      CANDIDATE,
      "active-deployment",
    )).toMatchObject({
      sourceSha: CANDIDATE,
      replicasBefore: 1,
      replicasAfter: 1,
    });
    const activationVerificationSource = priorActivationVerification();
    expect(stagingWorkerBootstrapPrerequisiteInternals.validatePriorVerification(
      activationVerificationSource,
      JSON.parse(activationVerificationSource),
      {
        operation: "activate",
        bootstrapPath: "healthy-legacy",
        candidateSha: CANDIDATE,
        runId: "5000",
      },
    )).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedDeploymentSha: null,
    });
  });

  it("reconciles activation runner loss read-only and emits the alternate receipt", async () => {
    const snapshot = activatedProviderSnapshot();
    const runtime = activatedRuntimeProof();
    const written = new Map<string, string>();
    const output: string[] = [];
    const code = await runPermanentStagingActivationReconciliationProbe({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--bootstrap-path", "healthy-legacy",
        "--prior-activate-run-id", "4999",
        "--prerequisites-verification-file",
        "/private/activate/prerequisites-verification.json",
        "--reviewed-authority-file", "/private/activate/reviewed-authority.json",
        "--evidence-dir", "/private/activate/evidence",
      ],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: CURRENT_RUN,
        PINTPATH_PROTECTED_ENVIRONMENT:
          "permanent-staging-provider-mutation",
        PINTPATH_AUTOMATIC_MAINTENANCE_CONFIRMATION:
          `RECONCILE_ACTIVATE_AUTOMATIC_MAINTENANCE_IN_PERMANENT_STAGING_FOR_${CANDIDATE}`,
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
          "production-metadata-token-long-enough",
        PINTPATH_RAILWAY_STAGING_METADATA_TOKEN:
          "staging-metadata-token-long-enough",
      },
      cwd: process.cwd(),
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: {
          projectToken: {
            projectId: PROJECT_ID,
            environmentId: ENVIRONMENT_ID,
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })),
      now: () => Date.parse("2026-08-21T01:10:00.000Z"),
      sleep: vi.fn(),
      readState: vi.fn().mockResolvedValue(snapshot),
      probeRuntime: vi.fn().mockResolvedValue(runtime),
      boundaryCheck: vi.fn().mockResolvedValue({
        passed: true,
        receiptSha256: sha("boundary"),
      }),
      reassertRepositoryState: () => true,
      readPrivateEvidence: (filename) => filename.endsWith(
        "reviewed-authority.json",
      )
        ? activationReconcileAuthority()
        : priorActivationVerification("reconcile-activate", CURRENT_RUN),
      writeDurable: (_directory, leaf, source) => {
        written.set(leaf, source);
        return sha(source);
      },
      writeOutput: (source) => output.push(source),
    });
    expect(code, output.at(-1)).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      outcome: "reconciled_activated_after_runner_loss",
      attempts: 0,
      checks: {
        mutationCredentialsAbsent: true,
        noProviderWriteAttempted: true,
      },
    });
    const receiptSource = written.get(
      "automatic-maintenance-worker-fence-terminal.json",
    )!;
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateWorkerReceipt(
      receiptSource,
      JSON.parse(receiptSource),
      CANDIDATE,
      "activate",
    )).toMatchObject({
      outcome: "reconciled_activated_after_runner_loss",
      replicasBefore: 1,
      replicasAfter: 1,
    });
  });

  it("requires the activation-chain verification beside every activation terminal", () => {
    const parsed = stagingWorkerBootstrapPrerequisiteInternals.parseArguments([
      "--operation", "active-deploy",
      "--candidate-sha", CANDIDATE,
      "--activate-run-id", "5000",
      "--activate-terminal-file", ACTIVATE_FILE,
      "--activate-verification-file", ACTIVATE_VERIFICATION_FILE,
      "--output", OUTPUT_FILE,
    ]);
    expect(parsed.inputs.get("activate")?.verificationFile).toBe(
      ACTIVATE_VERIFICATION_FILE,
    );
    expect(() => stagingWorkerBootstrapPrerequisiteInternals.parseArguments([
      "--operation", "active-deploy",
      "--candidate-sha", CANDIDATE,
      "--activate-run-id", "5000",
      "--activate-terminal-file", ACTIVATE_FILE,
      "--output", OUTPUT_FILE,
    ])).toThrow("arguments_invalid");
  });

  it("accepts the cold-dead chain through every post-quiesce consumer", () => {
    const coldPrepare = [
      "--cold-prepare-run-id", PREPARE_RUN,
      "--cold-prepare-terminal-file", COLD_PREPARE_FILE,
    ];
    const coldQuiesce = [
      "--cold-quiesce-run-id", QUIESCE_RUN,
      "--cold-quiesce-receipt-file", COLD_QUIESCE_FILE,
      "--cold-quiesce-verification-file", COLD_QUIESCE_VERIFICATION_FILE,
    ];
    const fencedDeployment = [
      "--fenced-deployment-run-id", FENCED_DEPLOYMENT_RUN,
      "--fenced-deployment-receipt-file", FENCED_DEPLOYMENT_FILE,
    ];
    const venueDirectory = [
      "--venue-directory-run-id", VENUE_DIRECTORY_RUN,
      "--venue-directory-receipt-file", VENUE_DIRECTORY_FILE,
    ];
    const restore = [
      "--restore-run-id", "4000",
      "--restore-receipt-file", RESTORE_FILE,
      "--restore-verification-file", RESTORE_VERIFICATION_FILE,
    ];
    const activate = [
      "--activate-run-id", "5000",
      "--activate-terminal-file", ACTIVATE_FILE,
      "--activate-verification-file", ACTIVATE_VERIFICATION_FILE,
    ];
    const activeDeployment = [
      "--active-deployment-run-id", "6000",
      "--active-deployment-receipt-file", ACTIVE_DEPLOYMENT_FILE,
    ];
    const cases = [
      {
        operation: "cold-quiesce",
        extra: ["--expected-deployment-sha", COLD_SOURCE, ...coldPrepare],
        kinds: ["cold-prepare"],
      },
      {
        operation: "cold-reconcile-quiesce",
        extra: ["--expected-deployment-sha", COLD_SOURCE, ...coldPrepare],
        kinds: ["cold-prepare"],
      },
      {
        operation: "fenced-deploy",
        extra: [...coldPrepare, ...coldQuiesce],
        kinds: ["cold-prepare", "cold-quiesce"],
      },
      {
        operation: "restore",
        extra: [
          "--expected-deployment-sha", CANDIDATE,
          ...coldPrepare,
          ...coldQuiesce,
          ...fencedDeployment,
          ...venueDirectory,
        ],
        kinds: [
          "cold-prepare",
          "cold-quiesce",
          "fenced-deployment",
          "venue-directory",
        ],
      },
      {
        operation: "activate",
        extra: [
          ...coldPrepare,
          ...coldQuiesce,
          ...fencedDeployment,
          ...venueDirectory,
          ...restore,
        ],
        kinds: [
          "cold-prepare",
          "cold-quiesce",
          "fenced-deployment",
          "venue-directory",
          "restore",
        ],
      },
      {
        operation: "active-deploy",
        extra: activate,
        kinds: ["activate"],
      },
      {
        operation: "scale-evidence",
        extra: [...activate, ...activeDeployment],
        kinds: ["activate", "active-deployment"],
      },
    ];

    for (const fixture of cases) {
      const parsed = stagingWorkerBootstrapPrerequisiteInternals.parseArguments([
        "--operation", fixture.operation,
        "--bootstrap-path", "cold-dead",
        "--candidate-sha", CANDIDATE,
        ...fixture.extra,
        "--output", OUTPUT_FILE,
      ]);
      expect(parsed.bootstrapPath).toBe("cold-dead");
      expect([...parsed.inputs.keys()]).toEqual(fixture.kinds);
    }
  });

  it("requires the complete ordered chain for activate mode arguments", () => {
    const parsed = stagingWorkerBootstrapPrerequisiteInternals.parseArguments([
      "--operation", "activate",
      "--candidate-sha", CANDIDATE,
      "--prepare-run-id", PREPARE_RUN,
      "--prepare-terminal-file", PREPARE_FILE,
      "--quiesce-run-id", QUIESCE_RUN,
      "--quiesce-receipt-file", QUIESCE_FILE,
      "--quiesce-verification-file", QUIESCE_VERIFICATION_FILE,
      "--fenced-deployment-run-id", FENCED_DEPLOYMENT_RUN,
      "--fenced-deployment-receipt-file", FENCED_DEPLOYMENT_FILE,
      "--venue-directory-run-id", VENUE_DIRECTORY_RUN,
      "--venue-directory-receipt-file", VENUE_DIRECTORY_FILE,
      "--restore-run-id", "4000",
      "--restore-receipt-file",
      "/private/restore/bootstrap-staging-one-receipt.json",
      "--restore-verification-file",
      "/private/restore/prerequisites-verification.json",
      "--output", OUTPUT_FILE,
    ]);
    expect([...parsed.inputs.keys()]).toEqual([
      "prepare",
      "quiesce",
      "fenced-deployment",
      "venue-directory",
      "restore",
    ]);
    expect(() => stagingWorkerBootstrapPrerequisiteInternals.parseArguments([
      "--operation", "activate",
      "--candidate-sha", CANDIDATE,
      "--output", OUTPUT_FILE,
    ])).toThrow("arguments_invalid");
  });

  it("locks the manual workflow to one serialized direct scale mutation", () => {
    const source = fs.readFileSync(
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
      "utf8",
    );
    expect(source).toContain("group: pintpath-permanent-staging-key-rollout");
    expect(source).toContain("queue: max");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).toContain("environment: permanent-staging-scale-evidence");
    expect(source).toContain("run-name: Permanent staging worker bootstrap | ${{ inputs.operation }} | ${{ inputs.candidate_sha }}");
    expect(source).toContain("--direction \"$direction\"");
    expect(source).toContain("--expected-deployment-sha \"$EXPECTED_DEPLOYMENT_SHA\"");
    expect(source).toContain("QUIESCE_PERMANENT_STAGING_TO_ZERO_FOR_WORKER_BOOTSTRAP");
    expect(source).toContain("RESTORE_PERMANENT_STAGING_TO_ONE_FOR_WORKER_BOOTSTRAP");
    expect(source).not.toMatch(/gh workflow run|\/dispatches|workflow_dispatch[^:]/);
  });

  it("binds fenced deployment, active closeout, and scale evidence to prior artifacts", () => {
    const deployment = fs.readFileSync(
      ".github/workflows/deploy-permanent-staging.yml",
      "utf8",
    );
    const scale = fs.readFileSync(
      ".github/workflows/permanent-staging-scale-evidence.yml",
      "utf8",
    );

    expect(deployment).toContain(
      "run-name: Deploy permanent staging | ${{ inputs.phase }} | ${{ inputs.candidate_sha }}",
    );
    expect(deployment).toContain("--operation fenced-deploy");
    expect(deployment).toContain("--operation active-deploy");
    expect(deployment).toContain(
      '--activate-verification-file "$root/activate/prerequisites-verification.json"',
    );
    expect(deployment).toContain(
      "pintpath-permanent-staging-fenced-deployment-${{ inputs.candidate_sha }}",
    );
    expect(deployment).toContain(
      "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
    );
    expect(deployment).toContain(
      "DEPLOY_PERMANENT_STAGING_FENCED_AT_ZERO_FOR_${CANDIDATE_SHA}",
    );
    expect(deployment).toContain(
      "DEPLOY_PERMANENT_STAGING_ACTIVE_AT_ONE_FOR_${CANDIDATE_SHA}",
    );
    expect(deployment.indexOf(
      "Verify exact staging deployment prerequisite provenance and chronology",
    )).toBeLessThan(deployment.indexOf(
      "PINTPATH_RAILWAY_WRITE_TOKEN: ${{ secrets.PINTPATH_RAILWAY_STAGING_DEPLOY_TOKEN }}",
    ));

    expect(scale).toContain("group: pintpath-permanent-staging-key-rollout");
    expect(scale).toContain("queue: max");
    expect(scale).toContain("actions: read");
    expect(scale).toContain("pull-requests: read");
    expect(scale).toContain("--operation scale-evidence");
    expect(scale).toContain("--activate-run-id \"$ACTIVATION_RUN_ID\"");
    expect(scale).toContain(
      '--activate-verification-file "$root/sealed/activate/prerequisites-verification.json"',
    );
    expect(scale).toContain(
      "--active-deployment-run-id \"$ACTIVE_DEPLOYMENT_RUN_ID\"",
    );
    expect(scale.indexOf(
      "Seal and verify the exact active staging prerequisites",
    )).toBeLessThan(scale.indexOf(
      "PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: ${{ secrets.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN }}",
    ));
  });
});
