import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  RAILWAY_ENVIRONMENT_MUTATION_BOUNDARY_QUERY,
  RAILWAY_EXACT_STAGED_PATCH_BOUNDARY_RECEIPT_SCHEMA,
  RAILWAY_MUTATION_BOUNDARY_RECEIPT_SCHEMA,
  RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY,
  RAILWAY_PROJECT_TOKEN_SCOPE_QUERY,
  railwayMutationBoundaryInternals,
  runRailwayExactStagedPatchBoundaryCheck,
  runRailwayMutationBoundaryCheck,
} from "../scripts/check-railway-mutation-boundary.js";
import {
  evaluateRailwayMutationBoundary,
  parseRailwayMutationPolicy,
  sourceReferencePinsDigest,
  type RailwayEnvironmentBoundary,
  type RailwayMutationPolicy,
  type RailwayProjectTokenScope,
  type RailwayProductionDeploymentBoundary,
} from "../scripts/lib/railway-environment-mutation-guard.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCTION_ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const STAGING_ENVIRONMENT_ID = "33333333-3333-4333-8333-333333333333";
const POSTGRES_SERVICE_ID = "44444444-4444-4444-8444-444444444444";
const POSTGRES_INSTANCE_ID = "55555555-5555-4555-8555-555555555555";
const DEPLOYMENT_ID = "66666666-6666-4666-8666-666666666666";
const SNAPSHOT_ID = "77777777-7777-4777-8777-777777777777";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const SOURCE_IMAGE = `ghcr.io/pintpath/postgres:17.10@${IMAGE_DIGEST}`;
const DEPLOYMENT_SOURCE_IMAGE = "ghcr.io/pintpath/postgres:17.10";
const DISABLED_AUTO_UPDATES = {
  type: "disabled",
  schedule: null,
  tagMode: null,
} as const;

function policyFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "pintpath-railway-production-staging-mutation-policy/v2",
    policyId: "pintpath-production-staging-mutation-boundary",
    projectId: PROJECT_ID,
    environments: [
      { name: "production", environmentId: PRODUCTION_ENVIRONMENT_ID },
      { name: "staging", environmentId: STAGING_ENVIRONMENT_ID },
    ],
    productionPostgres: {
      environmentId: PRODUCTION_ENVIRONMENT_ID,
      serviceId: POSTGRES_SERVICE_ID,
      deploymentId: DEPLOYMENT_ID,
      snapshotId: SNAPSHOT_ID,
      deploymentRecordedSourceImage: DEPLOYMENT_SOURCE_IMAGE,
      desiredServiceSourceImage: SOURCE_IMAGE,
      imageDigest: IMAGE_DIGEST,
      requiredAutoUpdates: DISABLED_AUTO_UPDATES,
      requireImmutableSource: true,
    },
    ...overrides,
  };
}

function parsedPolicy(overrides: Record<string, unknown> = {}): RailwayMutationPolicy {
  const parsed = parseRailwayMutationPolicy(JSON.stringify(policyFixture(overrides)));
  expect(parsed).not.toBeNull();
  return parsed!;
}

function environmentBoundary(
  environmentId: string,
  patch: Record<string, unknown> = {},
): RailwayEnvironmentBoundary {
  return { environmentId, patch };
}

function postgresBoundary(
  overrides: Partial<RailwayProductionDeploymentBoundary> = {},
): RailwayProductionDeploymentBoundary {
  return {
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    serviceId: POSTGRES_SERVICE_ID,
    sourceImage: SOURCE_IMAGE,
    sourceRepo: null,
    configuredSource: {
      image: SOURCE_IMAGE,
      repo: null,
      autoUpdates: {
        ...DISABLED_AUTO_UPDATES,
        exactShape: true,
        remediationNoticePresent: false,
        snoozedUntilPresent: false,
      },
    },
    latestDeployment: {
      id: DEPLOYMENT_ID,
      status: "SUCCESS",
      deploymentStopped: false,
      snapshotId: SNAPSHOT_ID,
    },
    activeDeployments: [
      { id: DEPLOYMENT_ID, status: "SUCCESS", deploymentStopped: false },
    ],
    approvedDeployment: {
      id: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ENVIRONMENT_ID,
      serviceId: POSTGRES_SERVICE_ID,
      snapshotId: SNAPSHOT_ID,
      sourceImage: DEPLOYMENT_SOURCE_IMAGE,
      imageDigest: IMAGE_DIGEST,
      patchId: null,
    },
    ...overrides,
  };
}

