import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PROTECTED_STAGING_VARIABLE_DEPLOYMENT_QUERY,
  PROTECTED_STAGING_VARIABLE_CANCEL_DELETION_QUERY,
  PROTECTED_STAGING_VARIABLE_COMMIT_DELETION_QUERY,
  PROTECTED_STAGING_VARIABLE_METADATA_QUERY,
  PROTECTED_STAGING_VARIABLE_MUTATION_QUERY,
  PROTECTED_STAGING_VARIABLE_PATCH_QUERY,
  PROTECTED_STAGING_VARIABLE_STAGE_DELETION_QUERY,
  PROTECTED_STAGING_VARIABLE_MUTATION_STATE,
  PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY,
  protectedPermanentStagingVariableMutationInternals,
  runProtectedPermanentStagingVariableMutation,
} from "../scripts/execute-protected-permanent-staging-variable-mutation.js";

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const COLD_INSTANCE_ID = "5a2f3970-2850-44e0-9b6c-f5c7627dde13";
const COLD_DEPLOYMENT_ID = "c71fdb35-2be0-4031-b952-85595dfb2913";
const COLD_SNAPSHOT_ID = "f1061f4f-e1dd-49f3-b91a-60efbc3d6841";
const COLD_DOMAIN_ID = "afbb2417-c6df-48e3-9987-271b10ab2962";
const COLD_SOURCE_SHA = "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba";
const CANDIDATE_SHA = "a".repeat(40);
const LEGACY_SHA = "c".repeat(40);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const STAGED_PATCH_ID = "77777777-7777-4777-8777-777777777777";
const EMPTY_STAGED_PATCH_ID = "<empty>";
const FREEZE_ATTESTATION =
  "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
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
    serviceInstanceId?: string;
    numReplicas?: number | null;
    sourceRepo?: string | null;
    sourceImage?: string | null;
    latestStatus?: string;
    latestStopped?: boolean;
    latestDeploymentId?: string;
    snapshotId?: string;
    activeDeployments?: readonly Record<string, unknown>[];
    domain?: string;
    domainId?: string;
    targetPort?: number | null;
    stagedPatch?: Record<string, unknown>;
    stagedPatchId?: string;
    stagedPatchStatus?: "APPLYING" | "COMMITTED" | "STAGED";
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
      staged: {
        id: input.stagedPatchId ?? (input.stagedPatch
          && Object.keys(input.stagedPatch).length > 0
          ? STAGED_PATCH_ID
          : EMPTY_STAGED_PATCH_ID),
        environmentId: ENVIRONMENT_ID,
        status: input.stagedPatchStatus ?? "STAGED",
        patch: input.stagedPatch ?? {},
      },
      serviceInstance: {
        id: input.serviceInstanceId ?? INSTANCE_ID,
        serviceId: SERVICE_ID,
        environmentId: ENVIRONMENT_ID,
        numReplicas: Object.hasOwn(input, "numReplicas")
          ? input.numReplicas
          : 1,
        source: {
          repo: input.sourceRepo === undefined ? "blackmagic30/Beer" : input.sourceRepo,
          image: input.sourceImage ?? null,
        },
        latestDeployment: {
          id: latestDeploymentId,
          status: latestStatus,
          deploymentStopped: latestStopped,
          snapshotId: input.snapshotId ?? SNAPSHOT_ID,
        },
        activeDeployments: input.activeDeployments ?? [{
          id: latestDeploymentId,
          status: latestStatus,
          deploymentStopped: latestStopped,
        }],
        domains: {
          serviceDomains: [{
            id: input.domainId ?? DOMAIN_ID,
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
  imageDigest?: string | null;
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
          imageDigest: Object.hasOwn(input, "imageDigest")
            ? input.imageDigest
            : IMAGE_DIGEST,
          patchId: input.patchId ?? null,
        },
      },
    },
  });
}

function coldMetadata(
  rows: readonly Record<string, unknown>[],
  stagedPatch: Record<string, unknown> = {},
  overrides: Parameters<typeof metadata>[1] = {},
): Response {
  return metadata(rows, {
    serviceInstanceId: COLD_INSTANCE_ID,
    numReplicas: null,
    sourceRepo: null,
    sourceImage: null,
    latestStatus: "FAILED",
    latestStopped: true,
    latestDeploymentId: COLD_DEPLOYMENT_ID,
    snapshotId: COLD_SNAPSHOT_ID,
    activeDeployments: [],
    domainId: COLD_DOMAIN_ID,
    stagedPatch,
    ...overrides,
  });
}

function coldDeployment(
  overrides: Parameters<typeof deployment>[0] = {},
): Response {
  return deployment({
    id: COLD_DEPLOYMENT_ID,
    snapshotId: COLD_SNAPSHOT_ID,
    commitHash: COLD_SOURCE_SHA,
    imageDigest: null,
    ...overrides,
  });
}

function stageDeletion(
  patch: Record<string, unknown>,
  id = STAGED_PATCH_ID,
): Response {
  return json({
    data: {
      environmentStageChanges: {
        id,
        environmentId: ENVIRONMENT_ID,
        status: "STAGED",
        patch,
      },
    },
  });
}

function committedDeletionPatch(
  patch: Record<string, unknown>,
  id = STAGED_PATCH_ID,
  status: "APPLYING" | "COMMITTED" | "STAGED" = "COMMITTED",
): Response {
  return json({
    data: {
      environmentPatch: { id, environmentId: ENVIRONMENT_ID, status, patch },
    },
  });
}

