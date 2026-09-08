import { describe, expect, it } from "vitest";

import { parseProductionApplicationDeploymentReceipt } from
  "../scripts/lib/production-application-deployment-receipt.js";
import { productionApplicationDeploymentReceiptFixture } from
  "./production-application-deployment-receipt.fixtures.js";

const candidateSha = "a".repeat(40);

function receipt(): Record<string, unknown> {
  return productionApplicationDeploymentReceiptFixture({
    candidateSha,
    previousDeploymentIdSha256: "1".repeat(64),
    deploymentIdSha256: "2".repeat(64),
    startedAt: "2026-09-08T00:00:00.000Z",
    completedAt: "2026-09-08T00:01:00.000Z",
  });
}

describe("production application deployment receipt v6", () => {
  it("accepts exact configured-topology evidence while retaining legacy nulls", () => {
    expect(parseProductionApplicationDeploymentReceipt(receipt(), candidateSha))
      .toEqual({
        startedAt: "2026-09-08T00:00:00.000Z",
        completedAt: "2026-09-08T00:01:00.000Z",
        deploymentIdSha256: "2".repeat(64),
      });
  });

  it("normalizes nested object key order when comparing topology snapshots", () => {
    const value = receipt();
    const chain = value.configuredTopology as {
      after: {
        configuredReplicas: number;
        configuredRegions: unknown[];
        configuredTopologySha256: string;
      };
    };
    const after = chain.after;
    chain.after = {
      configuredTopologySha256: after.configuredTopologySha256,
      configuredRegions: after.configuredRegions.map((entry) => {
        const region = entry as { region: string; numReplicas: number };
        return { numReplicas: region.numReplicas, region: region.region };
      }),
      configuredReplicas: after.configuredReplicas,
    };

    expect(parseProductionApplicationDeploymentReceipt(value, candidateSha))
      .not.toBeNull();
  });

  it.each([
    ["topology hash", (value: Record<string, unknown>) => {
      const topology = value.configuredTopology as {
        after: { configuredTopologySha256: string };
      };
      topology.after.configuredTopologySha256 = "f".repeat(64);
    }],
    ["runtime absence", (value: Record<string, unknown>) => {
      const absence = value.runtimeAbsence as { postflight: boolean | null };
      absence.postflight = true;
    }],
    ["legacy observation type", (value: Record<string, unknown>) => {
      const legacy = value.legacyReplicaCounts as {
        immediatelyBeforeWrite: unknown;
      };
      legacy.immediatelyBeforeWrite = "0";
    }],
    ["collateral continuity", (value: Record<string, unknown>) => {
      const collateral = value.collateralSnapshotSha256s as { after: string };
      collateral.after = "f".repeat(64);
    }],
  ] as const)("rejects %s tampering", (_label, tamper) => {
    const value = receipt();
    tamper(value);
    expect(parseProductionApplicationDeploymentReceipt(value, candidateSha))
      .toBeNull();
  });
});