async function runWith(input: {
  policy?: Record<string, unknown>;
  production?: RailwayEnvironmentBoundary;
  staging?: RailwayEnvironmentBoundary;
  postgres?: RailwayProductionDeploymentBoundary;
  productionTokenScope?: RailwayProjectTokenScope;
  stagingTokenScope?: RailwayProjectTokenScope;
}) {
  const output: string[] = [];
  const queryEnvironment = vi.fn(async (variables: { environmentId: string }) =>
    variables.environmentId === PRODUCTION_ENVIRONMENT_ID
      ? (input.production ?? environmentBoundary(PRODUCTION_ENVIRONMENT_ID))
      : (input.staging ?? environmentBoundary(STAGING_ENVIRONMENT_ID)));
  const queryPostgres = vi.fn(async () => input.postgres ?? postgresBoundary());
  const queryTokenScope = vi.fn(async (tokenName: string) =>
    tokenName === "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN"
      ? (input.productionTokenScope ?? {
        projectId: PROJECT_ID,
        environmentId: PRODUCTION_ENVIRONMENT_ID,
      })
      : (input.stagingTokenScope ?? {
        projectId: PROJECT_ID,
        environmentId: STAGING_ENVIRONMENT_ID,
      }));
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", "fixture-policy.json"],
    readPolicy: () => JSON.stringify(input.policy ?? policyFixture()),
    queryEnvironment,
    queryPostgres,
    queryTokenScope,
    writeOutput: (line) => output.push(line),
  });
  expect(output).toHaveLength(1);
  expect(output[0]!.endsWith("\n")).toBe(true);
  return {
    code,
    queryEnvironment,
    queryPostgres,
    queryTokenScope,
    output: output[0]!,
    receipt: JSON.parse(output[0]!) as {
      schemaVersion: string;
      policy: string;
      mode: string;
      outcome: string;
      checks: Record<string, boolean>;
    },
  };
}

async function runExactStagedWith(input: {
  expectedPatch: Record<string, unknown>;
  stagingPatch: Record<string, unknown>;
  productionPatch?: Record<string, unknown>;
}) {
  const output: string[] = [];
  const code = await runRailwayExactStagedPatchBoundaryCheck(
    path.resolve("fixture-policy.json"),
    input.expectedPatch,
    {
      readPolicy: () => JSON.stringify(policyFixture()),
      queryEnvironment: async (variables) =>
        variables.environmentId === PRODUCTION_ENVIRONMENT_ID
          ? environmentBoundary(
              PRODUCTION_ENVIRONMENT_ID,
              input.productionPatch ?? {},
            )
          : environmentBoundary(STAGING_ENVIRONMENT_ID, input.stagingPatch),
      queryPostgres: async () => postgresBoundary(),
      queryTokenScope: async (tokenName) => tokenName ===
        "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN"
        ? { projectId: PROJECT_ID, environmentId: PRODUCTION_ENVIRONMENT_ID }
        : { projectId: PROJECT_ID, environmentId: STAGING_ENVIRONMENT_ID },
      writeOutput: (line) => output.push(line),
    },
  );
  expect(output).toHaveLength(1);
  return {
    code,
    receipt: JSON.parse(output[0]!) as {
      schemaVersion: string;
      outcome: string;
      ordinaryChecks: Record<string, boolean>;
      checks: Record<string, boolean>;
    },
  };
}

function environmentResponse(environmentId: string, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      environment: { id: environmentId },
      staged: {
        id: "<empty>",
        environmentId,
        status: "STAGED",
        createdAt: null,
        updatedAt: null,
        appliedAt: null,
        message: null,
        patch,
      },
    },
  });
}

