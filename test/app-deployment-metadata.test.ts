import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appDeploymentMetadataInternals,
  createApp,
  replicaIdSha256,
  shutdownAppServices,
} from "../src/app.js";
import {
  railwayDeploymentIdentityHashes,
  railwayDeploymentIdentityIdSha256,
} from "../src/lib/railway-deployment-identity.js";

const RAILWAY_IDS = Object.freeze({
  project: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environment: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  service: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  deployment: "77b0d060-8438-47bd-97ed-068416afc81e",
  replica: "railway-replica-a-private-platform-id",
} as const);

const DOMAINS = Object.freeze({
  project: "pintpath/railway-project-evidence/v1\0",
  environment: "pintpath/railway-environment-evidence/v1\0",
  service: "pintpath/railway-service-evidence/v1\0",
  deployment: "pintpath/railway-deployment-evidence/v1\0",
  replica: "pintpath/replica-evidence/v1\0",
} as const);

function expectedHash(kind: keyof typeof RAILWAY_IDS): string {
  return crypto
    .createHash("sha256")
    .update(DOMAINS[kind], "utf8")
    .update(RAILWAY_IDS[kind], "utf8")
    .digest("hex");
}

function stubValidRailwayIdentity(): void {
  vi.stubEnv("RAILWAY_PROJECT_ID", RAILWAY_IDS.project);
  vi.stubEnv("RAILWAY_ENVIRONMENT_ID", RAILWAY_IDS.environment);
  vi.stubEnv("RAILWAY_SERVICE_ID", RAILWAY_IDS.service);
  vi.stubEnv("RAILWAY_DEPLOYMENT_ID", RAILWAY_IDS.deployment);
  vi.stubEnv("RAILWAY_REPLICA_ID", RAILWAY_IDS.replica);
}

async function deploymentPayloads(
  paths: readonly string[],
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await Promise.all(paths.map(async (pathname) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const payload = await response.json() as Record<string, unknown>;
      const data = payload.data as Record<string, unknown>;
      return data.deployment as Record<string, unknown>;
    }));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await shutdownAppServices();
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await shutdownAppServices();
});

