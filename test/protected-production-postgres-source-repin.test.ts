import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_POSTGRES_SOURCE_LOCK_BOUNDARY_POLICY_SHA256,
  PRODUCTION_POSTGRES_SOURCE_LOCK_POLICY_SHA256,
  PRODUCTION_POSTGRES_SOURCE_REPIN_COMMIT_MUTATION,
  PRODUCTION_POSTGRES_SOURCE_REPIN_DISMISS_MUTATION,
  PRODUCTION_POSTGRES_SOURCE_REPIN_STAGE_MUTATION,
  PRODUCTION_POSTGRES_SOURCE_REPIN_STATE_QUERY,
  protectedProductionPostgresSourceRepinInternals,
  runProtectedProductionPostgresSourceRepin,
} from "../scripts/execute-protected-production-postgres-source-repin.js";

const CANDIDATE = "a".repeat(40);
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "4a2334a1-71e7-4745-970a-2cd95da10169";
const SERVICE_INSTANCE_ID = "bba99cde-3f9b-4045-b349-93da78461b44";
const DEPLOYMENT_ID = "f31d3dbd-a997-42cf-b3a8-970b8c337841";
const SNAPSHOT_ID = "03f6d2ff-e78e-42a5-a78f-216a4a1f498d";
const RUNNING_INSTANCE_ID = "0a8b344a-8d17-4f77-8f1b-1677dcf122de";
const VOLUME_INSTANCE_ID = "74cbfae2-3383-40b4-8464-21a403ca509d";
const VOLUME_ID = "a3585b0a-b57a-4b69-ad45-05f798e739e1";
const PATCH_ID = "11111111-1111-4111-8111-111111111111";
const BASELINE_ETAG =
  "e50589bf4093433313fd07b844b6e25eeb69878679626006edb9784629989bf9";
const MUTABLE_SOURCE = "ghcr.io/railwayapp-templates/postgres-ssl:17";
const IMAGE_DIGEST =
  "sha256:7383de344f558c61a16ecdcb3e6fc86f05c45c82a4e02ad77d96aa72b5ae2ba8";
const IMMUTABLE_SOURCE = `ghcr.io/railwayapp-templates/postgres-ssl@${IMAGE_DIGEST}`;
const PRODUCTION_METADATA_TOKEN = "production-metadata-token-unique";
const STAGING_METADATA_TOKEN = "staging-metadata-token-unique";
const MUTATION_TOKEN = "production-source-writer-token-unique";
const RUN_ID = "12345";
const PRIOR_RUN_ID = "12344";
const INCIDENT_CANDIDATE =
  "52049a1ef414e274e47197e28726387c90d96990";
const INCIDENT_RUN_ID = "33923801697";
const RECOVERY_BRIDGE_CANDIDATE =
  "4edaddbee03e44f7d2e0cb808b2357e7e5739db5";
const INCIDENT_DISMISSED_ETAG =
  "ac5fb1e97cc4451ab5c09d05ecf1bcf591646a90d04945017a68616363b3227f";

const BOUNDARY_CHECK_NAMES = [
  "policyValid",
  "queriesMetadataOnly",
  "productionTokenScopeExact",
  "stagingTokenScopeExact",
  "productionEnvironmentExact",
  "stagingEnvironmentExact",
  "productionPatchEmpty",
  "stagingPatchEmpty",
  "productionPostgresExact",
  "approvedDeploymentCurrent",
  "approvedDeploymentActive",
  "approvedDeploymentHealthy",
  "approvedSnapshotExact",
  "approvedImageDigestExact",
  "deploymentPatchAbsent",
  "deploymentRecordedSourceExact",
  "sourceImageExact",
  "autoUpdatesDisabledExact",
  "sourceReferenceImmutable",
] as const;

type BoundaryCheckName = (typeof BOUNDARY_CHECK_NAMES)[number];

const SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS: readonly BoundaryCheckName[] =
  [
    "sourceImageExact",
    "autoUpdatesDisabledExact",
    "sourceReferenceImmutable",
  ] as const;
const SOURCE_LOCK_NON_EXEMPT_BOUNDARY_CHECKS = BOUNDARY_CHECK_NAMES.filter(
  (name) => !SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS.includes(name),
);

type StateKind = "armed" | "dismissed" | "staged" | "desired";
type Phase = "prepare" | "apply" | "reconcile";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(source: string | Buffer): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function boundary(falseChecks: readonly string[] = []) {
  const rejected = new Set(falseChecks);
  const checks = Object.fromEntries(
    BOUNDARY_CHECK_NAMES.map((name) => [name, !rejected.has(name)]),
  ) as Record<(typeof BOUNDARY_CHECK_NAMES)[number], boolean>;
  return {
    code: falseChecks.length === 0 ? (0 as const) : (1 as const),
    checks,
  };
}

const baselineBoundary = () =>
  boundary(SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS);
const stagedBoundary = () =>
  boundary([
    "productionPatchEmpty",
    "sourceImageExact",
    "autoUpdatesDisabledExact",
    "sourceReferenceImmutable",
  ]);

function deployment(instanceId = RUNNING_INSTANCE_ID) {
  return {
    id: DEPLOYMENT_ID,
    projectId: PROJECT_ID,
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    status: "SUCCESS",
    deploymentStopped: false,
    snapshotId: SNAPSHOT_ID,
    instances: [{ id: instanceId, status: "RUNNING" }],
  };
}

function removedDeployment(
  id: string,
  instanceId: string,
  snapshotId: string,
  instances: { id: string; status: string }[] = [
    { id: instanceId, status: "REMOVED" },
  ],
) {
  return {
    id,
    projectId: PROJECT_ID,
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    status: "REMOVED",
    deploymentStopped: true,
    snapshotId,
    instances,
  };
}

function emptyPatch() {
  return {
    id: "<empty>",
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    status: "STAGED",
    message: null,
    createdAt: null,
    updatedAt: null,
    appliedAt: null,
    lastAppliedError: null,
    patch: {},
  };
}

function stagedPatch() {
  return {
    id: PATCH_ID,
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    status: "STAGED",
    message: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
    appliedAt: null,
    lastAppliedError: null,
    patch:
      protectedProductionPostgresSourceRepinInternals.providerNormalizedPatch(),
  };
}

