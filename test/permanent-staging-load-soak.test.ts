import { describe, expect, it } from "vitest";

import {
  http5xxRatioPasses,
  loadPermanentStagingLoadSecrets,
  LoadSoakConfigurationError,
  parsePermanentStagingLoadConfiguration,
  percentile,
  permanentStagingIdentitySha256,
  runPermanentStagingLoadSoak,
  sha256,
  type PermanentStagingLoadConfiguration,
  type PermanentStagingLoadSecrets,
} from "../scripts/permanent-staging-load-soak.js";
import { railwayDeploymentIdentityIdSha256 } from "../src/lib/railway-deployment-identity.js";

const targetOrigin = "https://pintpath-staging.up.railway.app";
const projectId = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const environmentId = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const serviceId = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const commitSha = "a".repeat(40);
const projectIdSha256 = railwayDeploymentIdentityIdSha256("project", projectId)!;
const environmentIdSha256 = railwayDeploymentIdentityIdSha256(
  "environment",
  environmentId,
)!;
const serviceIdSha256 = railwayDeploymentIdentityIdSha256("service", serviceId)!;
const railwayIdentityIds = { projectId, environmentId, serviceId } as const;
const railwayIdentitySha256 = permanentStagingIdentitySha256(railwayIdentityIds);
const fixture = {
  schemaVersion: 1,
  purpose: "permanent-staging-disposable-load",
  reviewed: true,
  venueId: "venue-reviewed-load-01",
  venueName: "Reviewed Staging Hotel",
  suburb: "Carlton",
  beerName: "Guinness",
  servingSize: "pint",
  price: 13.75,
  isOnTap: "yes",
} as const;
const fixtureBytes = Buffer.from(JSON.stringify(fixture), "utf8");

function validEnvironment(): Record<string, string> {
  return {
    PINTPATH_STAGING_LOAD_MUTATION: "confirmed",
    PINTPATH_STAGING_LOAD_DISPOSABLE_USERS: "confirmed",
    PINTPATH_STAGING_LOAD_BASE_URL: targetOrigin,
    PINTPATH_STAGING_LOAD_EXPECTED_HOSTNAME: "pintpath-staging.up.railway.app",
    PINTPATH_STAGING_LOAD_EXPECTED_ORIGIN_SHA256: sha256(targetOrigin),
    PINTPATH_STAGING_LOAD_PRODUCTION_ORIGIN_SHA256: sha256("https://pintpath.au"),
    PINTPATH_STAGING_LOAD_RESTORE_ORIGIN_SHA256: sha256("https://restore-drill.invalid"),
    PINTPATH_STAGING_LOAD_EXPECTED_COMMIT_SHA: commitSha,
    PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: projectId,
    PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: environmentId,
    PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: serviceId,
    PINTPATH_STAGING_LOAD_EXPECTED_IDENTITY_SHA256: railwayIdentitySha256,
    PINTPATH_STAGING_LOAD_EXPECTED_RPS: "2",
    PINTPATH_STAGING_LOAD_EXPECTED_CONCURRENCY: "4",
    PINTPATH_STAGING_LOAD_EXPECTED_REPLICA_COUNT: "2",
    PINTPATH_STAGING_LOAD_USER_A_TOKEN_FILE: "/private/load-user-a-token",
    PINTPATH_STAGING_LOAD_USER_B_TOKEN_FILE: "/private/load-user-b-token",
    PINTPATH_STAGING_LOAD_ADMIN_TOKEN_FILE: "/private/load-admin-token",
    PINTPATH_STAGING_LOAD_WRITE_FIXTURE_FILE: "/private/load-fixture.json",
    PINTPATH_STAGING_LOAD_WRITE_FIXTURE_SHA256: sha256(fixtureBytes),
  };
}

function expectConfigurationFailure(
  environment: Record<string, string>,
  arguments_: string[],
  code: string,
): void {
  try {
    parsePermanentStagingLoadConfiguration(environment, arguments_);
    throw new Error("configuration unexpectedly passed");
  } catch (error) {
    expect(error).toBeInstanceOf(LoadSoakConfigurationError);
    expect((error as LoadSoakConfigurationError).code).toBe(code);
  }
}

