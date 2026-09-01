import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_HA_PITR_HEALTH,
  POSTGRES_HA_PITR_INVENTORY,
  POSTGRES_HA_PITR_PROGRESS,
  POSTGRES_HA_PITR_SCOPE,
} from "../scripts/execute-protected-postgres-ha-pitr.js";
import {
  PRODUCTION_POST_PROMOTION_PITR_OBSERVATION_SCHEMA,
  runProductionPostPromotionPitrObservation,
} from "../scripts/observe-production-post-promotion-pitr.js";
import { productionApplicationDeploymentReceiptFixture } from
  "./production-application-deployment-receipt.fixtures.js";
import { writeLogicalOffsiteFixture } from "./postgres-logical-offsite.fixtures.js";

const CANDIDATE = "c".repeat(40);
const ROOT_SERVICE = "11111111-1111-4111-8111-111111111111";
const MEMBER_SERVICE = "22222222-2222-4222-8222-222222222222";
const WORKFLOW = "33333333-3333-4333-8333-333333333333";
const PROJECT = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT = "13dab015-df74-45c6-b26f-69323daea99a";
const PRE_UPLOAD_DEPLOYMENT_ID_SHA256 = "c".repeat(64);
const UPLOAD_DEPLOYMENT_ID_SHA256 = "d".repeat(64);
const ACTIVE_DEPLOYMENT_ID_SHA256 = "e".repeat(64);
const roots: string[] = [];

type Json = Record<string, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function privateRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-pitr-")));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function queryName(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as { query: string; variables: Json };
  if (body.query === POSTGRES_HA_PITR_SCOPE) return "scope";
  if (body.query === POSTGRES_HA_PITR_INVENTORY) return "inventory";
  if (body.query === POSTGRES_HA_PITR_PROGRESS) return "progress";
  if (body.query === POSTGRES_HA_PITR_HEALTH) {
    return `health:${String(body.variables.rootServiceId)}`;
  }
  return "unknown";
}