function committedPatch(runId: string, candidateSha = CANDIDATE) {
  return {
    id: PATCH_ID,
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    status: "COMMITTED",
    message: `pintpath:production-postgres-source-lock:${candidateSha}:${runId}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:03.000Z",
    appliedAt: "2026-09-01T00:00:02.000Z",
    lastAppliedError: null,
    patch:
      protectedProductionPostgresSourceRepinInternals.providerNormalizedPatch(),
  };
}

function autoUpdates(kind: StateKind): unknown {
  if (kind === "armed") {
    return protectedProductionPostgresSourceRepinInternals.ARMED_AUTO_UPDATES;
  }
  if (kind === "desired") {
    return protectedProductionPostgresSourceRepinInternals.DESIRED_AUTO_UPDATES;
  }
  return protectedProductionPostgresSourceRepinInternals.DISMISSED_AUTO_UPDATES;
}

function providerState(
  kind: StateKind,
  options: {
    runId?: string;
    runningInstanceId?: string;
    autoUpdatesOverride?: unknown;
    historyOverride?: unknown[];
    configEtag?: string;
    intentCandidateSha?: string;
  } = {},
) {
  const instanceId = options.runningInstanceId ?? RUNNING_INSTANCE_ID;
  const exactDeployment = deployment(instanceId);
  const sourceImage = kind === "desired" ? IMMUTABLE_SOURCE : MUTABLE_SOURCE;
  const activePatch = kind === "staged" ? stagedPatch() : emptyPatch();
  const history =
    options.historyOverride ??
    (kind === "desired"
      ? [
          committedPatch(
            options.runId ?? RUN_ID,
            options.intentCandidateSha ?? CANDIDATE,
          ),
        ]
      : kind === "staged"
        ? [stagedPatch()]
        : []);
  return {
    data: {
      environment: {
        id: PRODUCTION_ENVIRONMENT_ID,
        configEtag:
          options.configEtag ??
          (kind === "armed" ? BASELINE_ETAG : "c".repeat(64)),
        config: {
          services: {
            [SERVICE_ID]: {
              source: {
                image: sourceImage,
                autoUpdates: options.autoUpdatesOverride ?? autoUpdates(kind),
              },
            },
          },
        },
        volumeInstances: {
          edges: [
            {
              node: {
                id: "6100f33b-7425-4a3f-b53c-5d0ae666b429",
                environmentId: PRODUCTION_ENVIRONMENT_ID,
                serviceId: "d6351cec-fe04-4a6f-8e05-1cc164ea1e73",
                volumeId: "372b736a-fa8b-4ca0-88bc-68760fc98d69",
                deletedAt: null,
                isPendingDeletion: false,
                mountPath: "/data",
                region: "europe-west4-drams3a",
                volume: { id: "372b736a-fa8b-4ca0-88bc-68760fc98d69" },
              },
            },
            {
              node: {
                id: VOLUME_INSTANCE_ID,
                environmentId: PRODUCTION_ENVIRONMENT_ID,
                serviceId: SERVICE_ID,
                volumeId: VOLUME_ID,
                deletedAt: null,
                isPendingDeletion: false,
                mountPath: "/var/lib/postgresql/data",
                region: "asia-southeast1-eqsg3a",
                volume: { id: VOLUME_ID },
              },
            },
            {
              node: {
                id: "f11459c6-a360-4636-abf8-b6ba25bba64f",
                environmentId: PRODUCTION_ENVIRONMENT_ID,
                serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
                volumeId: "ba8ef214-9f16-4c35-9bbd-7169a8a91e68",
                deletedAt: null,
                isPendingDeletion: false,
                mountPath: "/app/data",
                region: "asia-southeast1-eqsg3a",
                volume: { id: "ba8ef214-9f16-4c35-9bbd-7169a8a91e68" },
              },
            },
          ],
          pageInfo: {
            hasNextPage: false,
            endCursor: "volume-instances-end",
          },
        },
      },
      staged: activePatch,
      patchHistory: {
        edges: history.map((node) => ({ node })),
        pageInfo: {
          hasNextPage: false,
          endCursor: history.length === 0 ? null : "patch-history-end",
        },
      },
      serviceInstance: {
        id: SERVICE_INSTANCE_ID,
        serviceId: SERVICE_ID,
        environmentId: PRODUCTION_ENVIRONMENT_ID,
        numReplicas: 1,
        region: null,
        source: { image: sourceImage, repo: null },
        latestDeployment: exactDeployment,
        activeDeployments: [exactDeployment],
      },
      deployments: {
        edges: [
          { node: exactDeployment },
          {
            node: removedDeployment(
              "ccb513ee-c850-49a1-a205-9ab8ab7534cc",
              "a73d456f-d2a1-4d8d-aaea-c87b3c8a73d5",
              "f2a08518-2336-4837-a77b-11852cf2a8ab",
            ),
          },
          {
            node: removedDeployment(
              "fe94a81a-aeb3-46ae-ad7f-b1907f0cfe5e",
              "6ed6d2ad-c657-4c30-9941-1f58b5766e1f",
              "b78b9bea-25fd-431d-b1f6-8a65c0e24843",
            ),
          },
          {
            node: removedDeployment(
              "c6004774-7680-41ec-a816-d872221d5890",
              "f17fa8b4-74e9-431c-8765-ff3e09f121fd",
              "3f601066-8b66-4315-8f2e-ef499d17fad8",
            ),
          },
          {
            node: removedDeployment(
              "e0e040eb-310d-40fa-b2b8-14897d80e683",
              "4a9190b5-2c74-4e94-ae3c-718179ff569f",
              "e87dbeb5-c86c-47f7-bccc-fe6bdd25a4b1",
              [
                {
                  id: "4a9190b5-2c74-4e94-ae3c-718179ff569f",
                  status: "REMOVED",
                },
                {
                  id: "a1fce5d4-337f-4a00-9904-3e39e3cec3d4",
                  status: "REMOVED",
                },
              ],
            ),
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: "deployments-end" },
      },
      baselineDeployment: {
        ...exactDeployment,
        meta: {
          image: MUTABLE_SOURCE,
          imageDigest: IMAGE_DIGEST,
          patchId: null,
        },
      },
    },
  };
}

function patchReadback() {
  return { data: { active: stagedPatch(), selected: stagedPatch() } };
}

function stageAcknowledgement() {
  const { patch: _patch, ...acknowledgement } = stagedPatch();
  return { data: { environmentStageChanges: acknowledgement } };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createEvidence(runId = RUN_ID, safePrior = [PRIOR_RUN_ID]) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-production-postgres-source-lock-"),
    ),
  );
  temporaryDirectories.push(directory);
  fs.chmodSync(directory, 0o700);
  const authorityFile = path.join(directory, "reviewed-authority.json");
  writeAuthority(authorityFile, runId, safePrior);
  return { directory, authorityFile };
}

function writeAuthority(filename: string, runId: string, safePrior: string[]) {
  fs.writeFileSync(
    filename,
    `${JSON.stringify({
      command: "verify-github-reviewed-candidate-authority",
      ok: true,
      schemaVersion: 1,
      kind: "pintpath-github-reviewed-candidate-authority",
      repository: "blackmagic30/Beer",
      candidateSha: CANDIDATE,
      reviewedPrHeadSha: "b".repeat(40),
      reviewedPullRequestNumber: 88,
      operation: "production-postgres-source-repin",
      workflowPath: ".github/workflows/repin-production-postgres-source.yml",
      workflowRunId: runId,
      workflowRunAttempt: 1,
      workflowRunCreatedAt: "2026-09-01T00:10:00.000Z",
      reviewedPullRequestMergedAt: "2026-09-01T00:00:00.000Z",
      candidateHistoryMaximumAgeHours: 168,
      completeRetainedHistoryExact: true,
      safePriorSkippedWriteRunIds: safePrior,
      reviewedAuthorityExact: true,
      freshDispatchWriteGuardExact: true,
    })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(filename, 0o600);
}

function writeReconcileAuthority(
  filename: string,
  runId: string,
  priorRunId: string,
  safePrior: string[] = [],
  originalRunCompletedAt = "2026-09-01T00:08:00.000Z",
  priorCandidateSha = CANDIDATE,
) {
  fs.writeFileSync(
    filename,
    `${JSON.stringify({
      command: "verify-github-reviewed-candidate-authority",
      ok: true,
      schemaVersion: 1,
      kind: "pintpath-github-reviewed-candidate-authority",
      repository: "blackmagic30/Beer",
      candidateSha: CANDIDATE,
      reviewedPrHeadSha: "b".repeat(40),
      reviewedPullRequestNumber: 88,
      operation: "production-postgres-source-repin-reconcile",
      workflowPath: ".github/workflows/repin-production-postgres-source.yml",
      workflowRunId: runId,
      workflowRunAttempt: 1,
      workflowRunCreatedAt: "2026-09-01T00:10:00.000Z",
      reviewedPullRequestMergedAt: "2026-09-01T00:00:00.000Z",
      candidateHistoryMaximumAgeHours: 168,
      completeRetainedHistoryExact: true,
      safePriorSkippedWriteRunIds: safePrior,
      reviewedAuthorityExact: true,
      freshDispatchWriteGuardExact: true,
      priorAmbiguousProductionPostgresSourceRepinRunId: priorRunId,
      priorProductionPostgresSourceRepinIntentCandidateSha:
        priorCandidateSha,
      crossCandidateProductionPostgresSourceRepinRecoveryExact:
        priorCandidateSha !== CANDIDATE,
      productionPostgresSourceRepinRecoveryChainCandidateShas:
        priorCandidateSha === CANDIDATE
          ? [CANDIDATE]
          : [priorCandidateSha, RECOVERY_BRIDGE_CANDIDATE, CANDIDATE],
      productionPostgresSourceRepinRecoveryBridgeExact:
        priorCandidateSha !== CANDIDATE,
      exactPriorProductionPostgresSourceRepinCandidateRunBound: true,
      secondProductionPostgresRemediationDismissPreventedExact: true,
      runnerLossRecoveryOriginalRunCompletedAt: originalRunCompletedAt,
      runnerLossRecoverySettlementSeconds: 60,
      runnerLossRecoveryGraceHours:
        priorCandidateSha === CANDIDATE ? 24 : 168,
      runnerLossRecoveryWithinGraceExact: true,
    })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(filename, 0o600);
}

function environment(
  phase: Phase,
  runId = RUN_ID,
  options: { mutationToken?: string; priorGrace?: boolean } = {},
) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: "1",
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_REPIN_CONFIRMATION:
      "LOCK_PRODUCTION_POSTGRES_SOURCE_AND_DISABLE_AUTO_UPDATES_WITHOUT_DEPLOY",
    PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION:
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
    PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: PRODUCTION_METADATA_TOKEN,
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: STAGING_METADATA_TOKEN,
    ...(phase === "prepare"
      ? {}
      : {
          PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN:
            options.mutationToken ?? MUTATION_TOKEN,
        }),
    ...(options.priorGrace
      ? {
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_GRACE:
            "I_ATTEST_PRIOR_SOURCE_LOCK_RUN_ENDED_AND_NO_WRITER_IS_ACTIVE",
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_CANDIDATE_SHA:
            CANDIDATE,
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_ID: PRIOR_RUN_ID,
        }
      : {}),
  };
}

function argsFor(
  phase: Phase,
  evidence: ReturnType<typeof createEvidence>,
  intentFile?: string,
  priorCandidateSha = CANDIDATE,
) {
  return [
    "--phase",
    phase,
    "--candidate-sha",
    CANDIDATE,
    "--github-authority",
    evidence.authorityFile,
    "--evidence-dir",
    evidence.directory,
    ...(phase === "reconcile"
      ? ["--prior-candidate-sha", priorCandidateSha]
      : []),
    ...(phase === "prepare" ? [] : ["--intent-file", intentFile!]),
  ];
}

interface ProviderOptions {
  states?: Array<unknown | "FAIL">;
  patches?: Array<unknown | "FAIL">;
  dismiss?: "ok" | "fail";
  stage?: "ok" | "fail";
  commit?: "ok" | "fail";
  wrongScopeToken?: string;
}

function providerMock(options: ProviderOptions = {}) {
  const states = [...(options.states ?? [])];
  const patches = [...(options.patches ?? [])];
  const calls: Array<{
    operationName: string;
    token: string;
    variables: Record<string, unknown>;
  }> = [];
  const fetchImpl = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const token = headers["Project-Access-Token"];
      const body = JSON.parse(String(init?.body)) as {
        operationName: string;
        variables: Record<string, unknown>;
      };
      calls.push({
        operationName: body.operationName,
        token,
        variables: body.variables,
      });
      if (body.operationName === "PintPathProductionPostgresSourceLockScope") {
        return response({
          data: {
            projectToken: {
              projectId: PROJECT_ID,
              environmentId:
                token === options.wrongScopeToken
                  ? STAGING_ENVIRONMENT_ID
                  : token === STAGING_METADATA_TOKEN
                    ? STAGING_ENVIRONMENT_ID
                    : PRODUCTION_ENVIRONMENT_ID,
            },
          },
        });
      }
      if (body.operationName === "PintPathProductionPostgresSourceLockState") {
        const value = states.shift();
        return value === undefined || value === "FAIL"
          ? response({}, 503)
          : response(value);
      }
      if (
        body.operationName === "PintPathProductionPostgresSourceLockDismiss"
      ) {
        return options.dismiss === "fail"
          ? response({}, 503)
          : response({
              data: { serviceInstanceVulnRemediationDismiss: true },
            });
      }
      if (body.operationName === "PintPathProductionPostgresSourceLockStage") {
        return options.stage === "fail"
          ? response({}, 503)
          : response(stageAcknowledgement());
      }
      if (body.operationName === "PintPathProductionPostgresSourceLockPatch") {
        const value = patches.shift();
        return value === undefined || value === "FAIL"
          ? response({}, 503)
          : response(value);
      }
      if (body.operationName === "PintPathProductionPostgresSourceLockCommit") {
        return options.commit === "fail"
          ? response({}, 503)
          : response({
              data: {
                environmentPatchCommitStaged: `commitChanges/${PRODUCTION_ENVIRONMENT_ID}/${PATCH_ID}`,
              },
            });
      }
      return response({}, 500);
    },
  );
  return { fetchImpl, calls, states, patches };
}

async function run(
  phase: Phase,
  evidence: ReturnType<typeof createEvidence>,
  provider: ReturnType<typeof providerMock>,
  observations: ReturnType<typeof boundary>[],
  env = environment(phase),
  intentFile?: string,
  now: () => number = () => Date.parse("2026-09-01T00:10:00.000Z"),
  priorCandidateSha = CANDIDATE,
) {
  let output = "";
  const code = await runProtectedProductionPostgresSourceRepin({
    argv: argsFor(phase, evidence, intentFile, priorCandidateSha),
    env,
    cwd: process.cwd(),
    fetchImpl: provider.fetchImpl as typeof fetch,
    runBoundary: async () => observations.shift()!,
    verifyPolicy: () => true,
    now,
    writeOutput: (source) => {
      output += source;
    },
  });
  return { code, receipt: JSON.parse(output), output };
}

async function prepare(runId = RUN_ID): Promise<{
  evidence: ReturnType<typeof createEvidence>;
  intentFile: string;
  intentSha: string;
}> {
  const evidence = createEvidence(
    runId,
    runId === RUN_ID ? [PRIOR_RUN_ID] : [],
  );
  const provider = providerMock({ states: [providerState("armed")] });
  const result = await run(
    "prepare",
    evidence,
    provider,
    [baselineBoundary()],
    environment("prepare", runId),
  );
  expect(result.code, result.output).toBe(0);
  const intentFile = path.join(evidence.directory, "source-lock-intent.json");
  return {
    evidence,
    intentFile,
    intentSha: sha256(fs.readFileSync(intentFile)),
  };
}

function historicalIncidentPrepared(): {
  evidence: ReturnType<typeof createEvidence>;
  intentFile: string;
  intentSha: string;
} {
  const evidence = createEvidence(INCIDENT_RUN_ID, []);
  const intentFile = path.join(evidence.directory, "source-lock-intent.json");
  const intent = {
    schemaVersion: "pintpath-production-postgres-source-lock-intent/v2",
    operation: "production-postgres-source-repin",
    candidateSha: INCIDENT_CANDIDATE,
    githubRunId: INCIDENT_RUN_ID,
    reviewedAuthoritySha256:
      "5526eab8a9ed4f252ac9976af2bcfbd354a8d3adab2016f46936c652d37c73c6",
    reviewedPullRequestNumber: 81,
    projectId: PROJECT_ID,
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    serviceInstanceId: SERVICE_INSTANCE_ID,
    deploymentId: DEPLOYMENT_ID,
    snapshotId: SNAPSHOT_ID,
    runningInstanceId: RUNNING_INSTANCE_ID,
    volumeInstanceId: VOLUME_INSTANCE_ID,
    volumeId: VOLUME_ID,
    sourceBefore: MUTABLE_SOURCE,
    sourceAfter: IMMUTABLE_SOURCE,
    baselineConfigEtag: BASELINE_ETAG,
    runtimeBeforeSha256:
      "55087986055cb1f247c4011e07e0b8ea856daa15f9fd04b90d33c0dec2482b48",
    armedAutoUpdatesSha256:
      "b7a7680c3c8e27e2c29eae1de29d1f710f3f8715a40335fbeb4dd792bbfe28c2",
    requestedPatchSha256:
      "833695a9060fa01b798dd73ac440080652253baac0e3c43b04a149515ed34dcd",
    providerNormalizedPatchSha256:
      "01806817d0d79894a0d1ab3cff8e484a5ec6a04840b91fbbc2d05813c026e55a",
    commitMessage: `pintpath:production-postgres-source-lock:${INCIDENT_CANDIDATE}:${INCIDENT_RUN_ID}`,
    externalMutationFreeze:
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
    retryAllowed: false,
    deploymentAllowed: false,
    secretMaterialIncluded: false,
    rawProviderMetadataIncluded: false,
  };
  fs.writeFileSync(intentFile, `${JSON.stringify(intent, null, 2)}\n`, {
    mode: 0o600,
  });
  const intentSha = sha256(fs.readFileSync(intentFile));
  expect(intentSha).toBe(
    "61381d0ea3fd5394bb4de33b63379fcd13f524614797a434ff2b3e13f862bf9c",
  );
  return { evidence, intentFile, intentSha };
}

function boundEnvironment(
  phase: "apply" | "reconcile",
  prepared: Awaited<ReturnType<typeof prepare>>,
  currentRunId = RUN_ID,
  priorGrace = false,
) {
  const intent = JSON.parse(fs.readFileSync(prepared.intentFile, "utf8")) as {
    githubRunId: string;
    candidateSha: string;
  };
  const crossCandidate =
    phase === "reconcile" && intent.candidateSha !== CANDIDATE;
  return {
    ...environment(phase, currentRunId, { priorGrace }),
    ...(phase === "reconcile"
      ? {
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_CANDIDATE_SHA:
            intent.candidateSha,
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_ID:
            intent.githubRunId,
        }
      : {}),
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_SHA256: prepared.intentSha,
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_ID: crossCandidate
      ? "9956146300"
      : "777",
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_DIGEST:
      crossCandidate
        ? "sha256:03f39ec4e154809d7f778067fed83ba908af4a30e4b17a5a70809c1bbe6654f3"
        : `sha256:${"d".repeat(64)}`,
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_NAME: `pintpath-production-postgres-source-lock-intent-${intent.candidateSha}-${intent.githubRunId}`,
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_RUN_ID:
      intent.githubRunId,
    ...(crossCandidate
      ? {
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_ID:
            "9956147717",
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_DIGEST:
            "sha256:56829b4867083450e79eca099c75e1535453256cc4341611674f5228e34ec785",
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_SIZE:
            "5869",
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_APPLY_TERMINAL_SHA256:
            "608420a0186048d2f60b376774444f116d411029a359734e8d0b5fcdf296f431",
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_APPLY_RECEIPT_SHA256:
            "571c8b3269d557392c2fac317e330d9d28a38a95838265a926922f284b651b36",
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_EVIDENCE_EXACT:
            "true",
        }
      : {}),
  };
}

function parsedIntentArgs(prepared: Awaited<ReturnType<typeof prepare>>) {
  const args = protectedProductionPostgresSourceRepinInternals.parseArgs(
    argsFor("apply", prepared.evidence, prepared.intentFile),
  );
  if (args === null) throw new Error("expected valid intent arguments");
  return args;
}

function mutationCalls(provider: ReturnType<typeof providerMock>) {
  return provider.calls.filter((call) =>
    [
      "PintPathProductionPostgresSourceLockDismiss",
      "PintPathProductionPostgresSourceLockStage",
      "PintPathProductionPostgresSourceLockCommit",
    ].includes(call.operationName),
  );
}

describe("protected production Postgres source lock", () => {
  it("pins and validates the complete reviewed v3 policy contract", () => {
    expect(PRODUCTION_POSTGRES_SOURCE_LOCK_POLICY_SHA256).toBe(
      "b384d6433c45a365ab70ec395213e10f7d3be881bc6b8186d2653d95a80754f7",
    );
    expect(PRODUCTION_POSTGRES_SOURCE_LOCK_BOUNDARY_POLICY_SHA256).toBe(
      "a61ccb5493bbb15e37c8b158f441219b4540937d9dd0ab46ddc0a0cf0be84079",
    );
    expect(
      protectedProductionPostgresSourceRepinInternals.policyExact(
        process.cwd(),
      ),
    ).toBe(true);
    const policy = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "ops/railway/protected-production-postgres-source-repin-policy.json",
        ),
        "utf8",
      ),
    ) as {
      securityRemediation: unknown;
      autoUpdates: { armed: { remediationNotice: { currentVersion: string } } };
    };
    expect(policy.securityRemediation).toEqual({
      cveId: "CVE-2026-15741",
      affectedVersions: "before 17.11",
      fixedVersion: "17.11",
      officialAdvisory:
        "https://www.postgresql.org/support/security/CVE-2026-15741/",
      observedRunningDatabaseVersion: "17.11",
      runtimeObservationMode: "READ_ONLY_SQL_SHOW_SERVER_VERSION",
      approvedDigestMatchesObservedRunningDeployment: true,
      armedNoticeCurrentVersionIsPreRemediationBaseline: "17.10",
      sourceLockMustNotDeploy: true,
    });
    expect(policy.autoUpdates.armed.remediationNotice.currentVersion).toBe(
      "17.10",
    );
  });

  it("binds the current runtime and exact source/auto-update mutation primitives", () => {
    expect(PRODUCTION_POSTGRES_SOURCE_REPIN_STATE_QUERY).toContain(
      "config(decryptVariables: false)",
    );
    expect(PRODUCTION_POSTGRES_SOURCE_REPIN_STATE_QUERY).toContain(
      "patchHistory: environmentPatches",
    );
    expect(PRODUCTION_POSTGRES_SOURCE_REPIN_DISMISS_MUTATION).toContain(
      "serviceInstanceVulnRemediationDismiss",
    );
    expect(PRODUCTION_POSTGRES_SOURCE_REPIN_STAGE_MUTATION).toContain(
      "environmentStageChanges",
    );
    expect(PRODUCTION_POSTGRES_SOURCE_REPIN_COMMIT_MUTATION).toContain(
      "environmentPatchCommitStaged",
    );
    expect(PRODUCTION_POSTGRES_SOURCE_REPIN_COMMIT_MUTATION).toContain(
      "skipDeploys: $skipDeploys",
    );
    expect(
      protectedProductionPostgresSourceRepinInternals.requestedPatch(),
    ).toEqual({
      services: {
        [SERVICE_ID]: {
          source: {
            image: IMMUTABLE_SOURCE,
            autoUpdates: {
              type: "disabled",
              schedule: null,
              tagMode: null,
              remediationNotice: null,
              snoozedUntil: null,
            },
          },
        },
      },
    });
    expect(
      protectedProductionPostgresSourceRepinInternals.providerNormalizedPatch(),
    ).toEqual({
      services: {
        [SERVICE_ID]: {
          source: {
            image: IMMUTABLE_SOURCE,
            autoUpdates: {
              type: "disabled",
              schedule: null,
              tagMode: null,
            },
          },
        },
      },
    });
  });

  it("accepts complete non-empty Relay pages and rejects pagination or truncation", () => {
    const parseNode = (value: unknown): string | null =>
      typeof value === "string" ? value : null;
    const exact = {
      edges: [{ node: "one" }],
      pageInfo: { hasNextPage: false, endCursor: "terminal-cursor" },
    };

    expect(
      protectedProductionPostgresSourceRepinInternals.parseConnection(
        exact,
        parseNode,
        100,
      ),
    ).toEqual(["one"]);
    expect(
      protectedProductionPostgresSourceRepinInternals.parseConnection(
        {
          ...exact,
          pageInfo: { hasNextPage: true, endCursor: "terminal-cursor" },
        },
        parseNode,
        100,
      ),
    ).toBeNull();
    expect(
      protectedProductionPostgresSourceRepinInternals.parseConnection(
        {
          ...exact,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        parseNode,
        100,
      ),
    ).toBeNull();
    expect(
      protectedProductionPostgresSourceRepinInternals.parseConnection(
        {
          edges: Array.from({ length: 101 }, (_, index) => ({
            node: String(index),
          })),
          pageInfo: { hasNextPage: false, endCursor: "terminal-cursor" },
        },
        parseNode,
        100,
      ),
    ).toBeNull();
    expect(
      protectedProductionPostgresSourceRepinInternals.parseConnection(
        {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        parseNode,
        100,
      ),
    ).toEqual([]);
  });

  it("prepare is metadata-only, validates exact armed state, and durably records intent", async () => {
    const evidence = createEvidence();
    const provider = providerMock({ states: [providerState("armed")] });
    const result = await run("prepare", evidence, provider, [
      baselineBoundary(),
    ]);

    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      phase: "prepare",
      outcome: "prepared",
      totalMutationCalls: 0,
      checks: {
        baselineExact: true,
        boundaryPreflightExact: true,
        durableIntentExact: true,
        terminalEvidenceExact: true,
        receiptEvidenceExact: true,
      },
    });
    expect(mutationCalls(provider)).toHaveLength(0);
    for (const leaf of [
      "source-lock-intent.json",
      "prepare-terminal.json",
      "prepare-receipt.json",
    ]) {
      expect(
        fs.statSync(path.join(evidence.directory, leaf)).mode & 0o077,
      ).toBe(0);
    }
  });

  it("accepts Railway's synthesized timestamps on the canonical empty patch sentinel", async () => {
    const evidence = createEvidence();
    const state = providerState("armed");
    state.data.staged.createdAt = "2026-09-04T21:17:08.430Z";
    state.data.staged.updatedAt = "2026-09-04T21:17:08.430Z";
    const provider = providerMock({ states: [state] });

    const result = await run("prepare", evidence, provider, [
      baselineBoundary(),
    ]);

    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      outcome: "prepared",
      totalMutationCalls: 0,
      checks: { baselineExact: true, durableIntentExact: true },
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it("rejects reversed synthesized timestamps on the empty patch sentinel", async () => {
    const evidence = createEvidence();
    const state = providerState("armed");
    state.data.staged.createdAt = "2026-09-04T21:17:09.430Z";
    state.data.staged.updatedAt = "2026-09-04T21:17:08.430Z";
    const provider = providerMock({ states: [state] });

    const result = await run("prepare", evidence, provider, [
      baselineBoundary(),
    ]);

    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      totalMutationCalls: 0,
      checks: { baselineExact: false },
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it("rejects a symlinked reviewed-authority file before contacting Railway", async () => {
    const evidence = createEvidence();
    const authorityTarget = path.join(
      evidence.directory,
      "reviewed-authority-target.json",
    );
    fs.renameSync(evidence.authorityFile, authorityTarget);
    fs.symlinkSync(authorityTarget, evidence.authorityFile);
    const provider = providerMock();

    const result = await run(
      "prepare",
      evidence,
      provider,
      [],
      environment("prepare"),
    );

    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { authorityExact: false },
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a group-readable reviewed-authority file before contacting Railway", async () => {
    const evidence = createEvidence();
    fs.chmodSync(evidence.authorityFile, 0o640);
    const provider = providerMock();

    const result = await run(
      "prepare",
      evidence,
      provider,
      [],
      environment("prepare"),
    );

    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { authorityExact: false },
    });
    expect(provider.calls).toHaveLength(0);
  });

  it.each(["symlink", "group-readable", "hard-link", "oversized"] as const)(
    "rejects an unsafe %s intent file through held descriptor custody",
    async (unsafeKind) => {
      const prepared = await prepare();
      const args = parsedIntentArgs(prepared);
      if (unsafeKind === "symlink") {
        const target = path.join(
          prepared.evidence.directory,
          "source-lock-intent-target.json",
        );
        fs.renameSync(prepared.intentFile, target);
        fs.symlinkSync(target, prepared.intentFile);
      } else if (unsafeKind === "group-readable") {
        fs.chmodSync(prepared.intentFile, 0o640);
      } else if (unsafeKind === "hard-link") {
        fs.linkSync(
          prepared.intentFile,
          path.join(
            prepared.evidence.directory,
            "source-lock-intent-link.json",
          ),
        );
      } else {
        fs.appendFileSync(prepared.intentFile, Buffer.alloc(65_536, 0x20));
      }

      expect(
        protectedProductionPostgresSourceRepinInternals.parseIntent(
          prepared.intentFile,
          args,
        ),
      ).toBeNull();
    },
  );

  it("rejects a symlinked intent before any source-lock writer call", async () => {
    const prepared = await prepare();
    const target = path.join(
      prepared.evidence.directory,
      "source-lock-intent-target.json",
    );
    fs.renameSync(prepared.intentFile, target);
    fs.symlinkSync(target, prepared.intentFile);
    const provider = providerMock();

    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );

    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { intentExact: false },
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it(
    "rejects an intent pathname replacement after no-follow open and closes the held descriptor",
    async () => {
      const prepared = await prepare();
      const args = parsedIntentArgs(prepared);
      const source = fs.readFileSync(prepared.intentFile);
      const displaced = path.join(
        prepared.evidence.directory,
        "source-lock-intent-held.json",
      );
      const originalOpen = fs.openSync.bind(fs);
      let heldDescriptor: number | null = null;
      let replaced = false;
      const open = vi.spyOn(fs, "openSync").mockImplementation(
        ((filename, flags, mode) => {
          const descriptor = originalOpen(filename, flags, mode);
          if (
            !replaced &&
            filename === prepared.intentFile &&
            typeof flags === "number" &&
            (flags & fs.constants.O_NOFOLLOW) !== 0
          ) {
            replaced = true;
            heldDescriptor = descriptor;
            fs.renameSync(prepared.intentFile, displaced);
            fs.writeFileSync(prepared.intentFile, source, { mode: 0o600 });
          }
          return descriptor;
        }) as typeof fs.openSync,
      );

      expect(
        protectedProductionPostgresSourceRepinInternals.parseIntent(
          prepared.intentFile,
          args,
        ),
      ).toBeNull();
      open.mockRestore();
      expect(heldDescriptor).not.toBeNull();
      expect(() => fs.fstatSync(heldDescriptor!)).toThrow();
      source.fill(0);
    },
  );

  it("rejects a mutation credential in prepare and still writes terminal evidence", async () => {
    const evidence = createEvidence();
    const provider = providerMock();
    const env = {
      ...environment("prepare"),
      PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN: MUTATION_TOKEN,
    };
    const result = await run("prepare", evidence, provider, [], env);
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { credentialsExact: false, terminalEvidenceExact: true },
    });
    expect(provider.calls).toHaveLength(0);
    expect(
      fs.existsSync(path.join(evidence.directory, "source-lock-intent.json")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(evidence.directory, "prepare-terminal.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(evidence.directory, "prepare-receipt.json")),
    ).toBe(true);
  });

  it("rejects wrong/non-distinct token scopes before any writer call", async () => {
    const prepared = await prepare();
    const provider = providerMock({ wrongScopeToken: MUTATION_TOKEN });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { tokenScopesExact: false },
    });
    expect(mutationCalls(provider)).toHaveLength(0);
    expect(
      fs.existsSync(
        path.join(prepared.evidence.directory, "apply-terminal.json"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(prepared.evidence.directory, "apply-receipt.json"),
      ),
    ).toBe(true);
  });

  it("rejects a writer credential that is not distinct before contacting Railway", async () => {
    const prepared = await prepare();
    const provider = providerMock();
    const env = {
      ...boundEnvironment("apply", prepared),
      PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN:
        PRODUCTION_METADATA_TOKEN,
    };
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [],
      env,
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { credentialsExact: false },
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("requires off-runner artifact persistence and authority binding before writes", async () => {
    const prepared = await prepare();
    const provider = providerMock();
    const env = boundEnvironment("apply", prepared);
    delete (env as Record<string, string | undefined>)
      .PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_DIGEST;
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [],
      env,
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { artifactBindingExact: false },
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it("applies once: dismisses, exact-reads twice, stages normalized patch, and commits no-deploy", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      states: [
        providerState("armed"),
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged"),
        providerState("desired"),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [baselineBoundary(), baselineBoundary(), stagedBoundary(), boundary()],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );

    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      outcome: "applied",
      attempts: { dismiss: 1, stage: 1, commit: 1 },
      totalMutationCalls: 3,
      checks: {
        dismissedReadbackExact: true,
        stagedReadbackOneExact: true,
        stagedReadbackTwoExact: true,
        precommitRaceAbsent: true,
        committedHistoryExact: true,
        desiredStateExact: true,
        runtimeContinuityExact: true,
      },
    });
    const stage = provider.calls.find(
      (call) =>
        call.operationName === "PintPathProductionPostgresSourceLockStage",
    );
    expect(stage?.variables).toEqual({
      environmentId: PRODUCTION_ENVIRONMENT_ID,
      input: protectedProductionPostgresSourceRepinInternals.requestedPatch(),
      merge: false,
    });
    const commit = provider.calls.find(
      (call) =>
        call.operationName === "PintPathProductionPostgresSourceLockCommit",
    );
    expect(commit?.variables).toMatchObject({ skipDeploys: true });
  });

  it("accepts a lost dismiss acknowledgement only after exact dismissed readback", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      dismiss: "fail",
      states: [
        providerState("armed"),
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged"),
        providerState("desired"),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [baselineBoundary(), baselineBoundary(), stagedBoundary(), boundary()],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      outcome: "applied_reconciled_after_lost_ack",
      checks: {
        dismissAcknowledgementExact: false,
        dismissedReadbackExact: true,
      },
    });
  });

  it("never stages when a lost dismiss acknowledgement reads back armed state", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      dismiss: "fail",
      states: [providerState("armed"), providerState("armed")],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [baselineBoundary()],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: { dismiss: 1, stage: 0, commit: 0 },
      checks: {
        dismissAcknowledgementExact: false,
        dismissedReadbackExact: false,
      },
    });
    expect(
      provider.calls.some(
        (call) =>
          call.operationName === "PintPathProductionPostgresSourceLockStage",
      ),
    ).toBe(false);
  });

  it("recovers only the pinned cross-candidate incident from exact dismissed+empty state without another dismiss", async () => {
    const prepared = historicalIncidentPrepared();
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      INCIDENT_RUN_ID,
      [],
      "2026-09-01T00:08:00.000Z",
      INCIDENT_CANDIDATE,
    );
    const provider = providerMock({
      states: [
        providerState("dismissed", { configEtag: INCIDENT_DISMISSED_ETAG }),
        providerState("staged", { configEtag: INCIDENT_DISMISSED_ETAG }),
        providerState("staged", { configEtag: INCIDENT_DISMISSED_ETAG }),
        providerState("desired", {
          runId: INCIDENT_RUN_ID,
          intentCandidateSha: INCIDENT_CANDIDATE,
          configEtag: "d".repeat(64),
        }),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [baselineBoundary(), stagedBoundary(), boundary()],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
      () => Date.parse("2026-09-01T00:10:00.000Z"),
      INCIDENT_CANDIDATE,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      candidateSha: CANDIDATE,
      outcome: "reconciled_stage_and_commit",
      intentSha256:
        "61381d0ea3fd5394bb4de33b63379fcd13f524614797a434ff2b3e13f862bf9c",
      attempts: { dismiss: 0, stage: 1, commit: 1 },
      totalMutationCalls: 2,
      deploymentAllowed: false,
      retryAllowed: false,
      checks: {
        artifactBindingExact: true,
        priorRunGraceExact: true,
        baselineExact: true,
        precommitRaceAbsent: true,
        desiredStateExact: true,
      },
    });
    expect(mutationCalls(provider).map((call) => call.operationName)).toEqual([
      "PintPathProductionPostgresSourceLockStage",
      "PintPathProductionPostgresSourceLockCommit",
    ]);
  });

  it.each([
    ["at the exact 168-hour deadline", "2026-08-25T00:10:00.000Z", 0, 2],
    ["one millisecond after 168 hours", "2026-08-25T00:09:59.999Z", 1, 0],
  ])(
    "cross-candidate recovery is bounded %s",
    async (_label, originalRunCompletedAt, expectedCode, expectedWrites) => {
      const prepared = historicalIncidentPrepared();
      writeReconcileAuthority(
        prepared.evidence.authorityFile,
        RUN_ID,
        INCIDENT_RUN_ID,
        [],
        originalRunCompletedAt,
        INCIDENT_CANDIDATE,
      );
      const provider = providerMock({
        states: [
          providerState("dismissed", { configEtag: INCIDENT_DISMISSED_ETAG }),
          providerState("staged", { configEtag: INCIDENT_DISMISSED_ETAG }),
          providerState("staged", { configEtag: INCIDENT_DISMISSED_ETAG }),
          providerState("desired", {
            runId: INCIDENT_RUN_ID,
            intentCandidateSha: INCIDENT_CANDIDATE,
            configEtag: "d".repeat(64),
          }),
        ],
        patches: [patchReadback(), patchReadback()],
      });
      const result = await run(
        "reconcile",
        prepared.evidence,
        provider,
        [baselineBoundary(), stagedBoundary(), boundary()],
        boundEnvironment("reconcile", prepared, RUN_ID, true),
        prepared.intentFile,
        () => Date.parse("2026-09-01T00:10:00.000Z"),
        INCIDENT_CANDIDATE,
      );
      expect(result.code, result.output).toBe(expectedCode);
      expect(mutationCalls(provider)).toHaveLength(expectedWrites);
      expect(result.receipt.checks.priorRunGraceExact).toBe(
        expectedCode === 0,
      );
    },
  );

  it("cross-candidate recovery rejects a changed incident ETag before any write", async () => {
    const prepared = historicalIncidentPrepared();
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      INCIDENT_RUN_ID,
      [],
      "2026-09-01T00:08:00.000Z",
      INCIDENT_CANDIDATE,
    );
    const provider = providerMock({
      states: [providerState("dismissed", { configEtag: "e".repeat(64) })],
    });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
      () => Date.parse("2026-09-01T00:10:00.000Z"),
      INCIDENT_CANDIDATE,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      attempts: { dismiss: 0, stage: 0, commit: 0 },
      checks: { baselineExact: false },
    });
    expect(mutationCalls(provider)).toEqual([]);
  });

  it.each([
    ["2026-09-04T21:17:08.430Z", null],
    [null, "2026-09-04T21:17:08.430Z"],
  ])(
    "cross-candidate recovery rejects a one-sided empty-patch timestamp pair before any write (%s, %s)",
    async (createdAt, updatedAt) => {
      const prepared = historicalIncidentPrepared();
      writeReconcileAuthority(
        prepared.evidence.authorityFile,
        RUN_ID,
        INCIDENT_RUN_ID,
        [],
        "2026-09-01T00:08:00.000Z",
        INCIDENT_CANDIDATE,
      );
      const malformed = providerState("dismissed", {
        configEtag: INCIDENT_DISMISSED_ETAG,
      });
      malformed.data.staged.createdAt = createdAt;
      malformed.data.staged.updatedAt = updatedAt;
      const provider = providerMock({ states: [malformed] });
      const result = await run(
        "reconcile",
        prepared.evidence,
        provider,
        [],
        boundEnvironment("reconcile", prepared, RUN_ID, true),
        prepared.intentFile,
        () => Date.parse("2026-09-01T00:10:00.000Z"),
        INCIDENT_CANDIDATE,
      );
      expect(result.code).toBe(1);
      expect(result.receipt).toMatchObject({
        outcome: "failed_before_write",
        totalMutationCalls: 0,
        checks: { baselineExact: false },
      });
      expect(mutationCalls(provider)).toEqual([]);
    },
  );

  it("cross-candidate recovery refuses commit when the ETag changes while staging", async () => {
    const prepared = historicalIncidentPrepared();
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      INCIDENT_RUN_ID,
      [],
      "2026-09-01T00:08:00.000Z",
      INCIDENT_CANDIDATE,
    );
    const provider = providerMock({
      states: [
        providerState("dismissed", { configEtag: INCIDENT_DISMISSED_ETAG }),
        providerState("staged", { configEtag: "e".repeat(64) }),
      ],
    });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [baselineBoundary()],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
      () => Date.parse("2026-09-01T00:10:00.000Z"),
      INCIDENT_CANDIDATE,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: { dismiss: 0, stage: 1, commit: 0 },
    });
    expect(mutationCalls(provider).map((call) => call.operationName)).toEqual([
      "PintPathProductionPostgresSourceLockStage",
    ]);
  });

  it.each(SOURCE_LOCK_NON_EXEMPT_BOUNDARY_CHECKS)(
    "apply refuses to stage when the immediate boundary has non-exempt %s drift",
    async (falseCheck) => {
      const prepared = await prepare();
      const provider = providerMock({
        states: [providerState("armed"), providerState("dismissed")],
      });
      const result = await run(
        "apply",
        prepared.evidence,
        provider,
        [
          baselineBoundary(),
          boundary([...SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS, falseCheck]),
        ],
        boundEnvironment("apply", prepared),
        prepared.intentFile,
      );

      expect(result.code).toBe(1);
      expect(result.receipt).toMatchObject({
        outcome: "mutation_uncertain",
        attempts: { dismiss: 1, stage: 0, commit: 0 },
        checks: { boundaryPreflightExact: false },
      });
      expect(
        provider.calls.filter((call) =>
          [
            "PintPathProductionPostgresSourceLockStage",
            "PintPathProductionPostgresSourceLockCommit",
          ].includes(call.operationName),
        ),
      ).toHaveLength(0);
    },
  );

  it("accepts a lost stage acknowledgement only after both exact staged readbacks", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      stage: "fail",
      states: [
        providerState("armed"),
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged"),
        providerState("desired"),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [baselineBoundary(), baselineBoundary(), stagedBoundary(), boundary()],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      outcome: "applied_reconciled_after_lost_ack",
      attempts: { dismiss: 1, stage: 1, commit: 1 },
      checks: {
        stageAcknowledgementExact: false,
        stagedReadbackOneExact: true,
        stagedReadbackTwoExact: true,
      },
    });
  });

  it("fails closed when stage may have applied but exact readback is unavailable", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      states: [providerState("armed"), providerState("dismissed"), "FAIL"],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [baselineBoundary(), baselineBoundary()],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: { dismiss: 1, stage: 1, commit: 0 },
    });
    expect(
      provider.calls.filter(
        (call) =>
          call.operationName === "PintPathProductionPostgresSourceLockCommit",
      ),
    ).toHaveLength(0);
  });

  it("detects a precommit runtime race and never commits", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      states: [
        providerState("armed"),
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged", {
          runningInstanceId: "22222222-2222-4222-8222-222222222222",
        }),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [baselineBoundary(), baselineBoundary(), stagedBoundary()],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: { dismiss: 1, stage: 1, commit: 0 },
      checks: { precommitRaceAbsent: false },
    });
  });

  it("does not retry a timed-out commit that did not apply", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      commit: "fail",
      states: [
        providerState("armed"),
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged"),
        providerState("staged"),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [
        baselineBoundary(),
        baselineBoundary(),
        stagedBoundary(),
        stagedBoundary(),
      ],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: { commit: 1 },
      checks: { commitAcknowledgementExact: false, desiredStateExact: false },
    });
    expect(
      provider.calls.filter(
        (call) =>
          call.operationName === "PintPathProductionPostgresSourceLockCommit",
      ),
    ).toHaveLength(1);
  });

  it("binds a lost commit acknowledgement through exact patch history without a local patch id", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      commit: "fail",
      states: [
        providerState("armed"),
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged"),
        providerState("desired"),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [baselineBoundary(), baselineBoundary(), stagedBoundary(), boundary()],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      outcome: "applied_reconciled_after_lost_ack",
      checks: {
        commitAcknowledgementExact: false,
        committedHistoryExact: true,
      },
    });
  });

  it("fails postflight when runtime identity changes", async () => {
    const prepared = await prepare();
    const provider = providerMock({
      states: [
        providerState("armed"),
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged"),
        providerState("desired", {
          runningInstanceId: "22222222-2222-4222-8222-222222222222",
        }),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "apply",
      prepared.evidence,
      provider,
      [baselineBoundary(), baselineBoundary(), stagedBoundary(), boundary()],
      boundEnvironment("apply", prepared),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "mutation_uncertain",
      checks: { runtimeContinuityExact: false },
    });
  });

  it("fails prepare on any auto-update mismatch without creating intent", async () => {
    const evidence = createEvidence();
    const provider = providerMock({
      states: [
        providerState("armed", {
          autoUpdatesOverride: {
            ...protectedProductionPostgresSourceRepinInternals.ARMED_AUTO_UPDATES,
            type: "minor",
          },
        }),
      ],
    });
    const result = await run("prepare", evidence, provider, [
      baselineBoundary(),
    ]);
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { baselineExact: false },
    });
    expect(
      fs.existsSync(path.join(evidence.directory, "source-lock-intent.json")),
    ).toBe(false);
  });

  it("reconcile treats exact desired+empty as read-only success", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
    );
    const provider = providerMock({
      states: [providerState("desired", { runId: PRIOR_RUN_ID })],
    });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [boundary()],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      outcome: "reconciled_read_only",
      totalMutationCalls: 0,
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it("reconcile exact prior staged patch commits only and never re-dismisses", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
      [],
      "2026-09-01T00:09:00.000Z",
    );
    const provider = providerMock({
      states: [
        providerState("staged"),
        providerState("staged"),
        providerState("desired", { runId: PRIOR_RUN_ID }),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [stagedBoundary(), boundary()],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      outcome: "reconciled_commit_only",
      attempts: { dismiss: 0, stage: 0, commit: 1 },
      checks: { priorRunGraceExact: true },
    });
    expect(
      provider.calls.some(
        (call) =>
          call.operationName === "PintPathProductionPostgresSourceLockDismiss",
      ),
    ).toBe(false);
  });

  it("reconcile exact dismissed-only state stages+commits after prior-run grace", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
      [],
      "2026-08-31T00:10:00.000Z",
    );
    const provider = providerMock({
      states: [
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged"),
        providerState("desired", { runId: PRIOR_RUN_ID }),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [baselineBoundary(), stagedBoundary(), boundary()],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code, result.output).toBe(0);
    expect(result.receipt).toMatchObject({
      outcome: "reconciled_stage_and_commit",
      attempts: { dismiss: 0, stage: 1, commit: 1 },
    });
    expect(
      provider.calls.some(
        (call) =>
          call.operationName === "PintPathProductionPostgresSourceLockDismiss",
      ),
    ).toBe(false);
  });

  it.each(SOURCE_LOCK_NON_EXEMPT_BOUNDARY_CHECKS)(
    "reconcile refuses to stage when the recovery boundary has non-exempt %s drift",
    async (falseCheck) => {
      const prepared = await prepare(PRIOR_RUN_ID);
      writeReconcileAuthority(
        prepared.evidence.authorityFile,
        RUN_ID,
        PRIOR_RUN_ID,
      );
      const provider = providerMock({ states: [providerState("dismissed")] });
      const result = await run(
        "reconcile",
        prepared.evidence,
        provider,
        [boundary([...SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS, falseCheck])],
        boundEnvironment("reconcile", prepared, RUN_ID, true),
        prepared.intentFile,
      );

      expect(result.code).toBe(1);
      expect(result.receipt).toMatchObject({
        outcome: "failed_before_write",
        attempts: { dismiss: 0, stage: 0, commit: 0 },
        checks: { boundaryPreflightExact: false },
      });
      expect(
        provider.calls.filter((call) =>
          [
            "PintPathProductionPostgresSourceLockStage",
            "PintPathProductionPostgresSourceLockCommit",
          ].includes(call.operationName),
        ),
      ).toHaveLength(0);
    },
  );

  it("reconcile rechecks grace immediately before commit and stops if it expires after staging", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
    );
    const provider = providerMock({
      states: [
        providerState("dismissed"),
        providerState("staged"),
        providerState("staged"),
      ],
      patches: [patchReadback(), patchReadback()],
    });
    const clock = [
      Date.parse("2026-09-01T00:10:00.000Z"),
      Date.parse("2026-09-01T00:10:00.000Z"),
      Date.parse("2026-09-08T00:08:00.001Z"),
    ];
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [baselineBoundary(), stagedBoundary()],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
      () => clock.shift()!,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: { dismiss: 0, stage: 1, commit: 0 },
      checks: { priorRunGraceExact: false },
    });
    expect(
      provider.calls.some(
        (call) =>
          call.operationName === "PintPathProductionPostgresSourceLockCommit",
      ),
    ).toBe(false);
  });

  it("reconcile exact armed+empty is a no-write not-applied failure", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
    );
    const provider = providerMock({ states: [providerState("armed")] });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "not_applied",
      totalMutationCalls: 0,
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it("reconcile fails closed without writes for every undocumented provider state", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
    );
    const provider = providerMock({
      states: [
        providerState("dismissed", {
          autoUpdatesOverride: {
            ...protectedProductionPostgresSourceRepinInternals.DISMISSED_AUTO_UPDATES,
            tagMode: "digest",
          },
        }),
      ],
    });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      totalMutationCalls: 0,
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it("reconcile rejects malformed staged timestamps before any writer call", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
    );
    const malformed = providerState("staged");
    malformed.data.staged.createdAt = null;
    const provider = providerMock({ states: [malformed] });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      totalMutationCalls: 0,
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it("reconcile rejects duplicate exact committed history instead of guessing", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
    );
    const duplicate = {
      ...committedPatch(PRIOR_RUN_ID),
      id: "22222222-2222-4222-8222-222222222222",
    };
    const provider = providerMock({
      states: [
        providerState("desired", {
          runId: PRIOR_RUN_ID,
          historyOverride: [committedPatch(PRIOR_RUN_ID), duplicate],
        }),
      ],
    });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      totalMutationCalls: 0,
      checks: { committedHistoryExact: false },
    });
    expect(mutationCalls(provider)).toHaveLength(0);
  });

  it("reconcile refuses recovery without prior-run authority/grace", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(prepared.evidence.authorityFile, RUN_ID, "12343");
    const provider = providerMock({ states: [providerState("dismissed")] });
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("reconcile", prepared, RUN_ID, false),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { priorRunGraceExact: false },
    });
    expect(mutationCalls(provider)).toHaveLength(0);
    expect(
      fs.existsSync(
        path.join(prepared.evidence.directory, "reconcile-terminal.json"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(prepared.evidence.directory, "reconcile-receipt.json"),
      ),
    ).toBe(true);
  });

  it("reconcile rejects authority that does not prove a second dismiss was prevented", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
    );
    const authority = JSON.parse(
      fs.readFileSync(prepared.evidence.authorityFile, "utf8"),
    ) as Record<string, unknown>;
    authority.secondProductionPostgresRemediationDismissPreventedExact = false;
    fs.writeFileSync(
      prepared.evidence.authorityFile,
      `${JSON.stringify(authority)}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(prepared.evidence.authorityFile, 0o600);
    const provider = providerMock();
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { authorityExact: false },
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("reconcile rejects a prior run classified as both ambiguous and safely skipped", async () => {
    const prepared = await prepare(PRIOR_RUN_ID);
    writeReconcileAuthority(
      prepared.evidence.authorityFile,
      RUN_ID,
      PRIOR_RUN_ID,
      [PRIOR_RUN_ID],
    );
    const provider = providerMock();
    const result = await run(
      "reconcile",
      prepared.evidence,
      provider,
      [],
      boundEnvironment("reconcile", prepared, RUN_ID, true),
      prepared.intentFile,
    );
    expect(result.code).toBe(1);
    expect(result.receipt).toMatchObject({
      outcome: "failed_before_write",
      checks: { authorityExact: false },
    });
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    ["before settlement", "2026-09-01T00:09:00.001Z"],
    ["after grace", "2026-08-24T23:59:59.999Z"],
  ])(
    "reconcile independently rejects recovery %s",
    async (_label, originalRunCompletedAt) => {
      const prepared = await prepare(PRIOR_RUN_ID);
      writeReconcileAuthority(
        prepared.evidence.authorityFile,
        RUN_ID,
        PRIOR_RUN_ID,
        [],
        originalRunCompletedAt,
      );
      const provider = providerMock();
      const result = await run(
        "reconcile",
        prepared.evidence,
        provider,
        [],
        boundEnvironment("reconcile", prepared, RUN_ID, true),
        prepared.intentFile,
      );
      expect(result.code).toBe(1);
      expect(result.receipt).toMatchObject({
        outcome: "failed_before_write",
        checks: { authorityExact: true, priorRunGraceExact: false },
      });
      expect(mutationCalls(provider)).toHaveLength(0);
    },
  );
});