describe("permanent-staging load/soak configuration", () => {
  it("pins the reviewed target, commit, Railway identity and bounded expected-peak profile", () => {
    const configuration = parsePermanentStagingLoadConfiguration(
      validEnvironment(),
      ["--profile=expected-peak", "--duration-minutes=10"],
    );

    expect(configuration).toMatchObject({
      profile: "expected-peak",
      durationMs: 600_000,
      ratePerSecond: 2,
      maxConcurrency: 4,
      requestTimeoutMs: 10_000,
      writeIntervalMs: 300_000,
      writeConcurrency: 4,
      expectedReplicaCount: 2,
      targetOrigin,
      targetOriginSha256: sha256(targetOrigin),
      targetProjectIdSha256: projectIdSha256,
      targetEnvironmentIdSha256: environmentIdSha256,
      targetServiceIdSha256: serviceIdSha256,
      expectedCommitSha: commitSha,
    });
    expect(configuration).not.toHaveProperty("userAToken");
    expect(configuration).not.toHaveProperty("adminToken");
  });

  it("doubles only the reviewed peak rate and concurrency", () => {
    const configuration = parsePermanentStagingLoadConfiguration(
      validEnvironment(),
      ["--profile=2x-peak", "--duration-minutes=10"],
    );
    expect(configuration.ratePerSecond).toBe(4);
    expect(configuration.maxConcurrency).toBe(8);
  });

  it("accepts a configurable soak only at sixty minutes or longer", () => {
    const sixty = parsePermanentStagingLoadConfiguration(
      validEnvironment(),
      ["--profile=soak", "--duration-minutes=60"],
    );
    const eightHours = parsePermanentStagingLoadConfiguration(
      validEnvironment(),
      ["--profile=soak", "--duration-minutes=480"],
    );
    expect(sixty.durationMs).toBe(3_600_000);
    expect(eightHours.durationMs).toBe(28_800_000);
    expectConfigurationFailure(
      validEnvironment(),
      ["--profile=soak", "--duration-minutes=59"],
      "profile_bounds_invalid",
    );
  });

  it.each([
    ["missing mutation confirmation", { PINTPATH_STAGING_LOAD_MUTATION: "" }, "mutation_confirmation_missing"],
    ["missing disposable-user confirmation", { PINTPATH_STAGING_LOAD_DISPOSABLE_USERS: "" }, "disposable_user_confirmation_missing"],
    ["restore mode", { RESTORE_REHEARSAL_MODE: "true" }, "restore_mode_detected"],
    ["canonical production target", {
      PINTPATH_STAGING_LOAD_BASE_URL: "https://pintpath.au",
      PINTPATH_STAGING_LOAD_EXPECTED_HOSTNAME: "pintpath.au",
      PINTPATH_STAGING_LOAD_EXPECTED_ORIGIN_SHA256: sha256("https://pintpath.au"),
    }, "target_invalid"],
    ["host without staging marker", {
      PINTPATH_STAGING_LOAD_BASE_URL: "https://pintpath-preview.up.railway.app",
      PINTPATH_STAGING_LOAD_EXPECTED_HOSTNAME: "pintpath-preview.up.railway.app",
      PINTPATH_STAGING_LOAD_EXPECTED_ORIGIN_SHA256: sha256("https://pintpath-preview.up.railway.app"),
    }, "target_not_staging"],
    ["origin pin mismatch", { PINTPATH_STAGING_LOAD_EXPECTED_ORIGIN_SHA256: "f".repeat(64) }, "target_pin_mismatch"],
    ["forbidden production origin", { PINTPATH_STAGING_LOAD_PRODUCTION_ORIGIN_SHA256: sha256(targetOrigin) }, "target_is_forbidden"],
    ["commit not exact", { PINTPATH_STAGING_LOAD_EXPECTED_COMMIT_SHA: "a".repeat(39) }, "commit_pin_invalid"],
    ["identity mismatch", { PINTPATH_STAGING_LOAD_EXPECTED_IDENTITY_SHA256: "b".repeat(64) }, "identity_pin_invalid"],
  ])("rejects %s before any request", (_label, overrides, code) => {
    expectConfigurationFailure(
      { ...validEnvironment(), ...overrides },
      ["--profile=expected-peak", "--duration-minutes=10"],
      code,
    );
  });

  const railwayIdentityInputs = [
    {
      label: "project",
      environmentName: "PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID",
      identityField: "projectId",
      value: projectId,
    },
    {
      label: "environment",
      environmentName: "PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID",
      identityField: "environmentId",
      value: environmentId,
    },
    {
      label: "service",
      environmentName: "PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID",
      identityField: "serviceId",
      value: serviceId,
    },
  ] as const;

  const invalidRailwayIdentityInputs = railwayIdentityInputs.flatMap((input) => {
    const uppercase = input.value.toUpperCase();
    const nonRfcVersion = `${input.value.slice(0, 14)}0${input.value.slice(15)}`;
    return [
      {
        ...input,
        state: "leading whitespace",
        invalidValue: ` ${input.value}`,
        expectedIdentitySha256: railwayIdentitySha256,
      },
      {
        ...input,
        state: "trailing whitespace",
        invalidValue: `${input.value} `,
        expectedIdentitySha256: railwayIdentitySha256,
      },
      {
        ...input,
        state: "uppercase spelling",
        invalidValue: uppercase,
        expectedIdentitySha256: permanentStagingIdentitySha256({
          ...railwayIdentityIds,
          [input.identityField]: uppercase,
        }),
      },
      {
        ...input,
        state: "non-RFC version spelling",
        invalidValue: nonRfcVersion,
        expectedIdentitySha256: permanentStagingIdentitySha256({
          ...railwayIdentityIds,
          [input.identityField]: nonRfcVersion,
        }),
      },
    ];
  });

  it.each(invalidRailwayIdentityInputs)(
    "rejects a $state for the raw Railway $label ID before hashing",
    ({ environmentName, invalidValue, expectedIdentitySha256 }) => {
      expectConfigurationFailure(
        {
          ...validEnvironment(),
          [environmentName]: invalidValue,
          PINTPATH_STAGING_LOAD_EXPECTED_IDENTITY_SHA256: expectedIdentitySha256,
        },
        ["--profile=expected-peak", "--duration-minutes=10"],
        "identity_pin_invalid",
      );
    },
  );

  it("loads distinct credentials and only the exact pinned reviewed fixture", async () => {
    const configuration = parsePermanentStagingLoadConfiguration(
      validEnvironment(),
      ["--profile=expected-peak", "--duration-minutes=10"],
    );
    const files = new Map<string, Buffer>([
      [configuration.userATokenFile, Buffer.from("user-a-opaque-token-1234567890")],
      [configuration.userBTokenFile, Buffer.from("user-b-opaque-token-1234567890")],
      [configuration.adminTokenFile, Buffer.from("admin-opaque-token-12345678900")],
      [configuration.writeFixtureFile, fixtureBytes],
    ]);
    const secrets = await loadPermanentStagingLoadSecrets(configuration, async (filename) => files.get(filename)!);

    expect(secrets.writeFixture).toEqual(fixture);
    expect(JSON.stringify(configuration)).not.toContain(secrets.userAToken);
    expect(JSON.stringify(configuration)).not.toContain(secrets.userBToken);
    expect(JSON.stringify(configuration)).not.toContain(secrets.adminToken);

    const changedFixture = Buffer.from(JSON.stringify({ ...fixture, price: 13.76 }));
    await expect(loadPermanentStagingLoadSecrets(configuration, async (filename) => (
      filename === configuration.writeFixtureFile ? changedFixture : files.get(filename)!
    ))).rejects.toMatchObject({ code: "fixture_pin_invalid" });
  });

  it("implements the strict published thresholds", () => {
    expect(http5xxRatioPasses(0, 1)).toBe(true);
    expect(http5xxRatioPasses(1, 101)).toBe(true);
    expect(http5xxRatioPasses(1, 100)).toBe(false);
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBe(50);
    expect(percentile([], 0.95)).toBeNull();
  });
});

