import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  STAGING_POSTGRES_BACKUP_CANARY_LOCK,
  STAGING_POSTGRES_BACKUP_CANARY_SCHEMA,
  STAGING_POSTGRES_BACKUP_CANARY_SCOPE,
} from "../src/lib/postgres-staging-backup-canary.js";
import {
  RAILWAY_ENVIRONMENT_MUTATION_BOUNDARY_QUERY as ORIGINAL_BOUNDARY_QUERY,
  RAILWAY_PROJECT_TOKEN_SCOPE_QUERY as ORIGINAL_TOKEN_QUERY,
  parseEnvironmentBoundaryResponse,
  parseProjectTokenScopeResponse,
} from "../scripts/check-railway-mutation-boundary.js";
import { STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK } from
  "../scripts/lib/staging-postgres-build-canary-executor.js";
import {
  STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK,
  STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_STATE,
  assembleAuthoritativePostflight,
  assembleAuthoritativePreflight,
  evaluateCanaryVariableInventory,
  foldCanaryDeploymentInventoryPages,
  foldCanaryServiceInventoryPages,
  foldCanaryVolumeInventoryPages,
  parseCanaryDeploymentInventoryPage,
  parseCanaryDirectDeploymentResponse,
  parseCanaryServiceInventoryPage,
  parseCanaryTcpProxyInventoryResponse,
  parseCanaryUploadAcknowledgement,
  parseCanaryVolumeInventoryPage,
  parseCanonicalBuildOnlyReceipt,
} from "../scripts/lib/staging-postgres-build-canary-railway-contract.js";
import {
  RAILWAY_VARIABLE_METADATA_QUERY,
  railwaySealedVariableReadinessInternals,
} from "../scripts/railway-sealed-variable-readiness.js";

const LOCK = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
const CONTRACT_LOCK = STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK;
const EXPECTED_VARIABLE_NAMES = CONTRACT_LOCK.expectedVariableNames;
const parseMetadataPage = railwaySealedVariableReadinessInternals.parseMetadataPage;
const OTHER_SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const SNAPSHOT_ID = "55555555-5555-4555-8555-555555555555";
const DOMAIN_ID = "66666666-6666-4666-8666-666666666666";
const VOLUME_ID = "77777777-7777-4777-8777-777777777777";
const TCP_PROXY_ID = "88888888-8888-4888-8888-888888888888";
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;

function deploymentSummary(id = DEPLOYMENT_ID) {
  return { id, status: "SUCCESS", deploymentStopped: true };
}

function serviceNode(input: {
  id?: string;
  serviceId?: string;
  serviceName?: string;
  environmentId?: string;
  domainIds?: string[];
  latestDeployment?: ReturnType<typeof deploymentSummary> | null;
  activeDeployments?: ReturnType<typeof deploymentSummary>[];
  source?: { repo: string | null; image: string | null } | null;
  extra?: Record<string, unknown>;
} = {}) {
  return {
    id: input.id ?? LOCK.serviceInstanceId,
    serviceId: input.serviceId ?? LOCK.serviceId,
    serviceName: input.serviceName ?? LOCK.serviceName,
    environmentId: input.environmentId ?? LOCK.environmentId,
    numReplicas: 1,
    latestDeployment: input.latestDeployment ?? null,
    activeDeployments: input.activeDeployments ?? [],
    source: input.source === undefined ? null : input.source,
    domains: {
      serviceDomains: (input.domainIds ?? []).map((id) => ({ id })),
      customDomains: [],
    },
    cronSchedule: null,
    startCommand: "node dist/scripts/staging-postgres-backup-canary.js",
    ...(input.extra ?? {}),
  };
}

function servicePage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  environmentId = LOCK.environmentId,
): string {
  return JSON.stringify({
    data: {
      environment: {
        id: environmentId,
        serviceInstances: {
          edges: nodes.map((node) => ({ node })),
          pageInfo,
        },
      },
    },
  });
}

