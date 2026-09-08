import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildRailwayReplicaEnvironmentPatch,
  commitRailwayReplicaEnvironmentPatch,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
} from "../scripts/lib/railway-environment-patch-commit.js";

const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const ACKNOWLEDGEMENT_ID = "wf-1";
const TOKEN = "environment-scoped-project-token";

function response(
  value: unknown,
  status = 200,
  contentType = "application/json",
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": contentType },
  });
}

describe("Railway direct environment patch commit", () => {
  it("builds the dashboard-compatible exact topology patch with zeros as null", () => {
    expect(buildRailwayReplicaEnvironmentPatch(SERVICE_ID, [
      { region: "europe-west4-drams3a", numReplicas: 0 },
      { region: "asia-southeast1-eqsg3a", numReplicas: 2 },
    ])).toEqual({
      services: {
        [SERVICE_ID]: {
          deploy: {
            multiRegionConfig: {
              "asia-southeast1-eqsg3a": { numReplicas: 2 },
              "europe-west4-drams3a": null,
            },
          },
        },
      },
    });
  });

  it("performs one exact Project-Access-Token mutation and hashes its acknowledgement", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: { environmentPatchCommit: ACKNOWLEDGEMENT_ID },
    }));
    const result = await commitRailwayReplicaEnvironmentPatch(
      fetchImpl,
      TOKEN,
      {
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        regions: [
          { region: "europe-west4-drams3a", numReplicas: 0 },
          { region: "asia-southeast1-eqsg3a", numReplicas: 0 },
        ],
        commitMessage: `PintPath cold quiesce ${"a".repeat(40)} run 1234`,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    expect(init.headers).toEqual({
      "Project-Access-Token": TOKEN,
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(String(init.body)).not.toContain("Account-Token");
    expect(JSON.parse(String(init.body))).toEqual({
      operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
      query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
      variables: {
        environmentId: ENVIRONMENT_ID,
        patch: {
          services: {
            [SERVICE_ID]: {
              deploy: {
                multiRegionConfig: {
                  "asia-southeast1-eqsg3a": null,
                  "europe-west4-drams3a": null,
                },
              },
            },
          },
        },
        commitMessage: `PintPath cold quiesce ${"a".repeat(40)} run 1234`,
      },
    });
    expect(result).toMatchObject({
      outcome: "acknowledged",
      acknowledgementExact: true,
      zeroRegionsEncodedAsJsonNull: true,
      acknowledgementSha256: crypto.createHash("sha256")
        .update(ACKNOWLEDGEMENT_ID).digest("hex"),
    });
    for (const hash of [
      result.querySha256,
      result.variablesSha256,
      result.requestBodySha256,
      result.responseBodySha256,
    ]) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["GraphQL error without a strict pre-execution rejection proof",
      response({ errors: [{ message: "denied" }] }),
      "transport_uncertain"],
    ["HTTP GraphQL rejection without pinned pre-execution proof",
      response({ errors: [{ message: "denied" }] }, 403),
      "transport_uncertain"],
    ["request timeout after possible resolver execution",
      response({ errors: [{ message: "timed out" }] }, 408),
      "transport_uncertain"],
    ["conflict after possible resolver execution",
      response({ errors: [{ message: "conflict" }] }, 409),
      "transport_uncertain"],
    ["unstructured HTTP rejection", response({ message: "denied" }, 403),
      "transport_uncertain"],
    ["server failure", response({ errors: [{ message: "failed" }] }, 500),
      "transport_uncertain"],
    ["rate limit", response({ errors: [{ message: "limited" }] }, 429),
      "transport_uncertain"],
    ["partial data and errors", response({
      data: { environmentPatchCommit: "wf-1" },
      errors: [{ message: "partial" }],
    }), "transport_uncertain"],
    ["content type drift", response(
      { data: { environmentPatchCommit: "wf-1" } },
      200,
      "text/plain",
    ), "transport_uncertain"],
    ["malformed success", response({ data: { environmentPatchCommit: true } }),
      "transport_uncertain"],
    ["extra response key", response({
      data: { environmentPatchCommit: "wf-1" },
      extensions: {},
    }), "transport_uncertain"],
  ])("classifies %s without retrying", async (_label, providerResponse, outcome) => {
    const fetchImpl = vi.fn().mockResolvedValue(providerResponse);
    await expect(commitRailwayReplicaEnvironmentPatch(fetchImpl, TOKEN, {
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      regions: [{ region: "asia-southeast1-eqsg3a", numReplicas: 0 }],
      commitMessage: `PintPath protected scale ${"a".repeat(40)} run 1234`,
    })).resolves.toMatchObject({
      outcome,
      acknowledgementExact: false,
      acknowledgementSha256: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable response as a lost acknowledgement without retrying", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket closed"));
    await expect(commitRailwayReplicaEnvironmentPatch(fetchImpl, TOKEN, {
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      regions: [{ region: "asia-southeast1-eqsg3a", numReplicas: 0 }],
      commitMessage: `PintPath protected scale ${"a".repeat(40)} run 1234`,
    })).resolves.toMatchObject({
      outcome: "transport_uncertain",
      responseBodySha256: null,
      acknowledgementExact: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["duplicate region", [
      { region: "asia-southeast1-eqsg3a", numReplicas: 0 },
      { region: "asia-southeast1-eqsg3a", numReplicas: 1 },
    ]],
    ["negative replicas", [
      { region: "asia-southeast1-eqsg3a", numReplicas: -1 },
    ]],
    ["invalid service", [
      { region: "asia-southeast1-eqsg3a", numReplicas: 0 },
    ]],
  ])("rejects %s before provider access", async (label, regions) => {
    const fetchImpl = vi.fn();
    await expect(commitRailwayReplicaEnvironmentPatch(fetchImpl, TOKEN, {
      environmentId: ENVIRONMENT_ID,
      serviceId: label === "invalid service" ? "Beer" : SERVICE_ID,
      regions,
      commitMessage: "PintPath protected scale candidate run 1234",
    })).rejects.toThrow("railway_environment_patch_commit_input_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