function postgresResponse(meta: Record<string, unknown> = {
  imageDigest: IMAGE_DIGEST,
  image: DEPLOYMENT_SOURCE_IMAGE,
}, configuredSource: Record<string, unknown> = {
  image: SOURCE_IMAGE,
  autoUpdates: DISABLED_AUTO_UPDATES,
}): string {
  return JSON.stringify({
    data: {
      environment: {
        id: PRODUCTION_ENVIRONMENT_ID,
        config: {
          services: {
            [POSTGRES_SERVICE_ID]: {
              source: configuredSource,
            },
          },
        },
      },
      serviceInstance: {
        id: POSTGRES_INSTANCE_ID,
        serviceId: POSTGRES_SERVICE_ID,
        environmentId: PRODUCTION_ENVIRONMENT_ID,
        source: { image: SOURCE_IMAGE, repo: null },
        latestDeployment: {
          id: DEPLOYMENT_ID,
          status: "SUCCESS",
          deploymentStopped: false,
          snapshotId: SNAPSHOT_ID,
        },
        activeDeployments: [
          { id: DEPLOYMENT_ID, status: "SUCCESS", deploymentStopped: false },
        ],
      },
      approvedDeployment: {
        id: DEPLOYMENT_ID,
        projectId: PROJECT_ID,
        environmentId: PRODUCTION_ENVIRONMENT_ID,
        serviceId: POSTGRES_SERVICE_ID,
        snapshotId: SNAPSHOT_ID,
        meta,
      },
    },
  });
}

