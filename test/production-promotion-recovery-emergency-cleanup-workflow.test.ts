import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  EmergencyCleanupArmError,
  verifyEmergencyCleanupArm,
} from "../scripts/verify-production-promotion-recovery-emergency-cleanup-arm.js";

const workflow = fs.readFileSync(
  ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
  "utf8",
);
const managerWorkflow = fs.readFileSync(
  ".github/workflows/manage-production-promotion-recovery-emergency-cleanup-arm.yml",
  "utf8",
);
const activation = fs.readFileSync(
  ".github/workflows/activate-production-promotion-recovery.yml",
  "utf8",
);
const candidate = "a".repeat(40);
const activationRunId = "123456789";
const cleanupRunId = "987654321";
const projectId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const projectName = "pintpath-disposable-restore-20260814";
const supabaseRef = "bcdefghijklmnopqrstu";
const roots: string[] = [];

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function privateFile(directory: string, name: string, source: string): string {
  const filename = path.join(directory, name);
  fs.writeFileSync(filename, source, { mode: 0o600, flag: "wx" });
  return filename;
}

function armFixture() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-emergency-arm-")),
  );
  fs.chmodSync(directory, 0o700);
  roots.push(directory);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const target = {
    repository: "blackmagic30/Beer",
    activationRunId,
    candidateSha: candidate,
    projectId,
    projectName,
    environmentId,
    environmentName: projectName,
    inventorySha256: "1".repeat(64),
    workspaceId,
    workspaceName: "PintPath recovery rehearsals",
    workspaceProjectInventorySha256: "2".repeat(64),
    supabaseProjectRef: supabaseRef,
    supabaseProjectName: projectName,
    organizationSlugSha256: "3".repeat(64),
    destinationOriginSha256: "4".repeat(64),
    destinationRestoreAuthoritySha256: "5".repeat(64),
  };
  const payload = {
    schemaVersion:
      "pintpath-production-promotion-recovery-emergency-cleanup-arm-payload/v2",
    operation: "arm-exact-production-promotion-recovery-emergency-cleanup",
    singletonArmSlot: "production-promotion-recovery",
    mechanicalCasRequired: true,
    stateRef:
      "refs/heads/pintpath-production-promotion-recovery-emergency-cleanup-state",
    armTransition: "initial",
    armLineageIdSha256: hash(canonicalPostgresBackupJson(target)),
    previousArmAuthoritySha256: null,
    renewalSequence: 0,
    repository: target.repository,
    activationWorkflowPath:
      ".github/workflows/activate-production-promotion-recovery.yml",
    emergencyCleanupWorkflowPath:
      ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
    requiredGitRef: "refs/heads/main",
    requiredActivationRunAttempt: 1,
    activationRunId: target.activationRunId,
    candidateSha: target.candidateSha,
    projectId: target.projectId,
    projectName: target.projectName,
    environmentId: target.environmentId,
    environmentName: target.environmentName,
    inventorySha256: target.inventorySha256,
    workspaceId: target.workspaceId,
    workspaceName: target.workspaceName,
    workspaceProjectInventorySha256: target.workspaceProjectInventorySha256,
    supabaseProjectRef: target.supabaseProjectRef,
    supabaseProjectName: target.supabaseProjectName,
    organizationSlugSha256: target.organizationSlugSha256,
    destinationOriginSha256: target.destinationOriginSha256,
    destinationRestoreAuthoritySha256: target.destinationRestoreAuthoritySha256,
    railwayCleanupPolicySha256:
      "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef",
    supabaseCleanupPolicySha256:
      "fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796",
    reviewerIdSha256: "6".repeat(64),
    reviewerPublicKeySha256: hash(publicKeyPem),
    issuedAt: "2026-08-14T04:00:00.000Z",
    expiresAt: "2026-08-14T06:00:00.000Z",
  };
  const source = canonicalPostgresBackupJson({
    schemaVersion:
      "pintpath-production-promotion-recovery-emergency-cleanup-arm/v2",
    payload,
    signatureBase64: crypto
      .sign(null, Buffer.from(canonicalPostgresBackupJson(payload)), privateKey)
      .toString("base64"),
  });
  const authorityFile = privateFile(directory, "authority.json", source);
  const publicKeyFile = privateFile(directory, "authority.pem", publicKeyPem);
  const authoritySha256 = hash(source);
  const argv = [
    "--mode",
    "watchdog",
    "--candidate-sha",
    candidate,
    "--activation-run-id",
    activationRunId,
    "--project-id",
    projectId,
    "--project-name",
    projectName,
    "--environment-id",
    environmentId,
    "--environment-name",
    projectName,
    "--inventory-sha256",
    "1".repeat(64),
    "--workspace-id",
    workspaceId,
    "--workspace-name",
    "PintPath recovery rehearsals",
    "--workspace-project-inventory-sha256",
    "2".repeat(64),
    "--supabase-project-ref",
    supabaseRef,
    "--supabase-project-name",
    projectName,
    "--organization-slug-sha256",
    "3".repeat(64),
    "--destination-origin-sha256",
    "4".repeat(64),
    "--destination-restore-authority-sha256",
    "5".repeat(64),
    "--authority-file",
    authorityFile,
    "--authority-sha256",
    authoritySha256,
    "--authority-public-key-file",
    publicKeyFile,
    "--authority-public-key-sha256",
    hash(publicKeyPem),
  ];
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: cleanupRunId,
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_WORKFLOW_REF:
      "blackmagic30/Beer/.github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml@refs/heads/main",
    PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARMED: "true",
    PINTPATH_RECOVERY_EMERGENCY_CLEANUP_STATE_REQUIRED: "true",
    PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_SHA256: authoritySha256,
  };
  return { argv, env };
}

