import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  sha256PostgresReviewedPriceOperationReceipt,
} from "../src/lib/postgres-reviewed-price-promotion-operation.js";
import {
  PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA,
  PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA,
  sha256ProductionPromotionRecoveryBytes,
  sha256ProductionPromotionRecoveryValue,
} from "../src/lib/production-promotion-recovery.js";
import {
  PRODUCTION_PROMOTION_RECOVERY_POLICY_SHA256,
  attestProductionPromotionRecovery,
} from "../scripts/attest-production-promotion-recovery.js";
import { writeLogicalOffsiteFixture } from "./postgres-logical-offsite.fixtures.js";

const CANDIDATE = "c".repeat(40);
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const TARGET = "1".repeat(64);
const CA_DER = "f".repeat(64);
const OPERATION = "11111111-1111-4111-8111-111111111111";
const AUTHORIZATION = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function privateRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-attestor-")));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writeJson(root: string, name: string, value: unknown): string {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, canonicalPostgresBackupJson(value), { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
  return filename;
}

function replay(input: {
  readonly at: string;
  readonly baseRestoreSha256: string;
  readonly newlyApplied: number;
  readonly alreadyApplied: number;
}) {
  return {
    kind: "pintpath-postgres-account-deletion-tombstone-replay",
    version: 2,
    status: "verified",
    replayedAt: input.at,
    targetIdentitySha256: TARGET,
    targetClass: "disposable-rehearsal",
    serverVersionNum: "170010",
    replayRoleRestricted: true,
    replayEffectiveRole: "pintpath_maintenance",
    transportProfile: "railway-stock-localhost-ca-v1",
    transportRootCaDerSha256: CA_DER,
    restoreLockKeySha256: HASH,
    baseRestoreReceiptSha256: input.baseRestoreSha256,
    migrationCandidateSha: CANDIDATE,
    migrationManifestSha256: HASH,
    migrationRunSha256: HASH,
    sourceSnapshotSha256: HASH,
    backupManifestSha256: HASH,
    backupArchiveSha256: HASH,
    sourceStateReceiptSha256: HASH,
    sourceSnapshotBindingSha256: HASH,
    expectedSourceOverallStateSha256: HASH,
    restoredOverallStateSha256: HASH,
    ledgerCurrentSha256: HASH,
    ledgerGenesisSha256: HASH,
    ledgerCheckpointSha256: HASH,
    ledgerImmutableSetSha256: HASH,
    ledgerTombstoneCount: 1,
    counts: {
      seen: 1,
      newlyApplied: input.newlyApplied,
      alreadyApplied: input.alreadyApplied,
      missing: 0,
      failed: 0,
    },
    recipientSecretPhysicalCheckpointVerified: true,
    semanticProjectionSha256: OTHER_HASH,
    idempotency: "exact-semantic-projection",
  };
}