const userAToken = "user-a-opaque-token-1234567890";
const userBToken = "user-b-opaque-token-1234567890";
const adminToken = "admin-opaque-token-12345678900";
const replicaA = "1".repeat(64);
const replicaB = "2".repeat(64);
const replicaC = "3".repeat(64);
const deploymentIdSha256 = "4".repeat(64);
const replacementDeploymentIdSha256 = "5".repeat(64);
const healthyPoolMetrics = [
  {
    label: "runtime",
    maxConnections: 2,
    totalConnections: 1,
    idleConnections: 1,
    waitingRequests: 0,
    capacityWaitEvents: 0,
    capacityWaitHighWater: 0,
    capacityWaitDurationMs: 0,
    connectionCreationHeadroom: 1,
    availableConnections: 2,
  },
  {
    label: "maintenance_work",
    maxConnections: 1,
    totalConnections: 1,
    idleConnections: 1,
    waitingRequests: 0,
    capacityWaitEvents: 0,
    capacityWaitHighWater: 0,
    capacityWaitDurationMs: 0,
    connectionCreationHeadroom: 0,
    availableConnections: 1,
  },
  {
    label: "maintenance_readiness",
    maxConnections: 1,
    totalConnections: 1,
    idleConnections: 1,
    waitingRequests: 0,
    capacityWaitEvents: 0,
    capacityWaitHighWater: 0,
    capacityWaitDurationMs: 0,
    connectionCreationHeadroom: 0,
    availableConnections: 1,
  },
] as const;

