import { productionArchiveFixture } from "./production-source-archive-downstream.fixtures.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROTECTED_STAGING_SCALE_DISCOVERY_QUERY,
  PROTECTED_STAGING_SCALE_PATCH_HISTORY_QUERY,
  PROTECTED_STAGING_SCALE_PATCH_QUERY,
  PROTECTED_STAGING_SCALE_SCHEMA,
  PROTECTED_STAGING_SCALE_SNAPSHOT_QUERY,
  PROTECTED_STAGING_SCALE_STATE,
  PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY,
  PROTECTED_SCALE_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
  protectedScaleCommitMessage,
  protectedPermanentStagingScaleInternals,
  runProtectedPermanentStagingScale,
} from "../scripts/execute-protected-permanent-staging-scale.js";
import type { ProductionScaleActivationPrerequisiteVerification } from
  "../scripts/verify-production-maintenance-role-limit-prerequisites.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  railwayEnvironmentPatchCommitVariables,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
  type RailwayEnvironmentPatchCommitInput,
} from "../scripts/lib/railway-environment-patch-commit.js";

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-4444-8444-444444444444";
const DRIFT_DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const DRIFT_SNAPSHOT_ID = "66666666-6666-4666-8666-666666666666";
const CANDIDATE_SHA = "a".repeat(40);
const PRODUCTION_SCALE_RUN_ID = "9000";
const PRODUCTION_ACTIVATE_RUN_ID = "8000";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalProviderJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(Object.keys(item as Record<string, unknown>)
      .sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function scope(environmentId = ENVIRONMENT_ID): Response {
  return response({
    data: { projectToken: { projectId: PROJECT_ID, environmentId } },
  });
}

function discovery(deploymentId = DEPLOYMENT_ID): Response {
  return response({
    data: { serviceInstance: { latestDeployment: { id: deploymentId } } },
  });
}

function snapshot(
  replicas: 0 | 1 | 2,
  environmentId = ENVIRONMENT_ID,
  domain = "beer-staging.up.railway.app",
  deployedSha: string | null = CANDIDATE_SHA,
  deploymentId = DEPLOYMENT_ID,
  snapshotId = SNAPSHOT_ID,
  targetPort = 8080,
  configuredRegions?: Readonly<Record<string, number | null>>,
  legacyReplicas: number | null = replicas,
  environmentConfig?: unknown,
  stagedPatch: unknown = {},
  serviceSource: unknown = { repo: null, image: "pintpath:test" },
): Response {
  const exactConfiguredRegions = configuredRegions ?? (
    environmentId === ENVIRONMENT_ID
      ? {
          "asia-southeast1-eqsg3a": replicas,
          "europe-west4-drams3a": 0,
        }
      : { "asia-southeast1-eqsg3a": replicas }
  );
  const multiRegionConfig = Object.fromEntries(
    Object.entries(exactConfiguredRegions).map(([region, numReplicas]) => [
      region,
      { numReplicas },
    ]),
  );
  return response({
    data: {
      environment: {
        id: environmentId,
        config: environmentConfig === undefined ? {
          services: {
            [SERVICE_ID]: { deploy: { multiRegionConfig } },
          },
        } : environmentConfig,
      },
      staged: { environmentId, patch: stagedPatch },
      serviceInstance: {
        id: INSTANCE_ID,
        serviceId: SERVICE_ID,
        environmentId,
        numReplicas: legacyReplicas,
        source: serviceSource,
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
        domains: {
          serviceDomains: [{
            id: DOMAIN_ID,
            domain,
            targetPort,
          }],
          customDomains: [],
        },
      },
      deployment: {
        id: deploymentId,
        projectId: PROJECT_ID,
        environmentId,
        serviceId: SERVICE_ID,
        snapshotId,
        meta: {
          commitHash: deployedSha,
          imageDigest: `sha256:${"b".repeat(64)}`,
          patchId: null,
        },
      },
    },
  });
}

function environment(
  direction: "out" | "converge-one",
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE_SHA,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "1234",
    PINTPATH_SCALE_CONFIRMATION: direction === "out"
      ? "SCALE_PERMANENT_STAGING_TO_TWO_FOR_EVIDENCE"
      : "CONVERGE_PERMANENT_STAGING_TO_ONE",
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "metadata-token-that-is-long-enough",
    PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: "scale-token-that-is-long-enough",
    PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
      PROTECTED_SCALE_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
    ...overrides,
  };
}

function argv(direction: "out" | "converge-one"): string[] {
  return [
    "--direction", direction,
    "--candidate-sha", CANDIDATE_SHA,
    "--evidence-dir", "/private/evidence",
  ];
}

function successfulFetch(before: 0 | 1 | 2, after?: 0 | 1 | 2) {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(scope())
    .mockResolvedValueOnce(scope())
    .mockResolvedValueOnce(discovery())
    .mockResolvedValueOnce(snapshot(before));
  if (after !== undefined) {
    fetchImpl
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(before))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(before))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(after));
  }
  return fetchImpl;
}

function transitionFetch(
  before: () => Response,
  after: () => Response,
) {
  return vi.fn()
    .mockResolvedValueOnce(scope())
    .mockResolvedValueOnce(scope())
    .mockResolvedValueOnce(discovery())
    .mockResolvedValueOnce(before())
    .mockResolvedValueOnce(discovery())
    .mockResolvedValueOnce(before())
    .mockResolvedValueOnce(discovery())
    .mockResolvedValueOnce(before())
    .mockResolvedValueOnce(discovery())
    .mockResolvedValueOnce(after());
}

function durable(_directory: string, _leaf: string, source: string): string {
  return sha256(source);
}

