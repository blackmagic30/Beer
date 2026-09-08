import { describe, expect, it } from "vitest";

import { protectedScaleReplicaTopologyExact } from
  "../scripts/lib/protected-scale-receipt-topology.js";
import {
  productionScaleTopologyFixture,
  stagingQuiesceScaleTopologyFixture,
  stagingRestoreScaleTopologyFixture,
} from "./fixtures/protected-scale-receipt.js";

function recursivelySortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recursivelySortObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, recursivelySortObjectKeys(entry)]));
}

describe("protected scale receipt topology", () => {
  it("accepts exact production and both staging transition topologies", () => {
    expect(protectedScaleReplicaTopologyExact(
      productionScaleTopologyFixture(),
      {
        direction: "converge-production-two",
        attempts: 1,
        desiredReplicas: 2,
        target: "production",
      },
    )).toBe(true);
    expect(protectedScaleReplicaTopologyExact(
      stagingQuiesceScaleTopologyFixture(),
      {
        direction: "quiesce-staging-zero",
        attempts: 1,
        desiredReplicas: 0,
        target: "staging",
      },
    )).toBe(true);
    expect(protectedScaleReplicaTopologyExact(
      stagingRestoreScaleTopologyFixture(),
      {
        direction: "bootstrap-staging-one",
        attempts: 1,
        desiredReplicas: 1,
        target: "staging",
      },
    )).toBe(true);
});
  it("treats JSON object key order as non-semantic", () => {
    const reordered = recursivelySortObjectKeys(productionScaleTopologyFixture());
    expect(protectedScaleReplicaTopologyExact(reordered, {
      direction: "converge-production-two",
      attempts: 1,
      desiredReplicas: 2,
      target: "production",
    })).toBe(true);
  });

  it("rejects a tampered topology self-hash", () => {
    const topology = structuredClone(productionScaleTopologyFixture());
    topology.after.configuredTopologySha256 = "0".repeat(64);
    expect(protectedScaleReplicaTopologyExact(topology, {
      direction: "converge-production-two",
      attempts: 1,
      desiredReplicas: 2,
      target: "production",
    })).toBe(false);
  });

  it("rejects direct-patch tampering and unapproved regions", () => {
    const assignments = structuredClone(stagingRestoreScaleTopologyFixture());
    (assignments.patchRegions[0] as { numReplicas: number }).numReplicas = 2;
    expect(protectedScaleReplicaTopologyExact(assignments, {
      direction: "bootstrap-staging-one",
      attempts: 1,
      desiredReplicas: 1,
      target: "staging",
    })).toBe(false);

    const region = structuredClone(stagingRestoreScaleTopologyFixture());
    region.before.configuredRegions.push({ region: "us-west2", numReplicas: 0 });
    expect(protectedScaleReplicaTopologyExact(region, {
      direction: "bootstrap-staging-one",
      attempts: 1,
      desiredReplicas: 1,
      target: "staging",
    })).toBe(false);
  });
});