function volumePage(
  rows: Array<{ volumeId: string; serviceId: string | null }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  environmentId = LOCK.environmentId,
): string {
  return JSON.stringify({
    data: {
      environment: {
        id: environmentId,
        volumeInstances: {
          edges: rows.map((row) => ({
            node: {
              serviceId: row.serviceId,
              environmentId,
              volume: { id: row.volumeId },
            },
          })),
          pageInfo,
        },
      },
    },
  });
}

function deploymentPage(
  ids: string[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      deployments: {
        edges: ids.map((id) => ({ node: { id } })),
        pageInfo,
      },
    },
  });
}

function variablePage(
  rows: Array<{ id: string; name: string; serviceId: string | null }>,
  pageInfo: { hasNextPage: boolean },
): string {
  const edges = rows.map((row, index) => ({
    cursor: `row-${row.id}-${index}`,
    node: {
      id: row.id,
      name: row.name,
      environmentId: LOCK.environmentId,
      serviceId: row.serviceId,
      isSealed: false,
      references: [],
    },
  }));
  return JSON.stringify({
    data: {
      environment: {
        id: LOCK.environmentId,
        variables: {
          edges,
          pageInfo: {
            hasNextPage: pageInfo.hasNextPage,
            endCursor: edges.at(-1)?.cursor ?? null,
          },
        },
      },
    },
  });
}

function buildOnlyReceipt(deploymentId = DEPLOYMENT_ID): Record<string, unknown> {
  return {
    schemaVersion: STAGING_POSTGRES_BACKUP_CANARY_SCHEMA,
    scope: STAGING_POSTGRES_BACKUP_CANARY_SCOPE,
    mode: "build-only",
    outcome: "passed",
    deploymentId,
    transport: {
      profile: STAGING_POSTGRES_BACKUP_CANARY_LOCK.transportProfile,
      rootCaDerSha256: STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256,
    },
    candidates: {
      adminUrlSha256: null,
      databaseIdentitySha256: null,
    },
    identity: {
      railwayProject: true,
      railwayEnvironment: true,
      railwayService: true,
      railwayServiceName: true,
      railwayDeployment: true,
      dedicatedRailwayConfig: true,
      forbiddenEnvironmentAbsent: true,
      node22_23_2: true,
      credentialEnvironmentCleared: true,
      credentialInputsExact: true,
      runtimeUidExact: true,
      adminUrlAuthority: false,
      rootCaAuthority: false,
      transportAuthority: false,
      tlsScram: false,
      readOnlyTransaction: false,
      stagingDatabase: false,
      administrator: false,
    },
  };
}

