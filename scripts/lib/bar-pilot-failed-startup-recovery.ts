import crypto from "node:crypto";
import path from "node:path";

import { readTrustedRegularFile } from "./trusted-filesystem.js";
import { BAR_PILOT_STOPPED_DEPLOYMENT_ID } from "./bar-pilot-staging-contract.js";

// One reviewed predecessor, not a general retry/redeploy capability. The failed
// upload was reconciled read-only using Railway's actual cliMessage and snapshot.
export const BAR_PILOT_FAILED_STARTUP_RECOVERY = Object.freeze({
  workflowRunId: "34437975279",
  candidateSha: "1d17eaf937f1c3561f0a42a0e4e3d2d7f356999a",
  deploymentId: "8b8bfe67-9829-4223-960f-2900d1c08c39",
  snapshotId: "d3c25929-ccec-434d-8693-91037479f354",
  intentSha256: "42f7b1e56519ae5c2be0e298411ceb87ba8fccbbf4ed35ce929ff2f7a683ffa4",
  sourceIdentitySha256: "89aecb6239161ae8636212f06c539abeb0234fba2144faec83e13e6f1488e37c",
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  collateralSha256: "f32099b84044946f0cd3571bd712c3af0a5ace2509b21ece45da651132ec426c",
  proofPath: "ops/railway/evidence/bar-pilot-startup-db-identity-correction.json",
  proofSha256: "30d0381312877e5378f4246b8352f5b271e2f74653beae93da78f05f4368f1d5",
});

type Environment = Readonly<Record<string, string | undefined>>;

export function barPilotFailedStartupRecoveryRequested(env: Environment): boolean {
  const requested = env.PINTPATH_BAR_PILOT_RECOVER_FAILED_STARTUP ?? "false";
  if (!["true", "false", ""].includes(requested)
    || (requested === "true" && env.PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID)) {
    throw new Error("failed_startup_recovery_invalid");
  }
  return requested === "true";
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function barPilotFailedStartupInstanceExact(value: unknown): boolean {
  if (!record(value) || !record(value.latestDeployment)) return false;
  const latest = value.latestDeployment;
  const lock = BAR_PILOT_FAILED_STARTUP_RECOVERY;
  return latest.id === lock.deploymentId && latest.snapshotId === lock.snapshotId
    && latest.status === "FAILED" && latest.deploymentStopped === true
    && Array.isArray(value.activeDeployments) && value.activeDeployments.length === 1
    && value.activeDeployments.every((row: unknown) => record(row)
      && row.id === BAR_PILOT_STOPPED_DEPLOYMENT_ID
      && row.status === "SUCCESS" && row.deploymentStopped === true);
}

export function barPilotFailedStartupDeploymentExact(value: unknown): boolean {
  if (!record(value) || !barPilotFailedStartupInstanceExact(value)
    || !record(value.deployment)) return false;
  const deployment = value.deployment;
  const lock = BAR_PILOT_FAILED_STARTUP_RECOVERY;
  return deployment.id === lock.deploymentId && deployment.snapshotId === lock.snapshotId
    && deployment.projectId === lock.projectId && deployment.environmentId === lock.environmentId
    && deployment.serviceId === lock.serviceId && deployment.commitHash === null
    && deployment.imageDigest === null && deployment.patchId === null
    && deployment.providerMessageField === "cliMessage"
    && deployment.providerMessage === `pintpath:permanent-staging:${lock.candidateSha}:${lock.intentSha256}`;
}

export function readBarPilotFailedStartupCorrectionProof(cwd: string): string {
  const lock = BAR_PILOT_FAILED_STARTUP_RECOVERY;
  try {
    const read = (leaf: string, expectedSha256: unknown) => {
      if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("invalid");
      const bytes = readTrustedRegularFile(path.resolve(cwd, path.dirname(lock.proofPath), leaf), {
        minBytes: 2, maxBytes: 64 * 1024,
      });
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("invalid");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!record(value)) throw new Error("invalid");
      return value;
    };
    const terminal = read(path.basename(lock.proofPath), lock.proofSha256);
    const sourceTerminal = read("bar-pilot-startup-db-source-terminal.json", terminal.priorSourceTerminalSha256);
    const sourceIntent = read("bar-pilot-startup-db-source-intent.json", terminal.sourceIntentSha256);
    const pinsIntent = read("bar-pilot-startup-db-pins-intent.json", terminal.pinsIntentSha256);
    if (terminal.schemaVersion !== "pintpath-staging-db-identity-correction/v1"
      || terminal.outcome !== "updated" || terminal.sourceWriteAttempts !== 1
      || terminal.pinWriteAttempts !== 1 || terminal.writeAttempts !== 2
      || terminal.databaseMutations !== 0 || terminal.productionMutations !== 0
      || terminal.skipDeploys !== true || terminal.retryAllowed !== false
      || terminal.replace !== false || terminal.secretMaterialIncluded !== false
      || terminal.candidateSha !== lock.candidateSha
      || terminal.failedDeploymentId !== lock.deploymentId
      || terminal.failedSnapshotId !== lock.snapshotId
      || terminal.failedSourceIntentSha256 !== lock.intentSha256
      || terminal.targetProject !== lock.projectId || terminal.targetEnvironment !== lock.environmentId
      || terminal.targetService !== lock.serviceId || !record(terminal.checks)
      || !Object.values(terminal.checks).every((value) => value === true)
      || sourceTerminal.outcome !== "mutation_uncertain"
      || sourceTerminal.sourceWriteAttempts !== 1 || sourceTerminal.pinWriteAttempts !== 0
      || sourceTerminal.sourceIntentSha256 !== terminal.sourceIntentSha256
      || pinsIntent.priorSourceTerminalSha256 !== terminal.priorSourceTerminalSha256
      || pinsIntent.sourceIntentSha256 !== terminal.sourceIntentSha256
      || pinsIntent.sourceWriteAllowed !== false || sourceIntent.maximumAttempts !== 1
      || pinsIntent.maximumAttempts !== 1) throw new Error("invalid");
    // The source operation succeeded once; its later read failed before any pin
    // write. The linked finisher wrote only the pins once. Preserve both records.
    return lock.proofSha256;
  } catch {
    throw new Error("failed_startup_recovery_invalid");
  }
}
