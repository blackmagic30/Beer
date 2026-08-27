import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  PROTECTED_STAGING_VARIABLE_DEPLOYMENT_QUERY,
  PROTECTED_STAGING_VARIABLE_METADATA_QUERY,
  PROTECTED_STAGING_VARIABLE_MUTATION_QUERY,
  PROTECTED_STAGING_VARIABLE_MUTATION_STATE,
  PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY,
  protectedPermanentStagingVariableMutationInternals,
  runProtectedPermanentStagingVariableMutation,
} from "../scripts/execute-protected-permanent-staging-variable-mutation.js";

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const CANARY_ID = "34a312cd-0920-4a7e-90db-8561c1e0746b";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const CANDIDATE_SHA = "a".repeat(40);
const LEGACY_SHA = "c".repeat(40);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function scope(): Response {
  return json({
    data: { projectToken: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID } },
  });
}

function variable(
  name: string,
  serviceId: string | null = SERVICE_ID,
  isSealed = false,
  references: readonly string[] = [],
): Record<string, unknown> {
  return {
    id: `row-${name}-${serviceId ?? "shared"}`,
    name,
    environmentId: ENVIRONMENT_ID,
    serviceId,
    isSealed,
    references,
  };
}

function metadata(
  rows: readonly Record<string, unknown>[],
  input: {
    numReplicas?: number;
    latestStatus?: string;
    latestStopped?: boolean;
    latestDeploymentId?: string;
    activeDeployments?: readonly Record<string, unknown>[];
    domain?: string;
    targetPort?: number | null;
  } = {},
): Response {
  const latestDeploymentId = input.latestDeploymentId ?? DEPLOYMENT_ID;
  const latestStatus = input.latestStatus ?? "SUCCESS";
  const latestStopped = input.latestStopped ?? false;
  return json({
    data: {
      environment: {
        id: ENVIRONMENT_ID,
        variables: {
          edges: rows.map((node) => ({ node })),
          pageInfo: { hasNextPage: false, endCursor: rows.length ? "end" : null },
        },
      },
      staged: { environmentId: ENVIRONMENT_ID, patch: {} },
      serviceInstance: {
        id: INSTANCE_ID,
        serviceId: SERVICE_ID,
        environmentId: ENVIRONMENT_ID,
        numReplicas: input.numReplicas ?? 1,
        latestDeployment: {
          id: latestDeploymentId,
          status: latestStatus,
          deploymentStopped: latestStopped,
          snapshotId: SNAPSHOT_ID,
        },
        activeDeployments: input.activeDeployments ?? [{
          id: latestDeploymentId,
          status: latestStatus,
          deploymentStopped: latestStopped,
        }],
        domains: {
          serviceDomains: [{
            id: DOMAIN_ID,
            domain: input.domain ?? "beer-staging.up.railway.app",
            targetPort: input.targetPort === undefined ? 8080 : input.targetPort,
          }],
          customDomains: [],
        },
      },
    },
  });
}

function deployment(input: {
  commitHash?: string;
  id?: string;
  snapshotId?: string;
  patchId?: string | null;
} = {}): Response {
  return json({
    data: {
      deployment: {
        id: input.id ?? DEPLOYMENT_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        snapshotId: input.snapshotId ?? SNAPSHOT_ID,
        meta: {
          commitHash: input.commitHash ?? LEGACY_SHA,
          imageDigest: IMAGE_DIGEST,
          patchId: input.patchId ?? null,
        },
      },
    },
  });
}

function environment(
  operation: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE_SHA,
    GITHUB_RUN_ATTEMPT: "1",
    PINTPATH_MUTATION_CONFIRMATION:
      `MUTATE_${operation.toUpperCase().replaceAll("-", "_")}_IN_PERMANENT_STAGING`,
    PINTPATH_RAILWAY_STAGING_MUTATION_TOKEN: "mutation-token-that-is-long-enough",
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "metadata-token-that-is-long-enough",
    ...overrides,
  };
}

function argv(operation: string): string[] {
  return [
    "--operation",
    operation,
    "--evidence-dir",
    "/private/evidence",
    "--value-file",
    "/private/value",
  ];
}