afterEach(() => {
  for (const directory of roots.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("production promotion-recovery emergency cleanup controller", () => {
  it("cryptographically binds the durable arm to the activation run, candidate, targets, workspace, and policies", () => {
    const value = armFixture();
    expect(
      verifyEmergencyCleanupArm(
        value.argv,
        value.env,
        new Date("2026-08-14T05:00:00.000Z"),
      ),
    ).toMatchObject({ activationRunId, candidateSha: candidate, projectId });

    const unarmed = {
      ...value.env,
      PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARMED: "false",
    };
    expect(() =>
      verifyEmergencyCleanupArm(
        value.argv,
        unarmed,
        new Date("2026-08-14T05:00:00.000Z"),
      ),
    ).toThrowError(new EmergencyCleanupArmError("github_authority_invalid"));

    const candidateIndex = value.argv.indexOf("--candidate-sha") + 1;
    value.argv[candidateIndex] = "b".repeat(40);
    expect(() =>
      verifyEmergencyCleanupArm(
        value.argv,
        value.env,
        new Date("2026-08-14T05:00:00.000Z"),
      ),
    ).toThrowError(new EmergencyCleanupArmError("authority_invalid"));
  });

  it("does not let a pending second activation reuse or replace an uncleared first arm", () => {
    const value = armFixture();
    const runIndex = value.argv.indexOf("--activation-run-id") + 1;
    value.argv[runIndex] = "123456790";
    expect(() =>
      verifyEmergencyCleanupArm(
        value.argv,
        value.env,
        new Date("2026-08-14T05:00:00.000Z"),
      ),
    ).toThrowError(new EmergencyCleanupArmError("authority_invalid"));
    expect(activation).toContain("group: pintpath-production-rollout");
    expect(activation).toContain("cancel-in-progress: false");
  });

  it("runs outside the activation cancellation domain and retries while ARMED", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain(
      'workflows: ["Activate protected production promotion recovery"]',
    );
    expect(workflow).toContain("types: [completed]");
    expect(workflow).toContain('cron: "*/15 * * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(
      "if: ${{ needs.resolve-arm.outputs.status == 'open' }}",
    );
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain(
      "environment: production-promotion-recovery-cleanup",
    );
    expect(workflow).toContain("needs: resolve-arm");
    expect(workflow).toContain("--cleanup-mode emergency");
    expect(workflow).toContain("--purge-receipt-file none");
    expect(workflow).toContain(
      "pintpath-production-promotion-recovery-emergency-cleanup-${{ env.PINTPATH_RECOVERY_EMERGENCY_ACTIVATION_RUN_ID }}-${{ github.run_id }}",
    );
    expect(workflow).not.toContain(
      "pintpath-production-promotion-recovery-activation-",
    );
    expect(workflow).toContain(
      "Require exact disarm terminal after both fresh absence proofs",
    );
    expect(workflow).toContain('git push origin "$commit:$ref"');
    expect(workflow).toContain(
      ".pintpath/emergency-cleanup/railway-delete-ack-terminal-$activation_run_id.json",
    );
    expect(workflow).toContain(
      ".pintpath/emergency-cleanup/supabase-delete-ack-terminal-$activation_run_id.json",
    );
    expect(managerWorkflow).toContain("options: [initial, renewal]");
    expect(managerWorkflow).toContain(
      "refs/heads/pintpath-production-promotion-recovery-emergency-cleanup-state",
    );
    expect(managerWorkflow).toContain('git push origin "$commit:$state_ref"');
    expect(managerWorkflow).toContain('if [ "$current_status" = open ]');
    expect(managerWorkflow).toContain('test "$OPERATION" = renewal');
    expect(managerWorkflow).toContain('test "$OPERATION" = initial');
    expect(managerWorkflow).toContain("transition_operation=initialize");
    expect(managerWorkflow).toContain("transition_operation=renew");
    expect(managerWorkflow).not.toContain("git push --force");
  });

  it("requires the same durable arm before activation capture starts", () => {
    const arm = activation.indexOf(
      "Require the exact durable emergency cleanup arm before capture",
    );
    const capture = activation.indexOf(
      "Create candidate-bound logical backup and observe PITR",
    );
    expect(arm).toBeGreaterThanOrEqual(0);
    expect(arm).toBeLessThan(capture);
    expect(activation).toContain("--mode activation");
    expect(activation).toContain('--activation-run-id "$GITHUB_RUN_ID"');
    expect(activation).toContain(
      'PINTPATH_RECOVERY_EMERGENCY_CLEANUP_STATE_REQUIRED: "true"',
    );
  });

  it("durably publishes raw provider acknowledgements before bounded renewal-safe CAS", () => {
    const railwayUpload = workflow.indexOf(
      "Publish the exact Railway delete acknowledgement before further mutation",
    );
    const supabaseMutation = workflow.indexOf(
      "Reconcile exact Supabase project absence in emergency mode",
    );
    const supabaseUpload = workflow.indexOf(
      "Publish the exact Supabase delete acknowledgement before state persistence",
    );
    const persistence = workflow.indexOf(
      "Compare-and-swap persisted acknowledgements and state",
    );
    expect(railwayUpload).toBeGreaterThan(0);
    expect(railwayUpload).toBeLessThan(supabaseMutation);
    expect(supabaseUpload).toBeGreaterThan(supabaseMutation);
    expect(supabaseUpload).toBeLessThan(persistence);
    expect(workflow).toContain(
      "resolve-github-production-promotion-recovery-emergency-cleanup-ack.mjs",
    );
    const combinedInventory = workflow.indexOf(
      "Classify only an exact complete activation acknowledgement inventory",
    );
    const resolver = workflow.indexOf(
      "Resolve exact prior watchdog acknowledgement artifacts",
    );
    expect(combinedInventory).toBeGreaterThan(0);
    expect(combinedInventory).toBeLessThan(resolver);
    expect(workflow).toContain(
      "steps.activation-ack-inventory.outputs.complete != 'true'",
    );
    expect(workflow).toContain(
      'if [ "$ACTIVATION_ACK_COMPLETE" = true ]; then',
    );
    expect(workflow).toContain("--prior-railway-cleanup-run-id");
    expect(workflow).toContain("--prior-supabase-cleanup-run-id");
    expect(workflow).toContain("for attempt in 1 2 3 4; do");
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$current_head" "$latest_head"',
    );
    expect(workflow).toContain('--base-state-file "$previous_state"');
    expect(workflow).toContain(
      'test "$changed" = $\'.pintpath/emergency-cleanup/arm-authority-public-key.pem',
    );
    expect(workflow).not.toContain("git push --force");
  });

  it("requires orderly activation cleanup to persist exact DISARMED state before finalize can green", () => {
    const railwayAck = activation.indexOf(
      "Publish exact Railway delete acknowledgement before Supabase mutation",
    );
    const supabase = activation.indexOf(
      "Reconcile exact Supabase project absence",
    );
    const cleanupArtifact = activation.indexOf(
      "Upload both independent cleanup terminals",
    );
    const persistence = activation.indexOf(
      "Persist exact orderly acknowledgements and DISARMED state with renewal-safe CAS",
    );
    expect(railwayAck).toBeGreaterThan(0);
    expect(railwayAck).toBeLessThan(supabase);
    expect(cleanupArtifact).toBeLessThan(persistence);
    expect(activation).toContain(
      "Validate orderly terminals and create the durable disarm transition",
    );
    expect(activation).toContain("for attempt in 1 2 3 4; do");
    expect(activation).toContain('--base-state-file "$previous_state"');
    expect(activation).toContain(
      '.status == "disarmed" and .disarmTerminal.observedCleanupRunId == env.GITHUB_RUN_ID',
    );
  });
});