function environment(
  operation: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_RUN_ID: "500",
    GITHUB_SHA: CANDIDATE_SHA,
    GITHUB_RUN_ATTEMPT: "1",
    PINTPATH_MUTATION_CONFIRMATION:
      `MUTATE_${operation.toUpperCase().replaceAll("-", "_")}_IN_PERMANENT_STAGING`,
    PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION: FREEZE_ATTESTATION,
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

function cleanupArgv(): string[] {
  return [
    "--operation",
    "remove-forbidden-offsite-backup-variables",
    "--evidence-dir",
    "/private/evidence",
  ];
}

function cleanupRecoveryArgv(operation: string, includeArtifact = true): string[] {
  const values = [
    "--operation",
    operation,
    "--evidence-dir",
    "/private/evidence",
    "--prior-cleanup-run-id",
    "450",
    "--reviewed-authority-file",
    "/private/reviewed-authority.json",
  ];
  if (includeArtifact) values.push(
    "--prior-cleanup-evidence-dir",
    "/private/prior-cleanup-evidence",
  );
  return values;
}

describe("protected permanent-staging variable mutation", () => {
  it("pins metadata-only reads and the reviewed skip-deploy mutation plans", () => {
    expect(PROTECTED_STAGING_VARIABLE_MUTATION_STATE)
      .toBe("GITHUB_ENVIRONMENT_PROTECTED");
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY)
      .toContain("patch(decryptVariables: false)");
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY).not.toMatch(/\bvalue\b/);
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY).toContain("domains");
    expect(PROTECTED_STAGING_VARIABLE_METADATA_QUERY).toContain("source { repo image }");
    expect(PROTECTED_STAGING_VARIABLE_DEPLOYMENT_QUERY).toContain("deployment(id:");
    expect(PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY).not.toMatch(/mutation\s/i);
    expect(PROTECTED_STAGING_VARIABLE_MUTATION_QUERY)
      .toContain("variableCollectionUpsert");
    expect(PROTECTED_STAGING_VARIABLE_MUTATION_QUERY).toContain("$skipDeploys");
    expect(PROTECTED_STAGING_VARIABLE_STAGE_DELETION_QUERY)
      .toContain("environmentStageChanges");
    expect(PROTECTED_STAGING_VARIABLE_STAGE_DELETION_QUERY)
      .toContain("patch(decryptVariables: false)");
    expect(PROTECTED_STAGING_VARIABLE_COMMIT_DELETION_QUERY)
      .toContain("environmentPatchCommitStaged");
    expect(PROTECTED_STAGING_VARIABLE_CANCEL_DELETION_QUERY)
      .toContain("environmentStageChanges");
    expect(PROTECTED_STAGING_VARIABLE_COMMIT_DELETION_QUERY)
      .toContain("$skipDeploys");
    expect(PROTECTED_STAGING_VARIABLE_PATCH_QUERY)
      .toContain("environmentPatch(id: $patchId)");
    expect(PROTECTED_STAGING_VARIABLE_PATCH_QUERY).not.toMatch(/mutation\s/i);
  });

  it("accepts only the captured patch identity in exact committed state", async () => {
    const patch = protectedPermanentStagingVariableMutationInternals
      .cleanupDeletionPatch();
    const parse = protectedPermanentStagingVariableMutationInternals
      .parseCommittedDeletionPatch;
    expect(parse(
      await committedDeletionPatch(patch).json(),
      STAGED_PATCH_ID,
    )).toBe(true);
    expect(parse(
      await committedDeletionPatch(patch, EMPTY_STAGED_PATCH_ID).json(),
      STAGED_PATCH_ID,
    )).toBe(false);
    expect(parse(
      await committedDeletionPatch(patch, STAGED_PATCH_ID, "STAGED").json(),
      STAGED_PATCH_ID,
    )).toBe(false);
    expect(parse(
      await committedDeletionPatch({}, STAGED_PATCH_ID).json(),
      STAGED_PATCH_ID,
    )).toBe(false);
  });

  it("reconciles one existing provider row on the exact dead/null baseline", async () => {
    const secret = "maps-key-private-value";
    const held = Buffer.from(secret);
    const beforeRows = [
      variable("DATABASE_URL", SERVICE_ID, true),
      variable("GOOGLE_MAPS_API_KEY"),
      variable("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED"),
    ];
    const afterRows = [...beforeRows];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(coldMetadata(afterRows))
      .mockResolvedValueOnce(coldDeployment());
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
    const expectedTokens = [
      "mutation-token-that-is-long-enough",
      "metadata-token-that-is-long-enough",
      "metadata-token-that-is-long-enough",
      "metadata-token-that-is-long-enough",
      "metadata-token-that-is-long-enough",
      "metadata-token-that-is-long-enough",
      "mutation-token-that-is-long-enough",
      "metadata-token-that-is-long-enough",
      "metadata-token-that-is-long-enough",
    ];
    for (const [index, call] of fetchImpl.mock.calls.entries()) {
      const headers = new Headers((call[1] as RequestInit).headers);
      expect(headers.get("Project-Access-Token")).toBe(expectedTokens[index]);
      expect(headers.has("Authorization")).toBe(false);
    }
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
    expect(writes[0]).toContain('"authorizedBaseline": "cold-dead-null"');
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
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockRejectedValueOnce(new Error("connection_lost_after_send"))
      .mockResolvedValueOnce(coldMetadata(afterRows))
      .mockResolvedValueOnce(coldDeployment());
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
      variable("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED"),
    ];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(metadata(rows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(metadata(rows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(json({
        disable_signup: false,
        external: { email: true },
      }))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(metadata(rows))
      .mockResolvedValueOnce(deployment());
    const outputs: string[] = [];
    const writes: string[] = [];
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
      writeDurable: (_directory, _leaf, source) => {
        writes.push(source);
        return sha256(source);
      },
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    const mutation = JSON.parse(
      String((fetchImpl.mock.calls[8]![1] as RequestInit).body),
    ) as { variables: { variables: Record<string, string>; skipDeploys: boolean } };
    expect(mutation.variables.variables).toEqual({
      SUPABASE_ANON_KEY: publishable,
      SUPABASE_SERVICE_ROLE_KEY: secret,
    });
    expect(mutation.variables.skipDeploys).toBe(true);
    expect(outputs[0]).not.toContain(publishable);
    expect(outputs[0]).not.toContain(secret);
    expect(writes.join("\n")).not.toContain(publishable);
    expect(writes.join("\n")).not.toContain(secret);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      supabaseKeyCanary: {
        publishableHttpStatus: 200,
        secretHttpStatus: 200,
        checks: {
          exactInputPairUsed: true,
          publishableAuthSettingsExact: true,
          secretProfilesRelationExact: true,
        },
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      },
      checks: { supabasePairCanaryExact: true },
    });
    expect(fetchImpl.mock.calls.filter((call) =>
      String(call[0]).includes("bbfibbadwjxzrcdncavy.supabase.co")))
      .toHaveLength(2);
  });

  it("never writes a Supabase pair when the exact in-memory pair canary fails", async () => {
    const publishable = `sb_publishable_${"p".repeat(32)}`;
    const secret = `sb_secret_${"s".repeat(32)}`;
    const held = [Buffer.from(publishable), Buffer.from(secret)];
    const rows = [
      variable("SUPABASE_ANON_KEY", SERVICE_ID, false),
      variable("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ID, true),
    ];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(metadata(rows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(metadata(rows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(json({ message: "invalid key" }, 401))
      .mockResolvedValueOnce(json([]));
    const outputs: string[] = [];
    let index = 0;
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
      readSecretFile: () => held[index++]!,
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });
    expect(result).toBe(1);
    expect(fetchImpl.mock.calls.some((call) =>
      String((call[1] as RequestInit | undefined)?.body ?? "")
        .includes("variableCollectionUpsert"))).toBe(false);
    expect(held.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        supabasePairCanaryExact: false,
        inputZeroized: true,
      },
    });
    expect(outputs[0]).not.toContain(publishable);
    expect(outputs[0]).not.toContain(secret);
  });

  it("deletes only the three Beer off-site rows from the exact dead/null baseline", async () => {
    const beforeRows = [
      variable("DATABASE_URL", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_BUCKET"),
      variable("OFFSITE_BACKUP_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_SUPABASE_URL"),
    ];
    const afterRows = [variable("DATABASE_URL", SERVICE_ID, true)];
    const patch = protectedPermanentStagingVariableMutationInternals
      .cleanupDeletionPatch();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(stageDeletion(patch))
      .mockResolvedValueOnce(coldMetadata(beforeRows, patch))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(json({
        data: {
          environmentPatchCommitStaged: "66666666-6666-4666-8666-666666666666",
        },
      }))
      .mockResolvedValueOnce(committedDeletionPatch(patch))
      .mockResolvedValueOnce(coldMetadata(afterRows))
      .mockResolvedValueOnce(coldDeployment());
    const boundaryCheck = vi.fn().mockResolvedValue(0);
    const outputs: string[] = [];
    const writes: string[] = [];

    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupArgv(),
      env: environment("remove-forbidden-offsite-backup-variables"),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck,
      readSecretFile: vi.fn(),
      writeDurable: (_directory, _leaf, source) => {
        writes.push(source);
        return sha256(source);
      },
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    expect(boundaryCheck).toHaveBeenCalledTimes(3);
    expect(boundaryCheck).toHaveBeenNthCalledWith(2, "cleanup-deletion");
    expect(fetchImpl).toHaveBeenCalledTimes(13);
    expect(JSON.parse(writes[0]!)).toMatchObject({
      schemaVersion: "pintpath-permanent-staging-variable-mutation-intent/v4",
      externalMutationFreeze: {
        attestation: FREEZE_ATTESTATION,
        enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
        providerCasOrLockVerified: false,
      },
    });
    const stage = JSON.parse(
      String((fetchImpl.mock.calls[6]![1] as RequestInit).body),
    ) as { variables: Record<string, unknown> };
    expect(stage.variables).toEqual({
      environmentId: ENVIRONMENT_ID,
      input: patch,
      merge: false,
    });
    const commit = JSON.parse(
      String((fetchImpl.mock.calls[9]![1] as RequestInit).body),
    ) as { variables: Record<string, unknown> };
    expect(commit.variables).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      skipDeploys: true,
    });
    const committedPatchRead = JSON.parse(
      String((fetchImpl.mock.calls[10]![1] as RequestInit).body),
    ) as { variables: Record<string, unknown> };
    expect(committedPatchRead.variables).toEqual({
      patchId: STAGED_PATCH_ID,
    });
    expect(fetchImpl.mock.calls.filter((call) =>
      String((call[1] as RequestInit).body).includes("environmentStageChanges")))
      .toHaveLength(1);
    expect(fetchImpl.mock.calls.filter((call) =>
      String((call[1] as RequestInit).body).includes("environmentPatchCommitStaged")))
      .toHaveLength(1);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "cleanup_acknowledged",
      attempts: 2,
      retryAllowed: false,
      stagedDeletionPatchId: STAGED_PATCH_ID,
      externalMutationFreeze: {
        attestation: FREEZE_ATTESTATION,
        enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
        providerCasOrLockVerified: false,
      },
      checks: {
        externalMutationFreezeAttested: true,
        stageAcknowledgementExact: true,
        commitAcknowledgementExact: true,
        boundaryPrecommitExact: true,
        stagedDeletionPatchExact: true,
        committedDeletionPatchExact: true,
        deploySuppressionExact: true,
        targetPostflightExact: true,
        deploymentUnchanged: true,
      },
    });
  });

  it("refuses to claim exact cleanup after the committed patch identity does not close", async () => {
    const beforeRows = [
      variable("OFFSITE_BACKUP_BUCKET"),
      variable("OFFSITE_BACKUP_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_SUPABASE_URL"),
    ];
    const patch = protectedPermanentStagingVariableMutationInternals
      .cleanupDeletionPatch();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(stageDeletion(patch))
      .mockResolvedValueOnce(coldMetadata(beforeRows, patch))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(json({
        data: {
          environmentPatchCommitStaged:
            "66666666-6666-4666-8666-666666666666",
        },
      }))
      .mockResolvedValueOnce(committedDeletionPatch(
        patch,
        STAGED_PATCH_ID,
        "STAGED",
      ))
      .mockResolvedValueOnce(coldMetadata([]))
      .mockResolvedValueOnce(coldDeployment());
    const outputs: string[] = [];

    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupArgv(),
      env: environment("remove-forbidden-offsite-backup-variables"),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      readSecretFile: vi.fn(),
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(1);
    expect(fetchImpl.mock.calls.filter((call) =>
      String((call[1] as RequestInit).body)
        .includes("environmentPatchCommitStaged"))).toHaveLength(1);
    const patchRead = JSON.parse(
      String((fetchImpl.mock.calls[10]![1] as RequestInit).body),
    ) as { variables: Record<string, unknown> };
    expect(patchRead.variables).toEqual({ patchId: STAGED_PATCH_ID });
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 2,
      stagedDeletionPatchId: STAGED_PATCH_ID,
      checks: {
        commitAcknowledgementExact: true,
        committedDeletionPatchExact: false,
        targetPostflightExact: true,
      },
    });
  });

  it("rejects a missing operational freeze attestation before Railway custody", async () => {
    const fetchImpl = vi.fn();
    const readSecretFile = vi.fn();
    const outputs: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupArgv(),
      env: environment("remove-forbidden-offsite-backup-variables", {
        PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION: undefined,
      }),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn(),
      readSecretFile,
      writeDurable: vi.fn(),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readSecretFile).not.toHaveBeenCalled();
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      externalMutationFreeze: {
        attestation: null,
        enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
        providerCasOrLockVerified: false,
      },
      checks: { externalMutationFreezeAttested: false },
    });
  });

  it.each([
    [
      "resume-forbidden-offsite-backup-deletion-patch",
      "cleanup_patch_resume_acknowledged",
    ],
    [
      "cancel-forbidden-offsite-backup-deletion-patch",
      "cleanup_patch_cancel_acknowledged",
    ],
  ])(
    "recovers the exact stranded patch with one %s action and no restaging retry",
    async (operation, expectedOutcome) => {
      const beforeRows = [
        variable("DATABASE_URL", SERVICE_ID, true),
        variable("OFFSITE_BACKUP_BUCKET"),
        variable("OFFSITE_BACKUP_SERVICE_ROLE_KEY", SERVICE_ID, true),
        variable("OFFSITE_BACKUP_SUPABASE_URL"),
      ];
      const afterRows = operation.startsWith("resume-")
        ? [variable("DATABASE_URL", SERVICE_ID, true)]
        : beforeRows;
      const patch = protectedPermanentStagingVariableMutationInternals
        .cleanupDeletionPatch();
      const acknowledgement = operation.startsWith("resume-")
        ? json({
          data: {
            environmentPatchCommitStaged:
              "66666666-6666-4666-8666-666666666666",
          },
        })
        : json({
          data: {
            environmentStageChanges: {
              environmentId: ENVIRONMENT_ID,
              patch: {},
            },
          },
        });
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(coldMetadata(beforeRows, patch))
        .mockResolvedValueOnce(coldDeployment())
        .mockResolvedValueOnce(coldMetadata(beforeRows, patch))
        .mockResolvedValueOnce(coldDeployment())
        .mockResolvedValueOnce(acknowledgement);
      if (operation.startsWith("resume-")) {
        fetchImpl.mockResolvedValueOnce(committedDeletionPatch(patch));
      }
      fetchImpl
        .mockResolvedValueOnce(coldMetadata(afterRows))
        .mockResolvedValueOnce(coldDeployment());
      const boundaryCheck = vi.fn().mockResolvedValue(0);
      const outputs: string[] = [];
      const result = await runProtectedPermanentStagingVariableMutation({
        argv: cleanupRecoveryArgv(operation),
        env: environment(operation, {
          PINTPATH_PRIOR_CLEANUP_RUN_ID: "450",
        }),
        cwd: process.cwd(),
        fetchImpl,
        boundaryCheck,
        verifyReviewedCleanupRecoveryAuthority: vi.fn().mockReturnValue(true),
        verifyPriorCleanupEvidence: vi.fn().mockReturnValue(true),
        readSecretFile: vi.fn(),
        writeDurable: (_directory, _leaf, source) => sha256(source),
        writeOutput: (source) => outputs.push(source),
      });

      expect(result).toBe(0);
      expect(boundaryCheck).toHaveBeenNthCalledWith(2, "cleanup-deletion");
      expect(fetchImpl.mock.calls.filter((call) => {
        const body = String((call[1] as RequestInit).body);
        return body.includes("environmentPatchCommitStaged") ||
          body.includes("PintPathProtectedCancelForbiddenVariableDeletion");
      })).toHaveLength(1);
      expect(fetchImpl.mock.calls.filter((call) =>
        String((call[1] as RequestInit).body)
          .includes("PintPathProtectedStageForbiddenVariableDeletion")))
        .toHaveLength(0);
      expect(JSON.parse(outputs[0]!)).toMatchObject({
        operation,
        outcome: expectedOutcome,
        attempts: 1,
        retryAllowed: false,
        stagedDeletionPatchId: STAGED_PATCH_ID,
        checks: {
          stagedDeletionPatchExact: true,
          committedDeletionPatchExact: operation.startsWith("resume-"),
          boundaryPrecommitExact: true,
          targetPostflightExact: true,
          deploymentUnchanged: true,
        },
      });
    },
  );

  it("resumes the authenticated exact staged patch when the prior artifact was lost", async () => {
    const beforeRows = [
      variable("DATABASE_URL", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_BUCKET"),
      variable("OFFSITE_BACKUP_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_SUPABASE_URL"),
    ];
    const afterRows = [variable("DATABASE_URL", SERVICE_ID, true)];
    const patch = protectedPermanentStagingVariableMutationInternals
      .cleanupDeletionPatch();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(coldMetadata(beforeRows, patch))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(beforeRows, patch))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(json({
        data: {
          environmentPatchCommitStaged:
            "66666666-6666-4666-8666-666666666666",
        },
      }))
      .mockResolvedValueOnce(committedDeletionPatch(patch))
      .mockResolvedValueOnce(coldMetadata(afterRows))
      .mockResolvedValueOnce(coldDeployment());
    const verifyPriorCleanupEvidence = vi.fn();
    const outputs: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupRecoveryArgv(
        "resume-forbidden-offsite-backup-deletion-patch",
        false,
      ),
      env: environment("resume-forbidden-offsite-backup-deletion-patch", {
        PINTPATH_PRIOR_CLEANUP_RUN_ID: "450",
      }),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      verifyReviewedCleanupRecoveryAuthority: vi.fn().mockReturnValue(true),
      verifyPriorCleanupEvidence,
      readSecretFile: vi.fn(),
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    expect(verifyPriorCleanupEvidence).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.filter((call) =>
      String((call[1] as RequestInit).body)
        .includes("environmentPatchCommitStaged"))).toHaveLength(1);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "cleanup_patch_resume_acknowledged",
      attempts: 1,
      checks: {
        githubAuthorityExact: true,
        stagedDeletionPatchExact: true,
        committedDeletionPatchExact: true,
        targetPostflightExact: true,
      },
    });
  });

  it("closes an authenticated cleanup whose commit succeeded before evidence was lost", async () => {
    const rows = [variable("DATABASE_URL", SERVICE_ID, true)];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(coldMetadata(rows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(rows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(rows))
      .mockResolvedValueOnce(coldDeployment());
    const boundaryCheck = vi.fn().mockResolvedValue(0);
    const verifyPriorCleanupEvidence = vi.fn();
    const writes: string[] = [];
    const outputs: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupRecoveryArgv(
        "resume-forbidden-offsite-backup-deletion-patch",
        false,
      ),
      env: environment("resume-forbidden-offsite-backup-deletion-patch", {
        PINTPATH_PRIOR_CLEANUP_RUN_ID: "450",
      }),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck,
      verifyReviewedCleanupRecoveryAuthority: vi.fn().mockReturnValue(true),
      verifyPriorCleanupEvidence,
      readSecretFile: vi.fn(),
      writeDurable: (_directory, _leaf, source) => {
        writes.push(source);
        return sha256(source);
      },
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    expect(verifyPriorCleanupEvidence).not.toHaveBeenCalled();
    expect(boundaryCheck).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(fetchImpl.mock.calls.some((call) =>
      String((call[1] as RequestInit).body).includes("mutation PintPath")))
      .toBe(false);
    expect(writes[0]).toContain('"action": "reconcile-exact-completed-deletion"');
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "cleanup_already_completed_reconciled",
      attempts: 0,
      checks: {
        githubAuthorityExact: true,
        boundaryPrecommitExact: false,
        stagedDeletionPatchExact: false,
        acknowledgementExact: false,
        targetPostflightExact: true,
        deploymentUnchanged: true,
      },
    });
  });

  it("retries one exact cleanup after the prior run provably had no effect", async () => {
    const beforeRows = [
      variable("DATABASE_URL", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_BUCKET"),
      variable("OFFSITE_BACKUP_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_SUPABASE_URL"),
    ];
    const afterRows = [variable("DATABASE_URL", SERVICE_ID, true)];
    const patch = protectedPermanentStagingVariableMutationInternals
      .cleanupDeletionPatch();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(beforeRows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(stageDeletion(patch))
      .mockResolvedValueOnce(coldMetadata(beforeRows, patch))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(json({
        data: {
          environmentPatchCommitStaged:
            "66666666-6666-4666-8666-666666666666",
        },
      }))
      .mockResolvedValueOnce(committedDeletionPatch(patch))
      .mockResolvedValueOnce(coldMetadata(afterRows))
      .mockResolvedValueOnce(coldDeployment());
    const boundaryCheck = vi.fn().mockResolvedValue(0);
    const outputs: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupRecoveryArgv(
        "resume-forbidden-offsite-backup-deletion-patch",
        false,
      ),
      env: environment("resume-forbidden-offsite-backup-deletion-patch", {
        PINTPATH_PRIOR_CLEANUP_RUN_ID: "450",
      }),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck,
      verifyReviewedCleanupRecoveryAuthority: vi.fn().mockReturnValue(true),
      verifyPriorCleanupEvidence: vi.fn(),
      readSecretFile: vi.fn(),
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    expect(boundaryCheck).toHaveBeenCalledTimes(3);
    expect(boundaryCheck).toHaveBeenNthCalledWith(2, "cleanup-deletion");
    expect(fetchImpl.mock.calls.filter((call) => {
      const body = String((call[1] as RequestInit).body);
      return body.includes("PintPathProtectedStageForbiddenVariableDeletion") ||
        body.includes("environmentPatchCommitStaged");
    })).toHaveLength(2);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "cleanup_no_effect_retry_acknowledged",
      attempts: 2,
      checks: {
        stageAcknowledgementExact: true,
        commitAcknowledgementExact: true,
        stagedDeletionPatchExact: true,
        committedDeletionPatchExact: true,
        targetPostflightExact: true,
      },
    });
  });

  it("reconciles an exact already-cancelled cleanup without another write", async () => {
    const rows = [
      variable("DATABASE_URL", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_BUCKET"),
      variable("OFFSITE_BACKUP_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_SUPABASE_URL"),
    ];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(coldMetadata(rows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(rows))
      .mockResolvedValueOnce(coldDeployment())
      .mockResolvedValueOnce(coldMetadata(rows))
      .mockResolvedValueOnce(coldDeployment());
    const outputs: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupRecoveryArgv(
        "cancel-forbidden-offsite-backup-deletion-patch",
        false,
      ),
      env: environment("cancel-forbidden-offsite-backup-deletion-patch", {
        PINTPATH_PRIOR_CLEANUP_RUN_ID: "450",
      }),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      verifyReviewedCleanupRecoveryAuthority: vi.fn().mockReturnValue(true),
      verifyPriorCleanupEvidence: vi.fn(),
      readSecretFile: vi.fn(),
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(fetchImpl.mock.calls.some((call) =>
      String((call[1] as RequestInit).body).includes("mutation PintPath")))
      .toBe(false);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "cleanup_already_cancelled_reconciled",
      attempts: 0,
      checks: {
        acknowledgementExact: false,
        stagedDeletionPatchExact: false,
        targetPostflightExact: true,
      },
    });
  });

  it("rejects missing or mismatched recovery authority before contacting Railway", async () => {
    const fetchImpl = vi.fn();
    const verifyPriorCleanupEvidence = vi.fn();
    const outputs: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupRecoveryArgv(
        "resume-forbidden-offsite-backup-deletion-patch",
        false,
      ),
      env: environment("resume-forbidden-offsite-backup-deletion-patch", {
        PINTPATH_PRIOR_CLEANUP_RUN_ID: "450",
      }),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn(),
      verifyReviewedCleanupRecoveryAuthority: vi.fn().mockReturnValue(false),
      verifyPriorCleanupEvidence,
      readSecretFile: vi.fn(),
      writeDurable: vi.fn(),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(verifyPriorCleanupEvidence).not.toHaveBeenCalled();
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: { githubAuthorityExact: false },
    });
  });

  it("rejects a supplied prior artifact that does not match the reviewed cleanup", async () => {
    const fetchImpl = vi.fn();
    const outputs: string[] = [];
    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupRecoveryArgv(
        "resume-forbidden-offsite-backup-deletion-patch",
      ),
      env: environment("resume-forbidden-offsite-backup-deletion-patch", {
        PINTPATH_PRIOR_CLEANUP_RUN_ID: "450",
      }),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn(),
      verifyReviewedCleanupRecoveryAuthority: vi.fn().mockReturnValue(true),
      verifyPriorCleanupEvidence: vi.fn().mockReturnValue(false),
      readSecretFile: vi.fn(),
      writeDurable: vi.fn(),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
    });
  });

  it("accepts an exact cleanup transition after a lost commit acknowledgement without retry", async () => {
    const beforeRows = [
      variable("OFFSITE_BACKUP_BUCKET"),
      variable("OFFSITE_BACKUP_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_SUPABASE_URL"),
    ];
    const patch = protectedPermanentStagingVariableMutationInternals
      .cleanupDeletionPatch();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(metadata(beforeRows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(metadata(beforeRows))
      .mockResolvedValueOnce(deployment())
      .mockResolvedValueOnce(stageDeletion(patch))
      .mockResolvedValueOnce(metadata(beforeRows, { stagedPatch: patch }))
      .mockResolvedValueOnce(deployment())
      .mockRejectedValueOnce(new Error("connection_lost_after_commit"))
      .mockResolvedValueOnce(committedDeletionPatch(patch))
      .mockResolvedValueOnce(metadata([]))
      .mockResolvedValueOnce(deployment());
    const outputs: string[] = [];

    const result = await runProtectedPermanentStagingVariableMutation({
      argv: cleanupArgv(),
      env: environment("remove-forbidden-offsite-backup-variables"),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      readSecretFile: vi.fn(),
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => outputs.push(source),
    });

    expect(result).toBe(0);
    expect(fetchImpl.mock.calls.filter((call) =>
      String((call[1] as RequestInit).body).includes("environmentPatchCommitStaged")))
      .toHaveLength(1);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      outcome: "cleanup_reconciled_after_lost_ack",
      attempts: 2,
      retryAllowed: false,
      checks: {
        acknowledgementExact: false,
        stageAcknowledgementExact: true,
        commitAcknowledgementExact: false,
        committedDeletionPatchExact: true,
        targetPostflightExact: true,
      },
    });
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
      variable("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ID, true),
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
        variables: exactRows.slice(0, 1),
      })).toBe(false);
    expect(protectedPermanentStagingVariableMutationInternals
      .supabaseMetadataExact({
        ...snapshot,
        variables: [...exactRows, variable("SUPABASE_ANON_KEY", null, false)],
      })).toBe(false);
    expect(parse).toBeTypeOf("function");
  });

  it("accepts Railway's exact empty staged-patch sentinel only for an empty STAGED patch", async () => {
    const parse = protectedPermanentStagingVariableMutationInternals.parseMetadata;
    const cleanupPatch = protectedPermanentStagingVariableMutationInternals
      .cleanupDeletionPatch();

    expect(parse(await metadata([]).json())).not.toBeNull();
    expect(parse(await metadata([], {
      stagedPatch: cleanupPatch,
      stagedPatchId: EMPTY_STAGED_PATCH_ID,
    }).json(), "cleanup-deletion")).toBeNull();
    expect(parse(await metadata([], {
      stagedPatchId: EMPTY_STAGED_PATCH_ID,
      stagedPatchStatus: "COMMITTED",
    }).json())).toBeNull();
  });

  it("accepts only exact Beer rows for in-place reconciliation and cleanup", () => {
    const offsiteRows = [
      variable("OFFSITE_BACKUP_BUCKET"),
      variable("OFFSITE_BACKUP_SERVICE_ROLE_KEY", SERVICE_ID, true),
      variable("OFFSITE_BACKUP_SUPABASE_URL"),
    ];
    const cleanupSnapshot = {
      environmentId: ENVIRONMENT_ID,
      variables: offsiteRows,
      stagedPatchEmpty: true,
      serviceInstance: {},
    } as never;
    expect(protectedPermanentStagingVariableMutationInternals
      .forbiddenOffsiteRowsExactForDeletion(cleanupSnapshot)).toBe(true);
    expect(protectedPermanentStagingVariableMutationInternals
      .forbiddenOffsiteRowsExactForDeletion({
        ...cleanupSnapshot,
        variables: offsiteRows.slice(0, 2),
      })).toBe(false);
    expect(protectedPermanentStagingVariableMutationInternals
      .forbiddenOffsiteRowsExactForDeletion({
        ...cleanupSnapshot,
        variables: [
          ...offsiteRows,
          variable("OFFSITE_BACKUP_BUCKET", null),
        ],
      })).toBe(false);

    const providerSnapshot = {
      ...cleanupSnapshot,
      variables: [
        variable("GOOGLE_MAPS_API_KEY"),
        variable("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED"),
      ],
    } as never;
    expect(protectedPermanentStagingVariableMutationInternals
      .providerPreflightExact(providerSnapshot, "GOOGLE_MAPS_API_KEY"))
      .toBe(true);
    expect(protectedPermanentStagingVariableMutationInternals
      .providerPreflightExact({
        ...providerSnapshot,
        variables: [
          ...providerSnapshot.variables,
          variable("GOOGLE_MAPS_API_KEY", null),
        ],
      }, "GOOGLE_MAPS_API_KEY")).toBe(false);
    expect(protectedPermanentStagingVariableMutationInternals
      .providerPreflightExact({
        ...providerSnapshot,
        variables: [...providerSnapshot.variables, ...offsiteRows],
      }, "GOOGLE_MAPS_API_KEY")).toBe(false);
  });

  it("accepts only the fully pinned dead/null baseline", async () => {
    const metadataValue = await coldMetadata([]).json();
    const deploymentValue = await coldDeployment().json();
    const parsedMetadata = protectedPermanentStagingVariableMutationInternals
      .parseMetadata(metadataValue);
    const parsedDeployment = protectedPermanentStagingVariableMutationInternals
      .parseDeployment(deploymentValue, COLD_DEPLOYMENT_ID);
    expect(parsedMetadata).not.toBeNull();
    expect(parsedDeployment).not.toBeNull();
    const exact = {
      ...parsedMetadata!,
      deployment: parsedDeployment!,
    };
    expect(protectedPermanentStagingVariableMutationInternals
      .exactColdDeadBaseline(exact)).toBe(true);

    const invalid = [
      {
        ...exact,
        serviceInstance: { ...exact.serviceInstance, numReplicas: 0 },
      },
      {
        ...exact,
        serviceInstance: {
          ...exact.serviceInstance,
          source: { repo: "blackmagic30/Beer", image: null },
        },
      },
      {
        ...exact,
        serviceInstance: {
          ...exact.serviceInstance,
          id: INSTANCE_ID,
        },
      },
      {
        ...exact,
        serviceInstance: {
          ...exact.serviceInstance,
          domains: [{ ...exact.serviceInstance.domains[0]!, id: DOMAIN_ID }],
        },
      },
      {
        ...exact,
        deployment: { ...exact.deployment, commitHash: LEGACY_SHA },
      },
      {
        ...exact,
        deployment: { ...exact.deployment, imageDigest: IMAGE_DIGEST },
      },
    ];
    for (const snapshot of invalid) {
      expect(protectedPermanentStagingVariableMutationInternals
        .exactColdDeadBaseline(snapshot)).toBe(false);
    }
  });

  it("normalizes omitted optional cold deployment metadata to null", async () => {
    const liveShape = await coldDeployment().json() as {
      data: { deployment: { meta: Record<string, unknown> } };
    };
    delete liveShape.data.deployment.meta.imageDigest;
    delete liveShape.data.deployment.meta.patchId;

    expect(protectedPermanentStagingVariableMutationInternals
      .parseDeployment(liveShape, COLD_DEPLOYMENT_ID)).toMatchObject({
        imageDigest: null,
        patchId: null,
      });

    for (const [field, invalid] of [
      ["imageDigest", 7],
      ["imageDigest", "sha256:not-a-digest"],
      ["patchId", 7],
      ["patchId", "not-a-uuid"],
    ] as const) {
      const malformed = structuredClone(liveShape);
      malformed.data.deployment.meta[field] = invalid;
      expect(protectedPermanentStagingVariableMutationInternals
        .parseDeployment(malformed, COLD_DEPLOYMENT_ID), field).toBeNull();
    }
  });

  it("accepts only the exact current-run reviewed cleanup recovery authority", () => {
    const authority = {
      command: "verify-github-reviewed-candidate-authority",
      ok: true,
      schemaVersion: 1,
      kind: "pintpath-github-reviewed-candidate-authority",
      repository: "blackmagic30/Beer",
      candidateSha: CANDIDATE_SHA,
      reviewedPrHeadSha: CANDIDATE_SHA,
      reviewedPullRequestNumber: 321,
      operation: "resume-forbidden-offsite-backup-deletion-patch",
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      workflowRunId: "500",
      workflowRunAttempt: 1,
      workflowRunCreatedAt: "2026-08-28T01:00:00.000Z",
      reviewedPullRequestMergedAt: "2026-08-28T00:30:00.000Z",
      candidateHistoryMaximumAgeHours: 168,
      completeRetainedHistoryExact: true,
      safePriorSkippedWriteRunIds: [],
      priorCleanupRunId: "450",
      priorCleanupPatchSha256:
        "3650174bf695aaebb3b9ba7f91a4f2a724a0806b30511578448964c36eebfb91",
      exactPriorCleanupCandidateRunBound: true,
      offsiteCleanupRecoveryOriginalRunCompletedAt:
        "2026-08-28T00:45:00.000Z",
      offsiteCleanupRecoveryGraceHours: 24,
      offsiteCleanupRecoveryWithinGraceExact: true,
      safePriorRecoverySkippedWriteRunIds: [],
      ambiguousPriorSameModeRecoveryRunIds: [],
      sameModeRecoveryConvergenceExact: true,
      successfulStagingDeploymentRunIds: [],
      stagingLifecycleSealed: false,
      reviewedAuthorityExact: true,
      freshDispatchWriteGuardExact: true,
    };
    const expected = {
      candidateSha: CANDIDATE_SHA,
      operation: "resume-forbidden-offsite-backup-deletion-patch" as const,
      priorCleanupRunId: "450",
      currentRunId: "500",
    };
    const exact = protectedPermanentStagingVariableMutationInternals
      .reviewedCleanupRecoveryAuthorityValueExact;
    expect(exact(authority, expected)).toBe(true);
    expect(exact({ ...authority, workflowRunId: "501" }, expected)).toBe(false);
    expect(exact({ ...authority, priorCleanupRunId: "449" }, expected)).toBe(false);
    expect(exact({ ...authority, priorCleanupPatchSha256: "0".repeat(64) }, expected))
      .toBe(false);
    expect(exact({
      ...authority,
      offsiteCleanupRecoveryOriginalRunCompletedAt:
        "2026-08-26T00:45:00.000Z",
    }, expected)).toBe(false);
    expect(exact({ ...authority, extra: true }, expected)).toBe(false);
    expect(exact({
      ...authority,
      safePriorRecoverySkippedWriteRunIds: ["500"],
    }, expected)).toBe(false);
  });

  it("accepts retained cleanup evidence from either exact post-stage or post-commit loss", () => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-cleanup-")),
    );
    try {
      const patch = protectedPermanentStagingVariableMutationInternals
        .cleanupDeletionPatch();
      const dispatch = {
        schemaVersion: "pintpath-provider-mutation-dispatch/v1",
        candidateSha: CANDIDATE_SHA,
        operation: "remove-forbidden-offsite-backup-variables",
        secretMaterialIncluded: false,
      };
      const intent = {
        schemaVersion: "pintpath-permanent-staging-variable-mutation-intent/v4",
        operation: "remove-forbidden-offsite-backup-variables",
        candidateSha: CANDIDATE_SHA,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        externalMutationFreeze: {
          attestation: FREEZE_ATTESTATION,
          enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
          providerCasOrLockVerified: false,
        },
        authorizedBaseline: "cold-dead-null",
        variableNames: [
          "OFFSITE_BACKUP_BUCKET",
          "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
          "OFFSITE_BACKUP_SUPABASE_URL",
        ],
        mutationPlan: {
          stage: {
            mutation: "environmentStageChanges",
            merge: false,
            maximumAttempts: 1,
            patch,
          },
          commit: {
            mutation: "environmentPatchCommitStaged",
            skipDeploys: true,
            maximumAttempts: 1,
            commitMessage: `pintpath:staging-offsite-cleanup:${CANDIDATE_SHA}`,
          },
        },
        retryAllowed: false,
        privateInputCount: 0,
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
        preflightMetadataSha256: "d".repeat(64),
      };
      const checks = {
        policyExact: true,
        githubAuthorityExact: true,
        externalMutationFreezeAttested: true,
        tokenScopesExact: true,
        boundaryPreflightExact: true,
        boundaryPrecommitExact: true,
        targetPreflightExact: true,
        supabasePairCanaryExact: true,
        durableIntentExact: true,
        mutationAttemptedAtMostOnce: true,
        acknowledgementExact: true,
        stageAcknowledgementExact: true,
        commitAcknowledgementExact: true,
        stagedDeletionPatchExact: true,
        committedDeletionPatchExact: true,
        deploySuppressionExact: true,
        postflightAttempted: true,
        targetPostflightExact: true,
        deploymentUnchanged: true,
        boundaryPostflightExact: true,
        inputZeroized: true,
        terminalEvidenceExact: false,
      };
      const terminal = (
        attempts: 0 | 1 | 2,
        stagedDeletionPatchExact = attempts > 0,
      ) => ({
        schemaVersion:
          "pintpath-permanent-staging-variable-mutation-terminal/v4",
        receipt: {
          schemaVersion: "pintpath-permanent-staging-variable-mutation/v4",
          executorState: "GITHUB_ENVIRONMENT_PROTECTED",
          operation: "remove-forbidden-offsite-backup-variables",
          outcome: attempts === 0
            ? "failed_before_attempt"
            : attempts === 1
            ? "mutation_uncertain"
            : "cleanup_acknowledged",
          candidateSha: CANDIDATE_SHA,
          attempts,
          retryAllowed: false,
          intentSha256: sha256(canonical(intent)),
          terminalEvidenceSha256: null,
          externalMutationFreeze: {
            attestation: FREEZE_ATTESTATION,
            enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
            providerCasOrLockVerified: false,
          },
          stagedDeletionPatchId: stagedDeletionPatchExact
            ? STAGED_PATCH_ID
            : null,
          supabaseKeyCanary: null,
          checks: attempts === 0
            ? {
                ...checks,
                boundaryPrecommitExact: false,
                targetPreflightExact: false,
                acknowledgementExact: false,
                stageAcknowledgementExact: false,
                commitAcknowledgementExact: false,
                stagedDeletionPatchExact: false,
                committedDeletionPatchExact: false,
                deploySuppressionExact: false,
                postflightAttempted: false,
                targetPostflightExact: false,
                deploymentUnchanged: false,
                boundaryPostflightExact: false,
              }
            : attempts === 1
            ? {
                ...checks,
                boundaryPrecommitExact: false,
                acknowledgementExact: false,
                stageAcknowledgementExact: stagedDeletionPatchExact,
                commitAcknowledgementExact: false,
                stagedDeletionPatchExact,
                committedDeletionPatchExact: false,
                deploySuppressionExact: false,
                targetPostflightExact: false,
              }
            : checks,
        },
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      });
      fs.writeFileSync(path.join(directory, "dispatch.json"), canonical(dispatch));
      const exact = protectedPermanentStagingVariableMutationInternals
        .priorCleanupEvidenceExact;
      expect(exact(directory, CANDIDATE_SHA)).toBe(true);
      fs.writeFileSync(path.join(directory, "intent.json"), canonical(intent));
      expect(exact(directory, CANDIDATE_SHA)).toBe(true);
      fs.writeFileSync(path.join(directory, "terminal.json"), canonical(terminal(0)));
      expect(exact(directory, CANDIDATE_SHA)).toBe(true);
      fs.writeFileSync(
        path.join(directory, "terminal.json"),
        canonical(terminal(1, false)),
      );
      expect(exact(directory, CANDIDATE_SHA)).toBe(true);
      fs.writeFileSync(path.join(directory, "terminal.json"), canonical(terminal(1)));
      expect(exact(directory, CANDIDATE_SHA)).toBe(true);
      fs.writeFileSync(path.join(directory, "terminal.json"), canonical(terminal(2)));
      expect(exact(directory, CANDIDATE_SHA)).toBe(true);
      fs.writeFileSync(path.join(directory, "terminal.json"), canonical({
        ...terminal(2),
        receipt: {
          ...terminal(2).receipt,
          checks: { ...checks, boundaryPrecommitExact: false },
        },
      }));
      expect(exact(directory, CANDIDATE_SHA)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