describe("protected permanent-staging variable mutation", () => {
  it("pins metadata-only reads and one atomic skip-deploy mutation", () => {
    expect(PROTECTED_STAGING_VARIABLE_MUTATION_STATE)
      .toBe("GITHUB_ENVIRONMENT_PROTECTED");
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY)
      .toContain("patch(decryptVariables: false)");
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY).not.toMatch(/\bvalue\b/);
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY).toContain("domains");
    expect(PROTECTED_STAGING_VARIABLE_DEPLOYMENT_QUERY).toContain("deployment(id:");
    expect(PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_VARIABLE_MUTATION_QUERY)
      .toContain("variableCollectionUpsert");
    expect(PROTECTED_STAGING_VARIABLE_MUTATION_QUERY).toContain("$skipDeploys");
  });

  it("creates one provider variable once and emits only secret-free evidence", async () => {
    const secret = "maps-key-private-value";
    const held = Buffer.from(secret);
    const beforeRows = [variable("DATABASE_URL", SERVICE_ID, true)];
    const afterRows = [...beforeRows, variable("GOOGLE_MAPS_API_KEY")];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(metadata(beforeRows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(metadata(beforeRows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(metadata(afterRows))
      .mockResolvedValueOnce(deployment());
    const boundaryCheck = vi.fn().mockResolvedValue(0);
    const outputs: string[] = [];
    const writes: string[] = [];

    const result = await runProtectedPermanentStagingVariableMutation({
      argv: argv("provider-google-maps-api-key"),
      env: environment("provider-google-maps-api-key"),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck,
      readSecretFile: () => held,
      writeDurable: (_directory, _leaf, source) => {
        writes.push(source);
        return sha256(source);
      },
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    expect(boundaryCheck).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    const mutation = JSON.parse(
      String((fetchImpl.mock.calls[6]![1] as RequestInit).body),
    ) as { variables: Record<string, unknown> };
    expect(mutation.variables).toEqual({
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      variables: { GOOGLE_MAPS_API_KEY: secret },
      skipDeploys: true,
    });
    expect(fetchImpl.mock.calls.filter((call) =>
      String((call[1] as RequestInit).body).includes("variableCollectionUpsert")))
      .toHaveLength(1);
    expect([...held]).toEqual(new Array(held.length).fill(0));
    expect(writes).toHaveLength(2);
    expect(writes.join("\n")).not.toContain(secret);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).not.toContain(secret);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "acknowledged_pending_runtime_proof",
      attempts: 1,
      retryAllowed: false,
      checks: {
        acknowledgementExact: true,
        postflightAttempted: true,
        targetPostflightExact: true,
        deploymentUnchanged: true,
        boundaryPostflightExact: true,
        inputZeroized: true,
        terminalEvidenceExact: true,
      },
    });
  });

  it("rejects unhealthy, multi-replica, identity-drifted, or unpinned baselines before custody", async () => {
    const scenarios: readonly {
      label: string;
      metadata?: Parameters<typeof metadata>[1];
      deployment?: Parameters<typeof deployment>[0];
      rows?: readonly Record<string, unknown>[];
    }[] = [
      { label: "failed latest deployment", metadata: { latestStatus: "FAILED" } },
      { label: "stopped latest deployment", metadata: { latestStopped: true } },
      { label: "multiple replicas", metadata: { numReplicas: 2 } },
      {
        label: "multiple active deployments",
        metadata: {
          activeDeployments: [
            { id: DEPLOYMENT_ID, status: "SUCCESS", deploymentStopped: false },
            { id: OTHER_DEPLOYMENT_ID, status: "SUCCESS", deploymentStopped: false },
          ],
        },
      },
      {
        label: "latest and active identity mismatch",
        metadata: {
          activeDeployments: [{
            id: OTHER_DEPLOYMENT_ID,
            status: "SUCCESS",
            deploymentStopped: false,
          }],
        },
      },
      { label: "snapshot identity mismatch", deployment: { snapshotId: DOMAIN_ID } },
      { label: "deployment patch present", deployment: { patchId: DOMAIN_ID } },
      {
        label: "candidate already deployed as the supposed legacy baseline",
        deployment: { commitHash: CANDIDATE_SHA },
      },
      { label: "unpinned domain", metadata: { domain: "wrong-staging.up.railway.app" } },
      { label: "unpinned target port", metadata: { targetPort: 3000 } },
      {
        label: "worker prepare already started",
        rows: [
          variable("DATABASE_URL", SERVICE_ID, true),
          variable("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED"),
          variable("PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA"),
        ],
      },
    ];

    for (const scenario of scenarios) {
      const rows = scenario.rows ?? [variable("DATABASE_URL", SERVICE_ID, true)];
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(metadata(rows, scenario.metadata))
        .mockResolvedValueOnce(deployment(scenario.deployment));
      const readSecretFile = vi.fn(() => Buffer.from("must-not-be-read"));
      const outputs: string[] = [];

      const result = await runProtectedPermanentStagingVariableMutation({
        argv: argv("provider-google-maps-api-key"),
        env: environment("provider-google-maps-api-key"),
        cwd: process.cwd(),
        fetchImpl,
        boundaryCheck: vi.fn().mockResolvedValue(0),
        readSecretFile,
        writeDurable: vi.fn(),
        writeOutput: (source) => outputs.push(source),
      });

      expect(result, scenario.label).toBe(1);
      expect(readSecretFile, scenario.label).not.toHaveBeenCalled();
      expect(fetchImpl.mock.calls.some((call) =>
        String((call[1] as RequestInit).body).includes("variableCollectionUpsert")), scenario.label)
        .toBe(false);
      expect(JSON.parse(outputs[0]!), scenario.label).toMatchObject({
        outcome: "failed_before_attempt",
        attempts: 0,
        checks: { targetPreflightExact: false },
      });
    }
  });

  it("rechecks the exact generation after intent and fails drift before a write attempt", async () => {
    const beforeRows = [variable("DATABASE_URL", SERVICE_ID, true)];
    const scenarios = [
      {
        label: "topology drift",
        metadata: metadata(beforeRows, { numReplicas: 2 }),
        deployment: deployment(),
      },
      {
        label: "deployment identity drift",
        metadata: metadata(beforeRows, { latestDeploymentId: OTHER_DEPLOYMENT_ID }),
        deployment: deployment({ id: OTHER_DEPLOYMENT_ID }),
      },
      {
        label: "target row drift",
        metadata: metadata([...beforeRows, variable("GOOGLE_MAPS_API_KEY")]),
        deployment: deployment(),
      },
    ];

    for (const scenario of scenarios) {
      const held = Buffer.from("maps-key-private-value");
      const writes: string[] = [];
      const outputs: string[] = [];
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(metadata(beforeRows))
        .mockResolvedValueOnce(deployment())
        .mockResolvedValueOnce(scenario.metadata)
        .mockResolvedValueOnce(scenario.deployment);

      const result = await runProtectedPermanentStagingVariableMutation({
        argv: argv("provider-google-maps-api-key"),
        env: environment("provider-google-maps-api-key"),
        cwd: process.cwd(),
        fetchImpl,
        boundaryCheck: vi.fn().mockResolvedValue(0),
        readSecretFile: () => held,
        writeDurable: (_directory, _leaf, source) => {
          writes.push(source);
          return sha256(source);
        },
        writeOutput: (source) => outputs.push(source),
      });

      expect(result, scenario.label).toBe(1);
      expect(fetchImpl, scenario.label).toHaveBeenCalledTimes(6);
      expect(fetchImpl.mock.calls.some((call) =>
        String((call[1] as RequestInit).body).includes("variableCollectionUpsert")), scenario.label)
        .toBe(false);
      expect([...held], scenario.label).toEqual(new Array(held.length).fill(0));
      expect(writes.join("\n"), scenario.label).not.toContain("maps-key-private-value");
      expect(JSON.parse(outputs[0]!), scenario.label).toMatchObject({
        outcome: "failed_before_attempt",
        attempts: 0,
        checks: {
          durableIntentExact: true,
          targetPreflightExact: false,
          inputZeroized: true,
        },
      });
    }
  });

  it("reconciles an ambiguous mutation exactly once and never retries", async () => {
    const secret = Buffer.from("openai-private-value");
    const beforeRows = [variable("DATABASE_URL", SERVICE_ID, true)];
    const afterRows = [...beforeRows, variable("OPENAI_API_KEY")];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(metadata(beforeRows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(metadata(beforeRows))
      .mockResolvedValueOnce(deployment())
      .mockRejectedValueOnce(new Error("connection_lost_after_send"))
      .mockResolvedValueOnce(metadata(afterRows))
      .mockResolvedValueOnce(deployment());
    const outputs: string[] = [];

    const result = await runProtectedPermanentStagingVariableMutation({
      argv: argv("provider-openai-api-key"),
      env: environment("provider-openai-api-key"),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      readSecretFile: () => secret,
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(fetchImpl.mock.calls.filter((call) =>
      String((call[1] as RequestInit).body).includes("variableCollectionUpsert")))
      .toHaveLength(1);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      retryAllowed: false,
      checks: { postflightAttempted: true, targetPostflightExact: true },
    });
  });

  it("replaces both Supabase keys in one all-or-nothing mutation", async () => {
    const publishable = `sb_publishable_${"p".repeat(32)}`;
    const secret = `sb_secret_${"s".repeat(32)}`;
    const rows = [
      variable("SUPABASE_ANON_KEY", SERVICE_ID, false),
      variable("SUPABASE_ANON_KEY", CANARY_ID, false, [`${SERVICE_ID}.SUPABASE_ANON_KEY`]),
      variable("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("SUPABASE_SERVICE_ROLE_KEY", CANARY_ID, true, [`${SERVICE_ID}.SUPABASE_SERVICE_ROLE_KEY`]),
      variable("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED"),
      variable("PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA"),
    ];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(metadata(rows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(metadata(rows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(metadata(rows))
      .mockResolvedValueOnce(deployment());
    const outputs: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: [
        "--operation", "supabase-key-replacement",
        "--evidence-dir", "/private/evidence",
        "--publishable-key-file", "/private/publishable",
        "--secret-key-file", "/private/secret",
      ],
      env: environment("supabase-key-replacement"),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      readSecretFile: (filename) => Buffer.from(
        filename.endsWith("publishable") ? publishable : secret,
      ),
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    const mutation = JSON.parse(
      String((fetchImpl.mock.calls[6]![1] as RequestInit).body),
    ) as { variables: { variables: Record<string, string>; skipDeploys: boolean } };
    expect(mutation.variables.variables).toEqual({
      SUPABASE_ANON_KEY: publishable,
      SUPABASE_SERVICE_ROLE_KEY: secret,
    });
    expect(mutation.variables.skipDeploys).toBe(true);
    expect(outputs[0]).not.toContain(publishable);
    expect(outputs[0]).not.toContain(secret);
  });

  it("blocks workflow reruns before reading input or contacting Railway", async () => {
    const fetchImpl = vi.fn();
    const readSecretFile = vi.fn();
    const output: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: argv("provider-google-maps-map-id"),
      env: environment("provider-google-maps-map-id", { GITHUB_RUN_ATTEMPT: "2" }),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn(),
      readSecretFile,
      writeDurable: vi.fn(),
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readSecretFile).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { githubAuthorityExact: false },
    });
  });

  it("rejects partial, shared, or foreign Supabase metadata", () => {
    const exactRows = [
      variable("SUPABASE_ANON_KEY", SERVICE_ID, false),
      variable("SUPABASE_ANON_KEY", CANARY_ID, false, ["SUPABASE_ANON_KEY"]),
      variable("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("SUPABASE_SERVICE_ROLE_KEY", CANARY_ID, true, ["SUPABASE_SERVICE_ROLE_KEY"]),
    ];
    const parse = (rows: readonly Record<string, unknown>[]) =>
      protectedPermanentStagingVariableMutationInternals.parseMetadata(
        JSON.parse(JSON.stringify(metadata(rows).body)) as unknown,
      );
    const snapshot = {
      environmentId: ENVIRONMENT_ID,
      variables: exactRows,
      stagedPatchEmpty: true,
      serviceInstance: {},
    } as never;
    expect(protectedPermanentStagingVariableMutationInternals
      .supabaseMetadataExact(snapshot)).toBe(true);
    expect(protectedPermanentStagingVariableMutationInternals
      .supabaseMetadataExact({
        ...snapshot,
        variables: exactRows.slice(0, 3),
      })).toBe(false);
    expect(protectedPermanentStagingVariableMutationInternals
      .supabaseMetadataExact({
        ...snapshot,
        variables: [...exactRows, variable("SUPABASE_ANON_KEY", null, false)],
      })).toBe(false);
    expect(parse).toBeTypeOf("function");
  });
});
