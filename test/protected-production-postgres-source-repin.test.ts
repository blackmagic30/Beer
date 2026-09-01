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
  "7bc537f25b01f8cc6d865552c829d8291e14d8fabb9982d2e63ca0cee8954e83";
const MUTABLE_SOURCE = "ghcr.io/railwayapp-templates/postgres-ssl:17";
const IMAGE_DIGEST =
  "sha256:7383de344f558c61a16ecdcb3e6fc86f05c45c82a4e02ad77d96aa72b5ae2ba8";
const IMMUTABLE_SOURCE = `ghcr.io/railwayapp-templates/postgres-ssl@${IMAGE_DIGEST}`;
const PRODUCTION_METADATA_TOKEN = "production-metadata-token-unique";
const STAGING_METADATA_TOKEN = "staging-metadata-token-unique";
const MUTATION_TOKEN = "production-source-writer-token-unique";
const RUN_ID = "12345";
const PRIOR_RUN_ID = "12344";

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

function committedPatch(runId: string) {
  return {
    id: PATCH_ID,
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    status: "COMMITTED",
    message: `pintpath:production-postgres-source-lock:${CANDIDATE}:${runId}`,
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
  } = {},
) {
  const instanceId = options.runningInstanceId ?? RUNNING_INSTANCE_ID;
  const exactDeployment = deployment(instanceId);
  const sourceImage = kind === "desired" ? IMMUTABLE_SOURCE : MUTABLE_SOURCE;
  const activePatch = kind === "staged" ? stagedPatch() : emptyPatch();
  const history =
    options.historyOverride ??
    (kind === "desired"
      ? [committedPatch(options.runId ?? RUN_ID)]
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
        edges: [{ node: exactDeployment }],
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
      exactPriorProductionPostgresSourceRepinCandidateRunBound: true,
      secondProductionPostgresRemediationDismissPreventedExact: true,
      runnerLossRecoveryOriginalRunCompletedAt: originalRunCompletedAt,
      runnerLossRecoverySettlementSeconds: 60,
      runnerLossRecoveryGraceHours: 24,
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
          PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_ID: PRIOR_RUN_ID,
        }
      : {}),
  };
}

function argsFor(
  phase: Phase,
  evidence: ReturnType<typeof createEvidence>,
  intentFile?: string,
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
) {
  let output = "";
  const code = await runProtectedProductionPostgresSourceRepin({
    argv: argsFor(phase, evidence, intentFile),
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

function boundEnvironment(
  phase: "apply" | "reconcile",
  prepared: Awaited<ReturnType<typeof prepare>>,
  currentRunId = RUN_ID,
  priorGrace = false,
) {
  const intent = JSON.parse(fs.readFileSync(prepared.intentFile, "utf8")) as {
    githubRunId: string;
  };
  return {
    ...environment(phase, currentRunId, { priorGrace }),
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_SHA256: prepared.intentSha,
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_ID: "777",
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_DIGEST: `sha256:${"d".repeat(64)}`,
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_NAME: `pintpath-production-postgres-source-lock-intent-${CANDIDATE}-${intent.githubRunId}`,
    PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_RUN_ID:
      intent.githubRunId,
  };
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
  it("pins and validates the complete reviewed v2 policy contract", () => {
    expect(PRODUCTION_POSTGRES_SOURCE_LOCK_POLICY_SHA256).toBe(
      "5785c34046e45116155a9344b30f907e15c4492410cc84e70da3e111a4173fc1",
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
      Date.parse("2026-09-02T00:08:00.001Z"),
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
    ["after grace", "2026-08-30T23:59:59.999Z"],
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