type DeploymentIdentityHashField =
  | "projectIdSha256"
  | "environmentIdSha256"
  | "serviceIdSha256";

type DeploymentIdentityHashOverrides = Partial<
  Record<DeploymentIdentityHashField, string | undefined>
>;

function response(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeRun(input: {
  leakToUserB?: boolean;
  durationMs?: number;
  preflightDeploymentOverrides?: Partial<
    Record<"health" | "ready", DeploymentIdentityHashOverrides>
  >;
  timedDeploymentOverrides?: DeploymentIdentityHashOverrides;
  preflightPoolMetrics?: unknown;
  timedPoolMetrics?: unknown;
  timedReadyFailureProbe?: number;
  healthReplicaSequence?: readonly string[];
  readyReplicaSequence?: readonly string[];
  readyDeploymentSequence?: readonly string[];
} = {}): {
  configuration: PermanentStagingLoadConfiguration;
  secrets: PermanentStagingLoadSecrets;
  fetchImplementation: typeof fetch;
} {
  const parsed = parsePermanentStagingLoadConfiguration(
    validEnvironment(),
    ["--profile=expected-peak", "--duration-minutes=5"],
  );
  const configuration: PermanentStagingLoadConfiguration = {
    ...parsed,
    durationMs: input.durationMs ?? 6_000,
  };
  const secrets: PermanentStagingLoadSecrets = {
    userAToken,
    userBToken,
    adminToken,
    writeFixture: fixture,
  };
  const submissions: Array<Record<string, unknown>> = [];
  let healthProbe = 0;
  let readyProbe = 0;
  const fetchImplementation = (async (requestInput: URL | RequestInfo, requestInit?: RequestInit) => {
    const url = requestInput instanceof URL
      ? requestInput
      : new URL(typeof requestInput === "string" ? requestInput : requestInput.url);
    const authorization = new Headers(requestInit?.headers).get("authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (url.pathname === "/health" || url.pathname === "/ready") {
      const route = url.pathname === "/health" ? "health" : "ready";
      const probeIndex = route === "health" ? healthProbe++ : readyProbe++;
      const replicaIdSha256 = (
        route === "health" ? input.healthReplicaSequence : input.readyReplicaSequence
      )?.[probeIndex] ?? (probeIndex % 2 === 0 ? replicaA : replicaB);
      const preflightIdentityProbe = route === "ready"
        ? probeIndex < configuration.expectedReplicaCount
        : probeIndex === 0;
      const deploymentOverrides = preflightIdentityProbe
        ? input.preflightDeploymentOverrides?.[route]
        : input.timedDeploymentOverrides;
      const selectedPoolMetrics = probeIndex < configuration.expectedReplicaCount
        ? input.preflightPoolMetrics
        : input.timedPoolMetrics;
      const responseStatus = route === "ready"
          && input.timedReadyFailureProbe === probeIndex
        ? 503
        : 200;
      return response({
        service: "pint-path",
        status: url.pathname === "/health" ? "ok" : "ready",
        deployment: {
          commitSha,
          environment: "production",
          projectIdSha256,
          environmentIdSha256,
          serviceIdSha256,
          deploymentIdSha256: route === "ready"
            ? input.readyDeploymentSequence?.[probeIndex] ?? deploymentIdSha256
            : deploymentIdSha256,
          replicaIdSha256,
          ...deploymentOverrides,
        },
        ...(route === "ready"
          ? {
              dependencies: {
                database: {
                  status: "ok",
                  foreignKeyViolations: 0,
                  poolMetrics: selectedPoolMetrics === undefined
                    ? healthyPoolMetrics
                    : selectedPoolMetrics,
                },
              },
            }
          : {}),
      }, responseStatus);
    }
    if (url.pathname === "/api/business/config") {
      return response({
        priceAccessModel: "fixed_preview",
        happyHourDiscoveryEnabled: false,
        happyHourContributionsEnabled: false,
        consumerPaidEnrollmentEnabled: false,
        pintPointsRewardsEnabled: false,
        alcoholGamificationEnabled: false,
        demoBillingMode: false,
        fieldTestMode: false,
      });
    }
    if (url.pathname === "/api/business/venues") {
      return response({ venues: [] });
    }
    if (url.pathname === "/api/business/price-records") {
      return response({ records: [] });
    }
    if (url.pathname === "/api/business/access") {
      return response({ access: "public" });
    }
    if (url.pathname === "/api/admin/status") {
      return token === adminToken
        ? response({ enabled: true, ocrEnabled: true, googlePlacesEnabled: true, queueEnabled: true })
        : response({ message: "denied" }, 401);
    }
    if (url.pathname === "/api/business/account") {
      if (token === userAToken) return response({ account: { id: "user-a", role: "user" } });
      if (token === userBToken) return response({ account: { id: "user-b", role: "user" } });
      return response({ message: "denied" }, 401);
    }
    if (url.pathname === "/api/business/submissions" && requestInit?.method === "POST") {
      if (token !== userAToken) return response({ message: "denied" }, 401);
      const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>;
      const clientSubmissionId = String(body.clientSubmissionId);
      const existing = submissions.find((submission) => submission.clientSubmissionId === clientSubmissionId);
      if (existing) return response({ submission: existing, idempotentReplay: true }, 200);
      const created = { id: `submission-${submissions.length + 1}`, clientSubmissionId };
      submissions.push(created);
      return response({ submission: created }, 201);
    }
    if (url.pathname === "/api/business/submissions") {
      if (token === userAToken || (input.leakToUserB && token === userBToken)) {
        return response({ submissions, pagination: { total: submissions.length } });
      }
      return response({ submissions: [], pagination: { total: 0 } });
    }
    throw new Error(`unexpected fake route: ${url.pathname}`);
  }) as typeof fetch;
  return { configuration, secrets, fetchImplementation };
}

describe("permanent-staging load/soak execution", () => {
  it("proves idempotent concurrency, isolation, latency and two-replica participation without leaking credentials", async () => {
    const harness = fakeRun();
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(report.passed).toBe(true);
    expect(report.schemaVersion).toBe(2);
    expect(report.failureCodes).toEqual([]);
    expect(report.deploymentIdSha256).toBe(deploymentIdSha256);
    expect(report.replicas).toEqual({
      expectedCount: 2,
      observedCount: 2,
      replicaIdSha256s: [replicaA, replicaB],
    });
    expect(report.postgresPoolMetrics).toEqual({
      readinessSamples: 5,
      observedReplicaCount: 2,
      replicaIdSha256s: [replicaA, replicaB],
      pools: [
        {
          label: "runtime",
          maxConnections: 2,
          samples: 5,
          maxWaitingRequests: 0,
          minAvailableConnections: 2,
          maxCapacityWaitEvents: 0,
          maxCapacityWaitHighWater: 0,
          maxCapacityWaitDurationMs: 0,
        },
        {
          label: "maintenance_work",
          maxConnections: 1,
          samples: 5,
          maxWaitingRequests: 0,
          minAvailableConnections: 1,
          maxCapacityWaitEvents: 0,
          maxCapacityWaitHighWater: 0,
          maxCapacityWaitDurationMs: 0,
        },
        {
          label: "maintenance_readiness",
          maxConnections: 1,
          samples: 5,
          maxWaitingRequests: 0,
          minAvailableConnections: 1,
          maxCapacityWaitEvents: 0,
          maxCapacityWaitHighWater: 0,
          maxCapacityWaitDurationMs: 0,
        },
      ],
    });
    expect(report.routes.find((route) => route.route === "GET /ready")?.requests)
      .toBeLessThan(report.postgresPoolMetrics.readinessSamples);
    expect(report.journeys).toMatchObject({
      writeCyclesAttempted: 1,
      writeCyclesCompleted: 1,
      writeRequests: 4,
      duplicateFailures: 0,
      lostWriteFailures: 0,
      isolationFailures: 0,
    });
    expect(report.thresholds.http5xxRatio).toBe(0);
    expect(report.routes.map((route) => route.route)).toEqual(expect.arrayContaining([
      "GET /health",
      "GET /ready",
      "GET /api/admin/status",
      "POST /api/business/submissions",
    ]));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(userAToken);
    expect(serialized).not.toContain(userBToken);
    expect(serialized).not.toContain(adminToken);
    expect(serialized).not.toContain(targetOrigin);
    expect(serialized).not.toContain("user-a");
    expect(serialized).not.toContain("user-b");
  });

  it("keeps post-load replica-sweep successes out of timed traffic thresholds", async () => {
    const execute = async (readyReplicaSequence: readonly string[]) => {
      const harness = fakeRun({ readyReplicaSequence });
      let monotonic = 0;
      let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
      return runPermanentStagingLoadSoak(
        harness.configuration,
        harness.secrets,
        {
          fetch: harness.fetchImplementation,
          wallNow: () => wallNow,
          monotonicNow: () => monotonic += 1,
          randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
          sleep: async (milliseconds) => { wallNow += milliseconds; },
        },
      );
    };
    const baseline = await execute([replicaA, replicaB, replicaA, replicaB]);
    const extendedSweep = await execute([
      replicaA,
      replicaB,
      ...Array.from({ length: 12 }, () => replicaA),
      replicaB,
    ]);

    expect(baseline.passed).toBe(true);
    expect(extendedSweep.passed).toBe(true);
    expect(extendedSweep.postgresPoolMetrics.readinessSamples)
      .toBeGreaterThan(baseline.postgresPoolMetrics.readinessSamples);
    expect(extendedSweep.totals).toEqual(baseline.totals);
    expect(extendedSweep.thresholds).toEqual(baseline.thresholds);
    expect(extendedSweep.routes).toEqual(baseline.routes);
  });

  it("fails closed when the second disposable user can observe the first user's write", async () => {
    const harness = fakeRun({ leakToUserB: true });
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(report.passed).toBe(false);
    expect(report.journeys.isolationFailures).toBe(1);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "isolation_failure",
      "profile_incomplete",
      "write_journey_failed",
    ]));
  });

  it("fails closed and retains the worst pool sample when any readiness probe waits", async () => {
    const harness = fakeRun({
      timedPoolMetrics: healthyPoolMetrics.map((pool) => pool.label === "runtime"
        ? { ...pool, waitingRequests: 1 }
        : pool),
    });
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(report.passed).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "postgres_pool_evidence_failed",
      "profile_incomplete",
      "response_contract_failure",
    ]));
    expect(report.postgresPoolMetrics.pools).toContainEqual({
      label: "runtime",
      maxConnections: 2,
      samples: 3,
      maxWaitingRequests: 1,
      minAvailableConnections: 2,
      maxCapacityWaitEvents: 0,
      maxCapacityWaitHighWater: 0,
      maxCapacityWaitDurationMs: 0,
    });
  });

  it("rejects a drained historical capacity wait that an instantaneous gauge misses", async () => {
    const harness = fakeRun({
      timedPoolMetrics: healthyPoolMetrics.map((pool) => pool.label === "runtime"
        ? {
            ...pool,
            waitingRequests: 0,
            capacityWaitEvents: 1,
            capacityWaitHighWater: 1,
            capacityWaitDurationMs: 37,
          }
        : pool),
    });
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(report.passed).toBe(false);
    expect(report.failureCodes).toContain("postgres_pool_evidence_failed");
    expect(report.postgresPoolMetrics.pools).toContainEqual({
      label: "runtime",
      maxConnections: 2,
      samples: 3,
      maxWaitingRequests: 0,
      minAvailableConnections: 2,
      maxCapacityWaitEvents: 1,
      maxCapacityWaitHighWater: 1,
      maxCapacityWaitDurationMs: 37,
    });
  });

  it("rejects a replica replacement before the post-load monotonic-counter sweep completes", async () => {
    const harness = fakeRun({
      readyReplicaSequence: [replicaA, replicaB, replicaA, replicaC],
    });
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(report.passed).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "profile_incomplete",
      "target_identity_changed",
    ]));
  });

  it("rejects a third replica observed during timed traffic", async () => {
    const harness = fakeRun({
      healthReplicaSequence: [replicaA, replicaA, replicaC],
    });
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(report.passed).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "profile_incomplete",
      "replica_participation_failed",
      "target_identity_changed",
    ]));
    expect(report.replicas.replicaIdSha256s).not.toContain(replicaC);
  });

  it("rejects a same-commit deployment replacement that resets process counters", async () => {
    const harness = fakeRun({
      readyDeploymentSequence: [
        deploymentIdSha256,
        deploymentIdSha256,
        replacementDeploymentIdSha256,
      ],
    });
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(report.passed).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "profile_incomplete",
      "target_identity_changed",
    ]));
  });

  it("rejects one timed readiness failure even when it is below the global 1% HTTP threshold", async () => {
    const harness = fakeRun({
      durationMs: 70_000,
      timedReadyFailureProbe: 11,
    });
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(http5xxRatioPasses(report.totals.http5xx, report.totals.requests)).toBe(true);
    expect(report.totals.http5xx).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "postgres_pool_evidence_failed",
      "profile_incomplete",
      "response_contract_failure",
    ]));
  });

  it("rejects impossible pool counters during preflight", async () => {
    const harness = fakeRun({
      preflightPoolMetrics: healthyPoolMetrics.map((pool) => pool.label === "runtime"
        ? {
            ...pool,
            totalConnections: 3,
            connectionCreationHeadroom: 0,
            availableConnections: 1,
          }
        : pool),
    });
    let monotonic = 0;
    let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
    const report = await runPermanentStagingLoadSoak(
      harness.configuration,
      harness.secrets,
      {
        fetch: harness.fetchImplementation,
        wallNow: () => wallNow,
        monotonicNow: () => monotonic += 1,
        randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
        sleep: async (milliseconds) => { wallNow += milliseconds; },
      },
    );

    expect(report.passed).toBe(false);
    expect(report.failureCodes).toEqual(expect.arrayContaining([
      "target_preflight_failed",
      "postgres_pool_evidence_failed",
      "profile_incomplete",
      "response_contract_failure",
    ]));
    expect(report.postgresPoolMetrics.readinessSamples).toBe(0);
    expect(report.postgresPoolMetrics.pools.every((pool) => pool.samples === 0)).toBe(true);
  });

  const invalidIdentityHashes = ([
    "projectIdSha256",
    "environmentIdSha256",
    "serviceIdSha256",
  ] as const).flatMap((field) => [
    { field, state: "missing" as const, value: undefined },
    { field, state: "wrong" as const, value: "f".repeat(64) },
  ]);

  it.each(invalidIdentityHashes.flatMap(({ field, state, value }) => [
    { field, state, value, route: "health" as const },
    { field, state, value, route: "ready" as const },
  ]))(
    "rejects a $state $field from the preflight $route response",
    async ({ field, value, route }) => {
      const harness = fakeRun({
        preflightDeploymentOverrides: {
          [route]: { [field]: value },
        },
      });
      let monotonic = 0;
      let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
      const report = await runPermanentStagingLoadSoak(
        harness.configuration,
        harness.secrets,
        {
          fetch: harness.fetchImplementation,
          wallNow: () => wallNow,
          monotonicNow: () => monotonic += 1,
          randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
          sleep: async (milliseconds) => { wallNow += milliseconds; },
        },
      );

      expect(report.passed).toBe(false);
      expect(report.failureCodes).toEqual(expect.arrayContaining([
        "target_preflight_failed",
        "profile_incomplete",
      ]));
      expect(report.journeys.writeCyclesAttempted).toBe(0);
      expect(report.totals.contractFailures).toBe(1);
    },
  );

  it.each(invalidIdentityHashes)(
    "rejects a $state $field after the exact preflight",
    async ({ field, value }) => {
      const harness = fakeRun({
        timedDeploymentOverrides: { [field]: value },
      });
      let monotonic = 0;
      let wallNow = Date.parse("2026-08-09T00:00:00.000Z");
      const report = await runPermanentStagingLoadSoak(
        harness.configuration,
        harness.secrets,
        {
          fetch: harness.fetchImplementation,
          wallNow: () => wallNow,
          monotonicNow: () => monotonic += 1,
          randomBytes: () => Buffer.from("0123456789abcdef01234567", "hex"),
          sleep: async (milliseconds) => { wallNow += milliseconds; },
        },
      );

      expect(report.passed).toBe(false);
      expect(report.failureCodes).toEqual(expect.arrayContaining([
        "target_identity_changed",
        "profile_incomplete",
      ]));
      expect(report.totals.contractFailures).toBeGreaterThanOrEqual(1);
    },
  );
});