function mutationAttempt(
  input: RailwayEnvironmentPatchCommitInput,
  outcome: "acknowledged" | "transport_uncertain" = "acknowledged",
) {
  const variables = railwayEnvironmentPatchCommitVariables(input)!;
  const requestBody = JSON.stringify({
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
    variables,
  });
  const acknowledgementExact = outcome === "acknowledged";
  return {
    outcome,
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    querySha256: sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
    variablesSha256: sha256(JSON.stringify(variables)),
    requestBodySha256: sha256(requestBody),
    responseBodySha256: outcome === "acknowledged" ? "4".repeat(64) : null,
    acknowledgementSha256: acknowledgementExact ? "5".repeat(64) : null,
    acknowledgementExact,
    zeroRegionsEncodedAsJsonNull: true,
  };
}

function successfulCommit(
  outcome: "acknowledged" | "transport_uncertain" = "acknowledged",
) {
  return vi.fn(async (_token: string, input: RailwayEnvironmentPatchCommitInput) =>
    mutationAttempt(input, outcome));
}

function patchHistory(
  matchingPatchCount: 0 | 1,
  commitMessage: string,
  expectedPatch: unknown,
) {
  const baseProjectionSha256 = "6".repeat(64);
  return {
    querySha256: {
      history: sha256(PROTECTED_STAGING_SCALE_PATCH_HISTORY_QUERY),
      patch: sha256(PROTECTED_STAGING_SCALE_PATCH_QUERY),
    },
    pages: [
      { requestAfter: null, count: 100, endCursor: "cursor-1", hasNextPage: true },
      {
        requestAfter: "cursor-1",
        count: 23 + matchingPatchCount,
        endCursor: "cursor-2",
        hasNextPage: false,
      },
    ],
    pageCount: 2,
    rowCount: 123 + matchingPatchCount,
    rowsProjectionSha256: matchingPatchCount === 0
      ? baseProjectionSha256
      : "a".repeat(64),
    nonMatchingRowsProjectionSha256: baseProjectionSha256,
    paginationCompleteExact: true,
    matchingPatchCount,
    matchingPatch: matchingPatchCount === 1 ? {
      rowIndex: 0 as const,
      idSha256: "7".repeat(64),
      status: "COMMITTED" as const,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      appliedAt: "1970-01-01T00:00:00.000Z",
      messageSha256: sha256(commitMessage),
      patchSha256: sha256(canonicalProviderJson(expectedPatch)),
      crossFetchExact: true as const,
    } : null,
    secretMaterialIncluded: false as const,
    secretDerivedCommitmentsIncluded: false as const,
  };
}

function successfulPatchHistory() {
  let call = 0;
  return vi.fn(async (
    _token: string,
    _environmentId: string,
    commitMessage: string,
    expectedPatch: unknown,
  ) => patchHistory(call++ === 0 ? 0 : 1, commitMessage, expectedPatch));
}

function historyNode(
  index: number,
  options: {
    message?: string | null;
    patch?: unknown;
    id?: string;
    createdAt?: string;
    updatedAt?: string;
    appliedAt?: string | null;
  } = {},
) {
  const createdAt = options.createdAt ??
    new Date(Date.parse("2026-09-08T07:00:00.000Z") -
      index * 10_000).toISOString();
  return {
    id: options.id ??
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    environmentId: ENVIRONMENT_ID,
    status: options.message ? "COMMITTED" : "APPLIED",
    createdAt,
    updatedAt: options.updatedAt ??
      new Date(Date.parse(createdAt) + 10_000).toISOString(),
    appliedAt: options.appliedAt === undefined
      ? options.message
        ? new Date(Date.parse(createdAt) - 1).toISOString()
        : null
      : options.appliedAt,
    message: options.message ?? null,
    patch: options.patch ?? {},
  };
}

function historyPage(
  nodes: readonly ReturnType<typeof historyNode>[],
  options: { hasNextPage?: boolean; endCursor?: string | null } = {},
): Response {
  const edges = nodes.map((node, index) => ({
    cursor: `cursor-${node.id}-${index}`,
    node,
  }));
  return response({
    data: {
      environmentPatches: {
        edges,
        pageInfo: {
          hasNextPage: options.hasNextPage ?? false,
          endCursor: options.endCursor === undefined
            ? edges.at(-1)?.cursor ?? null
            : options.endCursor,
        },
      },
    },
  });
}

function historyContract() {
  const commitMessage = protectedScaleCommitMessage("out", CANDIDATE_SHA, "1234");
  const variables = railwayEnvironmentPatchCommitVariables({
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    regions: [
      { region: "asia-southeast1-eqsg3a", numReplicas: 2 },
      { region: "europe-west4-drams3a", numReplicas: 0 },
    ],
    commitMessage,
  })!;
  return { commitMessage, patch: variables.patch };
}