describe("Railway deployment identity evidence", () => {
  it("uses a distinct domain for every Railway deployment identity", () => {
    const hashes = railwayDeploymentIdentityHashes({
      RAILWAY_PROJECT_ID: RAILWAY_IDS.project,
      RAILWAY_ENVIRONMENT_ID: RAILWAY_IDS.environment,
      RAILWAY_SERVICE_ID: RAILWAY_IDS.service,
      RAILWAY_DEPLOYMENT_ID: RAILWAY_IDS.deployment,
      RAILWAY_REPLICA_ID: RAILWAY_IDS.replica,
    });

    expect(hashes).toEqual({
      projectIdSha256: expectedHash("project"),
      environmentIdSha256: expectedHash("environment"),
      serviceIdSha256: expectedHash("service"),
      deploymentIdSha256: expectedHash("deployment"),
      replicaIdSha256: expectedHash("replica"),
    });
    expect(new Set(Object.values(hashes))).toHaveLength(5);
    expect(replicaIdSha256(RAILWAY_IDS.replica)).toBe(expectedHash("replica"));
    for (const rawId of Object.values(RAILWAY_IDS)) {
      expect(JSON.stringify(hashes)).not.toContain(rawId);
    }
  });

  it("rejects missing, malformed, padded, uppercase, non-versioned, and non-RFC UUIDs", () => {
    const invalidValues = [
      undefined,
      "",
      "not-a-uuid",
      ` ${RAILWAY_IDS.project}`,
      `${RAILWAY_IDS.project} `,
      RAILWAY_IDS.project.toUpperCase(),
      "48d8c6cd-1c66-0148-874b-20877f48e1a5",
      "48d8c6cd-1c66-4148-774b-20877f48e1a5",
    ];

    for (const value of invalidValues) {
      expect(railwayDeploymentIdentityIdSha256("project", value)).toBeUndefined();
    }

    expect(railwayDeploymentIdentityHashes({
      RAILWAY_PROJECT_ID: RAILWAY_IDS.project.toUpperCase(),
      RAILWAY_ENVIRONMENT_ID: ` ${RAILWAY_IDS.environment}`,
      RAILWAY_SERVICE_ID: "not-a-uuid",
      RAILWAY_DEPLOYMENT_ID: "",
    })).toEqual({});
  });

  it("requires own data identity values without invoking prototype, accessor, or proxy authority", () => {
    const inheritedValues = {
      RAILWAY_PROJECT_ID: RAILWAY_IDS.project,
      RAILWAY_ENVIRONMENT_ID: RAILWAY_IDS.environment,
      RAILWAY_SERVICE_ID: RAILWAY_IDS.service,
      RAILWAY_DEPLOYMENT_ID: RAILWAY_IDS.deployment,
      RAILWAY_REPLICA_ID: RAILWAY_IDS.replica,
    } as const;
    const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
    let inheritedHashes: ReturnType<typeof railwayDeploymentIdentityHashes>;
    try {
      for (const [name, value] of Object.entries(inheritedValues)) {
        previousDescriptors.set(name, Object.getOwnPropertyDescriptor(Object.prototype, name));
        Object.defineProperty(Object.prototype, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      }
      inheritedHashes = railwayDeploymentIdentityHashes({});
    } finally {
      for (const [name, descriptor] of previousDescriptors) {
        if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[name];
      }
    }
    expect(inheritedHashes!).toEqual({});

    const getter = vi.fn(() => RAILWAY_IDS.project);
    const accessorSource: Record<string, unknown> = {};
    Object.defineProperty(accessorSource, "RAILWAY_PROJECT_ID", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    expect(railwayDeploymentIdentityHashes(accessorSource)).toEqual({});
    expect(getter).not.toHaveBeenCalled();

    let proxyTraps = 0;
    const proxy = new Proxy({ RAILWAY_PROJECT_ID: RAILWAY_IDS.project }, {
      getOwnPropertyDescriptor() {
        proxyTraps += 1;
        return { configurable: true, enumerable: true, writable: true,
          value: RAILWAY_IDS.project };
      },
    });
    expect(railwayDeploymentIdentityHashes(proxy)).toEqual({});
    expect(proxyTraps).toBe(0);
  });

  it("preserves bounded opaque Railway replica ID normalization", () => {
    expect(replicaIdSha256(`  ${RAILWAY_IDS.replica}  `)).toBe(expectedHash("replica"));
    expect(replicaIdSha256(RAILWAY_IDS.replica.toUpperCase())).not.toBe(expectedHash("replica"));
    expect(replicaIdSha256("replica\ncontrol")).toBeUndefined();
    expect(replicaIdSha256("r".repeat(257))).toBeUndefined();
    expect(replicaIdSha256("  ")).toBeUndefined();
    expect(replicaIdSha256()).toBeUndefined();
  });

  it("publishes only hashes on health, startup, and readiness probes", async () => {
    stubValidRailwayIdentity();

    const deployments = await deploymentPayloads(["/health", "/startup", "/ready"]);
    for (const deployment of deployments) {
      expect(deployment).toMatchObject({
        projectIdSha256: expectedHash("project"),
        environmentIdSha256: expectedHash("environment"),
        serviceIdSha256: expectedHash("service"),
        deploymentIdSha256: expectedHash("deployment"),
        replicaIdSha256: expectedHash("replica"),
      });
      for (const rawId of Object.values(RAILWAY_IDS)) {
        expect(JSON.stringify(deployment)).not.toContain(rawId);
      }
    }
  });

  it("serializes deployment evidence without ambient JSON or inherited toJSON authority", () => {
    const originalStringify = JSON.stringify;
    const originalToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const expected = {
      ok: true,
      data: {
        service: "pint-path",
        status: "ok",
        deployment: {
          version: "0.1.0",
          commitSha: "a".repeat(40),
          environment: "production",
          projectIdSha256: expectedHash("project"),
          environmentIdSha256: expectedHash("environment"),
          serviceIdSha256: expectedHash("service"),
          deploymentIdSha256: expectedHash("deployment"),
          replicaIdSha256: expectedHash("replica"),
        },
      },
    };
    let serialized: string | undefined;
    let caught: unknown;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => ({ forged: true }),
      });
      JSON.stringify = (() => "{\"forged\":true}") as typeof JSON.stringify;
      serialized = appDeploymentMetadataInternals.secureProbeJson(expected);
    } catch (error) {
      caught = error;
    } finally {
      JSON.stringify = originalStringify;
      if (originalToJson) {
        Object.defineProperty(Object.prototype, "toJSON", originalToJson);
      } else {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      }
    }
    expect(caught).toBeUndefined();
    expect(JSON.parse(serialized!)).toEqual(expected);
    expect(serialized).not.toContain("forged");
  });

  it("serves the health evidence bytes without ambient JSON.stringify authority", async () => {
    stubValidRailwayIdentity();
    const originalStringify = JSON.stringify;
    let deployment: Record<string, unknown> | undefined;
    let caught: unknown;
    try {
      JSON.stringify = (() => "{\"forged\":true}") as typeof JSON.stringify;
      [deployment] = await deploymentPayloads(["/health"]);
    } catch (error) {
      caught = error;
    } finally {
      JSON.stringify = originalStringify;
    }
    expect(caught).toBeUndefined();
    expect(deployment).toMatchObject({
      projectIdSha256: expectedHash("project"),
      environmentIdSha256: expectedHash("environment"),
      serviceIdSha256: expectedHash("service"),
      deploymentIdSha256: expectedHash("deployment"),
      replicaIdSha256: expectedHash("replica"),
    });
    expect(deployment).not.toHaveProperty("forged");
  });

  it("omits every absent or invalid identifier from public probe metadata", async () => {
    vi.stubEnv("RAILWAY_PROJECT_ID", "");
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", RAILWAY_IDS.environment.toUpperCase());
    vi.stubEnv("RAILWAY_SERVICE_ID", ` ${RAILWAY_IDS.service}`);
    vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "not-a-uuid");
    vi.stubEnv("RAILWAY_REPLICA_ID", "railway-replica\nprivate-platform-id");

    const [deployment] = await deploymentPayloads(["/health"]);
    expect(deployment).not.toHaveProperty("projectIdSha256");
    expect(deployment).not.toHaveProperty("environmentIdSha256");
    expect(deployment).not.toHaveProperty("serviceIdSha256");
    expect(deployment).not.toHaveProperty("deploymentIdSha256");
    expect(deployment).not.toHaveProperty("replicaIdSha256");
  });

  it("does not publish inherited commit, version, or Railway identity metadata", async () => {
    const names = [
      "RAILWAY_GIT_COMMIT_SHA",
      "PINT_PATH_VERSION",
      "RAILWAY_PROJECT_ID",
      "RAILWAY_ENVIRONMENT_ID",
      "RAILWAY_SERVICE_ID",
      "RAILWAY_DEPLOYMENT_ID",
      "RAILWAY_REPLICA_ID",
    ] as const;
    const inherited: Record<typeof names[number], string> = {
      RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
      PINT_PATH_VERSION: "9.9.9-forged",
      RAILWAY_PROJECT_ID: RAILWAY_IDS.project,
      RAILWAY_ENVIRONMENT_ID: RAILWAY_IDS.environment,
      RAILWAY_SERVICE_ID: RAILWAY_IDS.service,
      RAILWAY_DEPLOYMENT_ID: RAILWAY_IDS.deployment,
      RAILWAY_REPLICA_ID: RAILWAY_IDS.replica,
    };
    const priorEnvironment = new Map<string, string | undefined>();
    const priorPrototype = new Map<string, PropertyDescriptor | undefined>();
    let deployment: Record<string, unknown> | undefined;
    try {
      for (const name of names) {
        priorEnvironment.set(name, process.env[name]);
        delete process.env[name];
        priorPrototype.set(name, Object.getOwnPropertyDescriptor(Object.prototype, name));
        Object.defineProperty(Object.prototype, name, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: inherited[name],
        });
      }
      [deployment] = await deploymentPayloads(["/health"]);
    } finally {
      for (const name of names) {
        const prior = priorEnvironment.get(name);
        if (prior === undefined) delete process.env[name];
        else process.env[name] = prior;
        const descriptor = priorPrototype.get(name);
        if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[name];
      }
    }

    expect(deployment).toMatchObject({ commitSha: "unknown", version: "0.1.0" });
    expect(deployment).not.toHaveProperty("projectIdSha256");
    expect(deployment).not.toHaveProperty("environmentIdSha256");
    expect(deployment).not.toHaveProperty("serviceIdSha256");
    expect(deployment).not.toHaveProperty("deploymentIdSha256");
    expect(deployment).not.toHaveProperty("replicaIdSha256");
  });
});