describe("production post-promotion PITR observer", () => {
  it("produces a candidate/deployment-bound receipt from read-only healthy provider state", async () => {
    const root = privateRoot();
    const backup = writeLogicalOffsiteFixture(root, "2026-08-14T00:04:30.000Z", 3);
    const manifestFile = path.join(backup.backupDirectory, "manifest.json");
    const deploymentFile = path.join(root, "deployment.json");
    fs.writeFileSync(deploymentFile, canonicalPostgresBackupJson(
      productionApplicationDeploymentReceiptFixture({
        candidateSha: CANDIDATE,
        previousDeploymentIdSha256: PRE_UPLOAD_DEPLOYMENT_ID_SHA256,
        deploymentIdSha256: UPLOAD_DEPLOYMENT_ID_SHA256,
        startedAt: "2026-08-14T00:00:30.000Z",
        completedAt: "2026-08-14T00:01:00.000Z",
      }),
    ), { mode: 0o600 });
    fs.chmodSync(deploymentFile, 0o600);
    const scaleFile = path.join(root, "scale.json");
    fs.writeFileSync(scaleFile, canonicalPostgresBackupJson({
      schemaVersion: "pintpath-permanent-staging-scale-operation/v2",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      direction: "converge-production-two",
      outcome: "scaled",
      candidateSha: CANDIDATE,
      startedAt: "2026-08-14T00:01:30.000Z",
      completedAt: "2026-08-14T00:02:00.000Z",
      desiredReplicas: 2,
      deploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      attempts: 1,
      retryAllowed: false,
      intentSha256: "1".repeat(64),
      terminalEvidenceSha256: "2".repeat(64),
      commandStdoutSha256: "3".repeat(64),
      commandStderrSha256: "4".repeat(64),
      productionActivationPrerequisite: {
        runId: "8000",
        verificationSha256: "5".repeat(64),
        terminalSha256: "6".repeat(64),
        prerequisitesSha256: "7".repeat(64),
        deploymentBeforeIdSha256: UPLOAD_DEPLOYMENT_ID_SHA256,
        deploymentAfterIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      },
      checks: {
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
      },
    }), { mode: 0o600 });
    fs.chmodSync(scaleFile, 0o600);
    const closeFile = path.join(root, "close.json");
    fs.writeFileSync(closeFile, canonicalPostgresBackupJson({
      schemaVersion: "pintpath-protected-production-route-mutation/v1",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      outcome: "closed",
      operation: "close",
      candidateSha: CANDIDATE,
      startedAt: "2026-08-14T00:02:30.000Z",
      completedAt: "2026-08-14T00:03:00.000Z",
      githubEnvironment: "production-route-close",
      policySha256: "047a742e63c69ebb57fb8230a1efd2d27ae3dfd307f5a087b35a095c4839f348",
      projectIdSha256: "8".repeat(64),
      environmentIdSha256: "9".repeat(64),
      serviceIdSha256: "a".repeat(64),
      domain: "pintpath.au",
      targetPort: null,
      routeIdSha256: "b".repeat(64),
      deploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      predecessorAuthoritySha256: "c".repeat(64),
      orderedProductionChainSha256: "d".repeat(64),
      productionDeploymentArtifactDigest: `sha256:${"e".repeat(64)}`,
      productionScaleArtifactDigest: `sha256:${"f".repeat(64)}`,
      closedRouteArtifactDigest: null,
      promotionRecoveryArtifactDigest: null,
      promotionRecoveryReceiptSha256: null,
      productionDeploymentReceiptSha256: sha256(fs.readFileSync(deploymentFile)),
      productionScaleReceiptSha256: sha256(fs.readFileSync(scaleFile)),
      closedRouteReceiptSha256: null,
      attempts: 1,
      retryAllowed: false,
      intentSha256: "0".repeat(64),
      terminalEvidenceSha256: "1".repeat(64),
      beforeInventorySha256: "2".repeat(64),
      afterInventorySha256: "3".repeat(64),
      checks: {
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
      },
    }), { mode: 0o600 });
    fs.chmodSync(closeFile, 0o600);
    const output = path.join(root, "pitr-receipt.json");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      switch (queryName(init)) {
        case "scope": return response({ data: { projectToken: {
          projectId: PROJECT, environmentId: ENVIRONMENT,
        } } });
        case "inventory": return response({ data: { environment: {
          id: ENVIRONMENT,
          projectId: PROJECT,
          serviceInstances: {
            edges: [ROOT_SERVICE, MEMBER_SERVICE].map((serviceId) => ({ node: {
              environmentId: ENVIRONMENT, serviceId,
            } })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        } } });
        case `health:${MEMBER_SERVICE}`:
          return response({ data: { pitrHaClusterReplicationHealth: null } });
        case `health:${ROOT_SERVICE}`:
          return response({ data: { pitrHaClusterReplicationHealth: {
            allHealthy: true,
            checkedAt: "2026-08-14T00:05:00.000Z",
            environmentId: ENVIRONMENT,
            reachable: true,
            rootServiceId: ROOT_SERVICE,
            members: [
              { healthy: true, isLeader: true, lagMb: 0, patroniName: "root",
                serviceId: ROOT_SERVICE, serviceName: "postgres-root", state: "running" },
              { healthy: true, isLeader: false, lagMb: 0, patroniName: "replica",
                serviceId: MEMBER_SERVICE, serviceName: "postgres-replica", state: "streaming" },
            ],
          } } });
        case "progress": return response({ data: { pitrHaWorkflowProgress: {
          workflowId: WORKFLOW,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          rootServiceId: ROOT_SERVICE,
          direction: "ENABLE",
          phase: "DONE",
          clusterMutated: true,
          startedAt: "2026-08-13T23:50:00.000Z",
          updatedAt: "2026-08-14T00:00:00.000Z",
          completedAt: "2026-08-14T00:00:00.000Z",
          currentMemberServiceId: null,
          newLeaderServiceId: null,
          errorMessage: null,
          failedAtPhase: null,
          members: [
            { serviceId: ROOT_SERVICE, serviceName: "postgres-root", isLeader: true,
              status: "HEALTHY" },
            { serviceId: MEMBER_SERVICE, serviceName: "postgres-replica", isLeader: false,
              status: "HEALTHY" },
          ],
        } } });
        default: return response({ errors: [{ message: "unexpected query" }] });
      }
    });
    let stdout = "";
    const exit = await runProductionPostPromotionPitrObservation({
      argv: [
        "--candidate-sha", CANDIDATE,
        "--production-deployment-receipt", deploymentFile,
        "--production-scale-receipt", scaleFile,
        "--closed-route-receipt", closeFile,
        "--logical-backup-manifest", manifestFile,
        "--output", output,
      ],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION:
          "ATTEST_PRODUCTION_PROMOTION_RECOVERY",
        PINTPATH_POSTGRES_HA_PITR_AUTHORITY_TARGET: "production",
        PINTPATH_POSTGRES_HA_PITR_EXPECTED_ROOT_SERVICE_ID: ROOT_SERVICE,
        PINTPATH_RAILWAY_PITR_METADATA_TOKEN: "m".repeat(32),
      },
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date("2026-08-14T00:05:30.000Z"),
      writeOutput: (source) => { stdout += source; },
    });
    expect(exit, stdout).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, candidateSha: CANDIDATE });
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
      schemaVersion: PRODUCTION_POST_PROMOTION_PITR_OBSERVATION_SCHEMA,
      outcome: "verified",
      candidateSha: CANDIDATE,
      productionDeploymentIdSha256: ACTIVE_DEPLOYMENT_ID_SHA256,
      recoveryPointAt: "2026-08-14T00:04:30.000Z",
      observedAt: "2026-08-14T00:05:00.000Z",
      pitrEnabled: true,
      clusterHealthy: true,
    });
    expect(fs.statSync(output).mode & 0o7777).toBe(0o600);
  });

  it("fails before provider access outside exact protected main authority", async () => {
    let stdout = "";
    const fetchImpl = vi.fn();
    const exit = await runProductionPostPromotionPitrObservation({
      argv: [], env: {}, fetchImpl: fetchImpl as typeof fetch,
      writeOutput: (source) => { stdout += source; },
    });
    expect(exit).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toEqual({
      failureCode: "arguments_invalid", ok: false, schemaVersion: 1,
    });
  });
});