describe("protected permanent-staging scale evidence operation", () => {
  it("pins metadata-only queries and a protected executor", () => {
    expect(PROTECTED_STAGING_SCALE_STATE).toBe("GITHUB_ENVIRONMENT_PROTECTED");
    expect(PROTECTED_STAGING_SCALE_DISCOVERY_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_SCALE_SNAPSHOT_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_SCALE_PATCH_HISTORY_QUERY).not.toMatch(/mutation\s/i);
  });

  it("collects one exact run-bound provider patch and cross-fetches it", async () => {
    const { commitMessage, patch } = historyContract();
    const matching = historyNode(0, {
      message: commitMessage,
      patch,
      // Railway has emitted both timestamp orderings. A slow but valid commit
      // must remain recoverable when appliedAt is well after createdAt.
      appliedAt: "2026-09-08T07:00:06.419Z",
    });
    const older = historyNode(1);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(historyPage([matching, older]))
      .mockResolvedValueOnce(response({ data: { environmentPatch: matching } }));
    const evidence = await protectedPermanentStagingScaleInternals.readPatchHistory(
      fetchImpl as unknown as typeof fetch,
      "metadata-token-that-is-long-enough",
      ENVIRONMENT_ID,
      commitMessage,
      patch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(evidence).toMatchObject({
      pageCount: 1,
      rowCount: 2,
      matchingPatchCount: 1,
      matchingPatch: {
        rowIndex: 0,
        messageSha256: sha256(commitMessage),
        patchSha256: sha256(canonicalProviderJson(patch)),
        crossFetchExact: true,
      },
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
  });

  it("accepts either timestamp ordering but rejects a patch applied after its update", async () => {
    const { commitMessage, patch } = historyContract();
    const beforeCreated = historyNode(0, {
      message: commitMessage,
      patch,
      appliedAt: "2026-09-08T06:59:59.999Z",
    });
    const beforeFetch = vi.fn()
      .mockResolvedValueOnce(historyPage([beforeCreated]))
      .mockResolvedValueOnce(response({ data: { environmentPatch: beforeCreated } }));
    await expect(protectedPermanentStagingScaleInternals.readPatchHistory(
      beforeFetch as unknown as typeof fetch,
      "metadata-token-that-is-long-enough",
      ENVIRONMENT_ID,
      commitMessage,
      patch,
    )).resolves.toMatchObject({ matchingPatchCount: 1 });

    const afterUpdated = historyNode(0, {
      message: commitMessage,
      patch,
      updatedAt: "2026-09-08T07:00:01.000Z",
      appliedAt: "2026-09-08T07:00:01.001Z",
    });
    const invalidFetch = vi.fn().mockResolvedValueOnce(historyPage([afterUpdated]));
    await expect(protectedPermanentStagingScaleInternals.readPatchHistory(
      invalidFetch as unknown as typeof fetch,
      "metadata-token-that-is-long-enough",
      ENVIRONMENT_ID,
      commitMessage,
      patch,
    )).rejects.toThrow("provider_patch_history_invalid");
  });

  it("binds the unique provider row to the authenticated producer window without a latency limit", () => {
    const { commitMessage, patch } = historyContract();
    const evidence = patchHistory(1, commitMessage, patch);
    evidence.matchingPatch!.createdAt = "2026-09-08T07:00:00.000Z";
    evidence.matchingPatch!.appliedAt = "2026-09-08T07:00:06.419Z";
    evidence.matchingPatch!.updatedAt = "2026-09-08T07:00:07.000Z";
    const window = {
      startedAtMs: Date.parse("2026-09-08T06:59:59.000Z"),
      completedAtMs: Date.parse("2026-09-08T07:00:08.000Z"),
    };
    expect(protectedPermanentStagingScaleInternals.patchHistoryEvidenceExact(
      evidence,
      1,
      commitMessage,
      patch,
      window,
    )).toBe(true);

    const appliedAfterUpdated = structuredClone(evidence);
    appliedAfterUpdated.matchingPatch!.appliedAt =
      "2026-09-08T07:00:07.001Z";
    expect(protectedPermanentStagingScaleInternals.patchHistoryEvidenceExact(
      appliedAfterUpdated,
      1,
      commitMessage,
      patch,
      window,
    )).toBe(false);

    const outsideWindow = structuredClone(evidence);
    outsideWindow.matchingPatch!.appliedAt = "2026-09-08T06:59:58.999Z";
    expect(protectedPermanentStagingScaleInternals.patchHistoryEvidenceExact(
      outsideWindow,
      1,
      commitMessage,
      patch,
      window,
    )).toBe(false);

    const nonCanonical = structuredClone(evidence);
    nonCanonical.matchingPatch!.createdAt = "2026-09-08T17:00:00+10:00";
    expect(protectedPermanentStagingScaleInternals.patchHistoryEvidenceExact(
      nonCanonical,
      1,
      commitMessage,
      patch,
      window,
    )).toBe(false);
  });

  it("rejects a short nonterminal provider-history page", async () => {
    const { commitMessage, patch } = historyContract();
    const fetchImpl = vi.fn().mockResolvedValueOnce(historyPage(
      [historyNode(0)],
      { hasNextPage: true },
    ));
    await expect(protectedPermanentStagingScaleInternals.readPatchHistory(
      fetchImpl as unknown as typeof fetch,
      "metadata-token-that-is-long-enough",
      ENVIRONMENT_ID,
      commitMessage,
      patch,
    )).rejects.toThrow("provider_patch_history_invalid");
  });

  it("rejects mismatched cursors, duplicate ids, and chronology reversal", async () => {
    const { commitMessage, patch } = historyContract();
    const duplicateId = historyNode(0).id;
    const cases = [
      historyPage([historyNode(0)], { endCursor: "not-the-edge-cursor" }),
      historyPage([historyNode(0), historyNode(1, { id: duplicateId })]),
      historyPage([historyNode(2), historyNode(1)]),
    ];
    for (const page of cases) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(page);
      await expect(protectedPermanentStagingScaleInternals.readPatchHistory(
        fetchImpl as unknown as typeof fetch,
        "metadata-token-that-is-long-enough",
        ENVIRONMENT_ID,
        commitMessage,
        patch,
      )).rejects.toThrow("provider_patch_history_invalid");
    }
  });

  it("rejects impossible timestamps on a non-target history row", async () => {
    const { commitMessage, patch } = historyContract();
    const impossible = historyNode(0, {
      updatedAt: "2026-09-08T06:59:59.999Z",
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(historyPage([impossible]));
    await expect(protectedPermanentStagingScaleInternals.readPatchHistory(
      fetchImpl as unknown as typeof fetch,
      "metadata-token-that-is-long-enough",
      ENVIRONMENT_ID,
      commitMessage,
      patch,
    )).rejects.toThrow("provider_patch_history_invalid");
  });

  it("rejects an incomplete eighth provider-history page", async () => {
    const { commitMessage, patch } = historyContract();
    const fetchImpl = vi.fn();
    for (let page = 0; page < 8; page += 1) {
      const nodes = Array.from({ length: 100 }, (_, row) =>
        historyNode(page * 100 + row));
      fetchImpl.mockResolvedValueOnce(historyPage(nodes, { hasNextPage: true }));
    }
    await expect(protectedPermanentStagingScaleInternals.readPatchHistory(
      fetchImpl as unknown as typeof fetch,
      "metadata-token-that-is-long-enough",
      ENVIRONMENT_ID,
      commitMessage,
      patch,
    )).rejects.toThrow("provider_patch_history_invalid");
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it("rejects a provider patch whose cross-fetch no longer matches", async () => {
    const { commitMessage, patch } = historyContract();
    const matching = historyNode(0, { message: commitMessage, patch });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(historyPage([matching]))
      .mockResolvedValueOnce(response({
        data: { environmentPatch: { ...matching, message: "substituted" } },
      }));
    await expect(protectedPermanentStagingScaleInternals.readPatchHistory(
      fetchImpl as unknown as typeof fetch,
      "metadata-token-that-is-long-enough",
      ENVIRONMENT_ID,
      commitMessage,
      patch,
    )).rejects.toThrow("provider_patch_history_invalid");
  });

  it("proves runtime absence only from repeated exact 404 responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 }),
    );
    await expect(protectedPermanentStagingScaleInternals.probeRuntimeAbsent(
      fetchImpl as unknown as typeof fetch,
      { environmentId: ENVIRONMENT_ID, domain: "beer-staging.up.railway.app" },
      vi.fn().mockResolvedValue(undefined),
    )).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it.each([401, 403, 429, 500])(
    "does not treat HTTP %i as proof that runtime is absent",
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status }));
      await expect(protectedPermanentStagingScaleInternals.probeRuntimeAbsent(
        fetchImpl as unknown as typeof fetch,
        { environmentId: ENVIRONMENT_ID, domain: "beer-staging.up.railway.app" },
        vi.fn().mockResolvedValue(undefined),
      )).resolves.toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("does not treat a network failure as proof that runtime is absent", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(protectedPermanentStagingScaleInternals.probeRuntimeAbsent(
      fetchImpl as unknown as typeof fetch,
      { environmentId: ENVIRONMENT_ID, domain: "beer-staging.up.railway.app" },
      vi.fn().mockResolvedValue(undefined),
    )).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("scales one reviewed candidate from one to two exactly once", async () => {
    const fetchImpl = successfulFetch(1, 2);
    const commitScale = successfulCommit();
    const readPatchHistory = successfulPatchHistory();
    const boundaryCheck = vi.fn().mockResolvedValue(0);
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck,
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory,
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(0);
    expect(commitScale).toHaveBeenCalledOnce();
    expect(commitScale).toHaveBeenCalledWith(
      "scale-token-that-is-long-enough",
      {
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        regions: [
          { region: "asia-southeast1-eqsg3a", numReplicas: 2 },
          { region: "europe-west4-drams3a", numReplicas: 0 },
        ],
        commitMessage: protectedScaleCommitMessage("out", CANDIDATE_SHA, "1234"),
      },
    );
    expect(boundaryCheck).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(JSON.parse(output[0]!)).toMatchObject({
      schemaVersion: PROTECTED_STAGING_SCALE_SCHEMA,
      direction: "out",
      outcome: "scaled",
      startedAt: "1970-01-01T00:00:00.000Z",
      completedAt: "1970-01-01T00:00:00.000Z",
      deploymentIdSha256:
        expect.stringMatching(/^[a-f0-9]{64}$/),
      desiredReplicas: 2,
      attempts: 1,
      retryAllowed: false,
      checks: {
        externalMutationFreezeAttested: true,
        directMutationContractExact: true,
        mutationResponseClassified: true,
        targetPreflightExact: true,
        runtimePreflightExact: true,
        acknowledgementExact: true,
        lostAcknowledgementExact: false,
        providerHistoryPrewriteExact: true,
        providerHistoryPostflightExact: true,
        postflightAttempted: true,
        targetPostflightExact: true,
        runtimePostflightExact: true,
        candidateUnchanged: true,
        deploymentUnchanged: true,
        boundaryPostflightExact: true,
        terminalEvidenceExact: true,
        finalReceiptEvidenceExact: true,
      },
    });
  });

  it("converges staging from two to one through the same direct transport", async () => {
    const commitScale = successfulCommit();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("converge-one"),
      env: environment("converge-one"),
      cwd: process.cwd(),
      fetchImpl: successfulFetch(2, 1),
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(commitScale).toHaveBeenCalledWith(
      "scale-token-that-is-long-enough",
      expect.objectContaining({
        regions: [
          { region: "asia-southeast1-eqsg3a", numReplicas: 1 },
          { region: "europe-west4-drams3a", numReplicas: 0 },
        ],
        commitMessage: protectedScaleCommitMessage(
          "converge-one",
          CANDIDATE_SHA,
          "1234",
        ),
      }),
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      githubRunId: "1234",
      outcome: "scaled",
      desiredReplicas: 1,
    });
  });

  it("accepts provider readback that omits the null staging region", async () => {
    const commitScale = successfulCommit();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl: transitionFetch(
        () => snapshot(1),
        () => snapshot(
          2,
          ENVIRONMENT_ID,
          "beer-staging.up.railway.app",
          CANDIDATE_SHA,
          DEPLOYMENT_ID,
          SNAPSHOT_ID,
          8080,
          { "asia-southeast1-eqsg3a": 2 },
          null,
        ),
      ),
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(commitScale.mock.calls[0]?.[1].regions).toEqual([
      { region: "asia-southeast1-eqsg3a", numReplicas: 2 },
      { region: "europe-west4-drams3a", numReplicas: 0 },
    ]);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: "scaled" });
  });

  it("compares secret-bearing config only in memory and persists no secret commitment", async () => {
    const sealedSecret = "sealed-database-value-never-persist";
    const config = (replicas: 1 | 2) => ({
      services: {
        [SERVICE_ID]: {
          variables: { DATABASE_URL: { value: sealedSecret } },
          deploy: {
            multiRegionConfig: {
              "asia-southeast1-eqsg3a": { numReplicas: replicas },
              "europe-west4-drams3a": { numReplicas: 0 },
            },
          },
        },
      },
      sharedVariables: { INTERNAL_KEY: { value: sealedSecret } },
    });
    const evidence: string[] = [];
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl: transitionFetch(
        () => snapshot(1, ENVIRONMENT_ID, "beer-staging.up.railway.app",
          CANDIDATE_SHA, DEPLOYMENT_ID, SNAPSHOT_ID, 8080, undefined, null,
          config(1)),
        () => snapshot(2, ENVIRONMENT_ID, "beer-staging.up.railway.app",
          CANDIDATE_SHA, DEPLOYMENT_ID, SNAPSHOT_ID, 8080, undefined, null,
          config(2)),
      ),
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale: successfulCommit(),
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: (_directory, _leaf, source) => {
        evidence.push(source);
        return sha256(source);
      },
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    const durable = [...evidence, ...output].join("\n");
    expect(durable).not.toContain(sealedSecret);
    expect(durable).not.toContain(sha256(sealedSecret));
    expect(JSON.parse(output[0]!)).toMatchObject({
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
      replicaTopology: { environmentConfigCollateralUnchanged: true },
    });
  });

  it("fails closed when non-topology provider config changes after the write", async () => {
    const config = (replicas: 1 | 2, setting: string) => ({
      services: {
        [SERVICE_ID]: {
          deploy: {
            multiRegionConfig: {
              "asia-southeast1-eqsg3a": { numReplicas: replicas },
              "europe-west4-drams3a": { numReplicas: 0 },
            },
            restartPolicyType: setting,
          },
        },
      },
    });
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl: transitionFetch(
        () => snapshot(1, ENVIRONMENT_ID, "beer-staging.up.railway.app",
          CANDIDATE_SHA, DEPLOYMENT_ID, SNAPSHOT_ID, 8080, undefined, null,
          config(1, "ON_FAILURE")),
        () => snapshot(2, ENVIRONMENT_ID, "beer-staging.up.railway.app",
          CANDIDATE_SHA, DEPLOYMENT_ID, SNAPSHOT_ID, 8080, undefined, null,
          config(2, "ALWAYS")),
      ),
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale: successfulCommit(),
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      checks: { providerConfigurationCollateralUnchanged: false },
      replicaTopology: { environmentConfigCollateralUnchanged: false },
    });
  });

  it("blocks a nonempty staged patch in the final provider prewrite read", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        CANDIDATE_SHA,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        8080,
        undefined,
        1,
        undefined,
        { services: { [SERVICE_ID]: { deploy: { startCommand: "drift" } } } },
      ));
    const commitScale = successfulCommit();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
    });
  });

  it.each([
    ["operationName", "NotTheReviewedOperation"],
    ["querySha256", "0".repeat(64)],
    ["variablesSha256", "0".repeat(64)],
    ["requestBodySha256", "0".repeat(64)],
    ["zeroRegionsEncodedAsJsonNull", false],
    ["acknowledgementExact", false],
    ["acknowledgementSha256", null],
  ])("rejects mismatched direct mutation attempt evidence: %s", async (
    field,
    replacement,
  ) => {
    const commitScale = vi.fn(async (
      _token: string,
      input: RailwayEnvironmentPatchCommitInput,
    ) => ({ ...mutationAttempt(input), [field]: replacement }) as never);
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl: successfulFetch(1, 2),
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(commitScale).toHaveBeenCalledOnce();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      checks: {
        mutationResponseClassified: false,
        acknowledgementExact: false,
        lostAcknowledgementExact: false,
      },
    });
  });

  it("does not classify a thrown transport as a lost acknowledgement", async () => {
    const commitScale = vi.fn().mockRejectedValue(new Error("socket closed"));
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl: successfulFetch(1, 2),
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(commitScale).toHaveBeenCalledOnce();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      checks: {
        mutationResponseClassified: false,
        lostAcknowledgementExact: false,
      },
    });
  });

  it("quiesces the exact live legacy staging deployment at zero after two identity probes", async () => {
    const legacySha = "b".repeat(40);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        legacySha,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        8080,
        { "europe-west4-drams3a": 1 },
        null,
      ))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        legacySha,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        8080,
        { "europe-west4-drams3a": 1 },
        null,
      ))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        legacySha,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        8080,
        { "europe-west4-drams3a": 1 },
        null,
      ))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        0,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        legacySha,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        8080,
        {
          "asia-southeast1-eqsg3a": 0,
          "europe-west4-drams3a": 0,
        },
        null,
      ));
    const commitScale = successfulCommit();
    const probeRuntime = vi.fn().mockResolvedValue(true);
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "quiesce-staging-zero",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", legacySha,
        "--evidence-dir", "/private/evidence",
      ],
      env: {
        ...environment("out"),
        PINTPATH_SCALE_CONFIRMATION:
          "QUIESCE_PERMANENT_STAGING_TO_ZERO_FOR_WORKER_BOOTSTRAP",
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(0);
    expect(probeRuntime).toHaveBeenCalledTimes(3);
    expect(probeRuntime).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      legacySha,
      DEPLOYMENT_ID,
      { legacyIdentityOnly: true },
    );
    expect(probeRuntime).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      legacySha,
      DEPLOYMENT_ID,
      { legacyIdentityOnly: true },
    );
    expect(probeRuntime).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      legacySha,
      DEPLOYMENT_ID,
      { legacyIdentityOnly: true },
    );
    expect(commitScale).toHaveBeenCalledWith(
      "scale-token-that-is-long-enough",
      {
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        regions: [
          { region: "asia-southeast1-eqsg3a", numReplicas: 0 },
          { region: "europe-west4-drams3a", numReplicas: 0 },
        ],
        commitMessage: protectedScaleCommitMessage(
          "quiesce-staging-zero",
          CANDIDATE_SHA,
          "1234",
        ),
      },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      direction: "quiesce-staging-zero",
      outcome: "scaled",
      desiredReplicas: 0,
      checks: {
        runtimePreflightExact: true,
        runtimePostflightExact: true,
        deploymentUnchanged: true,
      },
    });
  });

  it("rejects a staging deployment whose service domain no longer targets the Railway app port", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        CANDIDATE_SHA,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        3000,
      ));
    const commitScale = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      probeRuntime: vi.fn(),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { targetPreflightExact: false },
    });
  });

  it("rejects an unauthorized positive configured region before any scale write", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        CANDIDATE_SHA,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        8080,
        { "us-west2": 1 },
        null,
      ));
    const commitScale = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      probeRuntime: vi.fn(),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { targetPreflightExact: false },
    });
  });

  it.each([
    ["null", null],
    ["missing topology", {}],
    ["malformed topology", {
      services: {
        [SERVICE_ID]: { deploy: { multiRegionConfig: "asia=1" } },
      },
    }],
  ])("rejects %s environment configuration before any scale write", async (
    _label,
    environmentConfig,
  ) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        ENVIRONMENT_ID,
        "beer-staging.up.railway.app",
        CANDIDATE_SHA,
        DEPLOYMENT_ID,
        SNAPSHOT_ID,
        8080,
        { "asia-southeast1-eqsg3a": 1 },
        null,
        environmentConfig,
      ));
    const commitScale = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      probeRuntime: vi.fn(),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
    });
  });

  it("restores the fenced candidate from zero to one and proves workers remain disabled", async () => {
    const fetchImpl = successfulFetch(0, 1);
    const commitScale = successfulCommit();
    const probeRuntime = vi.fn().mockResolvedValue(true);
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "bootstrap-staging-one",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", CANDIDATE_SHA,
        "--evidence-dir", "/private/evidence",
      ],
      env: {
        ...environment("out"),
        PINTPATH_SCALE_CONFIRMATION:
          "RESTORE_PERMANENT_STAGING_TO_ONE_FOR_WORKER_BOOTSTRAP",
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime,
      probeRuntimeAbsent: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(0);
    expect(probeRuntime).toHaveBeenCalledWith(
      expect.anything(),
      CANDIDATE_SHA,
      DEPLOYMENT_ID,
      { enabled: false, candidateBound: true },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      direction: "bootstrap-staging-one",
      outcome: "scaled",
      desiredReplicas: 1,
      checks: {
        runtimePreflightExact: true,
        runtimePostflightExact: true,
      },
    });
  });

  it("reconciles an exact lost acknowledgement without retrying", async () => {
    const fetchImpl = successfulFetch(1, 2);
    const commitScale = successfulCommit("transport_uncertain");
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(commitScale).toHaveBeenCalledOnce();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "reconciled_scaled",
      attempts: 1,
      checks: {
        acknowledgementExact: false,
        lostAcknowledgementExact: true,
        postflightAttempted: true,
        targetPostflightExact: true,
      },
    });
  });

  it("blocks before scaling unless the exact candidate reports an active worker fence", async () => {
    const fetchImpl = successfulFetch(1, 1);
    const commitScale = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      commitScale,
      probeRuntime: vi.fn().mockResolvedValue(false),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        targetPreflightExact: true,
        runtimePreflightExact: false,
      },
    });
  });

  it("makes converge-to-one idempotent on the sole authorized attempt", async () => {
    const fetchImpl = successfulFetch(1, 1);
    const commitScale = vi.fn();
    const boundaryCheck = vi.fn().mockResolvedValue(0);
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("converge-one"),
      env: environment("converge-one"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck,
      reassertRepositoryState: () => true,
      commitScale,
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(commitScale).not.toHaveBeenCalled();
    expect(boundaryCheck).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "already_converged",
      attempts: 0,
      githubRunId: "1234",
      directMutationEvidence: {
        transportOutcome: null,
        variablesSha256: null,
        requestBodySha256: null,
        responseBodySha256: null,
        acknowledgementSha256: null,
        acknowledgementExact: false,
        commitMessageSha256: null,
        zeroRegionsEncodedAsJsonNull: false,
      },
      providerHistoryEvidence: { prewrite: null, postflight: null },
      checks: { targetPostflightExact: true, terminalEvidenceExact: true },
    });
  });

  it.each([false, true])("converges an exact existing production deployment to two without a scale-down path (archive=%s)", async (archive) => {
    const deployedSha = archive ? null : CANDIDATE_SHA;
    const evidenceDirectory = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-production-scale-test-"),
    ));
    temporaryRoots.push(evidenceDirectory);
    const activationVerificationFile = path.join(
      evidenceDirectory,
      "production-scale-activation-verification.json",
    );
    fs.writeFileSync(activationVerificationFile, "{}\n", { mode: 0o600 });
    const activationDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      DEPLOYMENT_ID,
    )!;
    const preActivationDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      "55555555-5555-4555-8555-555555555555",
    )!;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1, PRODUCTION_ENVIRONMENT_ID, "pintpath.au", deployedSha))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1, PRODUCTION_ENVIRONMENT_ID, "pintpath.au", deployedSha))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(1, PRODUCTION_ENVIRONMENT_ID, "pintpath.au", deployedSha))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(2, PRODUCTION_ENVIRONMENT_ID, "pintpath.au", deployedSha));
    const commitScale = successfulCommit();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "converge-production-two",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", CANDIDATE_SHA,
        "--evidence-dir", evidenceDirectory,
        "--production-activation-run-id", PRODUCTION_ACTIVATE_RUN_ID,
        "--production-scale-verification-file", activationVerificationFile,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_RUN_ID: PRODUCTION_SCALE_RUN_ID,
        GITHUB_SHA: CANDIDATE_SHA,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "production-metadata-token-long-enough",
        PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN: "production-scale-token-long-enough",
        PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
          PROTECTED_SCALE_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
        PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID: PRODUCTION_ACTIVATE_RUN_ID,
        PINTPATH_PRODUCTION_SCALE_ACTIVATION_VERIFICATION_FILE:
          activationVerificationFile,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateProductionActivationPrerequisite: vi.fn(() => ({
        candidateSha: CANDIDATE_SHA,
        consumer: { runId: PRODUCTION_SCALE_RUN_ID },
        activationPrerequisites: { rolePrerequisites: { productionDeployment: {
          ...(archive ? { sourceArchive: productionArchiveFixture() } : {}),
        } } },
        activation: {
          runId: PRODUCTION_ACTIVATE_RUN_ID,
          terminalSha256: "1".repeat(64),
          prerequisitesSha256: "2".repeat(64),
          deploymentBeforeIdSha256: preActivationDeploymentIdSha256,
          deploymentAfterIdSha256: activationDeploymentIdSha256,
        },
      } as unknown as ProductionScaleActivationPrerequisiteVerification)),
      commitScale,
      readPatchHistory: successfulPatchHistory(),
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(commitScale).toHaveBeenCalledOnce();
    expect(commitScale).toHaveBeenCalledWith(
      "production-scale-token-long-enough",
      {
        environmentId: PRODUCTION_ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        regions: [{ region: "asia-southeast1-eqsg3a", numReplicas: 2 }],
        commitMessage: protectedScaleCommitMessage(
          "converge-production-two",
          CANDIDATE_SHA,
          PRODUCTION_SCALE_RUN_ID,
        ),
      },
    );
    expect(JSON.parse(output[0]!)).toMatchObject({
      direction: "converge-production-two",
      outcome: "scaled",
      desiredReplicas: 2,
      attempts: 1,
      retryAllowed: false,
      checks: {
        productionActivationPrerequisiteExact: true,
        productionActivationDeploymentContinuityExact: true,
        targetPostflightExact: true,
        deploymentUnchanged: true,
      },
      productionActivationPrerequisite: {
        runId: PRODUCTION_ACTIVATE_RUN_ID,
        verificationSha256: sha256("{}\n"),
        deploymentAfterIdSha256: activationDeploymentIdSha256,
      },
    });
  });

  it("blocks a D2 generation drift immediately before the direct mutation", async () => {
    const evidenceDirectory = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-production-scale-prewrite-drift-test-"),
    ));
    temporaryRoots.push(evidenceDirectory);
    const activationVerificationFile = path.join(
      evidenceDirectory,
      "production-scale-activation-verification.json",
    );
    fs.writeFileSync(activationVerificationFile, "{}\n", { mode: 0o600 });
    const activationDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      DEPLOYMENT_ID,
    )!;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        PRODUCTION_ENVIRONMENT_ID,
        "pintpath.au",
      ))
      .mockResolvedValueOnce(discovery(DRIFT_DEPLOYMENT_ID))
      .mockResolvedValueOnce(snapshot(
        1,
        PRODUCTION_ENVIRONMENT_ID,
        "pintpath.au",
        CANDIDATE_SHA,
        DRIFT_DEPLOYMENT_ID,
        DRIFT_SNAPSHOT_ID,
      ));
    const commitScale = vi.fn();
    const output: string[] = [];

    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "converge-production-two",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", CANDIDATE_SHA,
        "--evidence-dir", evidenceDirectory,
        "--production-activation-run-id", PRODUCTION_ACTIVATE_RUN_ID,
        "--production-scale-verification-file", activationVerificationFile,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_RUN_ID: PRODUCTION_SCALE_RUN_ID,
        GITHUB_SHA: CANDIDATE_SHA,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
          "production-metadata-token-long-enough",
        PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN:
          "production-scale-token-long-enough",
        PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
          PROTECTED_SCALE_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
        PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID: PRODUCTION_ACTIVATE_RUN_ID,
        PINTPATH_PRODUCTION_SCALE_ACTIVATION_VERIFICATION_FILE:
          activationVerificationFile,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateProductionActivationPrerequisite: vi.fn(() => ({
        candidateSha: CANDIDATE_SHA,
        consumer: { runId: PRODUCTION_SCALE_RUN_ID },
        activationPrerequisites: { rolePrerequisites: { productionDeployment: {} } },
        activation: {
          runId: PRODUCTION_ACTIVATE_RUN_ID,
          terminalSha256: "1".repeat(64),
          prerequisitesSha256: "2".repeat(64),
          deploymentBeforeIdSha256: "3".repeat(64),
          deploymentAfterIdSha256: activationDeploymentIdSha256,
        },
      } as unknown as ProductionScaleActivationPrerequisiteVerification)),
      commitScale,
      probeRuntime: vi.fn().mockResolvedValue(true),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        durableIntentExact: true,
        targetPreflightExact: false,
        productionActivationDeploymentContinuityExact: false,
        writeAttemptedAtMostOnce: true,
      },
    });
  });

  it("rejects production convergence unless the observed deployment SHA is the candidate", async () => {
    const fetchImpl = vi.fn();
    const commitScale = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "converge-production-two",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", "b".repeat(40),
        "--evidence-dir", "/private/evidence",
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE_SHA,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn(),
      reassertRepositoryState: () => true,
      commitScale,
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      candidateSha: null,
    });
  });

  it("blocks production scale before the write when activation names another deployment", async () => {
    const evidenceDirectory = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-production-scale-drift-test-"),
    ));
    temporaryRoots.push(evidenceDirectory);
    const activationVerificationFile = path.join(
      evidenceDirectory,
      "production-scale-activation-verification.json",
    );
    fs.writeFileSync(activationVerificationFile, "{}\n", { mode: 0o600 });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(scope(PRODUCTION_ENVIRONMENT_ID))
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(snapshot(
        1,
        PRODUCTION_ENVIRONMENT_ID,
        "pintpath.au",
      ));
    const commitScale = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: [
        "--direction", "converge-production-two",
        "--candidate-sha", CANDIDATE_SHA,
        "--expected-deployment-sha", CANDIDATE_SHA,
        "--evidence-dir", evidenceDirectory,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_RUN_ID: PRODUCTION_SCALE_RUN_ID,
        GITHUB_SHA: CANDIDATE_SHA,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
          "production-metadata-token-long-enough",
        PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN:
          "production-scale-token-long-enough",
        PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
          PROTECTED_SCALE_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
        PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID: PRODUCTION_ACTIVATE_RUN_ID,
        PINTPATH_PRODUCTION_SCALE_ACTIVATION_VERIFICATION_FILE:
          activationVerificationFile,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      reassertRepositoryState: () => true,
      validateProductionActivationPrerequisite: vi.fn(() => ({
        candidateSha: CANDIDATE_SHA,
        consumer: { runId: PRODUCTION_SCALE_RUN_ID },
        activationPrerequisites: { rolePrerequisites: { productionDeployment: {} } },
        activation: {
          runId: PRODUCTION_ACTIVATE_RUN_ID,
          terminalSha256: "1".repeat(64),
          prerequisitesSha256: "2".repeat(64),
          deploymentBeforeIdSha256: "3".repeat(64),
          deploymentAfterIdSha256: "4".repeat(64),
        },
      } as unknown as ProductionScaleActivationPrerequisiteVerification)),
      commitScale,
      probeRuntime: vi.fn(),
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });

    expect(result).toBe(1);
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        productionActivationPrerequisiteExact: true,
        productionActivationDeploymentContinuityExact: false,
      },
    });
  });

  it.each([
    ["out", argv("out"), "SCALE_PERMANENT_STAGING_TO_TWO_FOR_EVIDENCE"],
    ["converge-one", argv("converge-one"), "CONVERGE_PERMANENT_STAGING_TO_ONE"],
    ["quiesce-staging-zero", [
      "--direction", "quiesce-staging-zero",
      "--candidate-sha", CANDIDATE_SHA,
      "--expected-deployment-sha", "b".repeat(40),
      "--evidence-dir", "/private/evidence",
    ], "QUIESCE_PERMANENT_STAGING_TO_ZERO_FOR_WORKER_BOOTSTRAP"],
    ["bootstrap-staging-one", [
      "--direction", "bootstrap-staging-one",
      "--candidate-sha", CANDIDATE_SHA,
      "--expected-deployment-sha", CANDIDATE_SHA,
      "--evidence-dir", "/private/evidence",
    ], "RESTORE_PERMANENT_STAGING_TO_ONE_FOR_WORKER_BOOTSTRAP"],
    ["converge-production-two", [
      "--direction", "converge-production-two",
      "--candidate-sha", CANDIDATE_SHA,
      "--expected-deployment-sha", CANDIDATE_SHA,
      "--evidence-dir", "/private/evidence",
    ], "CONVERGE_PRODUCTION_TO_TWO_REPLICAS"],
  ] as const)("blocks a %s rerun before any provider read or write", async (
    _direction,
    directionArgv,
    confirmation,
  ) => {
    const fetchImpl = vi.fn();
    const commitScale = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: directionArgv,
      env: {
        ...environment("out"),
        GITHUB_RUN_ATTEMPT: "2",
        PINTPATH_SCALE_CONFIRMATION: confirmation,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn(),
      reassertRepositoryState: () => true,
      commitScale,
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { githubAuthorityExact: false },
    });
  });

  it("blocks before any provider call without the exact writer-freeze attestation", async () => {
    const fetchImpl = vi.fn();
    const commitScale = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingScale({
      argv: argv("out"),
      env: environment("out", {
        PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION: undefined,
      }),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: vi.fn(),
      boundaryCheck: vi.fn(),
      reassertRepositoryState: () => true,
      commitScale,
      writeDurable: durable,
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(commitScale).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      directMutationEvidence: {
        variablesSha256: null,
        requestBodySha256: null,
        commitMessageSha256: null,
        zeroRegionsEncodedAsJsonNull: false,
      },
      checks: { externalMutationFreezeAttested: false },
    });
  });
});
