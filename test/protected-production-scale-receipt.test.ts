import { describe, expect, it } from "vitest";

import { parseProtectedProductionScaleReceipt } from
  "../scripts/lib/protected-production-scale-receipt.js";
import { productionScaleReceiptFixture } from
  "./fixtures/protected-scale-receipt.js";

const CANDIDATE = "a".repeat(40);
const BEFORE_DEPLOYMENT = "b".repeat(64);
const ACTIVE_DEPLOYMENT = "c".repeat(64);
const RUN_ID = "9000";

function receipt(
  outcome: "scaled" | "reconciled_scaled" | "already_converged" = "scaled",
) {
  return productionScaleReceiptFixture({
    candidateSha: CANDIDATE,
    githubRunId: RUN_ID,
    deploymentBeforeActivationIdSha256: BEFORE_DEPLOYMENT,
    deploymentIdSha256: ACTIVE_DEPLOYMENT,
    startedAt: "2026-09-08T07:00:00.000Z",
    completedAt: "2026-09-08T07:01:00.000Z",
    outcome,
  });
}

function parse(value: unknown, expectedGithubRunId = RUN_ID) {
  return parseProtectedProductionScaleReceipt(value, {
    candidateSha: CANDIDATE,
    deploymentBeforeActivationIdSha256: BEFORE_DEPLOYMENT,
    expectedGithubRunId,
  });
}

describe("protected production scale receipt v4", () => {
  it.each(["scaled", "reconciled_scaled", "already_converged"] as const)(
    "accepts the exact %s evidence relation",
    (outcome) => {
      expect(parse(receipt(outcome))).toMatchObject({
        outcome,
        githubRunId: RUN_ID,
        deploymentIdSha256: ACTIVE_DEPLOYMENT,
        attempts: outcome === "already_converged" ? 0 : 1,
      });
    },
  );

  it("binds the receipt to the trusted producer run id", () => {
    expect(parse(receipt(), "9001")).toBeNull();
  });

  it("requires callers to supply the trusted producer run id", () => {
    // @ts-expect-error expectedGithubRunId is intentionally mandatory.
    expect(parseProtectedProductionScaleReceipt(receipt(), {
      candidateSha: CANDIDATE,
      deploymentBeforeActivationIdSha256: BEFORE_DEPLOYMENT,
    })).toBeNull();
  });

  it.each([
    ["variablesSha256", "0".repeat(64)],
    ["requestBodySha256", "0".repeat(64)],
    ["commitMessageSha256", "0".repeat(64)],
    ["responseBodySha256", null],
  ])("rejects direct mutation evidence tampering: %s", (field, replacement) => {
    const value = structuredClone(receipt());
    (value.directMutationEvidence as Record<string, unknown>)[field] = replacement;
    expect(parse(value)).toBeNull();
  });

  it("rejects a substituted provider-history ledger", () => {
    const value = structuredClone(receipt());
    value.providerHistoryEvidence.postflight.nonMatchingRowsProjectionSha256 =
      "0".repeat(64);
    expect(parse(value)).toBeNull();
  });

  it("accepts both Railway timestamp orderings and an in-window 6.419s commit", () => {
    const appliedAfterCreated = structuredClone(receipt());
    const after = appliedAfterCreated.providerHistoryEvidence.postflight
      .matchingPatch!;
    after.createdAt = "2026-09-08T07:00:00.000Z";
    after.appliedAt = "2026-09-08T07:00:06.419Z";
    after.updatedAt = "2026-09-08T07:00:07.000Z";
    expect(parse(appliedAfterCreated)).not.toBeNull();

    const appliedBeforeCreated = structuredClone(receipt());
    const before = appliedBeforeCreated.providerHistoryEvidence.postflight
      .matchingPatch!;
    before.createdAt = "2026-09-08T07:00:01.000Z";
    before.appliedAt = "2026-09-08T07:00:00.000Z";
    before.updatedAt = "2026-09-08T07:00:02.000Z";
    expect(parse(appliedBeforeCreated)).not.toBeNull();
  });

  it("rejects noncanonical, out-of-window, and after-update patch timestamps", () => {
    for (const mutate of [
      (patch: Record<string, unknown>) => {
        patch.createdAt = "2026-09-08T17:00:00+10:00";
      },
      (patch: Record<string, unknown>) => {
        patch.appliedAt = "2026-09-08T06:59:59.999Z";
      },
      (patch: Record<string, unknown>) => {
        patch.appliedAt = "2026-09-08T07:00:02.000Z";
        patch.updatedAt = "2026-09-08T07:00:01.999Z";
      },
    ]) {
      const value = structuredClone(receipt());
      mutate(value.providerHistoryEvidence.postflight.matchingPatch!);
      expect(parse(value)).toBeNull();
    }
  });

  it("rejects any claim that secret material or commitments were persisted", () => {
    const value = structuredClone(receipt());
    value.secretDerivedCommitmentsIncluded = true;
    expect(parse(value)).toBeNull();
  });
});
