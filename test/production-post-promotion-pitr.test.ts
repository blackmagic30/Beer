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
import { writeLogicalOffsiteFixture } from "./postgres-logical-offsite.fixtures.js";

const CANDIDATE = "c".repeat(40);
const ROOT_SERVICE = "11111111-1111-4111-8111-111111111111";
const MEMBER_SERVICE = "22222222-2222-4222-8222-222222222222";
const WORKFLOW = "33333333-3333-4333-8333-333333333333";
const PROJECT = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT = "13dab015-df74-45c6-b26f-69323daea99a";
const DEPLOYMENT_ID_SHA256 = "d".repeat(64);
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
    fs.writeFileSync(deploymentFile, canonicalPostgresBackupJson({
      schemaVersion: "pintpath-railway-application-deployment-executor/v4",
      target: "production",
      candidateSha: CANDIDATE,
      deploymentIdSha256: DEPLOYMENT_ID_SHA256,
      completedAt: "2026-08-14T00:01:00.000Z",
      checks: { exact: true },
    }), { mode: 0o600 });
    fs.chmodSync(deploymentFile, 0o600);
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
      productionDeploymentIdSha256: DEPLOYMENT_ID_SHA256,
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