describe("staging Postgres build-canary Railway contract candidates", () => {
  it("imports without reading ambient provider capabilities", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      get() {
        throw new Error("ambient-fetch-read");
      },
    });
    try {
      vi.resetModules();
      const imported = await import(
        "../scripts/lib/staging-postgres-build-canary-railway-contract.js"
      );
      expect(imported.STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_STATE).toBe(
        "HARD_DISABLED_LIVE_FIXTURES_REQUIRED",
      );
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
      else delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  it("binds pure public pins to the reviewed operational contracts", () => {
    expect(ORIGINAL_TOKEN_QUERY).toContain("projectToken");
    expect(ORIGINAL_BOUNDARY_QUERY).toContain("patch(decryptVariables: false)");
    expect(RAILWAY_VARIABLE_METADATA_QUERY).not.toMatch(/\bvalue\b/);
    expect(RAILWAY_VARIABLE_METADATA_QUERY).not.toContain("decryptVariables");
    expect(EXPECTED_VARIABLE_NAMES).toEqual([
      "RAILPACK_PACKAGES",
      "STAGING_POSTGRES_CA_CANARY_MODE",
      "STAGING_POSTGRES_CA_CANARY_RAILWAY_CONFIG_PATH",
    ]);
    expect(Object.isFrozen(EXPECTED_VARIABLE_NAMES)).toBe(true);
    expect(CONTRACT_LOCK).toMatchObject({
      projectId: LOCK.projectId,
      environmentId: LOCK.environmentId,
      serviceId: LOCK.serviceId,
      serviceInstanceId: LOCK.serviceInstanceId,
      serviceName: LOCK.serviceName,
      railwayConfigPath: LOCK.railwayConfigPath,
      canarySchema: STAGING_POSTGRES_BACKUP_CANARY_SCHEMA,
      canaryScope: STAGING_POSTGRES_BACKUP_CANARY_SCOPE,
      transportProfile: STAGING_POSTGRES_BACKUP_CANARY_LOCK.transportProfile,
      rootCaDerSha256: STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256,
    });

    expect(parseProjectTokenScopeResponse(JSON.stringify({
      data: {
        projectToken: {
          project: { id: LOCK.projectId },
          environment: { id: LOCK.environmentId },
        },
      },
    }))).toEqual({ projectId: LOCK.projectId, environmentId: LOCK.environmentId });
    expect(parseEnvironmentBoundaryResponse(JSON.stringify({
      data: {
        environment: { id: LOCK.environmentId },
        staged: {
          id: "<empty>",
          environmentId: LOCK.environmentId,
          status: "STAGED",
          createdAt: null,
          updatedAt: null,
          appliedAt: null,
          message: null,
          patch: {},
        },
      },
    }))).toEqual({ environmentId: LOCK.environmentId, patch: {} });
  });

  it("parses an exact multi-page service response sequence structurally", () => {
    const first = parseCanaryServiceInventoryPage(servicePage([
      serviceNode({
        id: OTHER_INSTANCE_ID,
        serviceId: OTHER_SERVICE_ID,
        serviceName: "other-service",
      }),
    ], { hasNextPage: true, endCursor: "service-page-1" }));
    const second = parseCanaryServiceInventoryPage(servicePage([
      serviceNode(),
    ], { hasNextPage: false, endCursor: "service-page-2" }));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(foldCanaryServiceInventoryPages([first!, second!])).toEqual({
      authority: "structural-candidate",
      pageInfoSequenceShape: "page-info-sequence-shape-candidate",
      serviceRowCount: 2,
      target: expect.objectContaining({
        serviceInstanceId: LOCK.serviceInstanceId,
        serviceId: LOCK.serviceId,
        serviceNameExact: true,
        domainIds: [],
        sourceAbsent: true,
        cronScheduleAbsent: true,
        startCommandExact: true,
      }),
    });
  });

  it("rejects service page drift, cursor incompleteness, loops, duplicates, and target ambiguity", () => {
    expect(foldCanaryServiceInventoryPages([null as never])).toBeNull();
    expect(parseCanaryServiceInventoryPage(servicePage([
      serviceNode({ extra: { unexpected: true } }),
    ], { hasNextPage: false, endCursor: null }))).toBeNull();
    expect(parseCanaryServiceInventoryPage(JSON.stringify({
      errors: [{ message: "raw provider error" }],
      data: null,
    }))).toBeNull();

    const open = parseCanaryServiceInventoryPage(servicePage(
      [serviceNode()],
      { hasNextPage: true, endCursor: "same" },
    ))!;
    const repeated = parseCanaryServiceInventoryPage(servicePage(
      [serviceNode({
        id: OTHER_INSTANCE_ID,
        serviceId: OTHER_SERVICE_ID,
        serviceName: "other-service",
      })],
      { hasNextPage: false, endCursor: "same" },
    ))!;
    expect(foldCanaryServiceInventoryPages([open])).toBeNull();
    expect(foldCanaryServiceInventoryPages([open, repeated])).toBeNull();

    const duplicateTarget = parseCanaryServiceInventoryPage(servicePage([
      serviceNode(),
      serviceNode({ id: OTHER_INSTANCE_ID }),
    ], { hasNextPage: false, endCursor: null }))!;
    expect(foldCanaryServiceInventoryPages([duplicateTarget])).toBeNull();

    const wrongEnvironment = parseCanaryServiceInventoryPage(servicePage(
      [serviceNode({ environmentId: OTHER_SERVICE_ID })],
      { hasNextPage: false, endCursor: null },
      OTHER_SERVICE_ID,
    ))!;
    expect(foldCanaryServiceInventoryPages([wrongEnvironment])).toBeNull();
  });

  it("retains only safe target domain and deployment metadata", () => {
    const repoSecret = "https://operator:repo-secret@example.invalid/private.git";
    const imageSecret = "registry.invalid/canary?token=image-secret";
    const commandSecret = "PASSWORD=command-secret node app.js";
    const page = parseCanaryServiceInventoryPage(servicePage([
      serviceNode({
        domainIds: [DOMAIN_ID],
        latestDeployment: deploymentSummary(),
        activeDeployments: [deploymentSummary()],
        source: { repo: repoSecret, image: imageSecret },
        extra: {
          cronSchedule: "PASSWORD=cron-secret",
          startCommand: commandSecret,
        },
      }),
    ], { hasNextPage: false, endCursor: null }))!;
    const inventory = foldCanaryServiceInventoryPages([page]);
    expect(inventory?.target).toMatchObject({
      domainIds: [DOMAIN_ID],
      latestDeployment: { id: DEPLOYMENT_ID, status: "SUCCESS" },
      activeDeployments: [{ id: DEPLOYMENT_ID, status: "SUCCESS" }],
      sourceAbsent: false,
      cronScheduleAbsent: false,
      startCommandExact: false,
    });
    expect(inventory?.target).not.toHaveProperty("domains");
    const retained = JSON.stringify(inventory);
    for (const secret of [repoSecret, imageSecret, commandSecret, "cron-secret"]) {
      expect(retained).not.toContain(secret);
    }
  });

  it("parses bounded volume page-info shapes and exposes target blockers", () => {
    const first = parseCanaryVolumeInventoryPage(volumePage(
      [{ volumeId: VOLUME_ID, serviceId: LOCK.serviceId }],
      { hasNextPage: true, endCursor: "volume-page-1" },
    ))!;
    const second = parseCanaryVolumeInventoryPage(volumePage(
      [],
      { hasNextPage: false, endCursor: null },
    ))!;
    expect(foldCanaryVolumeInventoryPages([first, second])).toEqual({
      authority: "structural-candidate",
      pageInfoSequenceShape: "page-info-sequence-shape-candidate",
      volumeRowCount: 1,
      targetVolumeIds: [VOLUME_ID],
    });
    expect(foldCanaryVolumeInventoryPages([first])).toBeNull();

    const duplicate = parseCanaryVolumeInventoryPage(volumePage(
      [{ volumeId: VOLUME_ID, serviceId: OTHER_SERVICE_ID }],
      { hasNextPage: false, endCursor: "volume-page-2" },
    ))!;
    expect(foldCanaryVolumeInventoryPages([first, duplicate])).toBeNull();
  });

  it("requires explicit pageInfo before a deployment inventory can even be structural", () => {
    const currentCliShape = JSON.stringify({
      data: {
        deployments: {
          edges: [{
            node: {
              id: DEPLOYMENT_ID,
              createdAt: "2026-08-11T00:00:00.000Z",
              status: "SUCCESS",
              meta: {},
            },
          }],
        },
      },
    });
    expect(parseCanaryDeploymentInventoryPage(currentCliShape)).toBeNull();

    const first = parseCanaryDeploymentInventoryPage(deploymentPage(
      [DEPLOYMENT_ID],
      { hasNextPage: true, endCursor: "deployment-page-1" },
    ))!;
    const second = parseCanaryDeploymentInventoryPage(deploymentPage(
      [SECOND_DEPLOYMENT_ID],
      { hasNextPage: false, endCursor: "deployment-page-2" },
    ))!;
    expect(foldCanaryDeploymentInventoryPages([first, second])).toEqual({
      authority: "structural-candidate",
      pageInfoSequenceShape: "page-info-sequence-shape-candidate",
      deploymentIds: [DEPLOYMENT_ID, SECOND_DEPLOYMENT_ID],
    });
    expect(foldCanaryDeploymentInventoryPages([first, { ...second, endCursor: "deployment-page-1" }]))
      .toBeNull();
  });

  it("parses only target-bound TCP proxy identifiers and never claims completeness", () => {
    expect(parseCanaryTcpProxyInventoryResponse(JSON.stringify({
      data: { tcpProxies: [] },
    }))).toEqual({ authority: "structural-candidate", tcpProxyIds: [] });
    expect(parseCanaryTcpProxyInventoryResponse(JSON.stringify({
      data: {
        tcpProxies: [{
          id: TCP_PROXY_ID,
          serviceId: LOCK.serviceId,
          environmentId: LOCK.environmentId,
          deletedAt: null,
        }],
      },
    }))).toEqual({
      authority: "structural-candidate",
      tcpProxyIds: [TCP_PROXY_ID],
    });
    expect(parseCanaryTcpProxyInventoryResponse(JSON.stringify({
      data: {
        tcpProxies: [{
          id: TCP_PROXY_ID,
          serviceId: OTHER_SERVICE_ID,
          environmentId: LOCK.environmentId,
          deletedAt: null,
        }],
      },
    }))).toBeNull();
  });

  it("accepts three target-owned names across a structural page-info sequence", () => {
    const first = parseMetadataPage(variablePage([
      { id: "other", name: "OTHER_SERVICE_ONLY", serviceId: OTHER_SERVICE_ID },
      { id: "one", name: EXPECTED_VARIABLE_NAMES[0], serviceId: LOCK.serviceId },
    ], { hasNextPage: true }))!;
    const second = parseMetadataPage(variablePage([
      { id: "shared-unrelated", name: "UNRELATED_SHARED_METADATA", serviceId: null },
      { id: "two", name: EXPECTED_VARIABLE_NAMES[1], serviceId: LOCK.serviceId },
      { id: "three", name: EXPECTED_VARIABLE_NAMES[2], serviceId: LOCK.serviceId },
    ], { hasNextPage: false }))!;
    expect(evaluateCanaryVariableInventory([first, second])).toEqual({
      authority: "structural-candidate",
      pageInfoSequenceShape: "page-info-sequence-shape-candidate",
      variableNames: [...EXPECTED_VARIABLE_NAMES],
      variableMetadataExact: true,
    });
  });

  it("rejects variable extras, shadows, duplicates, cursor loops, and value-bearing pages", () => {
    const exact = parseMetadataPage(variablePage(EXPECTED_VARIABLE_NAMES.map((name, index) => ({
      id: `variable-${index}`,
      name,
      serviceId: LOCK.serviceId,
    })), { hasNextPage: false }))!;
    expect(evaluateCanaryVariableInventory([exact])).not.toBeNull();

    const extra = parseMetadataPage(variablePage([
      ...EXPECTED_VARIABLE_NAMES.map((name, index) => ({
        id: `variable-${index}`,
        name,
        serviceId: LOCK.serviceId,
      })),
      { id: "extra", name: "UNEXPECTED_PUBLIC_VALUE", serviceId: LOCK.serviceId },
    ], { hasNextPage: false }))!;
    expect(evaluateCanaryVariableInventory([extra])).toBeNull();

    const shadow = parseMetadataPage(variablePage([
      ...EXPECTED_VARIABLE_NAMES.map((name, index) => ({
        id: `variable-${index}`,
        name,
        serviceId: LOCK.serviceId,
      })),
      { id: "shadow", name: EXPECTED_VARIABLE_NAMES[0], serviceId: null },
    ], { hasNextPage: false }))!;
    expect(evaluateCanaryVariableInventory([shadow])).toBeNull();
    expect(evaluateCanaryVariableInventory([{ ...exact, hasNextPage: true, endCursor: "open" }]))
      .toBeNull();

    const unrelatedShared = {
      ...exact,
      variables: [
        ...exact.variables,
        {
          ...exact.variables[0]!,
          id: "shared-unrelated",
          name: "UNRELATED_SHARED_METADATA",
          serviceId: null,
        },
      ],
    };
    expect(evaluateCanaryVariableInventory([unrelatedShared])).not.toBeNull();
    const sealedTarget = {
      ...exact,
      variables: exact.variables.map((variable, index) =>
        index === 0 ? { ...variable, isSealed: true } : variable
      ),
    };
    expect(evaluateCanaryVariableInventory([sealedTarget])).toBeNull();
    const referencedTarget = {
      ...exact,
      variables: exact.variables.map((variable, index) => index === 0
        ? {
          ...variable,
          references: [{ serviceId: OTHER_SERVICE_ID, name: "OTHER_REFERENCE" }],
        }
        : variable),
    };
    expect(evaluateCanaryVariableInventory([referencedTarget])).toBeNull();

    const withValue = JSON.parse(variablePage([], {
      hasNextPage: false,
    })) as { data: { environment: { variables: { edges: unknown[] } } } };
    withValue.data.environment.variables.edges.push({
      cursor: "secret-row",
      node: {
        id: "secret",
        name: EXPECTED_VARIABLE_NAMES[0],
        environmentId: LOCK.environmentId,
        serviceId: LOCK.serviceId,
        isSealed: false,
        references: [],
        value: "must-not-be-read",
      },
    });
    expect(parseMetadataPage(JSON.stringify(withValue))).toBeNull();
  });

  it("accepts only the exact canonical CLI acknowledgement and discards logsUrl", () => {
    const logsUrl = `https://railway.com/project/${LOCK.projectId}/service/${
      LOCK.serviceId
    }?environmentId=${LOCK.environmentId}&id=${DEPLOYMENT_ID}`;
    const source = `${JSON.stringify({ deploymentId: DEPLOYMENT_ID, logsUrl })}\n`;
    const parsed = parseCanaryUploadAcknowledgement(source);
    expect(parsed).toEqual({
      authority: "structural-candidate",
      deploymentId: DEPLOYMENT_ID,
    });
    expect(parsed).not.toHaveProperty("logsUrl");
    for (const invalid of [
      source.trim(),
      ` ${source}`,
      `${source}${source}`,
      `${JSON.stringify({ logsUrl, deploymentId: DEPLOYMENT_ID })}\n`,
      `${JSON.stringify({ deploymentId: DEPLOYMENT_ID, logsUrl, extra: true })}\n`,
      `${JSON.stringify({ deploymentId: "not-a-uuid", logsUrl })}\n`,
      `${JSON.stringify({ deploymentId: DEPLOYMENT_ID, logsUrl: logsUrl.replace("https://", "http://") })}\n`,
      `${JSON.stringify({ deploymentId: DEPLOYMENT_ID, logsUrl: `${logsUrl}#fragment` })}\n`,
    ]) expect(parseCanaryUploadAcknowledgement(invalid)).toBeNull();
  });

  it("parses a directly bound deployment while discarding opaque metadata", () => {
    const source = JSON.stringify({
      data: {
        deployment: {
          id: DEPLOYMENT_ID,
          projectId: LOCK.projectId,
          environmentId: LOCK.environmentId,
          serviceId: LOCK.serviceId,
          status: "SUCCESS",
          deploymentStopped: true,
          snapshotId: SNAPSHOT_ID,
          meta: {
            imageDigest: IMAGE_DIGEST,
            rawProviderDetail: "must-be-discarded",
          },
        },
      },
    });
    const parsed = parseCanaryDirectDeploymentResponse(source, DEPLOYMENT_ID);
    expect(parsed).toEqual({
      authority: "structural-candidate",
      deploymentId: DEPLOYMENT_ID,
      projectId: LOCK.projectId,
      environmentId: LOCK.environmentId,
      serviceId: LOCK.serviceId,
      status: "SUCCESS",
      deploymentStopped: true,
      snapshotId: SNAPSHOT_ID,
      imageDigest: IMAGE_DIGEST,
    });
    expect(JSON.stringify(parsed)).not.toContain("rawProviderDetail");
    expect(parseCanaryDirectDeploymentResponse(source, SECOND_DEPLOYMENT_ID)).toBeNull();
    expect(parseCanaryDirectDeploymentResponse(source.replace('"SUCCESS"', '"UNKNOWN"'), DEPLOYMENT_ID))
      .toBeNull();
    expect(parseCanaryDirectDeploymentResponse(source.replace(IMAGE_DIGEST, "latest"), DEPLOYMENT_ID))
      .toBeNull();
    expect(parseCanaryDirectDeploymentResponse(source.replace(LOCK.serviceId, OTHER_SERVICE_ID), DEPLOYMENT_ID))
      .toBeNull();

    Object.defineProperty(Object.prototype, "imageDigest", {
      configurable: true,
      value: IMAGE_DIGEST,
    });
    try {
      const withoutOwnDigest = JSON.stringify({
        data: {
          deployment: {
            id: DEPLOYMENT_ID,
            projectId: LOCK.projectId,
            environmentId: LOCK.environmentId,
            serviceId: LOCK.serviceId,
            status: "SUCCESS",
            deploymentStopped: true,
            snapshotId: SNAPSHOT_ID,
            meta: {},
          },
        },
      });
      expect(
        parseCanaryDirectDeploymentResponse(withoutOwnDigest, DEPLOYMENT_ID),
      ).toMatchObject({ imageDigest: null });
    } finally {
      delete (Object.prototype as Record<string, unknown>).imageDigest;
    }
  });

  it("accepts only the exact canonical passed build-only receipt", () => {
    const source = `${JSON.stringify(buildOnlyReceipt())}\n`;
    expect(parseCanonicalBuildOnlyReceipt(source, DEPLOYMENT_ID)).toEqual({
      authority: "structural-candidate",
      deploymentId: DEPLOYMENT_ID,
      buildOnlyReceiptPassed: true,
      buildOnlyReceiptSha256: crypto.createHash("sha256").update(source).digest("hex"),
      credentialCandidatesNull: true,
      dedicatedRailwayConfig: true,
      runtimePublicConfigurationExact: true,
    });

    const changedIdentity = buildOnlyReceipt() as {
      identity: Record<string, boolean>;
    };
    changedIdentity.identity.dedicatedRailwayConfig = false;
    const nonNullCandidate = buildOnlyReceipt() as {
      candidates: Record<string, string | null>;
    };
    nonNullCandidate.candidates.adminUrlSha256 = "a".repeat(64);
    const reordered = buildOnlyReceipt();
    const reorderedSource = `${JSON.stringify({
      scope: reordered.scope,
      schemaVersion: reordered.schemaVersion,
      mode: reordered.mode,
      outcome: reordered.outcome,
      deploymentId: reordered.deploymentId,
      transport: reordered.transport,
      candidates: reordered.candidates,
      identity: reordered.identity,
    })}\n`;
    for (const invalid of [
      JSON.stringify(buildOnlyReceipt()),
      `${source}${source}`,
      `${JSON.stringify({ ...buildOnlyReceipt(), outcome: "failed" })}\n`,
      `${JSON.stringify(changedIdentity)}\n`,
      `${JSON.stringify(nonNullCandidate)}\n`,
      reorderedSource,
    ]) expect(parseCanonicalBuildOnlyReceipt(invalid, DEPLOYMENT_ID)).toBeNull();
    expect(parseCanonicalBuildOnlyReceipt(source, SECOND_DEPLOYMENT_ID)).toBeNull();
  });

  it.each([
    "railwayProject",
    "railwayEnvironment",
    "railwayService",
    "railwayServiceName",
    "railwayDeployment",
    "dedicatedRailwayConfig",
    "forbiddenEnvironmentAbsent",
    "node22_23_2",
    "credentialEnvironmentCleared",
    "credentialInputsExact",
    "runtimeUidExact",
    "adminUrlAuthority",
    "rootCaAuthority",
    "transportAuthority",
    "tlsScram",
    "readOnlyTransaction",
    "stagingDatabase",
    "administrator",
  ])("rejects build-only identity drift at %s", (key) => {
    const receipt = buildOnlyReceipt() as { identity: Record<string, boolean> };
    receipt.identity[key] = !receipt.identity[key];
    expect(parseCanonicalBuildOnlyReceipt(
      `${JSON.stringify(receipt)}\n`,
      DEPLOYMENT_ID,
    )).toBeNull();
  });

  it("keeps every authoritative assembly path hard-disabled", () => {
    expect(STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_STATE).toBe(
      "HARD_DISABLED_LIVE_FIXTURES_REQUIRED",
    );
    const poison = new Proxy({}, {
      get() {
        throw new Error("candidate dependency must not be inspected");
      },
    });
    expect(assembleAuthoritativePreflight(poison)).toBeNull();
    expect(assembleAuthoritativePostflight(poison)).toBeNull();
  });
});
