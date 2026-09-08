import { describe, expect, it } from "vitest";

import {
  RAILWAY_MAX_REPLICAS_PER_REGION,
  RAILWAY_MAX_TOTAL_REPLICAS,
  parseRailwayMultiRegionReplicaTopology,
} from "../scripts/lib/railway-multi-region-replica-topology.js";

const TARGET_SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";

function config(multiRegionConfig: unknown): Record<string, unknown> {
  return {
    services: {
      [TARGET_SERVICE_ID]: {
        variables: {
          DATABASE_URL: { value: "postgres://private-secret" },
        },
        deploy: {
          startCommand: "node dist/src/server.js",
          multiRegionConfig,
        },
      },
      "unrelated-service": {
        variables: { API_TOKEN: { value: "another-private-secret" } },
      },
    },
    sharedVariables: {
      SECRET: { value: "shared-private-secret" },
    },
  };
}

describe("Railway multi-region replica topology", () => {
  it("returns canonical sorted regions and the configured replica total", () => {
    const result = parseRailwayMultiRegionReplicaTopology(config({
      "us-west2": { numReplicas: 2 },
      "asia-southeast1-eqsg3a": {
        numReplicas: 1,
        stackerAssignment: null,
      },
      "europe-west4-drams3a": {
        stackerAssignment: "ALL_STACKERS",
        numReplicas: 3,
      },
    }), TARGET_SERVICE_ID);

    expect(result).toEqual({
      kind: "configured",
      regions: [
        { region: "asia-southeast1-eqsg3a", numReplicas: 1 },
        { region: "europe-west4-drams3a", numReplicas: 3 },
        { region: "us-west2", numReplicas: 2 },
      ],
      configuredTotal: 6,
      effectiveZero: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.regions)).toBe(true);
    expect(result.regions.every(Object.isFrozen)).toBe(true);
  });

  it("keeps missing structural levels distinct from configured zero", () => {
    expect(parseRailwayMultiRegionReplicaTopology({}, TARGET_SERVICE_ID)).toEqual({
      kind: "target-service-absent",
      regions: [],
      configuredTotal: null,
      effectiveZero: null,
    });
    expect(parseRailwayMultiRegionReplicaTopology({ services: {} }, TARGET_SERVICE_ID))
      .toEqual({
        kind: "target-service-absent",
        regions: [],
        configuredTotal: null,
        effectiveZero: null,
      });
    expect(parseRailwayMultiRegionReplicaTopology({
      services: { [TARGET_SERVICE_ID]: {} },
    }, TARGET_SERVICE_ID)).toEqual({
      kind: "deploy-absent",
      regions: [],
      configuredTotal: null,
      effectiveZero: null,
    });
    expect(parseRailwayMultiRegionReplicaTopology({
      services: { [TARGET_SERVICE_ID]: { deploy: null } },
    }, TARGET_SERVICE_ID)).toEqual({
      kind: "deploy-absent",
      regions: [],
      configuredTotal: null,
      effectiveZero: null,
    });
    expect(parseRailwayMultiRegionReplicaTopology({
      services: { [TARGET_SERVICE_ID]: { deploy: {} } },
    }, TARGET_SERVICE_ID)).toEqual({
      kind: "multi-region-config-absent",
      regions: [],
      configuredTotal: null,
      effectiveZero: null,
    });
    expect(parseRailwayMultiRegionReplicaTopology(config(null), TARGET_SERVICE_ID)).toEqual({
      kind: "multi-region-config-null",
      regions: [],
      configuredTotal: null,
      effectiveZero: null,
    });
    expect(parseRailwayMultiRegionReplicaTopology(config({}), TARGET_SERVICE_ID)).toEqual({
      kind: "configured",
      regions: [],
      configuredTotal: 0,
      effectiveZero: true,
    });
  });

  it("normalizes provider-supported zero region encodings without hiding entries", () => {
    const result = parseRailwayMultiRegionReplicaTopology(config({
      "us-west2": null,
      "us-east4-eqdc4a": {},
      "europe-west4-drams3a": { numReplicas: null },
      "asia-southeast1-eqsg3a": { numReplicas: 0 },
    }), TARGET_SERVICE_ID);

    expect(result).toEqual({
      kind: "configured",
      regions: [
        { region: "asia-southeast1-eqsg3a", numReplicas: 0 },
        { region: "europe-west4-drams3a", numReplicas: 0 },
        { region: "us-east4-eqdc4a", numReplicas: 0 },
        { region: "us-west2", numReplicas: 0 },
      ],
      configuredTotal: 0,
      effectiveZero: true,
    });
  });

  it("rejects malformed structural levels without conflating them with absence", () => {
    const scenarios: readonly [unknown, string, string][] = [
      [null, TARGET_SERVICE_ID, "invalid-environment-config"],
      [{ services: [] }, TARGET_SERVICE_ID, "invalid-services"],
      [{ services: { [TARGET_SERVICE_ID]: null } }, TARGET_SERVICE_ID,
        "invalid-target-service"],
      [{ services: { [TARGET_SERVICE_ID]: { deploy: [] } } }, TARGET_SERVICE_ID,
        "invalid-deploy"],
      [config([]), TARGET_SERVICE_ID, "invalid-multi-region-config"],
      [config({ "us-west2": { numReplicas: 1 } }), "not-a-service-id",
        "invalid-target-service-id"],
    ];

    for (const [source, serviceId, failureCode] of scenarios) {
      expect(parseRailwayMultiRegionReplicaTopology(source, serviceId)).toEqual({
        kind: "invalid",
        failureCode,
        regions: [],
        configuredTotal: null,
        effectiveZero: null,
      });
    }
  });

  it("rejects malformed region names and replica counts", () => {
    const invalidRegions = [
      "",
      "US-WEST2",
      "-us-west2",
      "us-west2-",
      "us west2",
      "us/west2",
      `a${"b".repeat(128)}`,
    ];
    for (const region of invalidRegions) {
      expect(parseRailwayMultiRegionReplicaTopology(
        config({ [region]: { numReplicas: 1 } }),
        TARGET_SERVICE_ID,
      )).toMatchObject({ kind: "invalid", failureCode: "invalid-region-name" });
    }

    for (const count of [
      -1,
      0.5,
      "1",
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      RAILWAY_MAX_REPLICAS_PER_REGION + 1,
    ]) {
      expect(parseRailwayMultiRegionReplicaTopology(
        config({ "us-west2": { numReplicas: count } }),
        TARGET_SERVICE_ID,
      )).toMatchObject({ kind: "invalid", failureCode: "invalid-replica-count" });
    }

    expect(parseRailwayMultiRegionReplicaTopology(config({
      "us-west2": { numReplicas: RAILWAY_MAX_TOTAL_REPLICAS },
      "europe-west4-drams3a": { numReplicas: 1 },
    }), TARGET_SERVICE_ID)).toMatchObject({
      kind: "invalid",
      failureCode: "invalid-replica-count",
    });
  });

  it("rejects unknown region structures and malformed placement metadata", () => {
    const invalidRegionConfigs = [
      [],
      "one",
      { numReplicas: 1, futureReplicaMode: "unknown" },
      { numReplicas: 1, stackerAssignment: "not-an-ip" },
      { numReplicas: 1, stackerAssignment: 123 },
    ];
    for (const regionConfig of invalidRegionConfigs) {
      expect(parseRailwayMultiRegionReplicaTopology(
        config({ "us-west2": regionConfig }),
        TARGET_SERVICE_ID,
      )).toMatchObject({ kind: "invalid", failureCode: "invalid-region-config" });
    }
  });

  it("does not invoke accessors or retain sibling secret-bearing configuration", () => {
    let accessorInvoked = false;
    const regions = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(regions, "us-west2", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return { numReplicas: 1, secret: "must-not-be-read" };
      },
    });

    const result = parseRailwayMultiRegionReplicaTopology(
      config(regions),
      TARGET_SERVICE_ID,
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ kind: "invalid", failureCode: "invalid-region-config" });
    expect(accessorInvoked).toBe(false);
    expect(serialized).not.toContain("private-secret");
    expect(serialized).not.toContain("API_TOKEN");
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain("must-not-be-read");
  });
});