describe("Railway mutation boundary guard", () => {
  it("accepts only an empty two-environment boundary and exact immutable production image authority", async () => {
    const result = await runWith({});
    expect(result.code).toBe(0);
    expect(result.receipt).toEqual({
      schemaVersion: RAILWAY_MUTATION_BOUNDARY_RECEIPT_SCHEMA,
      policy: "pintpath-production-staging-mutation-boundary",
      mode: "read-only-boundary",
      outcome: "passed",
      checks: expect.objectContaining(
        Object.fromEntries(Object.keys(result.receipt.checks).map((key) => [key, true])),
      ),
    });
    expect(result.queryEnvironment).toHaveBeenCalledTimes(2);
    expect(result.queryPostgres).toHaveBeenCalledTimes(1);
    expect(result.queryTokenScope).toHaveBeenCalledTimes(2);
  });

  it("accepts only the exact reviewed staging patch while every other boundary stays clean", async () => {
    const decryptedDeletionPatch = {
      services: {
        "6816c4a2-e392-4ee5-826f-2584cb599ec0": {
          variables: {
            OFFSITE_BACKUP_BUCKET: null,
            OFFSITE_BACKUP_SERVICE_ROLE_KEY: null,
            OFFSITE_BACKUP_SUPABASE_URL: null,
          },
        },
      },
    };
    const expectedPatch = {
      services: {
        "6816c4a2-e392-4ee5-826f-2584cb599ec0": {
          variables: {
            OFFSITE_BACKUP_BUCKET: { value: "*****" },
            OFFSITE_BACKUP_SERVICE_ROLE_KEY: { value: "*****" },
            OFFSITE_BACKUP_SUPABASE_URL: { value: "*****" },
          },
        },
      },
    };
    const passed = await runExactStagedWith({
      expectedPatch,
      stagingPatch: expectedPatch,
    });
    expect(passed.code).toBe(0);
    expect(passed.receipt).toMatchObject({
      schemaVersion: RAILWAY_EXACT_STAGED_PATCH_BOUNDARY_RECEIPT_SCHEMA,
      outcome: "passed",
      ordinaryChecks: { stagingPatchEmpty: false },
      checks: {
        ordinaryBoundaryFailedOnlyForExpectedStagingPatch: true,
        stagingPatchExact: true,
      },
    });

    const wrongPatch = await runExactStagedWith({
      expectedPatch,
      stagingPatch: { services: { other: { variables: {} } } },
    });
    expect(wrongPatch.code).toBe(1);
    expect(wrongPatch.receipt.checks.stagingPatchExact).toBe(false);

    const decryptedInsteadOfMasked = await runExactStagedWith({
      expectedPatch,
      stagingPatch: decryptedDeletionPatch,
    });
    expect(decryptedInsteadOfMasked.code).toBe(1);
    expect(decryptedInsteadOfMasked.receipt.checks.stagingPatchExact)
      .toBe(false);

    const productionDrift = await runExactStagedWith({
      expectedPatch,
      stagingPatch: expectedPatch,
      productionPatch: { services: { drift: {} } },
    });
    expect(productionDrift.code).toBe(1);
    expect(productionDrift.receipt.checks).toMatchObject({
      ordinaryBoundaryFailedOnlyForExpectedStagingPatch: false,
      stagingPatchExact: true,
    });
  });

  it.each([
    [
      "a production staged patch",
      { production: environmentBoundary(PRODUCTION_ENVIRONMENT_ID, { services: { drift: {} } }) },
      "productionPatchEmpty",
    ],
    [
      "a staging staged patch",
      { staging: environmentBoundary(STAGING_ENVIRONMENT_ID, { variables: { drift: "x" } }) },
      "stagingPatchEmpty",
    ],
    [
      "a production token scoped to staging",
      { productionTokenScope: { projectId: PROJECT_ID, environmentId: STAGING_ENVIRONMENT_ID } },
      "productionTokenScopeExact",
    ],
    [
      "a staging token scoped to production",
      { stagingTokenScope: { projectId: PROJECT_ID, environmentId: PRODUCTION_ENVIRONMENT_ID } },
      "stagingTokenScopeExact",
    ],
    [
      "a different latest deployment",
      { postgres: postgresBoundary({ latestDeployment: { id: "88888888-8888-4888-8888-888888888888", status: "SUCCESS", deploymentStopped: false, snapshotId: SNAPSHOT_ID } }) },
      "approvedDeploymentCurrent",
    ],
    [
      "a missing active deployment",
      { postgres: postgresBoundary({ activeDeployments: [] }) },
      "approvedDeploymentActive",
    ],
    [
      "a stopped deployment",
      { postgres: postgresBoundary({ activeDeployments: [{ id: DEPLOYMENT_ID, status: "SUCCESS", deploymentStopped: true }] }) },
      "approvedDeploymentHealthy",
    ],
    [
      "snapshot drift",
      { postgres: postgresBoundary({ latestDeployment: { id: DEPLOYMENT_ID, status: "SUCCESS", deploymentStopped: false, snapshotId: "88888888-8888-4888-8888-888888888888" } }) },
      "approvedSnapshotExact",
    ],
    [
      "image digest drift",
      { postgres: postgresBoundary({ approvedDeployment: { ...postgresBoundary().approvedDeployment!, imageDigest: `sha256:${"b".repeat(64)}` } }) },
      "approvedImageDigestExact",
    ],
    [
      "a patch-derived deployment",
      { postgres: postgresBoundary({ approvedDeployment: { ...postgresBoundary().approvedDeployment!, patchId: "88888888-8888-4888-8888-888888888888" } }) },
      "deploymentPatchAbsent",
    ],
    [
      "a repository source",
      { postgres: postgresBoundary({ sourceRepo: "pintpath/app" }) },
      "sourceImageExact",
    ],
    [
      "deployment-recorded source drift",
      { postgres: postgresBoundary({ approvedDeployment: { ...postgresBoundary().approvedDeployment!, sourceImage: "ghcr.io/pintpath/postgres:other" } }) },
      "deploymentRecordedSourceExact",
    ],
    [
      "configured service source drift",
      { postgres: postgresBoundary({ configuredSource: { ...postgresBoundary().configuredSource!, image: "ghcr.io/pintpath/postgres:other" } }) },
      "sourceImageExact",
    ],
    [
      "enabled image auto-updates",
      { postgres: postgresBoundary({ configuredSource: { ...postgresBoundary().configuredSource!, autoUpdates: { ...postgresBoundary().configuredSource!.autoUpdates!, type: "vuln" } } }) },
      "autoUpdatesDisabledExact",
    ],
    [
      "an armed image auto-update remediation notice",
      { postgres: postgresBoundary({ configuredSource: { ...postgresBoundary().configuredSource!, autoUpdates: { ...postgresBoundary().configuredSource!.autoUpdates!, exactShape: false, remediationNoticePresent: true } } }) },
      "autoUpdatesDisabledExact",
    ],
    [
      "image auto-update snooze metadata",
      { postgres: postgresBoundary({ configuredSource: { ...postgresBoundary().configuredSource!, autoUpdates: { ...postgresBoundary().configuredSource!.autoUpdates!, exactShape: false, snoozedUntilPresent: true } } }) },
      "autoUpdatesDisabledExact",
    ],
  ])("fails closed on %s", async (_label, input, failedCheck) => {
    const result = await runWith(input);
    expect(result.code).toBe(1);
    expect(result.receipt.outcome).toBe("failed");
    expect(result.receipt.checks[failedCheck]).toBe(false);
  });

  it("treats a matching mutable source tag as an explicit blocker", async () => {
    const mutableSource = "ghcr.io/pintpath/postgres:17.10";
    const policy = policyFixture({
      productionPostgres: {
        ...policyFixture().productionPostgres as Record<string, unknown>,
        desiredServiceSourceImage: mutableSource,
      },
    });
    const result = await runWith({
      policy,
      postgres: postgresBoundary({
        sourceImage: mutableSource,
        configuredSource: {
          ...postgresBoundary().configuredSource!,
          image: mutableSource,
        },
      }),
    });
    expect(result.receipt.checks).toMatchObject({
      sourceImageExact: true,
      sourceReferenceImmutable: false,
    });
    expect(result.code).toBe(1);
  });

  it("strictly parses policies and binds the immutable source digest", () => {
    expect(sourceReferencePinsDigest(SOURCE_IMAGE, IMAGE_DIGEST)).toBe(true);
    expect(sourceReferencePinsDigest("ghcr.io/pintpath/postgres:17.10", IMAGE_DIGEST)).toBe(false);
    expect(parseRailwayMutationPolicy(JSON.stringify(policyFixture()))).toMatchObject({
      projectId: PROJECT_ID,
      productionPostgres: {
        deploymentId: DEPLOYMENT_ID,
        snapshotId: SNAPSHOT_ID,
        deploymentRecordedSourceImage: DEPLOYMENT_SOURCE_IMAGE,
        desiredServiceSourceImage: SOURCE_IMAGE,
        imageDigest: IMAGE_DIGEST,
        requiredAutoUpdates: DISABLED_AUTO_UPDATES,
      },
    });
    expect(parseRailwayMutationPolicy(JSON.stringify({ ...policyFixture(), extra: true }))).toBeNull();
    expect(parseRailwayMutationPolicy(JSON.stringify(policyFixture({
      productionPostgres: {
        ...policyFixture().productionPostgres as Record<string, unknown>,
        requiredAutoUpdates: {
          ...DISABLED_AUTO_UPDATES,
          remediationNotice: null,
        },
      },
    })))).toBeNull();
    expect(parseRailwayMutationPolicy(JSON.stringify({
      ...policyFixture(),
      schemaVersion: "pintpath-railway-production-staging-mutation-policy/v1",
    }))).toBeNull();
    expect(parseRailwayMutationPolicy(JSON.stringify(policyFixture({ environments: [
      { name: "staging", environmentId: STAGING_ENVIRONMENT_ID },
      { name: "production", environmentId: PRODUCTION_ENVIRONMENT_ID },
    ] })))).toBeNull();
  });

  it("parses only exact metadata responses and discards raw deployment metadata", () => {
    expect(
      railwayMutationBoundaryInternals.parseProjectTokenScopeResponse(
        JSON.stringify({
          data: {
            projectToken: {
              projectId: PROJECT_ID,
              environmentId: PRODUCTION_ENVIRONMENT_ID,
            },
          },
        }),
      ),
    ).toEqual({
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ENVIRONMENT_ID,
    });
    expect(
      railwayMutationBoundaryInternals.parseProjectTokenScopeResponse(
        JSON.stringify({
          data: {
            projectToken: {
              project: { id: PROJECT_ID },
              environment: { id: PRODUCTION_ENVIRONMENT_ID },
            },
          },
        }),
      ),
    ).toBeNull();
    expect(
      railwayMutationBoundaryInternals.parseEnvironmentBoundaryResponse(
        environmentResponse(PRODUCTION_ENVIRONMENT_ID),
      ),
    ).toEqual({ environmentId: PRODUCTION_ENVIRONMENT_ID, patch: {} });
    const parsedPostgres =
      railwayMutationBoundaryInternals.parseProductionPostgresResponse(
        postgresResponse({
          image: DEPLOYMENT_SOURCE_IMAGE,
          imageDigest: IMAGE_DIGEST,
          patchId: null,
          unrelated: "discarded",
        }),
      );
    expect(parsedPostgres).toMatchObject({
      configuredSource: {
        image: SOURCE_IMAGE,
        repo: null,
        autoUpdates: {
          ...DISABLED_AUTO_UPDATES,
          exactShape: true,
          remediationNoticePresent: false,
          snoozedUntilPresent: false,
        },
      },
      approvedDeployment: {
        sourceImage: DEPLOYMENT_SOURCE_IMAGE,
        imageDigest: IMAGE_DIGEST,
        patchId: null,
      },
    });

    const rawConfigSecret = "must-not-leave-environment-config";
    const withRawConfig = JSON.parse(postgresResponse()) as {
      data: { environment: { config: Record<string, unknown> } };
    };
    withRawConfig.data.environment.config.variables = {
      DATABASE_URL: rawConfigSecret,
    };
    const sanitized = railwayMutationBoundaryInternals
      .parseProductionPostgresResponse(JSON.stringify(withRawConfig));
    expect(sanitized).not.toBeNull();
    expect(JSON.stringify(sanitized)).not.toContain(rawConfigSecret);

    const armedRemediation = railwayMutationBoundaryInternals
      .parseProductionPostgresResponse(
        postgresResponse(undefined, {
          image: SOURCE_IMAGE,
          autoUpdates: {
            ...DISABLED_AUTO_UPDATES,
            remediationNotice: { id: rawConfigSecret },
          },
        }),
      );
    expect(armedRemediation).toMatchObject({
      configuredSource: {
        autoUpdates: {
          exactShape: false,
          remediationNoticePresent: true,
          snoozedUntilPresent: false,
        },
      },
    });
    expect(JSON.stringify(armedRemediation)).not.toContain(rawConfigSecret);
    expect(
      railwayMutationBoundaryInternals.parseEnvironmentBoundaryResponse(
        JSON.stringify({ errors: [{ message: "secret" }], data: null }),
      ),
    ).toBeNull();
    expect(
      railwayMutationBoundaryInternals.parseProductionPostgresResponse(
        postgresResponse({ imageDigest: "not-a-digest" }),
      ),
    ).toBeNull();
  });

  it("uses fixed metadata-only queries and separate project-scoped tokens", async () => {
    expect(railwayMutationBoundaryInternals.railwayMutationQueriesAreMetadataOnly()).toBe(true);
    expect(RAILWAY_ENVIRONMENT_MUTATION_BOUNDARY_QUERY).toContain(
      "patch(decryptVariables: false)",
    );
    expect(RAILWAY_PROJECT_TOKEN_SCOPE_QUERY).toContain("projectToken");
    expect(RAILWAY_PROJECT_TOKEN_SCOPE_QUERY).toContain("projectId");
    expect(RAILWAY_PROJECT_TOKEN_SCOPE_QUERY).toContain("environmentId");
    expect(RAILWAY_PROJECT_TOKEN_SCOPE_QUERY).not.toContain("project {");
    expect(RAILWAY_PROJECT_TOKEN_SCOPE_QUERY).not.toContain("environment {");
    expect(RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY).toContain("snapshotId");
    expect(RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY).toContain("meta");
    expect(RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY).toContain(
      "config(decryptVariables: false)",
    );

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        "Project-Access-Token": "production-project-token",
      });
      const body = JSON.parse(String(init?.body)) as { operationName: string };
      return new Response(
        body.operationName === "PintPathRailwayProjectTokenScope"
          ? JSON.stringify({
            data: {
              projectToken: {
                projectId: PROJECT_ID,
                environmentId: PRODUCTION_ENVIRONMENT_ID,
              },
            },
          })
          : body.operationName === "PintPathRailwayEnvironmentMutationBoundary"
          ? environmentResponse(PRODUCTION_ENVIRONMENT_ID)
          : postgresResponse(),
        { status: 200 },
      );
    }) as typeof fetch;
    await expect(
      railwayMutationBoundaryInternals.defaultQueryEnvironment(
        { projectId: PROJECT_ID, environmentId: PRODUCTION_ENVIRONMENT_ID },
        "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
        {
          PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "production-project-token",
          DATABASE_URL: "must-not-reach-request",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({ environmentId: PRODUCTION_ENVIRONMENT_ID, patch: {} });
    await expect(
      railwayMutationBoundaryInternals.defaultQueryTokenScope(
        "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
        { PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "production-project-token" },
        fetchImpl,
      ),
    ).resolves.toEqual({
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ENVIRONMENT_ID,
    });
    await expect(
      railwayMutationBoundaryInternals.defaultQueryPostgres(
        {
          projectId: PROJECT_ID,
          environmentId: PRODUCTION_ENVIRONMENT_ID,
          serviceId: POSTGRES_SERVICE_ID,
          deploymentId: DEPLOYMENT_ID,
        },
        { PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "production-project-token" },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ approvedDeployment: { imageDigest: IMAGE_DIGEST } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("bounds chunked metadata bodies and aborts stalled reads", async () => {
    const tooLarge = new Response(new Uint8Array(1024 * 1024 + 1));
    await expect(
      railwayMutationBoundaryInternals.readBoundedResponseBody(
        tooLarge,
        new AbortController().signal,
      ),
    ).rejects.toThrow("metadata_query_failed");

    const controller = new AbortController();
    const stalled = new Response(new ReadableStream<Uint8Array>({
      start() {
        // The explicit abort below is the only completion path.
      },
    }));
    const pending = railwayMutationBoundaryInternals.readBoundedResponseBody(
      stalled,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("metadata_query_failed");
  });

  it("rejects a shared token or a raw query error without leaking it", async () => {
    const secret = "postgresql://operator:secret@private.internal/pintpath";
    const output: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error(secret);
    }) as typeof fetch;
    const code = await runRailwayMutationBoundaryCheck({
      argv: ["--policy", "fixture-policy.json"],
      readPolicy: () => JSON.stringify(policyFixture()),
      env: {
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "same-project-token",
        PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "same-project-token",
      },
      fetchImpl,
      writeOutput: (line) => output.push(line),
    });
    expect(code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(secret);
    expect(JSON.parse(output[0]!)).toMatchObject({
      policy: "pintpath-production-staging-mutation-boundary",
      outcome: "failed",
    });
  });

  it("keeps the checked-in production Postgres pin exact and immutable", () => {
    const source = fs.readFileSync(
      path.resolve("ops/railway/production-staging-mutation-policy.json"),
      "utf8",
    );
    expect(source).not.toMatch(/postgres(?:ql)?:\/\//i);
    const policy = parseRailwayMutationPolicy(source);
    expect(policy).toMatchObject({
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      productionPostgres: {
        deploymentId: "f31d3dbd-a997-42cf-b3a8-970b8c337841",
        snapshotId: "03f6d2ff-e78e-42a5-a78f-216a4a1f498d",
        deploymentRecordedSourceImage:
          "ghcr.io/railwayapp-templates/postgres-ssl:17",
        desiredServiceSourceImage:
          "ghcr.io/railwayapp-templates/postgres-ssl@sha256:7383de344f558c61a16ecdcb3e6fc86f05c45c82a4e02ad77d96aa72b5ae2ba8",
        imageDigest: "sha256:7383de344f558c61a16ecdcb3e6fc86f05c45c82a4e02ad77d96aa72b5ae2ba8",
        requiredAutoUpdates: DISABLED_AUTO_UPDATES,
        requireImmutableSource: true,
      },
    });
    expect(sourceReferencePinsDigest(
      policy!.productionPostgres.desiredServiceSourceImage,
      policy!.productionPostgres.imageDigest,
    )).toBe(true);
  });

  it("preserves fixed failure output on malformed policy before any query", async () => {
    const result = await runWith({ policy: { ...policyFixture(), unexpected: true } });
    expect(result.code).toBe(1);
    expect(result.queryEnvironment).not.toHaveBeenCalled();
    expect(result.queryPostgres).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      policy: "invalid",
      mode: "invalid",
      outcome: "failed",
    });
  });

  it("does not confuse point-in-time evaluation with a mutation executor", () => {
    const checks = evaluateRailwayMutationBoundary({
      policy: parsedPolicy(),
      queriesMetadataOnly: true,
      productionTokenScope: {
        projectId: PROJECT_ID,
        environmentId: PRODUCTION_ENVIRONMENT_ID,
      },
      stagingTokenScope: {
        projectId: PROJECT_ID,
        environmentId: STAGING_ENVIRONMENT_ID,
      },
      production: environmentBoundary(PRODUCTION_ENVIRONMENT_ID),
      staging: environmentBoundary(STAGING_ENVIRONMENT_ID),
      postgres: postgresBoundary(),
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
    const source = fs.readFileSync(
      path.resolve("scripts/check-railway-mutation-boundary.ts"),
      "utf8",
    );
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("environmentPatchCommitStaged");
    expect(source).not.toContain("serviceInstanceDeploy");
  });
});