describe("production promotion-recovery attestor", () => {
  it("accepts one exact apply-only post-promotion recovery chain", async () => {
    const root = privateRoot();
    const backup = writeLogicalOffsiteFixture(root, "2026-08-14T00:05:00.000Z", 3);
    const files = new Map<string, string>();
    const put = (name: string, value: unknown) => {
      const filename = writeJson(root, `${name}.json`, value);
      files.set(name, filename);
      return filename;
    };
    const deployment = {
      schemaVersion: "pintpath-railway-application-deployment-executor/v4",
      operation: "pintpath-railway-application-source-upload",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      target: "production",
      outcome: "deployed",
      candidateSha: CANDIDATE,
      deploymentIdSha256: HASH,
      completedAt: "2026-08-14T00:00:00.000Z",
      checks: { exact: true },
    };
    put("production-deployment-receipt", deployment);
    put("production-scale-receipt", {
      schemaVersion: "pintpath-permanent-staging-scale-operation/v1",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      direction: "converge-production-two",
      outcome: "scaled",
      candidateSha: CANDIDATE,
      startedAt: "2026-08-14T00:00:30.000Z",
      completedAt: "2026-08-14T00:01:00.000Z",
      desiredReplicas: 2,
      deploymentIdSha256: HASH,
      attempts: 1,
      retryAllowed: false,
      checks: { durableIntentExact: true, exact: true },
    });
    const provisionalClose = {
      schemaVersion: "pintpath-protected-production-route-mutation/v1",
      operation: "close",
      candidateSha: CANDIDATE,
      deploymentIdSha256: HASH,
      terminalEvidenceSha256: null,
      checks: { terminalEvidenceExact: false, finalReceiptEvidenceExact: false },
    };
    const terminal = {
      schemaVersion: "pintpath-protected-production-route-terminal/v1",
      receipt: provisionalClose,
    };
    const terminalFile = put("closed-route-terminal", terminal);
    const closeChecks = {
      policyExact: true,
      githubAuthorityExact: true,
      repositoryAuthorityExact: true,
      predecessorAuthorityExact: true,
      predecessorReceiptsExact: true,
      promotionRecoveryAuthorityExact: true,
      credentialsExact: true,
      tokenScopesExact: true,
      patchPreflightEmpty: true,
      inventoryPreflightExact: true,
      candidateDeploymentPreflightExact: true,
      boundaryPreflightExact: true,
      durableIntentExact: true,
      repositoryPrewriteReasserted: true,
      providerPrewriteReasserted: true,
      writeAttemptedAtMostOnce: true,
      acknowledgementExact: true,
      postflightAttempted: true,
      patchPostflightEmpty: true,
      inventoryTransitionExact: true,
      candidateDeploymentPostflightExact: true,
      boundaryPostflightExact: true,
      publicRuntimePostflightExact: false,
      terminalEvidenceExact: true,
      finalReceiptEvidenceExact: true,
    };
    put("closed-route-receipt", {
      schemaVersion: "pintpath-protected-production-route-mutation/v1",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      outcome: "closed",
      operation: "close",
      candidateSha: CANDIDATE,
      completedAt: "2026-08-14T00:02:00.000Z",
      githubEnvironment: "production-route-close",
      deploymentIdSha256: HASH,
      closedRouteArtifactDigest: null,
      promotionRecoveryArtifactDigest: null,
      promotionRecoveryReceiptSha256: null,
      productionDeploymentReceiptSha256: sha256(fs.readFileSync(files.get(
        "production-deployment-receipt",
      )!)),
      productionScaleReceiptSha256: sha256(fs.readFileSync(files.get(
        "production-scale-receipt",
      )!)),
      closedRouteReceiptSha256: null,
      attempts: 1,
      retryAllowed: false,
      terminalEvidenceSha256: sha256(fs.readFileSync(terminalFile)),
      checks: closeChecks,
    });
    const authorization = {
      approvalFileSha256: HASH,
      approvalPayloadSha256: HASH,
      authorizationId: AUTHORIZATION,
      authorizedAt: "2026-08-14T00:03:00.000Z",
      kind: "pintpath-postgres-reviewed-price-operation-authorization-receipt",
      operationId: OPERATION,
      operationKind: "apply",
      reviewerIdSha256: OTHER_HASH,
      version: 1,
    };
    put("apply-authorization-receipt", authorization);
    const applyWithoutHash = {
      approvalFileSha256: HASH,
      approvalReferenceSha256: HASH,
      authorizationId: AUTHORIZATION,
      authorityBundleSha256: HASH,
      candidateSha: CANDIDATE,
      committedAt: "2026-08-14T00:04:00.000Z",
      expectedEnvironment: "production" as const,
      itemCount: 1,
      kind: "pintpath-postgres-reviewed-price-operation-receipt" as const,
      operationId: OPERATION,
      operationKind: "apply" as const,
      operatorIdSha256: HASH,
      planCandidateSha256: HASH,
      requestSha256: HASH,
      requestedRowCount: 1,
      resultStateSha256: HASH,
      reviewPacketCandidateSha256: HASH,
      reviewerIdSha256: OTHER_HASH,
      sourceApplyOperationId: null,
      sourceIngestionIds: [SOURCE_ID],
      targetPhysicalIdentitySha256: backup.manifest.state.sourceDatabaseIdentitySha256,
      version: 1 as const,
    };
    put("apply-operation-receipt", {
      ...applyWithoutHash,
      receiptSha256: sha256PostgresReviewedPriceOperationReceipt(applyWithoutHash),
    });
    const pitrWithoutHash = {
      schemaVersion: "pintpath-production-post-promotion-pitr-observation/v1",
      outcome: "verified",
      candidateSha: CANDIDATE,
      productionDeploymentIdSha256: HASH,
      recoveryPointAt: "2026-08-14T00:05:00.000Z",
      observedAt: "2026-08-14T00:06:00.000Z",
      pitrEnabledAt: "2026-08-13T23:55:00.000Z",
      projectIdSha256: HASH,
      environmentIdSha256: HASH,
      rootServiceIdSha256: HASH,
      pitrWorkflowIdSha256: HASH,
      providerHealthSha256: HASH,
      pitrEnabled: true,
      clusterHealthy: true,
    };
    put("pitr-receipt", {
      ...pitrWithoutHash,
      receiptSha256: sha256ProductionPromotionRecoveryValue(pitrWithoutHash),
    });
    files.set("logical-backup-manifest", path.join(backup.backupDirectory, "manifest.json"));
    put("logical-offsite-result", {
      schemaVersion: 1,
      ok: true,
      manifestSha256: backup.manifestSha256,
      archiveSha256: backup.archiveSha256,
      stateReceiptSha256: backup.receiptSha256,
      sourceDatabaseIdentitySha256: backup.manifest.state.sourceDatabaseIdentitySha256,
      overallStateSha256: backup.manifest.state.overallStateSha256,
      successStateSha256: HASH,
      completedAt: "2026-08-14T00:08:00.000Z",
    });
    put("logical-worm-result", {
      schemaVersion: 1,
      ok: true,
      manifestSha256: backup.manifestSha256,
      archiveSha256: backup.archiveSha256,
      stateReceiptSha256: backup.receiptSha256,
      writerPrincipalArnSha256: HASH,
      readerPrincipalArnSha256: OTHER_HASH,
      receiptSha256: HASH,
      completedAt: "2026-08-14T00:09:00.000Z",
    });
    const recoveryManifest = {
      kind: "pintpath-postgres-private-storage-recovery-set",
      version: 2,
      logicalBackup: {
        candidateSha: CANDIDATE,
        sourceEnvironment: "production",
        manifestSha256: backup.manifestSha256,
      },
      deletionAuthority: {
        tombstoneCount: 1,
        currentSha256: HASH,
        authoritySetSha256: OTHER_HASH,
      },
      recoverySetSha256: HASH,
    };
    const recoveryManifestFile = put("private-storage-recovery-manifest", recoveryManifest);
    put("private-storage-capture-receipt", {
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-capture",
      ok: true,
      capturedAt: "2026-08-14T00:07:00.000Z",
      databaseTransportProfile: "railway-stock-localhost-ca-v1",
      databaseTransportRootCaDerSha256: CA_DER,
      databaseEffectiveRole: "pintpath_migrator",
      logicalBackupManifestSha256: backup.manifestSha256,
      storageObjectCount: 1,
      databaseReferenceCount: 1,
      deletionTombstoneCount: 1,
      recoverySetSha256: HASH,
      recoveryManifestSha256: sha256(fs.readFileSync(recoveryManifestFile)),
    });
    put("offsite-retrieval-receipt", {
      schemaVersion: 1,
      kind: "pintpath-postgres-logical-offsite-retrieval",
      ok: true,
      successStateSha256: HASH,
      manifestSha256: backup.manifestSha256,
      archiveSha256: backup.archiveSha256,
      stateReceiptSha256: backup.receiptSha256,
      sourceDatabaseIdentitySha256: backup.manifest.state.sourceDatabaseIdentitySha256,
      retrievedAt: "2026-08-14T00:10:00.000Z",
    });
    const restoreFile = put("logical-restore-receipt", {
      kind: "pintpath-postgres-logical-restore",
      version: 1,
      status: "verified",
      backupManifestSha256: backup.manifestSha256,
      backupArchiveSha256: backup.archiveSha256,
      expectedSourceOverallStateSha256: backup.manifest.state.overallStateSha256,
      restoredOverallStateSha256: backup.manifest.state.overallStateSha256,
      sourceStateBindingStatus: "exact-match",
      exactDataReconciliation: "canonical-contract-exact",
      targetIdentitySha256: TARGET,
      restoredAt: "2026-08-14T00:11:00.000Z",
    });
    put("private-storage-restore-receipt", {
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-restore",
      ok: true,
      restoredAt: "2026-08-14T00:12:00.000Z",
      databaseTransportProfile: "railway-stock-localhost-ca-v1",
      databaseTransportRootCaDerSha256: CA_DER,
      databaseEffectiveRole: "pintpath_migrator",
      destinationAuthoritySha256: HASH,
      destinationAuthorityPublicKeySha256: HASH,
      destinationAuthorityReviewerIdSha256: HASH,
      targetDatabaseIdentitySha256: TARGET,
      recoverySetSha256: HASH,
      recoveryManifestSha256: sha256(fs.readFileSync(recoveryManifestFile)),
      deletionAuthoritySetSha256: OTHER_HASH,
      restoredObjectCount: 1,
    });
    put("deletion-replay-first-receipt", replay({
      at: "2026-08-14T00:13:00.000Z",
      baseRestoreSha256: sha256(fs.readFileSync(restoreFile)),
      newlyApplied: 1,
      alreadyApplied: 0,
    }));
    put("deletion-replay-second-receipt", replay({
      at: "2026-08-14T00:14:00.000Z",
      baseRestoreSha256: sha256(fs.readFileSync(restoreFile)),
      newlyApplied: 0,
      alreadyApplied: 1,
    }));
    const keys = [crypto.generateKeyPairSync("ed25519"), crypto.generateKeyPairSync("ed25519")];
    const publicKeys = keys.map((pair, index) => {
      const bytes = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" }));
      const filename = path.join(root, `reviewer-${index + 1}.pem`);
      fs.writeFileSync(filename, bytes, { mode: 0o600 });
      fs.chmodSync(filename, 0o600);
      return { bytes, filename, sha256: sha256(bytes) };
    });
    files.set("approval-one-public-key", publicKeys[0]!.filename);
    files.set("approval-two-public-key", publicKeys[1]!.filename);
    const fileSha = (name: string) => sha256(fs.readFileSync(files.get(name)!));
    const reviewerPublicKeySha256s = publicKeys.map((entry) => entry.sha256).sort() as [string, string];
    const authority = {
      schemaVersion: PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA,
      candidateSha: CANDIDATE,
      productionDeploymentReceiptSha256: fileSha("production-deployment-receipt"),
      productionDeploymentIdSha256: HASH,
      productionScaleReceiptSha256: fileSha("production-scale-receipt"),
      closedRouteReceiptSha256: fileSha("closed-route-receipt"),
      closedRouteTerminalEvidenceSha256: fileSha("closed-route-terminal"),
      applyAuthorizationReceiptSha256: fileSha("apply-authorization-receipt"),
      applyOperationReceiptSha256: fileSha("apply-operation-receipt"),
      pitrReceiptSha256: fileSha("pitr-receipt"),
      pitrObservedAt: "2026-08-14T00:06:00.000Z",
      logicalBackupManifestSha256: backup.manifestSha256,
      logicalOffsiteResultSha256: fileSha("logical-offsite-result"),
      logicalWormResultSha256: fileSha("logical-worm-result"),
      privateStorageCaptureReceiptSha256: fileSha("private-storage-capture-receipt"),
      offsiteRetrievalReceiptSha256: fileSha("offsite-retrieval-receipt"),
      logicalRestoreReceiptSha256: fileSha("logical-restore-receipt"),
      privateStorageRestoreReceiptSha256: fileSha("private-storage-restore-receipt"),
      deletionReplayFirstReceiptSha256: fileSha("deletion-replay-first-receipt"),
      deletionReplaySecondReceiptSha256: fileSha("deletion-replay-second-receipt"),
      recoveryPointAt: "2026-08-14T00:05:00.000Z",
      recoveryStartedAt: "2026-08-14T00:10:00.000Z",
      recoveryCompletedAt: "2026-08-14T00:14:00.000Z",
      rpoSeconds: 60,
      rtoSeconds: 240,
      reviewerPublicKeySha256s,
    };
    const authorityFile = put("authority", authority);
    const authoritySha256 = sha256(fs.readFileSync(authorityFile));
    const approvalAt = ["2026-08-14T00:15:00.000Z", "2026-08-14T00:16:00.000Z"];
    keys.forEach((pair, index) => {
      const payload = {
        schemaVersion: "pintpath-production-promotion-recovery-approval-payload/v1",
        authorityManifestSha256: authoritySha256,
        candidateSha: CANDIDATE,
        reviewerIdSha256: index === 0 ? HASH : OTHER_HASH,
        reviewerPublicKeySha256: publicKeys[index]!.sha256,
        approvedAt: approvalAt[index]!,
      };
      put(`approval-${index === 0 ? "one" : "two"}`, {
        schemaVersion: PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA,
        payload,
        signatureBase64: crypto.sign(
          null,
          Buffer.from(canonicalPostgresBackupJson(payload)),
          pair.privateKey,
        ).toString("base64"),
      });
    });
    const output = path.join(root, "receipt.json");
    const argumentNames = [
      "authority", "production-deployment-receipt", "production-scale-receipt",
      "closed-route-receipt", "closed-route-terminal", "apply-authorization-receipt",
      "apply-operation-receipt", "pitr-receipt", "logical-backup-manifest",
      "logical-offsite-result", "logical-worm-result", "private-storage-capture-receipt",
      "private-storage-recovery-manifest", "offsite-retrieval-receipt",
      "logical-restore-receipt", "private-storage-restore-receipt",
      "deletion-replay-first-receipt", "deletion-replay-second-receipt",
      "approval-one", "approval-one-public-key", "approval-two", "approval-two-public-key",
    ];
    const argv = argumentNames.flatMap((name) => [`--${name}`, files.get(name)!]);
    argv.push(
      "--authority-sha256", authoritySha256,
      "--expected-reviewer-one-public-key-sha256", publicKeys[0]!.sha256,
      "--expected-reviewer-two-public-key-sha256", publicKeys[1]!.sha256,
      "--candidate-sha", CANDIDATE,
      "--output", output,
    );
    let stdout = "";
    const receipt = await attestProductionPromotionRecovery({
      argv,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION:
          "ATTEST_PRODUCTION_PROMOTION_RECOVERY",
      },
      cwd: process.cwd(),
      now: () => new Date("2026-08-14T00:17:00.000Z"),
      writeOutput: (source) => { stdout += source; },
    });
    expect(receipt).toMatchObject({
      outcome: "verified",
      candidateSha: CANDIDATE,
      policySha256: PRODUCTION_PROMOTION_RECOVERY_POLICY_SHA256,
      productionDeploymentIdSha256: HASH,
      productionScaleReceiptSha256: authority.productionScaleReceiptSha256,
      quarantineReceiptSha256: null,
      rpoSeconds: 60,
      rtoSeconds: 240,
    });
    expect(Object.values(receipt.checks)).not.toContain(false);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, candidateSha: CANDIDATE });
    expect(sha256(fs.readFileSync(output))).toBe(
      sha256ProductionPromotionRecoveryBytes(canonicalPostgresBackupJson(receipt)),
    );
    expect(fs.statSync(output).mode & 0o7777).toBe(0o600);
  });
});
